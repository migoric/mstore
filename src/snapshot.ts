/**
 * 索引快照的编解码。
 *
 * 为什么是二进制而不是 JSON：3 万行索引序列化成 JSON 约 3.5MB，解析要 30–40ms，
 * 省下来的时间又还回去了。二进制版本是一份可以直接 memcpy 的内存镜像。
 *
 * ## 一个 key 只存一次
 *
 * 页表要 `key → 逻辑页`，位图索引要 `rowid ↔ key`。朴素做法是两个结构各存一份 key，
 * 解码时字符串解码 6 万次、Map 插入 6 万次。实测 `Map.set` 3 万次就是 9ms（V8 已经
 * 对字符串键做了内部化，手写开放寻址表并不更快，试过），这块成本是硬的。
 *
 * 所以格式里 key 只出现一次：`ROWS` 块的一行同时给出 `rowid`（位图索引侧）和
 * `logical`（页表侧），恢复时**同一个字符串对象**同时插进两个 Map。
 * 省掉的是 3 万次字符串解码和一半的字节。
 *
 * 前提是「页表有、索引没有」的 key 极少（正常为 0）。真有的话落进 `LOOSE` 块，
 * 语义不变，不会因为这条捷径丢失数据。
 *
 * ## 布局（全部小端）
 *
 *   [0,4)    magic 'MSNP'
 *   [4,6)    ver u16
 *   [6,8)    flags u16（保留）
 *   [8,12)   blockCount u32
 *   blocks   [tag u8][pad u8][pad u16][len u32][payload …]
 *
 * 用「带 tag 的块」而不是固定顺序的字段：以后加块（比如 KV 索引快照）不用升版本。
 *
 * 所有长度都做边界校验：快照坏了必须**明确报错**，让 store 回退去重放，
 * 绝不能半信半疑地恢复一个残缺索引（那比慢糟得多）。
 */
import { Bitmap } from './bitmap.ts';
import type { BizIndex } from './bizindex.ts';
import type { PageTable } from './pagetable.ts';

export const SNAP_MAGIC = Buffer.from('MSNP', 'latin1');
/**
 * 3 = 页目录偏移升级为 u64，枚举列携带行字典；TypedArray 全部按块拷贝。
 * 版本不符就整份拒绝、回退重放，旧库只是慢一次，绝不会拿错位数据恢复索引。
 */
export const SNAP_VER = 3;

const TAG = {
  DIR: 1,
  ROWS: 2,
  LOOSE: 3,
  ENUM: 4,
  NUM: 5,
  ALIVE: 6,
  STATE: 7,
} as const;

const BLOCK_HEAD = 8;
const FILE_HEAD = 12;

/** 可增长的写入器：一次 alloc、不够翻倍，最后切出精确长度 */
class Writer {
  private buf: Buffer;
  private pos = 0;

  constructor(hint: number) {
    this.buf = Buffer.allocUnsafe(Math.max(1024, hint));
  }

  private need(n: number): void {
    if (this.pos + n <= this.buf.length) return; // equiv: 改成 < 只会让「正好填满」时多翻一倍容量，写出去的字节一样
    let cap = this.buf.length;
    while (cap < this.pos + n) cap *= 2; // equiv: 同上，<= 只是多翻一次
    const next = Buffer.allocUnsafe(cap);
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }

  u8(v: number): void {
    this.need(1);
    this.buf.writeUInt8(v & 0xff, this.pos);
    this.pos += 1;
  }

  u16(v: number): void {
    this.need(2);
    this.buf.writeUInt16LE(v & 0xffff, this.pos);
    this.pos += 2;
  }

  u32(v: number): void {
    this.need(4);
    this.buf.writeUInt32LE(v >>> 0, this.pos);
    this.pos += 4;
  }

