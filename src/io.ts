/**
 * IO 薄层：一个 fd、定块读写、fsync 计数、截断、打洞能力探测。
 * 数据读写保持同步以简化单写者顺序；刷盘提供异步接口，避免等待时阻塞事件循环。
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export class Io {
  readonly fd: number;
  readonly path: string;
  fsyncCount = 0;
  bytesWritten = 0;
  bytesRead = 0;
  private _closed = false;

  constructor(fd: number, path: string) {
    this.fd = fd;
    this.path = path;
  }

  static open(path: string, opts: { create?: boolean } = {}): Io {
    const fd = fs.openSync(path, opts.create ? 'w+' : 'r+');
    return new Io(fd, path);
  }

  size(): number {
    return fs.fstatSync(this.fd).size;
  }

  /** 精确读满 len；越界抛错，避免「读到一半」被当成完整数据 */
  readAt(off: number, len: number, buf: Buffer = Buffer.allocUnsafe(len)): Buffer {
    let done = 0;
    while (done < len) {
      const n = fs.readSync(this.fd, buf, done, len - done, off + done);
      if (n === 0) throw new Error(`unexpected EOF at ${off + done} (wanted ${len - done} more)`);
      done += n;
    }
    this.bytesRead += len;
    return buf;
  }

  /** 写满：处理短写 */
  writeAt(buf: Buffer, off: number): number {
    let done = 0;
    while (done < buf.length) {
      done += fs.writeSync(this.fd, buf, done, buf.length - done, off + done);
    }
    this.bytesWritten += buf.length;
    return done;
  }

  append(buf: Buffer): number {
    const off = this.size();
    this.writeAt(buf, off);
    return off;
  }

  truncate(len: number): void {
    fs.ftruncateSync(this.fd, len);
  }

  /** 预留空间：APFS 上是稀疏的，不占实际块（实测 160MB 预留只占 1MB） */
  reserve(len: number): void {
    if (this.size() < len) fs.ftruncateSync(this.fd, len);
  }

  fsync(): void {
    fs.fsyncSync(this.fd);
    this.fsyncCount++;
  }

  /** 同一个 fd 的异步全量刷盘；等待期间不阻塞 Node 事件循环。 */
  fsyncAsync(): Promise<void> {
    return new Promise((resolve, reject) => {
      fs.fsync(this.fd, (err) => {
        if (err) reject(err);
        else {
          this.fsyncCount++;
          resolve();
        }
      });
    });
  }

  /**
   * 打洞：macOS 的 fcntl(F_PUNCHHOLE)，Node 不暴露。
   * 设置了 MSTORE_PUNCH_HELPER 就调外部小工具；否则返回 false，
   * 由上层退化为「标记 dead + 优先复用」。
   */
  punchHole(off: number, len: number): boolean {
    const helper = process.env.MSTORE_PUNCH_HELPER;
    if (!helper) return false;
    const r = spawnSync(helper, [this.path, String(off), String(len)], { stdio: 'ignore' });
    return r.status === 0;
  }

  close(): void {
    if (this._closed) return;
    fs.closeSync(this.fd);
    this._closed = true;
  }
}

/** APFS clonefile 复制（时点快照），失败退化为普通复制 */
export function cloneFile(src: string, dst: string): { cloned: boolean } {
  try {
    fs.cpSync(src, dst, { mode: fs.constants.COPYFILE_FICLONE });
    return { cloned: true };
  } catch {
    fs.copyFileSync(src, dst);
    return { cloned: false };
  }
}
