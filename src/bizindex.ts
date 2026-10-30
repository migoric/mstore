/**
 * 业务数据的查询层：位图 + 数值列 + rowid 游标。
 *
 * 分工（对应设计总纲 §4.4）：
 *   - 枚举/低基数（部门、状态、级别）→ 位图，交集是纯位运算
 *   - 数值范围（评分、时间）→ 一列 Float64Array，顺序扫（比位图更适合高基数）
 *   - 分页 → rowid 天然有序，位图遍历就是 keyset，没有 OFFSET 退化
 *
 * 这里刻意不做「预计算维度组合位图」：运行时位与已经 3µs 级，
 * 预计算会随维度数指数爆炸，还失去「加筛选器不改磁盘格式」的自由。
 */
import { Bitmap } from './bitmap.ts';

export type EnumColumns = Record<string, readonly string[]>;
export type NumColumns = Record<string, readonly string[]>;

export interface Filter {
  /** 枚举等值：{ dept: ['R&D'], status: 'active' } */
  eq?: Record<string, string | string[]>;
  /** 数值下界：{ level: 5 } */
  gte?: Record<string, number>;
  /** 数值上界 */
  lte?: Record<string, number>;
  /** 分页：从某个 key 之后开始 */
  after?: string;
  limit?: number;
}

export interface BizIndexStats {
  rows: number;
  /** 枚举字段 → 该字段有多少个不同取值（位图数） */
  enums: Record<string, number>;
  /** 数值字段名 */
  nums: string[];
  bitmaps: number;
  /**
   * 枚举字段 → 出现过的值（升序）。
   * 存在的理由很具体：UI 的查询构建器要列出「可选的值」，而位图只有 value→bitmap
   * 的映射、没有顺序保证，让每个客户端自己遍历一遍是重复劳动。
   */
  enumValues: Record<string, string[]>;
}

interface EnumCol {
  kind: 'enum';
  bitmaps: Map<string, Bitmap>;
}

interface NumCol {
  kind: 'num';
  data: Float64Array;
}

export class BizIndex {
  private rowids = new Map<string, number>();
  private keys: string[] = []; // rowid -> key
  private nextRowid = 0;
  private enums: Record<string, EnumCol> = {};
  private nums: Record<string, NumCol> = {};
  private capacity = 1024;
  private liveCount = 0;
  /** 存活行位图：增量维护，避免每次查询重建（重建 3 万位约 30µs，是 p50 的主要来源） */
  private alive = new Bitmap(1024);

  constructor(enumFields: string[] = [], numFields: string[] = []) {
    for (const f of enumFields) this.enums[f] = { kind: 'enum', bitmaps: new Map() };
    for (const f of numFields) this.nums[f] = { kind: 'num', data: new Float64Array(this.capacity) };
  }

  get size(): number {
    return this.liveCount;
  }

  rowidOf(key: string): number | undefined {
    return this.rowids.get(key);
  }

  keyOf(rowid: number): string | undefined {
    return this.alive.get(rowid) ? this.keys[rowid] : undefined;
  }