  u64(v: number): void {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`snapshot u64 offset out of range: ${v}`);
    this.need(8);
    this.buf.writeBigUInt64LE(BigInt(v), this.pos);
    this.pos += 8;
  }

  f64Array(a: Float64Array): void {
    const bytes = a.length * 8;
    this.need(bytes);
    Buffer.from(a.buffer, a.byteOffset, bytes).copy(this.buf, this.pos);
    this.pos += bytes;
  }

  u32Array(a: Uint32Array): void {
    const bytes = a.length * 4;
    this.need(bytes);
    Buffer.from(a.buffer, a.byteOffset, bytes).copy(this.buf, this.pos);
    this.pos += bytes;
  }

  str(s: string): void {
    const bytes = Buffer.byteLength(s, 'utf8');
    this.u32(bytes);
    this.need(bytes);
    this.buf.write(s, this.pos, bytes, 'utf8');
    this.pos += bytes;
  }

  /** 开一个块：返回「回填 payload 长度」用的位置 */
  beginBlock(tag: number): number {
    this.need(BLOCK_HEAD);
    this.buf.writeUInt8(tag, this.pos);
    this.buf.writeUInt8(0, this.pos + 1);
    this.buf.writeUInt16LE(0, this.pos + 2);
    this.pos += BLOCK_HEAD;
    return this.pos - 4;
  }

  endBlock(lenAt: number): void {
    this.buf.writeUInt32LE(this.pos - (lenAt + 4), lenAt);
  }

  /** 回填一个先前写下占位值的 u32（条数这类「先写后知」的字段用） */
  patchU32(at: number, v: number): void {
    this.buf.writeUInt32LE(v >>> 0, at);
  }

  get position(): number {
    return this.pos;
  }

  finish(blockCount: number): Buffer {
    const out = Buffer.allocUnsafe(this.pos + FILE_HEAD);
    SNAP_MAGIC.copy(out, 0);
    out.writeUInt16LE(SNAP_VER, 4);
    out.writeUInt16LE(0, 6);
    out.writeUInt32LE(blockCount, 8);
    this.buf.copy(out, FILE_HEAD, 0, this.pos);
    return out;
  }
}

/** 带边界检查的读取器：任何越界都抛错（由调用方回退到重放） */
class Reader {
  private buf: Buffer;
  private pos: number;

  constructor(buf: Buffer, at = 0) {
    this.buf = buf;
    this.pos = at;
  }

  get offset(): number {
    return this.pos;
  }

