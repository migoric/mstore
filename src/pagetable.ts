/**
 * CoW 页表：业务数据的落盘结构。
 *
 * 关键取舍（都写在注释里，方便后来的人判断能不能改）：
 *   - 页内用 JSON 存「key → value」，所以 dump 出来的东西人眼可读（§16 可读性预算）
 *   - 每次更新**整页重写**到新偏移（CoW），旧页永不覆盖 → 崩溃安全不靠 WAL
 *   - 页目录（logical → 物理偏移）放在 store 的 meta 里，双份 CRC 交替写
 *   - 不做页内 compaction：一页 ≤ 几十行，JSON 里删掉一个 key 不影响其他 key 的定位
 *
 * 页表的行地址是 (逻辑页号, key)，不是 slot 号 —— slot 会在重写时漂移，key 不会。
 *
 * 字节账必须**精确**：一页装不装得下，算的是「JSON.stringify 之后的确切长度」。
 * 早先用「每行长度 + 2 字节逗号余量」估算，单行时会低估 6 字节（多算了不存在的
 * 逗号、少算了 `{"r":[]}` 空壳），结果是刚好超页的行能过检查、到 flush 才炸。
 */
import type { Meta } from './types.ts';
import { MemoryKeyDirectory } from './keydir.ts';
import type { KeyDirectory } from './keydir.ts';

export interface PageTableOpts {
  /** 页大小，默认 4096 */
  pageSize?: number;
  /** 一页最多放多少行（超过就开新页），默认 48 */
  rowsPerPage?: number;
  /**
   * 解码后页的缓存页数，默认 1024；传 0 关掉缓存。
   *
   * 缓存的是「解码后的页」而不是原始字节：一次点查的成本里 pread 4KB 只占 3.7µs，
   * 而把那一页 48 行 JSON.parse 出来要 19.6µs（占 64%）。只缓存字节等于没省。
   *
   * 1024 页约 14MB，能盖住 4.9 万行的库。低于工作集就会 LRU 抖动、等于没加：
   * 实测 2 万行（417 页）时 256 页缓存命中率只有 39%，随机点查 35µs（和不加一样）；
   * 4096 页时命中率 99%、点查 1.9µs。
   */
  pageCachePages?: number;
  /** PageTable 与 BizIndex 共用的 key 目录；缺省为进程内 Map */
  directory?: KeyDirectory;
}

interface RowEntry {
  k: string;
  v: unknown;
}

interface DirtyPage {
  off: number;
  rows: RowEntry[];
  data: Buffer;
}

const MAX_WRITE_BYTES = 1024 * 1024;

export interface PageTableStats {
  pages: number;
  rows: number;
  bytes: number;
  /** 当前 LRU 中缓存的解码页数，用于验证禁用与淘汰策略 */
  cachedPages: number;
  pageSize: number;
  rowsPerPage: number;
  rewrites: number;
}

/** 页表依赖的最小 IO 面：测试里可以塞一个内存实现，不用真文件 */
export interface PageIo {
  readAt(off: number, len: number): Buffer;
  writeAt(buf: Buffer, off: number): void;
}

export class PageTable {
  /** 空页骨架 `{"r":[]}` 的字节数：`{"r":[` 六字节 + `]}` 两字节 */
  private static readonly SHELL = 8;

  private io: PageIo;
  private meta: Meta;
  private alloc: (bytes: number) => number;
  private markDirty: () => void;
  readonly pageSize: number;
  readonly rowsPerPage: number;

  private dir: number[] = []; // logical -> physical offset（0 表示还没落盘/已作废）
  private directory: KeyDirectory;
  private dirtyPages = new Map<number, DirtyPage>();
  rewrites = 0;

  // 解码后页的 LRU 缓存（logical -> rows）。
  // 用 Map 的插入顺序当 LRU：命中时删了再插，最旧的自然排在最前面。
  private cache = new Map<number, RowEntry[]>();
  private cacheMax: number;
  /** 命中/未命中计数，只给 stats 看 —— 判断「缓存有没有用」得靠它，不靠感觉 */
  cacheHits = 0;
  cacheMisses = 0;

