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
  fsync: () => void | Promise<void>;
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
  private fsync: () => void | Promise<void>;
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
      // 队首请求立刻安排提交，不等满整个窗口。
      //
      // 窗口的作用是「让后来者搭上车」，不是「让第一个请求先罚站」。
      // 串行 `for (…) await put(…)` 时队列里永远只有 1 个 op，等满窗口就是纯延迟：
      // 实测 window=40ms + fsync=20ms → 每条 60ms（16 行/秒），
      // 而同一份数据并发提交能到 2824 行/秒。差的那 40ms 一点活都没干。
      //
      // 用 0ms 定时器：同一个 tick 内 submit 的后续 op 仍然并进这一批（group commit
      // 不受影响），单条也不再空等；而 fsync 本身那 20ms 期间到达的 op 会自然攒到
      // 下一轮——真正的合批能力来自 fsync 在途，不来自空等。
      if (!this.timer) this.timer = setTimeout(() => this._drain(), 0);
    });
  }

  private active: Promise<void> | null = null;

  private _drain(): Promise<void> {
    this.timer = null;
    if (this.active) return this.active;
    const run = this._run();
    this.active = run;
    void run.finally(() => {
      if (this.active === run) this.active = null;
      if (this.queue.length && !this.timer) this.timer = setTimeout(() => void this._drain(), 0);
    });
    return run;
  }

  /** 只有一个 _run 可进入 fsync；等待期间到达的请求留给下一批。 */
  private async _run(): Promise<void> {
    while (this.queue.length) {
      const batch = this.queue;
      this.queue = [];
      const results: unknown[] = [];
      try {
        for (const item of batch) results.push(item.op());
      } catch (err) {
        for (const item of batch) item.reject(err);
        continue;
      }

      try {
        this.flush(); // 数据写 + 可能写 meta，全在同一次 fsync 覆盖范围内
        const t0 = process.hrtime.bigint();
        await this.fsync();
        const t1 = process.hrtime.bigint();
        const syncMs = Number(t1 - t0) / 1e6;
        // ewma：0.7 旧 + 0.3 新，避免单次抖动带偏窗口
        this.fsyncMs = this.fsyncMs * 0.7 + syncMs * 0.3;
        this.stats.commits++;
        this.stats.ops += batch.length;
        this.stats.batches++;
        this.stats.fsyncs++;
        this.stats.maxBatch = Math.max(this.stats.maxBatch, batch.length);
        this.stats.totalMs += syncMs;
      } catch (err) {
        for (const item of batch) item.reject(err);
        continue;
      }

      for (let i = 0; i < batch.length; i++) batch[i]!.resolve(results[i]);
    }
  }

  /** 等待队列清空（flush() / close() 用） */
  async drainNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this._drain();
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
