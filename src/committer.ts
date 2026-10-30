/**
 * 提交协调器（group commit）。
 *
 * 内核里唯一赚钱的地方：实测 write 4KB 只要 8.3µs，但 fsync 要 ~20ms。
 * 吞吐上限 = 每批条数 / max(提交窗口, fsync 延迟)，
 * 所以把 N 次写合并成 1 次 fsync，吞吐直接乘 N。
 *
 * 窗口自适应：window = clamp(2 * ewma(fsync), min, max)。
 * 固定窗口会在 fsync 变慢时让队列无限堆积（延迟越滚越大），必须跟着实测走。
 */
export interface CommitterOpts {
  flush: () => void;
  fsync: () => void;
  minWindow?: number;
  maxWindow?: number;
}

interface Item<T> {
  op: () => T;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export interface CommitReport {
  commits: number;
  ops: number;
  fsyncs: number;
  batches: number;
  maxBatch: number;
  avgBatch: number;
  fsyncMsEwma: number;
  windowMs: number;
  totalMs: number;
}

export class Committer {
  private flush: () => void;
  private fsync: () => void;
  private minWindow: number;
  private maxWindow: number;
  private queue: Item<unknown>[] = [];
  private timer: NodeJS.Timeout | null = null;
  fsyncMs = 20; // 保守初值，几次提交后由实测接管
  stats = { commits: 0, ops: 0, batches: 0, maxBatch: 0, totalMs: 0, fsyncs: 0 };

  constructor(o: CommitterOpts) {
    this.flush = o.flush;
    this.fsync = o.fsync;
    this.minWindow = o.minWindow ?? 8;
    this.maxWindow = o.maxWindow ?? 100;
  }

  get window(): number {
    return Math.min(this.maxWindow, Math.max(this.minWindow, 2 * this.fsyncMs));
  }

  /** op 是同步函数：同批内按顺序执行，之后统一一次 fsync */
  submit<T>(op: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ op, resolve: resolve as (v: unknown) => void, reject });
      if (!this.timer) this.timer = setTimeout(() => this._drain(), this.window);
    });
  }

  private _drain(): void {
    this.timer = null;
    const batch = this.queue;
    if (batch.length === 0) return;
    this.queue = [];

    const results: unknown[] = [];
    try {
      for (const item of batch) results.push(item.op());
    } catch (err) {
      for (const item of batch) item.reject(err);
      return;
    }

    try {
      this.flush(); // 数据写 + 可能写 meta，全在同一次 fsync 覆盖范围内
      const t0 = process.hrtime.bigint();
      this.fsync();
      const t1 = process.hrtime.bigint();
      const syncMs = Number(t1 - t0) / 1e6;
      // ewma：0.7 旧 + 0.3 新，避免单次抖动带偏窗口
      this.fsyncMs = this.fsyncMs * 0.7 + syncMs * 0.3;
      this.stats.commits++;
      this.stats.ops += batch.length;
      this.stats.batches++;
      this.stats.maxBatch = Math.max(this.stats.maxBatch, batch.length);
      this.stats.totalMs += syncMs;
    } catch (err) {
      for (const item of batch) item.reject(err);
      return;
    }

    for (let i = 0; i < batch.length; i++) batch[i]!.resolve(results[i]);
  }
  /** 等待队列清空（flush() / close() 用） */
  async drainNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this._drain();
    if (this.queue.length) await this.drainNow();
  }

  report(): CommitReport {
    const { commits, ops, batches, maxBatch, totalMs, fsyncs } = this.stats;
    return {
      commits,
      ops,
      fsyncs,
      batches,
      maxBatch,
      avgBatch: batches ? +(ops / batches).toFixed(2) : 0,
      fsyncMsEwma: +this.fsyncMs.toFixed(3),
      windowMs: +this.window.toFixed(1),
      totalMs: +totalMs.toFixed(1),
    };
  }
}