  // 追加缓冲：新行先攒在这里，提交时整页写一次。
  // 否则「每插一行就重写整页」，30k 行会退化成 30k 次 4KB 写。
  private openLogical: number | null = null;
  private openRows: RowEntry[] = [];
  private openBytes = 0; // 只累计各行 JSON 的字节数，不含骨架与逗号
  private openDirty = false; // equiv: 初值改 true 也观察不到——flushOpen 要先有 openLogical

  constructor(io: PageIo, meta: Meta, alloc: (bytes: number) => number, markDirty: () => void, opts: PageTableOpts = {}) {
    this.io = io;
    this.meta = meta;
    this.alloc = alloc;
    this.markDirty = markDirty;
    this.pageSize = opts.pageSize ?? 4096;
    this.rowsPerPage = opts.rowsPerPage ?? 48;
    this.cacheMax = Math.max(0, opts.pageCachePages ?? 1024);
    this.directory = opts.directory ?? new MemoryKeyDirectory();
  }

  // ---------------- 字节账 ----------------

  /** 一页能装的 JSON 字节数：整页减掉 2B 长度前缀，再留 2B 余量 */
  private get cap(): number {
    return this.pageSize - 4;
  }

  private static rowJson(r: RowEntry): number {
    return Buffer.byteLength(JSON.stringify(r));
  }

  /** 一页装 count 行、各行 JSON 合计 rowBytes 时，序列化出来是多少字节 */
  private static frameBytes(rowBytes: number, count: number): number {
    return PageTable.SHELL + rowBytes + (count > 1 ? count - 1 : 0); // equiv: count 为 1 时 count-1 就是 0，改成 >= 1 结果一样
  }

  /** 假设再多装 extraBytes（或替换带来的 delta）并让行数变成「当前 + extraCount」，整页会有多大 */
  private frameAfter(extraBytes: number, extraCount: number): number {
    return PageTable.frameBytes(this.openBytes + extraBytes, this.openRows.length + extraCount);
  }

  // ---------------- 编解码 ----------------

  private encode(rows: RowEntry[]): Buffer {
    const json = Buffer.from(JSON.stringify({ r: rows }), 'utf8');
    if (json.length > this.cap) {
      throw new Error(`page overflow: ${json.length}B > ${this.cap}B`);
    }
    const buf = Buffer.alloc(this.pageSize); // 整页写，剩余补 0（可预测、可校验）
    buf.writeUInt16LE(json.length, 0);
    json.copy(buf, 2);
    return buf;
  }

  private decode(buf: Buffer): RowEntry[] {
    const len = buf.readUInt16LE(0);
    if (len === 0) return [];
    const json = buf.subarray(2, 2 + len);
    // subarray 会截断，所以比「实际拿到的长度」比「算一遍 len+2 再比」更实在
    if (json.length !== len) throw new Error(`corrupt page: len=${len} > ${buf.length - 2}`);
    const parsed = JSON.parse(json.toString('utf8')) as { r?: RowEntry[] };
    return parsed.r ?? [];
  }

  // ---------------- 生命周期 ----------------

  /** 从 meta 恢复页目录；持久化 key 目录已经可用时不再逐页扫描 key。 */
  load(): void {
    const saved = (this.meta as Meta & { pageDir?: number[] }).pageDir ?? [];
    this.dir = saved.slice();
    // 页目录整个换了，缓存的 logical → 内容对应关系不再成立
    this.cache.clear();
    this.dirtyPages.clear();
    if (this.directory.persistent) return;
    this.directory.clear();
    this.dir.forEach((off, logical) => {
      if (!off) return; // 占位 0：还没落盘的页
      for (const r of this.decode(this.io.readAt(off, this.pageSize))) this.directory.set(r.k, { logical });
    });
  }

  stats(): PageTableStats {
    let bytes = 0;
    for (const off of this.dir) if (off) bytes += this.pageSize;
    return {
      pages: this.dir.filter((o) => o > 0).length,
      rows: this.directory.size,
      bytes,
      cachedPages: this.cache.size,
      pageSize: this.pageSize,
      rowsPerPage: this.rowsPerPage,
      rewrites: this.rewrites,
    };
  }

  // ---------------- 读 ----------------

  has(key: string): boolean {
    return this.directory.get(key) !== undefined;
  }

