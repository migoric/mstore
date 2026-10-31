import { crc32 } from './crc32.ts';
import type { Io } from './io.ts';
import type { KeyIndexMeta } from './types.ts';

export interface KeyRecord {
  logical?: number;
  rowid?: number;
}

export interface KeyDirectory {
  readonly persistent: boolean;
  readonly size: number;
  get(key: string): KeyRecord | undefined;
  getKey(rowid: number): string | undefined;
  set(key: string, value: Partial<KeyRecord>): void;
  delete(key: string): void;
  clear(): void;
  entries(): IterableIterator<[string, KeyRecord]>;
}

export class MemoryKeyDirectory implements KeyDirectory {
  readonly persistent = false;
  private map = new Map<string, KeyRecord>();
  // rowid 是连续分配的，用密集数组反查比 Map 快一个数量级（数组索引 vs 哈希）。
  // bizQuery 对每个命中行都要 getKey，全量命中 4 万行时 Map 反查累积约 3ms，是过滤查询
  // 从「快 16×」掉到「快 7×」的直接原因。delete 只在行删除时留洞（undefined），
  // 稀疏数组的字典模式仍快过 Map。
  private reverse: Array<string | undefined> = [];

  get size(): number {
    return this.map.size;
  }

  get(key: string): KeyRecord | undefined {
    return this.map.get(key);
  }

  getKey(rowid: number): string | undefined {
    return this.reverse[rowid];
  }

  set(key: string, value: Partial<KeyRecord>): void {
    const old = this.map.get(key) ?? {};
    if (old.rowid !== undefined && old.rowid !== value.rowid) this.reverse[old.rowid] = undefined;
    const next = { logical: value.logical ?? old.logical, rowid: value.rowid ?? old.rowid };
    this.map.set(key, next);
    if (next.rowid !== undefined) this.reverse[next.rowid] = key;
  }

  delete(key: string): void {
    const old = this.map.get(key);
    if (!old) return;
    if (old.rowid !== undefined) this.reverse[old.rowid] = undefined;
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.reverse.length = 0;
  }

  *entries(): IterableIterator<[string, KeyRecord]> {
    yield* this.map;
  }
}

interface Block {
  off: number;
  firstKey: string;
  firstRowid: number;
  bloomA: number;
  bloomB: number;
}

class Parts {
  chunks: Buffer[] = [];
  length = 0;

  add(buf: Buffer): number {
    const off = this.length;
    this.chunks.push(buf);
    this.length += buf.length;
    return off;
  }
}

function hash(key: string): { a: number; b: number } {
  let h = 0x811c9dc5;
  const bytes = Buffer.from(key, 'utf8');
  for (const v of bytes) {
    h ^= v;
    h = Math.imul(h, 0x01000193);
  }
  return { a: h >>> 0, b: Math.imul(h ^ bytes.length, 0x85ebca6b) >>> 0 };
}

function bloomFor(key: string): { a: number; b: number } {
  const h = hash(key);
  const bit = h.a & 31;
  return { a: (1 << bit) >>> 0, b: (1 << (h.b & 31)) >>> 0 };
}

function makeBlock(records: Array<[string, KeyRecord]>): { data: Buffer; firstKey: string; firstRowid: number; bloomA: number; bloomB: number } {
  const chunks: Buffer[] = [];
  let bloomA = 0;
  let bloomB = 0;
  for (const [key, rec] of records) {
    if (rec.logical === undefined || rec.rowid === undefined) throw new Error(`incomplete key directory record: ${key}`);
    const bloom = bloomFor(key);
    bloomA |= bloom.a;
    bloomB |= bloom.b;
    const kb = Buffer.from(key, 'utf8');
    const head = Buffer.alloc(10);
    head.writeUInt16LE(kb.length, 0);
    head.writeUInt32LE(rec.logical, 2);
    head.writeUInt32LE(rec.rowid, 6);
    chunks.push(head, kb);
  }
  const payload = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(payload.length, 0);
  head.writeUInt32LE(crc32(payload), 4);
  const first = records[0]!;
  return {
    data: Buffer.concat([head, payload]),
    firstKey: first[0],
    firstRowid: first[1].rowid!,
    bloomA: bloomA >>> 0,
    bloomB: bloomB >>> 0,
  };
}

