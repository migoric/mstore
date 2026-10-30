/**
 * 段缓冲：每个「活跃段」一块内存，攒够一次写。
 * 存在理由只有一个 —— 把大量小 append 合并成 ≥64KB 的 write。
 * （实测：4KB 块顺序写 206MB/s，1MB 块 763MB/s，差的全是 syscall 开销）
 */
import { encodeSegHeader, SEG_HEADER_SIZE } from './format.ts';
import { crc32 } from './crc32.ts';
import type { Io } from './io.ts';

export interface SegBufferInit {
  id: number;
  off: number;
  cap: number;
  ns: number;
  type: number;
  session: number;
}

export class SegmentBuffer {
  readonly id: number;
  readonly off: number;
  readonly cap: number;
  readonly ns: number;
  readonly type: number;
  readonly session: number;
  readonly buf: Buffer;
  used = 0;
  flushed = 0;
  rows = 0;
  crc = 0;
  dirty = false;

  constructor(o: SegBufferInit) {
    this.id = o.id;
    this.off = o.off;
    this.cap = o.cap;
    this.ns = o.ns;
    this.type = o.type;
    this.session = o.session;
    this.buf = Buffer.allocUnsafe(o.cap);
  }

  get payloadOff(): number {
    return this.off + SEG_HEADER_SIZE;
  }

  get free(): number {
    return this.cap - this.used;
  }

  /** 放不下就返回 false，由上层换段 */
  append(bytes: Buffer): boolean {
    if (this.used + bytes.length > this.cap) return false;
    bytes.copy(this.buf, this.used);
    this.used += bytes.length;
    this.rows++;
    this.crc = crc32(bytes, this.crc);
    this.dirty = true;
    return true;
  }

  /** 只写脏的那一段字节，并更新段头（rows/len/crc） */
  flush(io: Io): number {
    const start = this.flushed;
    let written = 0;
    if (this.used > start) {
      written = this.used - start;
      io.writeAt(this.buf.subarray(start, this.used), this.payloadOff + start);
      this.flushed = this.used;
    }
    if (written > 0 || this.dirty) {
      io.writeAt(
        encodeSegHeader({
          id: this.id,
          type: this.type,
          ns: this.ns,
          rows: this.rows,
          len: this.used,
          crc: this.crc,
          session: this.session,
        }),
        this.off
      );
    }
    this.dirty = false;
    return written;
  }
}

export class BufferPool {
  private io: Io;
  private buffers = new Map<number, SegmentBuffer>();
  flushedBytes = 0;
  flushCount = 0;

  constructor(io: Io) {
    this.io = io;
  }

  add(b: SegmentBuffer): SegmentBuffer {
    this.buffers.set(b.id, b);
    return b;
  }

  get(id: number): SegmentBuffer | undefined {
    return this.buffers.get(id);
  }

  remove(id: number): void {
    this.buffers.delete(id);
  }

  get size(): number {
    return this.buffers.size;
  }

  get dirtyCount(): number {
    let n = 0;
    for (const b of this.buffers.values()) if (b.dirty) n++;
    return n;
  }

  flushAll(): number {
    let bytes = 0;
    let touched = 0;
    for (const b of this.buffers.values()) {
      if (!b.dirty) continue;
      bytes += b.flush(this.io);
      touched++;
    }
    if (touched) this.flushCount++;
    this.flushedBytes += bytes;
    return bytes;
  }

  clear(): void {
    this.buffers.clear();
  }
}
