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

/**
 * 数值列的块级统计粒度。
 *
 * 为什么是 4096（必须是 2 的幂，下面用 `>>> NUM_SHIFT` 求块号）：
 * 统计开销 = 行数 / 4096 × 16 字节，100 万行只有 4KB，1000 万行 40KB——可以忽略；
 * 而块越小剪枝越准。4096 在「统计很小」和「剪枝够细」之间，且一页 4KB 存 512 个 double，
 * 正好是将来「数值列按块落盘、按块读」的天然单位。
 */
const NUM_BLOCK = 4096;
const NUM_SHIFT = 12;

/**
 * 一块行区间内该列的分布范围。查询时先问「这块有没有可能命中」，
 * 整块不可能就直接跳过——区间查询最常见的失败形态就是「命中 0 行却扫完全表」。
 *
 * 不变式：**只放宽，不收窄**。
 *   - 删除行不收缩 min/max（那块可能因此被多扫，但绝不会漏行）
 *   - 覆盖写不收缩（同上）
 *   - NaN / 非有限值不参与统计（它们本来就被范围条件排除）
 * 违反这条不变式会造成「本该命中的行被剪掉」——静默丢数据，比慢严重得多。
 */
interface NumCol {
  kind: 'num';
  data: Float64Array;
  /** 每块最小值，空块为 +Infinity */
  bmin: Float64Array;
  /** 每块最大值，空块为 -Infinity */
  bmax: Float64Array;
}

/** 一条数值范围条件；min 与 max 互斥地出现（同一字段可以两条都有） */
interface NumCond {
  col: NumCol;
  min?: number;
  max?: number;
}

/**
 * 上一次查询的剪枝情况。
 *
 * 这不是测试专用的后门，是阶段 3（数值列按块落盘）的必需品：到了 10GB，
 * 「这条查询要读几个块」直接决定延迟，客户端和压测都得能看见它。
 *
 * 顺带解决了另一个问题：只断言「结果正确」无法区分「剪枝生效」和「剪枝根本没跑」——
 * 剪枝失效时结果依然是对的，只是慢。变异测试会因此放过一大批假通过。
 */
export interface ScanStats {
  /** 总块数 */
  blocks: number;
  /** 候选块数：块统计认为「可能命中」的块 */
  candidates: number;
  /** 实际遍历过的块数（被 limit 提前退出时小于 candidates） */
  scanned: number;
  /** 走的哪条路 */
  path: 'full' | 'pruned';
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
  /** 上一次 query 的剪枝情况，见 ScanStats */
  lastScan: ScanStats = { blocks: 0, candidates: 0, scanned: 0, path: 'full' };

  constructor(enumFields: string[] = [], numFields: string[] = []) {
    for (const f of enumFields) this.enums[f] = { kind: 'enum', bitmaps: new Map() };
    for (const f of numFields) this.nums[f] = BizIndex._newNumCol(this.capacity);
  }

  private static _newNumCol(capacity: number): NumCol {
    const blocks = Math.max(1, Math.ceil(capacity / NUM_BLOCK));
    return {
      kind: 'num',
      data: new Float64Array(capacity),
      bmin: new Float64Array(blocks).fill(Infinity),
      bmax: new Float64Array(blocks).fill(-Infinity),
    };
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
      const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number.NaN;
      this._numWrite(col, rowid, v);
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
    for (const f of Object.keys(this.nums)) this.nums[f] = BizIndex._newNumCol(this.capacity);
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
      // 没有枚举条件：全集就是存活位图。
      // 这里故意不 clone()——acc 之后只被读取（and 会新建、遍历只读）。
      // 100 万行时省掉一次 125KB memcpy，约 30µs。  // equiv: 只读使用，与 clone 行为一致
      acc = this.alive;
    } else {
      acc = acc.and(this.alive);
    }

    const gteEntries = Object.entries(filter.gte ?? {});
    const lteEntries = Object.entries(filter.lte ?? {});
    const rowids: number[] = [];
    const afterRowid = filter.after !== undefined ? this.rowids.get(filter.after) : undefined;
    const limit = filter.limit ?? Number.MAX_SAFE_INTEGER;

    // 数值条件先解析成 NumCond，顺便守住旧语义：
    // 字段不在 nums 里 → 没有任何行能满足（旧实现是这个行为，改成抛错会破坏调用方）。
    const numConds: NumCond[] = [];
    for (const [field, min] of gteEntries) {
      const col = this.nums[field];
      if (!col) return { rowids: [], keys: [] };
      numConds.push({ col, min });
    }
    for (const [field, max] of lteEntries) {
      const col = this.nums[field];
      if (!col) return { rowids: [], keys: [] };
      numConds.push({ col, max });
    }