function blocksOf(rows: Array<[string, KeyRecord]>, blockBytes: number): ReturnType<typeof makeBlock>[] {
  const out: ReturnType<typeof makeBlock>[] = []; // equiv: => 是返回类型箭头，不是比较运算符
  for (let at = 0; at < rows.length; ) {
    let end = at;
    let bytes = 8; // 每块自己的 length + CRC 头也占预算
    while (end < rows.length) {
      const next = 10 + Buffer.byteLength(rows[end]![0], 'utf8');
      // 单条记录超过预算仍要独占一块，否则永远无法前进；多条时绝不超过 blockBytes。
      if (end > at && bytes + next > blockBytes) break;
      bytes += next;
      end++;
    }
    out.push(makeBlock(rows.slice(at, end)));
    at = end;
  }
  return out;
}

export function encodeKeyDirectory(
  directory: KeyDirectory,
  dir: readonly number[],
  off: number,
  epoch: number
): { payload: Buffer; meta: Omit<KeyIndexMeta, 'seg'> } {
  const rows = [...directory.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); // equiv: key 唯一，>= 只在相同 key 时改变比较结果，而目录不会重复
  const primary = blocksOf(rows, 4096);
  const reverseRows = rows.map(([key, rec]) => [key, { logical: rec.logical, rowid: rec.rowid }] as [string, KeyRecord])
    .sort((a, b) => a[1].rowid! - b[1].rowid!);
  const reverse = blocksOf(reverseRows, 4096);
  const parts = new Parts();
  const header = Buffer.alloc(32);
  parts.add(header);
  const dirOff = off + parts.length;
  const dirBuf = Buffer.alloc(dir.length * 8);
  dir.forEach((v, i) => dirBuf.writeBigUInt64LE(BigInt(v), i * 8));
  parts.add(dirBuf);
  const primaryOff = off + parts.length;
  primary.forEach((b) => parts.add(b.data));
  const reverseOff = off + parts.length;
  reverse.forEach((b) => parts.add(b.data));

  const indexOff = off + parts.length;
  let cursor = primaryOff;
  const sparse = primary.map((b) => {
    const key = Buffer.from(b.firstKey, 'utf8');
    const out = Buffer.alloc(10 + key.length);
    out.writeBigUInt64LE(BigInt(cursor), 0);
    out.writeUInt16LE(key.length, 8);
    key.copy(out, 10);
    cursor += b.data.length;
    return out;
  });
  const indexLen = sparse.reduce((n, b) => n + b.length, 0);
  parts.add(Buffer.concat(sparse));

  const reverseIndexOff = off + parts.length;
  cursor = reverseOff;
  const reverseSparse = reverse.map((b) => {
    const out = Buffer.alloc(12);
    out.writeBigUInt64LE(BigInt(cursor), 0);
    out.writeUInt32LE(b.firstRowid, 8);
    cursor += b.data.length;
    return out;
  });
  const reverseIndexLen = reverseSparse.length * 12;
  parts.add(Buffer.concat(reverseSparse));

  const bloomOff = off + parts.length;
  const blooms = Buffer.alloc(primary.length * 8);
  primary.forEach((b, i) => {
    blooms.writeUInt32LE(b.bloomA, i * 8);
    blooms.writeUInt32LE(b.bloomB, i * 8 + 4);
  });
  parts.add(blooms);
  const footerCrc = crc32(Buffer.concat([...sparse, ...reverseSparse, blooms]));
  header.write('MKEYDIR1', 0, 'latin1');
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(4096, 12);
  header.writeUInt32LE(rows.length, 16);
  header.writeUInt32LE(dir.length, 20);
  header.writeUInt32LE(primary.length, 24);
  header.writeUInt32LE(reverse.length, 28);
  const payload = Buffer.concat(parts.chunks);

  return {
    payload,
    meta: {
      off,
      len: payload.length,
      crc: footerCrc,
      epoch,
      rows: rows.length,
      dirOff,
      dirCount: dir.length,
      dirCrc: crc32(dirBuf),
      primaryOff,
      primaryCount: primary.length,
      reverseOff,
      reverseCount: reverse.length,
      indexOff,
      indexLen,
      reverseIndexOff,
      reverseIndexLen,
      bloomOff,
      bloomLen: blooms.length,
    },
  };
}