  private demand(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new Error(`truncated snapshot: need ${n}B at ${this.pos}, have ${this.buf.length - this.pos}B`);
    }
  }

  u8(): number {
    this.demand(1);
    return this.buf.readUInt8(this.pos++);
  }

  u16(): number {
    this.demand(2);
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.demand(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  u64(): number {
    this.demand(8);
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`snapshot u64 offset out of range: ${v}`);
    return Number(v);
  }

  u32Array(n: number): Uint32Array {
    const bytes = n * 4;
    this.demand(bytes);
    const out = new Uint32Array(n);
    this.buf.copy(Buffer.from(out.buffer), 0, this.pos, this.pos + bytes);
    this.pos += bytes;
    return out;
  }

  f64Array(n: number): Float64Array {
    const bytes = n * 8;
    this.demand(bytes);
    const out = new Float64Array(n);
    this.buf.copy(Buffer.from(out.buffer), 0, this.pos, this.pos + bytes);
    this.pos += bytes;
    return out;
  }

  str(): string {
    const len = this.u32();
    this.demand(len);
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
}

export interface SnapInfo {
  ver: number;
  blocks: number;
  pages: number;
  rows: number;
  loose: number;
  bitmaps: number;
  bytes: number;
}

/** 把页表映射 + 位图索引整体编码成一段二进制 */
export function encodeSnapshot(pages: PageTable, biz: BizIndex): Buffer {
  const dir = pages.snapshotDir();
  const entries = pages.snapshotEntries();
  const state = biz.snapshotState();
  // 粗估每条 32B（rowid + logical + 平均 12B 的 key + 长度头），key 只存一次
  const w = new Writer(pages.snapshotSize() * 32 + 64 * 1024);

  let at = w.beginBlock(TAG.DIR);
  w.u32(dir.length);
  for (const off of dir) w.u64(off);
  w.endBlock(at);

  // ROWS + LOOSE：一趟遍历页表索引。走页表而不是走位图索引，是因为页表的 key 集合才是全集。
  at = w.beginBlock(TAG.ROWS);
  const countAt = w.position;
  w.u32(0);
  const loose: Array<readonly [string, number]> = [];
  let rows = 0;
  for (const [key, rec] of entries) {
    if (rec.logical === undefined) throw new Error(`snapshot entry missing logical page: ${key}`);
    if (rec.rowid === undefined) {
      // 页表可以独立于 BizIndex 使用；这类 key 没有 rowid，不能靠 `!`
      // 把 undefined 静默编码成 0，否则恢复后会与真正的首行撞号。
      loose.push([key, rec.logical]);
      continue;
    }
    w.u32(rec.rowid);
    w.u32(rec.logical);
    w.str(key);
    rows++;
  }
  w.patchU32(countAt, rows);
  w.endBlock(at);

  at = w.beginBlock(TAG.LOOSE);
  w.u32(loose.length);
  for (const [key, logical] of loose) {
    w.u32(logical);
    w.str(key);
  }
  w.endBlock(at);

  at = w.beginBlock(TAG.ENUM);
  const enums = biz.snapshotEnums();
  w.u32(enums.length);
  for (const col of enums) {
    w.str(col.field);
    w.u32(col.values.length);
    for (const v of col.values) {
      w.str(v.value);
      w.u32(v.bitmap.capacity);
      w.u32(v.bitmap.words.length);
      w.u32Array(v.bitmap.words);
    }
    w.u32(col.rows.length);
    w.u32Array(col.rows);
  }
  w.endBlock(at);

  at = w.beginBlock(TAG.NUM);
  const nums = biz.snapshotNums();
  w.u32(nums.length);
  for (const col of nums) {
    w.str(col.field);
    w.u32(col.data.length);
    w.f64Array(col.data);
    // 块统计跟数值列一起存：不存的话恢复后要 O(n) 重建一遍，
    // 而且「快照打开」与「重放打开」的查询性能会不一致——那是最难查的一类问题。
    w.u32(col.bmin.length);
    w.f64Array(col.bmin);
    w.f64Array(col.bmax);
  }
  w.endBlock(at);

  at = w.beginBlock(TAG.ALIVE);
  const alive = biz.snapshotAlive();
  w.u32(alive.capacity);
  w.u32(alive.words.length);
  w.u32Array(alive.words);
  w.endBlock(at);

  at = w.beginBlock(TAG.STATE);
  w.u32(state.nextRowid);
  w.u32(state.liveCount);
  w.u32(state.capacity);
  w.endBlock(at);

  return w.finish(7);
}

/**
 * 从快照恢复页表与索引。只改内存，不碰磁盘。
 *
 * 两趟：先扫一遍块头（这一步能挡住截断与长度错乱，成本可忽略），再逐块落地。
 * 落地阶段如果还是抛了（块内长度字段被改坏），调用方必须回退到逐页重放——
 * 所以恢复**不能**留下「一半新一半旧」的可用状态当结果用。
 */
export function decodeSnapshot(buf: Buffer, pages: PageTable, biz: BizIndex, restoreKeys = true): SnapInfo {
  if (buf.length < FILE_HEAD) throw new Error(`snapshot too short: ${buf.length}B`); // equiv: 长度正好 12 时走「missing DIR」那条拒绝路径，两条路都是拒绝
  if (!buf.subarray(0, 4).equals(SNAP_MAGIC)) throw new Error('bad snapshot magic');
  const ver = buf.readUInt16LE(4);
  if (ver !== SNAP_VER) throw new Error(`unsupported snapshot ver ${ver} (this build reads ${SNAP_VER})`);
  const blockCount = buf.readUInt32LE(8);

  // 第一趟：只走块头。每个块必须完整落在文件内，且刚好铺满整个 payload。
  const blocks: Array<{ tag: number; start: number; len: number }> = [];
  let pos = FILE_HEAD;
  for (let i = 0; i < blockCount; i++) {
    if (pos + BLOCK_HEAD > buf.length) throw new Error(`snapshot: block ${i} header out of range`); // equiv: 改成 >= 时，len 字段的 demand 一样会抛
    const tag = buf.readUInt8(pos);
    const len = buf.readUInt32LE(pos + 4);
    pos += BLOCK_HEAD;
    if (pos + len > buf.length) throw new Error(`snapshot: block ${i} (tag ${tag}) overruns file`);
    blocks.push({ tag, start: pos, len });
    pos += len;
  }
  if (pos !== buf.length) throw new Error(`snapshot: ${buf.length - pos}B trailing garbage`);

  // 第二趟：落地
  let dir: number[] | null = null;
  let rowKeys: string[] = [];
  let rowLogicals: number[] = [];
  const loose: Array<[string, number]> = [];
  let enumCols: Array<{ field: string; rows: Uint32Array; values: Array<{ value: string; bitmap: Bitmap }> }> = [];
  let numCols: Array<{ field: string; data: Float64Array; bmin: Float64Array; bmax: Float64Array }> = [];
  let alive: Bitmap | null = null;
  let state: { nextRowid: number; liveCount: number; capacity: number } | null = null;

  for (const b of blocks) {
    const r = new Reader(buf, b.start);
    switch (b.tag) {
      case TAG.DIR: {
        const n = r.u32();
        if (n * 8 + 4 > b.len) throw new Error(`snapshot: DIR declares ${n} offsets but block is ${b.len}B`);
        dir = [];
        for (let k = 0; k < n; k++) dir.push(r.u64());
        break;
      }
      case TAG.ROWS: {
        if (!restoreKeys) break;
        const n = r.u32();
        rowKeys = new Array(n);
        rowLogicals = new Array(n);
        for (let k = 0; k < n; k++) {
          const rowid = r.u32();
          const logical = r.u32();
          const key = r.str();
          // rowid 可能不连续（删过行），按 rowid 归位，别按遍历顺序堆
          rowKeys[rowid] = key;
          rowLogicals[rowid] = logical;
        }
        break;
      }
      case TAG.LOOSE: {
        if (!restoreKeys) break;
        const n = r.u32();
        for (let k = 0; k < n; k++) {
          const logical = r.u32();
          loose.push([r.str(), logical]);
        }
        break;
      }
      case TAG.ENUM: {
        const cols = r.u32();
        enumCols = [];
        for (let c = 0; c < cols; c++) {
          const field = r.str();
          const vn = r.u32();
          const values: Array<{ value: string; bitmap: Bitmap }> = [];
          for (let v = 0; v < vn; v++) {
            const value = r.str();
            const capacity = r.u32();
            const wordCount = r.u32();
            values.push({ value, bitmap: Bitmap.from(r.u32Array(wordCount), capacity) });
          }
          const rows = r.u32Array(r.u32());
          enumCols.push({ field, rows, values });
        }
        break;
      }
      case TAG.NUM: {
        const cols = r.u32();
        numCols = [];
        for (let c = 0; c < cols; c++) {
          const field = r.str();
          const n = r.u32();
          const data = r.f64Array(n);
          const blocks = r.u32();
          numCols.push({ field, data, bmin: r.f64Array(blocks), bmax: r.f64Array(blocks) });
        }
        break;
      }
      case TAG.ALIVE: {
        const capacity = r.u32();
        const wordCount = r.u32();
        alive = Bitmap.from(r.u32Array(wordCount), capacity);
        break;
      }
      case TAG.STATE: {
        state = { nextRowid: r.u32(), liveCount: r.u32(), capacity: r.u32() };
        break;
      }
      default:
        break; // 不认识的块跳过，向前兼容
    }
  }

  if (!dir) throw new Error('snapshot: missing DIR');
  if (!alive) throw new Error('snapshot: missing ALIVE');
  if (!state) throw new Error('snapshot: missing STATE');

  pages.restoreSnapshot(dir, rowKeys, rowLogicals, loose, restoreKeys);
  biz.restoreSnapshot({ keys: rowKeys, enums: enumCols, nums: numCols, alive, state }, restoreKeys, false);

  let bitmaps = 0;
  for (const col of enumCols) bitmaps += col.values.length;
  let live = 0;
  if (restoreKeys) {
    for (let i = 0; i < rowKeys.length; i++) if (rowKeys[i] !== undefined) live++;
  } else {
    live = pages.snapshotSize();
  }
  return {
    ver,
    blocks: blockCount,
    pages: dir.length,
    rows: live,
    loose: loose.length,
    bitmaps,
    bytes: buf.length,
  };
}