  get(key: string): unknown {
    const logical = this.directory.get(key)?.logical;
    if (logical === undefined) return undefined;
    const rows = logical === this.openLogical ? this.openRows : this.pageRows(logical);
    const hit = rows.find((r) => r.k === key);
    if (!hit) return undefined;
    // 返回副本。缓存里那一份是共享的，直接返回会让调用方的修改悄悄污染后续读，
    // 而且不报错——那种 bug 要等到某次读出错数据才被发现。
    // 深拷贝一个业务行约 1.1µs，比「不用缓存、每次重新解析整页」的 19.6µs 便宜得多，
    // 所以缓存 + 拷贝仍然划算，同时语义与「没有缓存」时完全一致。
    return PageTable.detach(hit.v);
  }

  /** 缓存里的值是共享的，凡是要交出去的都必须先过这一道 */
  private static detach(v: unknown): unknown {
    if (v === null || typeof v !== 'object') return v;
    return JSON.parse(JSON.stringify(v)) as unknown;
  }

  keys(): string[] {
    return [...this.directory.entries()].map(([key]) => key);
  }

  size(): number {
    return this.directory.size;
  }

  private readPage(logical: number): RowEntry[] {
    const off = this.dir[logical];
    if (!off) return [];
    return this.decode(this.io.readAt(off, this.pageSize));
  }