export function shiftKeyIndexOffsets(payload: Buffer, meta: Omit<KeyIndexMeta, 'seg'>, off: number): void {
  let at = meta.indexOff;
  const end = meta.indexOff + meta.indexLen;
  while (at < end) {
    payload.writeBigUInt64LE(payload.readBigUInt64LE(at) + BigInt(off), at);
    at += 10 + payload.readUInt16LE(at + 8);
  }
  for (let i = meta.reverseIndexOff; i < meta.reverseIndexOff + meta.reverseIndexLen; i += 12) {
    payload.writeBigUInt64LE(payload.readBigUInt64LE(i) + BigInt(off), i);
  }
  meta.crc = crc32(Buffer.concat([
    payload.subarray(meta.indexOff, meta.indexOff + meta.indexLen),
    payload.subarray(meta.reverseIndexOff, meta.reverseIndexOff + meta.reverseIndexLen),
    payload.subarray(meta.bloomOff, meta.bloomOff + meta.bloomLen),
  ]));
}

export function readKeyPageDir(io: Io, meta: KeyIndexMeta): number[] {
  const buf = io.readAt(meta.dirOff, meta.dirCount * 8);
  if (crc32(buf) !== meta.dirCrc) throw new Error('key page directory CRC mismatch');
  const out = new Array<number>(meta.dirCount);
  for (let i = 0; i < out.length; i++) out[i] = Number(buf.readBigUInt64LE(i * 8));
  return out;
}

export class PersistentKeyDirectory implements KeyDirectory {
  readonly persistent = true;
  private delta = new MemoryKeyDirectory();
  private deleted = new Set<string>();
  private firstKeys: string[] = [];
  private primaryOffsets: number[] = [];
  private reverseFirstRowids: number[] = [];
  private reverseOffsets: number[] = [];
  private blooms: Buffer;
  private cache = new Map<number, Array<[string, KeyRecord]>>();
  private deltaSize = 0;
  private io: Io;
  private meta: KeyIndexMeta;

  constructor(io: Io, meta: KeyIndexMeta) {
    this.io = io;
    this.meta = meta;
    const header = io.readAt(meta.off, 32);
    if (header.toString('latin1', 0, 8) !== 'MKEYDIR1' || header.readUInt32LE(8) !== 1) {
      throw new Error('unsupported key index header');
    }
    if (header.readUInt32LE(16) !== meta.rows || header.readUInt32LE(20) !== meta.dirCount) {
      throw new Error('key index header/meta mismatch');
    }
    const index = io.readAt(meta.indexOff, meta.indexLen);
    let at = 0;
    while (at < index.length) {
      const off = Number(index.readBigUInt64LE(at));
      const len = index.readUInt16LE(at + 8);
      this.primaryOffsets.push(off);
      this.firstKeys.push(index.toString('utf8', at + 10, at + 10 + len));
      at += 10 + len;
    }
    const reverse = io.readAt(meta.reverseIndexOff, meta.reverseIndexLen);
    for (let i = 0; i < reverse.length; i += 12) {
      this.reverseOffsets.push(Number(reverse.readBigUInt64LE(i)));
      this.reverseFirstRowids.push(reverse.readUInt32LE(i + 8));
    }
    this.blooms = io.readAt(meta.bloomOff, meta.bloomLen);
    const footer = Buffer.concat([index, reverse, this.blooms]);
    if (crc32(footer) !== meta.crc) throw new Error('key index footer CRC mismatch');
  }

