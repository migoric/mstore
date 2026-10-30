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

export interface PageTableOpts {
  /** 页大小，默认 4096 */
  pageSize?: number;
  /** 一页最多放多少行（超过就开新页），默认 48 */
  rowsPerPage?: number;
}

interface RowEntry {
  k: string;
  v: unknown;
}

export interface PageTableStats {
  pages: number;
  rows: number;
  bytes: number;
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
  private index = new Map<string, number>(); // key -> logical
  rewrites = 0;

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

  /** 从 meta 恢复页目录；dir 为空表示新库 */
  load(): void {
    const saved = (this.meta as Meta & { pageDir?: number[] }).pageDir ?? [];
    this.dir = saved.slice();
    this.index.clear();
    this.dir.forEach((off, logical) => {
      if (!off) return; // 占位 0：还没落盘的页
      for (const r of this.decode(this.io.readAt(off, this.pageSize))) this.index.set(r.k, logical);
    });
  }

  stats(): PageTableStats {
    let bytes = 0;
    for (const off of this.dir) if (off) bytes += this.pageSize;
    return {
      pages: this.dir.filter((o) => o > 0).length,
      rows: this.index.size,
      bytes,
      pageSize: this.pageSize,
      rowsPerPage: this.rowsPerPage,
      rewrites: this.rewrites,
    };
  }

  // ---------------- 读 ----------------

  has(key: string): boolean {
    return this.index.has(key);
  }

  get(key: string): unknown {
    const logical = this.index.get(key);
    if (logical === undefined) return undefined;
    const rows = logical === this.openLogical ? this.openRows : this.readPage(logical);
    const hit = rows.find((r) => r.k === key);
    return hit ? hit.v : undefined;
  }

  keys(): string[] {
    return [...this.index.keys()];
  }

  size(): number {
    return this.index.size;
  }

  private readPage(logical: number): RowEntry[] {
    const off = this.dir[logical];
    if (!off) return [];
    return this.decode(this.io.readAt(off, this.pageSize));
  }

  // ---------------- 写（全部 CoW） ----------------

  /** 整页重写到新偏移；旧页留在原地成为垃圾（由 vacuum 回收） */
  private writePage(logical: number, rows: RowEntry[]): void {
    const off = this.alloc(this.pageSize);
    this.io.writeAt(this.encode(rows), off);
    this.dir[logical] = off; // 新页（logical === dir.length）与重写走同一条路
    this.rewrites++;
    this.persistDir();
  }

  put(key: string, value: unknown): void {
    const existing = this.index.get(key);
    if (existing !== undefined) {
      if (existing === this.openLogical) {
        const i = this.openRows.findIndex((r) => r.k === key);
        if (i >= 0) {
          const oldEntry = this.openRows[i]!;
          const newEntry: RowEntry = { k: key, v: value };
          const delta = PageTable.rowJson(newEntry) - PageTable.rowJson(oldEntry);
          if (this.frameAfter(delta, 0) > this.cap) {
            // 变大后装不下：把这一行搬出去
            this.openRows.splice(i, 1);
            this.openBytes -= PageTable.rowJson(oldEntry);
            this.index.delete(key);
            this.openDirty = true;
            this.flushOpen();
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
      const rows = this.readPage(existing);
      const i = rows.findIndex((r) => r.k === key);
      if (i >= 0) {
        rows[i] = { k: key, v: value };
        this.writePage(existing, rows);
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
      this.flushOpen(); // 满了：先落盘，再开新页
      this.startOpenPage();
    }
    this.openRows.push(entry);
    this.openBytes += sz;
    this.index.set(key, this.openLogical!);
    this.openDirty = true;
    this.markDirty();
    if (this.openRows.length >= this.rowsPerPage) {
      this.flushOpen();
      this.openLogical = null;
      this.openRows = [];
      this.openBytes = 0;
    }
  }

  /** 把追加缓冲写成一页（提交前必须调用，保证页目录与磁盘一致） */
  flushOpen(): void {
    if (this.openLogical === null) return;
    if (!this.openDirty) return; // 没改过就别重复写一页，否则每次心跳都白白涨一次写放大
    this.writePage(this.openLogical, this.openRows);
    this.openDirty = false;
  }

  delete(key: string): boolean {
    const logical = this.index.get(key);
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
      const rows = this.readPage(logical).filter((r) => r.k !== key);
      this.writePage(logical, rows);
    }
    this.index.delete(key);
    return true;
  }

  /** 清空：只重置页目录，旧页成为垃圾（O(页数)，不删数据字节） */
  clear(): void {
    this.dir = [];
    this.index.clear();
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
      const rows = logical === this.openLogical ? this.openRows : this.readPage(logical);
      for (const r of rows) yield [r.k, r.v];
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

  /** 快照用：key → 逻辑页号（返回内部结构，调用方只读） */
  snapshotIndex(): ReadonlyMap<string, number> {
    return this.index;
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
    extra: ReadonlyArray<readonly [string, number]> = []
  ): void {
    this.dir = dir.slice();
    this.index.clear();
    for (let i = 0; i < keys.length; i++) { // equiv: 改成 <= 时 keys[length] 是 undefined，被下面那行 continue 掉
      const k = keys[i];
      if (k === undefined) continue;
      this.index.set(k, logicals[i]!);
    }
    for (const [k, logical] of extra) this.index.set(k, logical);
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
