/**
 * 磁盘格式常量与编解码。所有数字都是小端。
 *
 * 文件布局：
 *   [0, 4096)              文件头
 *   [4096, 4096+1MB)       meta.a
 *   [4096+1MB, +2MB)       meta.b
 *   [4096+2MB, EOF)        段序列（每段 64B 头 + payload）
 *
 * meta 预留 1MB：段表要装下约 1.2 万个段（每段约 80B JSON）。
 * 按 16MB/段算，1MB meta 覆盖约 192GB；超了就把 segSize 翻倍。
 */
import { crc32 } from './crc32.ts';
import type { Meta, SegMeta } from './types.ts';

export const MAGIC: Buffer = Buffer.from('MSTORE01', 'latin1');
export const FORMAT_VER = 1;
export const HEADER_SIZE = 4096;
export const META_SIZE = 1024 * 1024;
export const META_A_OFF = HEADER_SIZE;
export const META_B_OFF = HEADER_SIZE + META_SIZE;
export const DATA_OFF = HEADER_SIZE + META_SIZE * 2;
export const SEG_HEADER_SIZE = 64;
export const SEG_MAGIC: Buffer = Buffer.from('SEG0', 'latin1');
export const DEFAULT_SEG_SIZE = 16 * 1024 * 1024;

/** 段类型 */
export const T = { FREE: 0, SHELL: 1, BODY: 2 } as const;
export type SegType = (typeof T)[keyof typeof T];
export const TYPE_NAME: Record<number, string> = { 0: 'free', 1: 'shell', 2: 'body' };

/** 命名空间写进段头，用于「整段丢弃」式清空 */
export const NS_ID: Record<string, number> = { biz: 1, capture: 2, mock: 3, agent: 4 };
export const NS_NAME: Record<number, string> = { 1: 'biz', 2: 'capture', 3: 'mock', 4: 'agent' };

export function nsId(ns: string | number): number {
  const id = typeof ns === 'number' ? ns : NS_ID[ns];
  if (!id) throw new Error(`unknown namespace: ${String(ns)}`);
  return id;
}

// ---------------- 文件头 ----------------

export interface HeaderInfo {
  formatVer: number;
  segSize: number;
  createdAt: number;
}

export function encodeHeader(o: { segSize: number; createdAt: number }): Buffer {
  const b = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(b, 0);
  b.writeUInt16LE(FORMAT_VER, 8);
  b.writeUInt16LE(0, 10);
  b.writeUInt32LE(o.segSize >>> 0, 12);
  b.writeUInt32LE(o.createdAt >>> 0, 16);
  b.writeUInt32LE(0, 20);
  b.writeUInt32LE(crc32(b.subarray(0, 20)), 20);
  return b;
}

export function decodeHeader(buf: Buffer): HeaderInfo {
  if (buf.length < HEADER_SIZE) throw new Error('file too small: not an mstore file');
  if (!buf.subarray(0, 8).equals(MAGIC)) throw new Error('bad magic: not an mstore file');
  const ver = buf.readUInt16LE(8);
  if (ver !== FORMAT_VER) {
    throw new Error(`unsupported format_ver ${ver} (this build reads ${FORMAT_VER})`);
  }
  if (crc32(buf.subarray(0, 20)) !== buf.readUInt32LE(20)) {
    throw new Error('header CRC mismatch: file is corrupt');
  }
  return { formatVer: ver, segSize: buf.readUInt32LE(12), createdAt: buf.readUInt32LE(16) };
}

// ---------------- meta ----------------

/** meta 区：[u32 jsonLen][u32 crc][json...][0 填充] */
export function encodeMeta(meta: Meta): Buffer {
  const json = Buffer.from(JSON.stringify(meta), 'utf8');
  if (json.length + 8 > META_SIZE) {
    throw new Error(
      `meta too large: ${json.length}B > ${META_SIZE - 8}B; raise segSize so segment count drops`
    );
  }
  // 只写实际长度，不写满 1MB —— 否则每次提交都要写 1MB（实测会慢 30 倍）
  const b = Buffer.allocUnsafe(8 + json.length);
  b.writeUInt32LE(json.length, 0);
  b.writeUInt32LE(crc32(json), 4);
  json.copy(b, 8);
  return b;
}

export function decodeMeta(buf: Buffer | undefined): Meta | null {
  if (!buf || buf.length < 8) return null;
  const len = buf.readUInt32LE(0);
  if (len === 0 || len + 8 > buf.length) return null;
  const json = buf.subarray(8, 8 + len);
  if (crc32(json) !== buf.readUInt32LE(4)) return null;
  try {
    return JSON.parse(json.toString('utf8')) as Meta;
  } catch {
    return null;
  }
}

// ---------------- 段头（64 B） ----------------

export interface SegHeaderIn {
  id: number;
  type: number;
  ns: number;
  rows?: number;
  len?: number;
  crc?: number;
  session?: number;
  flags?: number;
}

export function encodeSegHeader(o: SegHeaderIn): Buffer {
  const b = Buffer.alloc(SEG_HEADER_SIZE);
  SEG_MAGIC.copy(b, 0);
  b.writeUInt16LE(FORMAT_VER, 4);
  b.writeUInt8(o.type, 6);
  b.writeUInt8(o.ns, 7);
  b.writeUInt32LE(o.id >>> 0, 8);
  b.writeUInt32LE((o.rows ?? 0) >>> 0, 12);
  b.writeUInt32LE((o.len ?? 0) >>> 0, 16);
  b.writeUInt32LE((o.crc ?? 0) >>> 0, 20);
  b.writeUInt32LE((o.session ?? 0) >>> 0, 24);
  b.writeUInt32LE((o.flags ?? 0) >>> 0, 28);
  return b;
}

export interface SegHeaderOut {
  ver: number;
  type: number;
  ns: number;
  id: number;
  rows: number;
  len: number;
  crc: number;
  session: number;
  flags: number;
}

export function decodeSegHeader(buf: Buffer, at = 0): SegHeaderOut | null {
  if (buf.length - at < SEG_HEADER_SIZE) return null;
  if (!buf.subarray(at, at + 4).equals(SEG_MAGIC)) return null;
  return {
    ver: buf.readUInt16LE(at + 4),
    type: buf.readUInt8(at + 6),
    ns: buf.readUInt8(at + 7),
    id: buf.readUInt32LE(at + 8),
    rows: buf.readUInt32LE(at + 12),
    len: buf.readUInt32LE(at + 16),
    crc: buf.readUInt32LE(at + 20),
    session: buf.readUInt32LE(at + 24),
    flags: buf.readUInt32LE(at + 28),
  };
}

/** BODY 段的帧：[u32 len][bytes] —— 原始字节，不 base64、不 parse */
export function frameBody(bytes: Uint8Array): Buffer {
  const b = Buffer.allocUnsafe(4 + bytes.length);
  b.writeUInt32LE(bytes.length, 0);
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).copy(b, 4);
  return b;
}

export function newMeta(segSize: number): Meta {
  return { gen: 1, segSize, nextId: 1, hwm: DATA_OFF, segs: [], seqs: {}, pending: [] };
}

export function segEnd(seg: Pick<SegMeta, 'off'>, segSize: number): number {
  return seg.off + SEG_HEADER_SIZE + segSize;
}