  get size(): number {
    return this.meta.rows + this.deltaSize;
  }

  private locate(key: string): number {
    let lo = 0;
    let hi = this.firstKeys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.firstKeys[mid]! <= key) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  private readBlock(off: number): Array<[string, KeyRecord]> {
    const cached = this.cache.get(off);
    if (cached) return cached;
    const head = this.io.readAt(off, 8);
    const len = head.readUInt32LE(0);
    const payload = this.io.readAt(off + 8, len);
    if (crc32(payload) !== head.readUInt32LE(4)) throw new Error(`key block CRC mismatch at ${off}`);
    const rows: Array<[string, KeyRecord]> = [];
    let at = 0;
    while (at < payload.length) {
      const keyLen = payload.readUInt16LE(at);
      const logical = payload.readUInt32LE(at + 2);
      const rowid = payload.readUInt32LE(at + 6);
      const key = payload.toString('utf8', at + 10, at + 10 + keyLen);
      rows.push([key, { logical, rowid }]);
      at += 10 + keyLen;
    }
    this.cache.set(off, rows);
    if (this.cache.size > 64) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest); // equiv: size 超过 64 时至少有一项，oldest 不可能为 undefined
    }
    return rows;
  }

  get cachedBlocks(): number {
    return this.cache.size;
  }

  private baseGet(key: string): KeyRecord | undefined {
    const b = this.locate(key);
    if (b < 0) return undefined;
    const h = hash(key);
    const a = this.blooms.readUInt32LE(b * 8);
    const bloomB = this.blooms.readUInt32LE(b * 8 + 4);
    if ((a & (1 << (h.a & 31))) === 0 || (bloomB & (1 << (h.b & 31))) === 0) return undefined;
    const rows = this.readBlock(this.primaryOffsets[b]!);
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (rows[mid]![0] < key) lo = mid + 1;
      else hi = mid;
    }
    const hit = rows[lo];
    return hit?.[0] === key ? hit[1] : undefined;
  }

  get(key: string): KeyRecord | undefined {
    const local = this.delta.get(key);
    if (local) return local;
    if (this.deleted.has(key)) return undefined;
    return this.baseGet(key);
  }

  getKey(rowid: number): string | undefined {
    const local = this.delta.getKey(rowid);
    if (local) return local;
    let lo = 0;
    let hi = this.reverseFirstRowids.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.reverseFirstRowids[mid]! <= rowid) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return undefined;
    const rows = this.readBlock(this.reverseOffsets[lo - 1]!);
    for (const [key, rec] of rows) if (rec.rowid === rowid && !this.deleted.has(key)) return key;
    return undefined;
  }

  set(key: string, value: Partial<KeyRecord>): void {
    if (!this.get(key)) this.deltaSize++;
    this.deleted.delete(key);
    this.delta.set(key, value);
  }

  delete(key: string): void {
    if (!this.get(key)) return;
    this.delta.delete(key);
    this.deleted.add(key);
    this.deltaSize--;
  }

  clear(): void {
    this.meta.rows = 0;
    this.deltaSize = 0;
    this.delta.clear();
    this.deleted.clear();
    this.firstKeys = [];
    this.primaryOffsets = [];
    this.reverseFirstRowids = [];
    this.reverseOffsets = [];
    this.blooms = Buffer.alloc(0);
    this.cache.clear();
  }

  entries(): IterableIterator<[string, KeyRecord]> {
    const merged = new Map<string, KeyRecord>();
    for (const off of this.primaryOffsets) {
      for (const [key, rec] of this.readBlock(off)) merged.set(key, rec);
    }
    for (const key of this.deleted) merged.delete(key);
    for (const [key, rec] of this.delta.entries()) merged.set(key, rec);
    return merged.entries();
  }
}
