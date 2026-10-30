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
  private io: PageIo;
  private meta: Meta;
  private alloc: (bytes: number) => number;
  private markDirty: () => void;
  readonly pageSize: number;
  readonly rowsPerPage: number;

  private dir: number[] = []; // logical -> physical offset（0 表示非法）
  private index = new Map<string, number>(); // key -> logical
  private pageKeys: string[][] = []; // logical -> keys（内存镜像，避免每次读页）
  rewrites = 0;

  // 追加缓冲：新行先攒在这里，提交时整页写一次。
  // 否则「每插一行就重写整页」，30k 行会退化成 30k 次 4KB 写。
  private openLogical: number | null = null;
  private openRows: RowEntry[] = [];
  private openDirty = false;
  private openBytes = 0;

  constructor(io: PageIo, meta: Meta, alloc: (bytes: number) => number, markDirty: () => void, opts: PageTableOpts = {}) {
    this.io = io;
    this.meta = meta;
    this.alloc = alloc;
    this.markDirty = markDirty;
    this.pageSize = opts.pageSize ?? 4096;
    this.rowsPerPage = opts.rowsPerPage ?? 48;
  }

  // ---------------- 编解码 ----------------

  private encode(rows: RowEntry[]): Buffer {
    const json = Buffer.from(JSON.stringify({ r: rows }), 'utf8');
    if (json.length + 4 > this.pageSize) {
      throw new Error(`page overflow: ${json.length}B > ${this.pageSize - 4}B`);
    }
    const buf = Buffer.alloc(this.pageSize); // 整页写，剩余补 0（可预测、可校验）
    buf.writeUInt16LE(json.length, 0);
    json.copy(buf, 2);
    return buf;
  }

  private decode(buf: Buffer): RowEntry[] {
    const len = buf.readUInt16LE(0);
    if (len === 0) return [];
    if (len + 2 > buf.length) throw new Error(`corrupt page: len=${len} > ${buf.length - 2}`);
    const json = buf.subarray(2, 2 + len).toString('utf8');
    const parsed = JSON.parse(json) as { r?: RowEntry[] };
    return parsed.r ?? [];
  }

  // ---------------- 生命周期 ----------------

  /** 从 meta 恢复页目录；dir 为空表示新库 */
  load(): void {
    const saved = (this.meta as Meta & { pageDir?: number[] }).pageDir ?? [];
    this.dir = saved.slice();
    this.pageKeys = this.dir.map(() => []);
    this.index.clear();
    for (let logical = 0; logical < this.dir.length; logical++) {
      const off = this.dir[logical];
      if (!off) continue;
      const rows = this.decode(this.io.readAt(off, this.pageSize));
      for (const r of rows) {
        this.index.set(r.k, logical);
        this.pageKeys[logical]!.push(r.k);
      }
    }
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
    if (logical >= this.dir.length) this.dir[logical] = off;
    else this.dir[logical] = off;
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
          const delta = PageTable.rowBytes(newEntry) - PageTable.rowBytes(oldEntry);
          if (this.openBytes + delta + 4 > this.pageSize) {
            // 变大后装不下：把这一行搬出去
            this.openRows.splice(i, 1);
            this.openBytes -= PageTable.rowBytes(oldEntry);
            const ks = this.pageKeys[this.openLogical]!;
            const ki = ks.indexOf(key);
            if (ki >= 0) ks.splice(ki, 1);
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

  private static rowBytes(r: RowEntry): number {
    return Buffer.byteLength(JSON.stringify(r)) + 2; // +2 是 JSON 里的逗号余量
  }

  /** 开一页新的可追加页 */
  private startOpenPage(): void {
    this.openLogical = this.dir.length;
    this.dir.push(0);
    this.pageKeys.push([]);
    this.openRows = [];
    this.openBytes = 0;
  }

  private appendToOpen(key: string, value: unknown): void {
    const entry: RowEntry = { k: key, v: value };
    const sz = PageTable.rowBytes(entry);
    if (sz + 4 > this.pageSize) {
      // 单行本身就超页：明确报错，绝不静默丢数据
      throw new Error(`page overflow: ${sz}B > ${this.pageSize - 4}B`);
    }
    if (this.openLogical === null) this.startOpenPage();
    else if (this.openBytes + sz + 4 > this.pageSize) {
      this.flushOpen(); // 满了：先落盘，再开新页
      this.startOpenPage();
    }
    this.openRows.push(entry);
    this.openBytes += sz;
    this.index.set(key, this.openLogical!);
    this.pageKeys[this.openLogical!]!.push(key);
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
    if (!this.openDirty) return;
    if (this.openLogical === null) return;
    this.writePage(this.openLogical, this.openRows);
    this.openDirty = false;
  }

  delete(key: string): boolean {
    const logical = this.index.get(key);
    if (logical === undefined) return false;
    if (logical === this.openLogical) {
      const removed = this.openRows.filter((r) => r.k === key);
      for (const r of removed) this.openBytes -= PageTable.rowBytes(r);
      this.openRows = this.openRows.filter((r) => r.k !== key);
      this.openDirty = true;
      this.markDirty();
    } else {
      const rows = this.readPage(logical).filter((r) => r.k !== key);
      this.writePage(logical, rows);
    }
    this.index.delete(key);
    const ks = this.pageKeys[logical]!;
    const i = ks.indexOf(key);
    if (i >= 0) ks.splice(i, 1);
    return true;
  }

  /** 清空：只重置页目录，旧页成为垃圾（O(页数)，不删数据字节） */
  clear(): void {
    this.dir = [];
    this.pageKeys = [];
    this.index.clear();
    this.openLogical = null;
    this.openRows = [];
    this.openDirty = false;
    this.openBytes = 0;
    this.persistDir();
  }

  private persistDir(): void {
    (this.meta as Meta & { pageDir?: number[] }).pageDir = this.dir;
    this.markDirty();
  }

  /** 线性遍历所有行（重建索引时用） */
  *entries(): Generator<[string, unknown]> {
    for (let logical = 0; logical < this.dir.length; logical++) {
      const rows = logical === this.openLogical ? this.openRows : this.readPage(logical);
      for (const r of rows) yield [r.k, r.v];
    }
  }
}

/** 页表的垃圾统计：有多少已分配字节不在当前目录里（供 vacuum 决策） */
export function reclaimableBytes(table: PageTable, stats: PageTableStats, allocatedBytes: number): number {
  return Math.max(0, allocatedBytes - stats.bytes);
}