  /**
   * 读一页（带 LRU 缓存）。所有读路径都必须走这里，包括 put/delete 内部的
   * 「读-改-写」——它们改完会调 writePage，而 writePage 会把新内容同步进缓存，
   * 所以两边不会打架。
   */
  private pageRows(logical: number): RowEntry[] {
    const pending = this.dirtyPages.get(logical);
    if (pending) return pending.rows;
    if (this.cacheMax === 0) return this.readPage(logical);
    const hit = this.cache.get(logical);
    if (hit !== undefined) {
      this.cacheHits++;
      // 命中时删了再插：Map 按插入顺序迭代，这样最久没用的那个自然排到最前面被淘汰
      this.cache.delete(logical);
      this.cache.set(logical, hit);
      return hit;
    }
    this.cacheMisses++;
    const rows = this.readPage(logical);
    this.cache.set(logical, rows);
    if (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest); // equiv: size 超限时 Map 至少有一项，oldest 不可能为 undefined
    }
    return rows;
  }

  // ---------------- 写（全部 CoW） ----------------

  /** 整页编码后进脏页队列；提交时按偏移合并写，旧页仍不覆盖。 */
  private writePage(logical: number, rows: RowEntry[]): void {
    const data = this.encode(rows);
    const off = this.alloc(this.pageSize);
    this.dirtyPages.set(logical, { off, rows, data });
    this.dir[logical] = off; // 新页（logical === dir.length）与重写走同一条路
    this.rewrites++;
    // 页内容变了，缓存必须跟着变。这里是唯一写页内容的地方，
    // 所以 put/delete 读-改-写之后不需要各自再管缓存。
    if (this.cacheMax !== 0) {
      this.cache.delete(logical);
      this.cache.set(logical, rows);
      if (this.cache.size > this.cacheMax) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest); // equiv: size 超限时 Map 至少有一项，oldest 不可能为 undefined
      }
    }
    this.persistDir();
  }

  put(key: string, value: unknown): void {
    // 页缓存与脏页队列会长期持有 value；必须在入口断开调用方引用，
    // 否则调用方后续修改原对象会绕过写路径，直接改变缓存里的已提交值。
    value = PageTable.detach(value);
    const existing = this.directory.get(key)?.logical;
    if (existing !== undefined) {
      if (existing === this.openLogical) {
        const i = this.openRows.findIndex((r) => r.k === key);
        if (i >= 0) {
          const oldEntry = this.openRows[i]!;
          const newEntry: RowEntry = { k: key, v: value };
          const delta = PageTable.rowJson(newEntry) - PageTable.rowJson(oldEntry);
          if (this.frameAfter(delta, 0) > this.cap) {
            // 单行本身也放不下时必须在改动旧页之前失败，不能先删旧行再抛错。
            if (PageTable.frameBytes(PageTable.rowJson(newEntry), 1) > this.cap) {
              throw new Error(`page overflow: ${PageTable.frameBytes(PageTable.rowJson(newEntry), 1)}B > ${this.cap}B`);
            }
            // 变大后装不下：把这一行搬出去。统一目录还保存 rowid，不能 delete；
            // appendToOpen 只覆盖 logical，rowid 必须原样保留给 BizIndex。
            this.openRows.splice(i, 1);
            this.openBytes -= PageTable.rowJson(oldEntry);
            this.openDirty = true;
            this.bufferOpen();
            this.appendToOpen(key, value);
            return;
          }
          this.openRows[i] = newEntry;
          this.openBytes += delta;
          this.openDirty = true;
          this.markDirty();
          return;
        }
      }
      const rows = this.pageRows(existing);
      const i = rows.findIndex((r) => r.k === key);
      if (i >= 0) {
        // 复制再改，不能原地写：writePage 里的 encode 可能抛 "page overflow"，
        // 而缓存数组是共享的——原地改等于「还没落盘就已经生效」，
        // 一次失败的更新会把超页的值留在缓存里，后续读直接读到它。
        const next = rows.slice();
        next[i] = { k: key, v: value };
        this.writePage(existing, next);
        return;
      }
      // 索引与页不一致（异常恢复路径）：当作新行处理
    }

    // 新行先攒到追加缓冲；单页装满才落盘一次
    this.appendToOpen(key, value);
  }

  /** 开一页新的可追加页 */
  private startOpenPage(): void {
    this.openLogical = this.dir.length;
    this.dir.push(0);
    this.openRows = [];
    this.openBytes = 0;
  }

  private appendToOpen(key: string, value: unknown): void {
    const entry: RowEntry = { k: key, v: value };
    const sz = PageTable.rowJson(entry);
    if (PageTable.frameBytes(sz, 1) > this.cap) {
      // 单行本身就超页：明确报错，绝不静默丢数据
      throw new Error(`page overflow: ${PageTable.frameBytes(sz, 1)}B > ${this.cap}B`);
    }
    if (this.openLogical === null) this.startOpenPage();
    else if (this.frameAfter(sz, 1) > this.cap) {
      this.bufferOpen(); // 满了：先落盘，再开新页
      this.startOpenPage();
    }
    this.openRows.push(entry);
    this.openBytes += sz;
    this.directory.set(key, { logical: this.openLogical! });
    this.openDirty = true;
    this.markDirty();
    if (this.openRows.length >= this.rowsPerPage) {
      this.bufferOpen();
      this.openLogical = null;
      this.openRows = [];
      this.openBytes = 0;
    }
  }

  /** 满页只进脏页队列，真正的磁盘写统一留到提交边界。 */
  private bufferOpen(): void {
    if (this.openLogical === null) return;
    if (!this.openDirty) return; // 没改过就别重复写一页，否则每次心跳都白白涨一次写放大
    this.writePage(this.openLogical, this.openRows);
    this.openDirty = false;
  }

  /** 把追加缓冲和全部脏页落盘；相邻页一次写，单次最多合并 1MB。 */
  flushOpen(): void {
    this.bufferOpen();
    const pending = [...this.dirtyPages.entries()].sort((a, b) => a[1].off - b[1].off);
    let first = 0;
    while (first < pending.length) {
      const start = pending[first]![1].off;
      let end = start + pending[first]![1].data.length;
      let last = first + 1;
      while (last < pending.length) {
        const page = pending[last]![1];
        if (page.off !== end || end + page.data.length - start > MAX_WRITE_BYTES) break;
        end += page.data.length;
        last++;
      }
      const group = pending.slice(first, last);
      const data = group.length === 1 ? group[0]![1].data : Buffer.concat(group.map(([, page]) => page.data), end - start);
      this.io.writeAt(data, start);
      for (const [logical] of group) this.dirtyPages.delete(logical);
      first = last;
    }
  }

  delete(key: string): boolean {
    const logical = this.directory.get(key)?.logical;
    if (logical === undefined) return false;
    if (logical === this.openLogical) {
      const i = this.openRows.findIndex((r) => r.k === key);
      if (i >= 0) {
        this.openBytes -= PageTable.rowJson(this.openRows[i]!);
        this.openRows.splice(i, 1);
        this.openDirty = true;
        this.markDirty();
      }
    } else {
      const rows = this.pageRows(logical).filter((r) => r.k !== key);
      this.writePage(logical, rows);
    }
    this.directory.delete(key);
    return true;
  }

  /** 清空：只重置页目录，旧页成为垃圾（O(页数)，不删数据字节） */
  clear(): void {
    this.dir = [];
    this.directory.clear();
    // 目录归零后 logical 号会从 0 重新分配，旧缓存会被新页「误认」成命中
    this.cache.clear();
    this.dirtyPages.clear();
    this.openLogical = null;
    this.openRows = [];
    this.openBytes = 0;
    this.openDirty = false; // equiv: openLogical 已经是 null，flushOpen 会先返回
    this.persistDir();
  }

  private persistDir(): void {
    (this.meta as Meta & { pageDir?: number[] }).pageDir = this.dir;
    this.markDirty();
  }

  /** 线性遍历所有行（重建索引时用） */
  *entries(): Generator<[string, unknown]> {
    for (const logical of this.dir.keys()) {
      const rows = logical === this.openLogical ? this.openRows : this.pageRows(logical);
      for (const r of rows) yield [r.k, PageTable.detach(r.v)];
    }
  }

  // ---------------- 快照 ----------------
  //
  // 页表里「贵」的不是页内容，是把页解回 key→逻辑页 的那一遍 JSON.parse：
  // 3 万行要读 1038 页、解 3 万个小 JSON，实测 80ms 上下。快照直接把这份映射存下来，
  // 恢复时只走一次 memcpy —— 页内容本身不用读，因为 dir 里的偏移就是它的地址。
  //
  // 快照**不自带有效性判断**：页表不知道数据有没有被改过，那是 store 的 bizEpoch 的事。

  /** 快照用：页目录（返回内部结构，调用方只读） */
  snapshotDir(): readonly number[] {
    return this.dir;
  }

  /** 兼容旧 API：key → 逻辑页号。新代码应使用 snapshotEntries()。 */
  snapshotIndex(): ReadonlyMap<string, number> {
    const out = new Map<string, number>();
    for (const [key, rec] of this.directory.entries()) {
      if (rec.logical !== undefined) out.set(key, rec.logical);
    }
    return out;
  }

  /** 快照用：统一目录条目与数量 */
  snapshotEntries(): ReturnType<KeyDirectory['entries']> {
    return this.directory.entries();
  }

  snapshotSize(): number {
    return this.directory.size;
  }

  /**
   * 从快照恢复内存映射：只改内存，不读盘也不写盘。
   * 页内容仍然在磁盘上，`dir` 里的偏移就是它们的地址。
   *
   * `keys[i]` 与 `logicals[i]` 是**并行数组**而不是 `[key, logical]` 二元组：
   * 3 万个二元组就是 3 万个小对象，光分配和回收就要好几毫秒，
   * 而并行数组可以让快照解码边读边填，全程零中间对象。
   *
   * `keys` 允许有洞（删过的行留下的 rowid），洞直接跳过。
   * `extra` 是「页表有、位图索引没有」的兜底 key，正常为空。
   */
  restoreSnapshot(
    dir: readonly number[],
    keys: readonly (string | undefined)[],
    logicals: readonly number[],
    extra: ReadonlyArray<readonly [string, number]> = [],
    restoreKeys = true
  ): void {
    this.dir = dir.slice();
    if (restoreKeys) {
      this.directory.clear();
      for (let i = 0; i < keys.length; i++) { // equiv: 改成 <= 时 keys[length] 是 undefined，被下面那行 continue 掉
        const k = keys[i];
        if (k === undefined) continue;
        this.directory.set(k, { logical: logicals[i]! });
      }
      for (const [k, logical] of extra) this.directory.set(k, { logical });
    }
    // 快照恢复换掉了整个页目录，缓存里的 logical → 内容对应关系不再成立。
    // 这里必须清：快照的 dir 偏移与内存里缓存的那些页可能毫无关系。
    this.cache.clear();
    this.dirtyPages.clear();
    // 追加缓冲一律清空：快照是「某一时刻已落盘的状态」，未落盘的行不属于它
    this.openLogical = null;
    this.openRows = [];
    this.openBytes = 0;
    this.openDirty = false; // equiv: openLogical 已经置 null，flushOpen 会先返回，脏标记无人读
  }
}

/** 页表的垃圾统计：有多少已分配字节不在当前目录里（供 vacuum 决策） */
export function reclaimableBytes(table: PageTable, stats: PageTableStats, allocatedBytes: number): number {
  return Math.max(0, allocatedBytes - stats.bytes);
}