    // 逐行判定用的扁平数组：把「无下界/无上界」编成 ±Infinity，
    // 内层就只剩一条比较链（见下面 makeRowFn 的注释）。数组按需建，没有数值条件时不分配。
    const cols: Float64Array[] = [];
    const los: number[] = [];
    const his: number[] = [];
    for (const c of numConds) {
      cols.push(c.col.data);
      los.push(c.min ?? -Infinity);
      his.push(c.max ?? Infinity);
    }

    /**
     * 单行判定；返回 false 表示要停下（limit 到了）。
     *
     * 这里按条件数量特化，是因为「命中率高 → 退回全量遍历」那条路每行的开销会被放大
     * 几十万倍。通用版每行要过一遍 `nConds` 循环、每次三处数组间接寻址
     * （`cols[i]` / `los[i]` / `his[i]`），而对照的全表扫只有一次直接取值 + 一条比较链；
     * 100 万行命中 100% 时实测慢 13%。`{gte, lte}` 落在同一列是压倒性常见的形状
     * （区间查询本来就这么写），把两个条件合并成 [max(lo), min(hi)] 之后内外完全等价。
     */
    type RowFn = (rowid: number) => boolean;
    const makeRowFn = (cols: Float64Array[], los: number[], his: number[]): RowFn => {
      if (cols.length === 0) {
        return (rowid) => {
          if (rowids.length >= limit) return false;
          if (afterRowid !== undefined && rowid <= afterRowid) return true;
          rowids.push(rowid);
          return true;
        };
      }
      if (cols.length === 1 || (cols.length === 2 && cols[0] === cols[1])) {
        // 同列多条件取交集 = 取更紧的那个区间；lo > hi 时比较链恒为 false，正是要的结果。
        //
        // 一个字段在 gte / lte 里各最多出现一次，所以「同列」最多两个条件——
        // 写成循环会被变异出「多跑一轮也看不出差别」的等价体，直接摊平成两条更清楚。
        const d = cols[0]!;
        const lo = cols.length === 1 ? los[0]! : Math.max(los[0]!, los[1]!);
        const hi = cols.length === 1 ? his[0]! : Math.min(his[0]!, his[1]!);
        return (rowid) => {
          if (rowids.length >= limit) return false;
          if (afterRowid !== undefined && rowid <= afterRowid) return true;
          const v = d[rowid]!;
          if (!(v >= lo && v <= hi)) return true;
          rowids.push(rowid);
          return true;
        };
      }
      return (rowid) => {
        if (rowids.length >= limit) return false;
        if (afterRowid !== undefined && rowid <= afterRowid) return true;
        for (let i = 0; i < cols.length; i++) {
          // 一条比较链同时挡掉两种情况：
          //   NaN（任何比较都是 false）、越界的 data[rowid] 是 undefined（同样 false）。
          // 换成 `v < min || v > max` 要写两个分支还得判 NaN。
          const v = cols[i]![rowid]!;
          if (!(v >= los[i]! && v <= his[i]!)) return true;
        }
        rowids.push(rowid);
        return true;
      };
    };
    const onRow = makeRowFn(cols, los, his);

    // 「真的落过行的块」。`capacity` 是按 2 的幂翻倍的，尾上一串块从没写过，
    // 它们的 bmin/bmax 是 ±Infinity，本来就不算候选；拿总容量当分母会把候选比例稀释掉，
    // 于是「所有有数据的块都命中」这种最该退回全量的情形反而被判成「剪得挺好」。
    const filled = Math.max(1, Math.ceil(this.nextRowid / NUM_BLOCK));