  /** 装载/覆盖一行；已存在则原位更新（先清旧位，再置新位） */
  put(key: string, value: unknown, existingRowid?: number): number {
    const rowid = existingRowid ?? this.rowids.get(key) ?? this._allocRow(key);
    const rec = (value ?? {}) as Record<string, unknown>;
    this._clearBits(rowid);
    for (const [field, col] of Object.entries(this.enums)) {
      const raw = rec[field];
      if (raw === undefined || raw === null) continue;
      const v = String(raw);
      let bm = col.bitmaps.get(v);
      if (!bm) {
        bm = new Bitmap(this.capacity);
        col.bitmaps.set(v, bm);
      }
      bm.set(rowid);
    }
    for (const [field, col] of Object.entries(this.nums)) {
      const raw = rec[field];
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        this._ensureNumCapacity(col, rowid + 1);
        col.data[rowid] = raw;
      } else {
        this._ensureNumCapacity(col, rowid + 1);
        col.data[rowid] = Number.NaN;
      }
    }
    return rowid;
  }

  delete(key: string): void {
    const rowid = this.rowids.get(key);
    if (rowid === undefined) return;
    this._clearBits(rowid);
    this.alive.clear(rowid);
    this.rowids.delete(key);
    this.liveCount--;
  }

  clear(): void {
    this.rowids.clear();
    this.keys = [];
    this.nextRowid = 0;
    this.liveCount = 0;
    this.alive = new Bitmap(1024);
    for (const col of Object.values(this.enums)) col.bitmaps.clear();
    for (const col of Object.values(this.nums)) col.data = new Float64Array(this.capacity);
  }

  /**
   * 执行筛选：所有 eq 取交集，gte/lte 用数值列判，最后按 limit 截断。
   * 返回的 rowid 天然升序。
   */
  query(filter: Filter = {}): { rowids: number[]; keys: string[] } {
    let acc: Bitmap | null = null;

    for (const [field, want] of Object.entries(filter.eq ?? {})) {
      const col = this.enums[field];
      if (!col) throw new Error(`not an enum field: ${field}`);
      const values = Array.isArray(want) ? want : [want];
      let union: Bitmap | null = null;
      for (const v of values) {
        const bm = col.bitmaps.get(String(v));
        if (!bm) continue;
        union = union ? union.or(bm) : bm.clone();
      }
      if (!union) return { rowids: [], keys: [] }; // 该字段没有匹配值
      acc = acc ? acc.and(union) : union;
    }

    if (!acc) {
      // 没有枚举条件：全集就是存活位图
      acc = this.alive.clone();
    } else {
      acc = acc.and(this.alive);
    }

    const gteEntries = Object.entries(filter.gte ?? {});
    const lteEntries = Object.entries(filter.lte ?? {});
    const rowids: number[] = [];
    const afterRowid = filter.after !== undefined ? this.rowids.get(filter.after) : undefined;
    const limit = filter.limit ?? Number.MAX_SAFE_INTEGER;

    acc.forEachWhile((rowid) => {
      if (rowids.length >= limit) return false; // 提前退出，别扫完整张位图
      if (afterRowid !== undefined && rowid <= afterRowid) return true;
      for (const [field, min] of gteEntries) {
        const v = this.nums[field]?.data[rowid];
        if (v === undefined || Number.isNaN(v) || v < min) return true;
      }
      for (const [field, max] of lteEntries) {
        const v = this.nums[field]?.data[rowid];
        if (v === undefined || Number.isNaN(v) || v > max) return true;
      }
      rowids.push(rowid);
      return true;
    });

    return { rowids, keys: rowids.map((r) => this.keys[r]!) };
  }

  stats(): BizIndexStats {
    const enums: Record<string, number> = {};
    const enumValues: Record<string, string[]> = {};
    let bitmaps = 0;
    for (const [f, col] of Object.entries(this.enums)) {
      enums[f] = col.bitmaps.size;
      bitmaps += col.bitmaps.size;
      enumValues[f] = [...col.bitmaps.keys()].sort();
    }
    return { rows: this.size, enums, nums: Object.keys(this.nums), bitmaps, enumValues };
  }

  // ---------------- 内部 ----------------

  private _allocRow(key: string): number {
    const rowid = this.nextRowid++;
    this.keys[rowid] = key;
    this.alive.set(rowid);
    this.rowids.set(key, rowid);
    this.liveCount++;
    if (rowid + 1 > this.capacity) {  // equiv: 容量只影响位图分配，多长一档无副作用
      this.capacity = Math.max(this.capacity * 2, rowid + 1);
      // 位图自己是稀疏的（越界写会 _ensure 扩容），这里不需要主动迁移
    }
    return rowid;
  }

  private _ensureNumCapacity(col: NumCol, need: number): void {
    if (col.data.length >= need) return;
    let n = col.data.length;
    while (n < need) n *= 2;  // equiv: 多翻一倍无副作用
    const next = new Float64Array(n);
    next.set(col.data);
    col.data = next;
  }

  private _clearBits(rowid: number): void {
    for (const col of Object.values(this.enums)) {
      for (const bm of col.bitmaps.values()) bm.clear(rowid);
    }
  }

  // ---------------- 快照 ----------------
  //
  // 索引全在内存里，重建一次 3 万行要 90ms 上下（位图逐个 set + 数值列逐个写）。
  // 快照把「已经建好的结构」按原样存下来：位图是 Uint32Array、数值列是 Float64Array，
  // 都是可以直接按字节存取的连续内存，不需要任何二次编码。
  //
  // 返回的都是内部引用（不复制）：快照编码是只读遍历，复制一遍 3 万个 key 反而更慢。

  /** 快照用：rowid → key（只吐存活的） */
  *snapshotRows(): Generator<readonly [number, string]> {
    for (let r = 0; r < this.keys.length; r++) {
      if (!this.alive.get(r)) continue;
      yield [r, this.keys[r]!];
    }
  }

  snapshotEnums(): Array<{ field: string; values: Array<{ value: string; bitmap: Bitmap }> }> {
    return Object.entries(this.enums).map(([field, col]) => ({
      field,
      values: [...col.bitmaps].map(([value, bitmap]) => ({ value, bitmap })),
    }));
  }

  snapshotNums(): Array<{ field: string; data: Float64Array }> {
    return Object.entries(this.nums).map(([field, col]) => ({ field, data: col.data }));
  }

  snapshotAlive(): Bitmap {
    return this.alive;
  }

  snapshotState(): { nextRowid: number; liveCount: number; capacity: number } {
    return { nextRowid: this.nextRowid, liveCount: this.liveCount, capacity: this.capacity };
  }

  /**
   * 从快照整体替换当前索引。先清空再装，保证「快照里没有的」不会残留在内存里。
   *
   * `keys` 按 rowid 索引（稀疏，洞 = 删掉的行），装入时不依赖 put 的分配逻辑：
   * rowid 由快照给定，`nextRowid` 也由快照给定，所以之后新增的行不会跟老行撞号。
   */
  restoreSnapshot(s: {
    keys: readonly (string | undefined)[];
    enums: Array<{ field: string; values: Array<{ value: string; bitmap: Bitmap }> }>;
    nums: Array<{ field: string; data: Float64Array }>;
    alive: Bitmap;
    state: { nextRowid: number; liveCount: number; capacity: number };
  }): void {
    this.rowids.clear();
    this.keys = [];
    this.enums = {};
    this.nums = {};
    this.alive = s.alive;
    this.capacity = s.state.capacity;
    this.nextRowid = s.state.nextRowid;
    this.liveCount = s.state.liveCount;
    for (let r = 0; r < s.keys.length; r++) {
      const k = s.keys[r];
      if (k === undefined) continue;
      this.keys[r] = k;
      this.rowids.set(k, r);
    }
    for (const col of s.enums) {
      const bitmaps = new Map<string, Bitmap>();
      for (const v of col.values) bitmaps.set(v.value, v.bitmap);
      this.enums[col.field] = { kind: 'enum', bitmaps };
    }
    for (const col of s.nums) this.nums[col.field] = { kind: 'num', data: col.data };
  }
}

/** 全表扫描（测试用基准实现）：结果必须与 query 完全一致 */
export function bruteForce(
  rows: Array<{ key: string; value: Record<string, unknown> }>,
  filter: Filter
): string[] {
  const out: string[] = [];
  const enums = Object.entries(filter.eq ?? {});
  const gte = Object.entries(filter.gte ?? {});
  const lte = Object.entries(filter.lte ?? {});
  for (const row of rows) {
    let ok = true;
    for (const [field, want] of enums) {
      const values = Array.isArray(want) ? want : [want];
      if (!values.map(String).includes(String(row.value[field]))) {
        ok = false;
        break;
      }
    }
    if (ok) {
      for (const [field, min] of gte) {
        const v = row.value[field];
        if (typeof v !== 'number' || v < min) {
          ok = false;
          break;
        }
      }
    }
    if (ok) {
      for (const [field, max] of lte) {
        const v = row.value[field];
        if (typeof v !== 'number' || v > max) {
          ok = false;
          break;
        }
      }
    }
    if (ok) out.push(row.key);
  }
  return out;
}
