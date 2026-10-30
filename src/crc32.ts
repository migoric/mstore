/**
 * CRC32 (IEEE 802.3)
 *
 * 优先用 Node 内置的 zlib.crc32（C 实现，实测 2812 MB/s），
 * 只有运行时没有它（Node < 22.2）才退回表驱动实现（332 MB/s，8.5× 差距）。
 *
 * 写路径上唯一纯 CPU 热点就是 CRC，所以这个分支不是兼容性洁癖，是性能决定。
 */
import zlib from 'node:zlib';

type CrcFn = (data: Buffer, value?: number) => number;

const nativeCrc: CrcFn | undefined =
  typeof (zlib as unknown as { crc32?: CrcFn }).crc32 === 'function'
    ? (zlib as unknown as { crc32: CrcFn }).crc32
    : undefined;

const TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32Table(buf: Buffer, prev = 0): number {
  let c = ~prev;
  for (let i = 0; i < buf.length; i++) {
    c = TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return ~c >>> 0;
}

/** 增量可用：crc32(chunk, prev) 可拼接，无需回读已写数据 */
export const crc32: CrcFn = nativeCrc ?? crc32Table;

/** 当前走哪条路，写进 info 便于现场诊断 */
export const crc32Impl: string = nativeCrc ? 'zlib.crc32' : 'js-table';

export function crc32Hex(buf: Buffer, prev = 0): string {
  return crc32(buf, prev).toString(16).padStart(8, '0');
}