    if (numConds.length === 0) {
      this.lastScan = { blocks: filled, candidates: filled, scanned: filled, path: 'full' };
      acc.forEachWhile(onRow);
    } else {
      // 按块剪枝：整块不可能命中就跳过。命中 0 行的区间查询从前要扫完整个位图
      // （100 万行 21.9ms），现在只碰块统计。
      //
      // 但剪枝不是免费的：每进一块都要重算字范围与掩码。命中率接近 100% 时一块都剪不掉，
      // 变成纯开销。所以先数候选块，剪不掉 1/4 以上就退回全量遍历。
      const cutThreshold = filled * 3;
      let cand = 0;
      for (let b = 0; b < filled; b++) { // equiv: 多跑一块 b===filled 是空块，_blockMayMatch 直接返回 false
        if (!this._blockMayMatch(b, numConds)) continue;
        cand++;
        if (cand * 4 >= cutThreshold) break; // equiv: 不 break 只是多数几块，cand 的最终值一样
      }
      if (cand * 4 >= cutThreshold) {
        this.lastScan = { blocks: filled, candidates: cand, scanned: filled, path: 'full' };
        acc.forEachWhile(onRow);
      } else {
        let stop = false;
        let scanned = 0;
        for (let b = 0; b < filled && !stop; b++) { // equiv: 同上，多跑的那一块是空块
          if (!this._blockMayMatch(b, numConds)) continue;
          scanned++;
          const lo = b << NUM_SHIFT;
          acc.forEachWhileRange(lo, lo + NUM_BLOCK, (rowid) => {
            if (onRow(rowid) === false) {
              stop = true;
              return false; // equiv: stop 已置位，外层下一轮退出；返回 true 只多扫本块剩余位
            }
            return true;
          });
        }
        this.lastScan = { blocks: filled, candidates: cand, scanned, path: 'pruned' };
      }
    }

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
    if (col.data.length < need) { // equiv: 多扩一档容量只影响内存，不改变数据
      let n = col.data.length;
      while (n < need) n *= 2;  // equiv: 多翻一倍无副作用
      const next = new Float64Array(n);
      next.set(col.data);
      col.data = next;
    }
    const needBlocks = Math.ceil(need / NUM_BLOCK);
    if (col.bmin.length < needBlocks) { // equiv: 同上
      let n = Math.max(1, col.bmin.length);
      while (n < needBlocks) n *= 2; // equiv: 多翻一倍只影响内存
      const bmin = new Float64Array(n).fill(Infinity);
      bmin.set(col.bmin);
      const bmax = new Float64Array(n).fill(-Infinity);
      bmax.set(col.bmax);
      col.bmin = bmin;
      col.bmax = bmax;
    }
  }

  /** 写一个数值并同步块统计。非有限值（NaN）不参与统计——它们本来就被范围条件排除。 */
  private _numWrite(col: NumCol, rowid: number, v: number): void {
    this._ensureNumCapacity(col, rowid + 1);
    col.data[rowid] = v;
    if (!Number.isFinite(v)) return;
    const b = rowid >>> NUM_SHIFT;
    if (v < col.bmin[b]!) col.bmin[b] = v; // equiv: v 等于当前 bmin 时赋值同值
    if (v > col.bmax[b]!) col.bmax[b] = v; // equiv: 同上
  }

  /**
   * 这块行区间有没有可能命中？返回 false 时可以整块跳过。
   *
   * 统计没覆盖到这块（bmin 越界）时返回 true——宁可多扫一块，也不能因为
   * 统计缺失就把行剪掉。
   */
  private _blockMayMatch(b: number, conds: readonly NumCond[]): boolean {
    for (const c of conds) {
      const lo = c.col.bmin[b];
      const hi = c.col.bmax[b];
      if (lo === undefined || hi === undefined) return true;
      if (lo > hi) return false; // 空块：没有任何有限值
      if (c.min !== undefined && hi < c.min) return false;
      if (c.max !== undefined && lo > c.max) return false;
    }
    return true;
  }

  /** 从数值列重建块统计（快照缺统计时的兜底） */
  private _rebuildNumStats(col: NumCol): void {
    const blocks = Math.max(1, Math.ceil(col.data.length / NUM_BLOCK));
    const bmin = new Float64Array(blocks).fill(Infinity);
    const bmax = new Float64Array(blocks).fill(-Infinity);
    for (let r = 0; r < col.data.length; r++) { // equiv: r === length 时 data[r] 是 undefined，被 Number.isFinite 挡掉
      const v = col.data[r]!;
      if (!Number.isFinite(v)) continue;
      const b = r >>> NUM_SHIFT;
      if (v < bmin[b]!) bmin[b] = v; // equiv: 相等时赋值同值
      if (v > bmax[b]!) bmax[b] = v; // equiv: 同上
    }
    col.bmin = bmin;
    col.bmax = bmax;
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
    for (let r = 0; r < this.keys.length; r++) { // equiv: 越界一位时 alive.get 返回 false
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

  snapshotNums(): Array<{ field: string; data: Float64Array; bmin: Float64Array; bmax: Float64Array }> {
    return Object.entries(this.nums).map(([field, col]) => ({
      field,
      data: col.data,
      bmin: col.bmin,
      bmax: col.bmax,
    }));
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
    nums: Array<{ field: string; data: Float64Array; bmin?: Float64Array; bmax?: Float64Array }>;
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
    for (let r = 0; r < s.keys.length; r++) { // equiv: 越界一位时 s.keys[r] 是 undefined，被 continue 跳过
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
    for (const col of s.nums) {
      const numCol: NumCol = {
        kind: 'num',
        data: col.data,
        bmin: col.bmin ?? new Float64Array(0),
        bmax: col.bmax ?? new Float64Array(0),
      };
      // 统计没跟着来（老调用方 / 手写的快照）就地重建：没有统计只会退化成全扫，
      // 不会算错，但慢得莫名其妙，所以补上。
      if (numCol.bmin.length === 0) this._rebuildNumStats(numCol);
      this.nums[col.field] = numCol;
    }
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
