/**
 * mstore vs SQLite：同一批数据、同一批查询，本机实测。
 *
 *   node bench/vs-sqlite.ts [--rows 200000] [--persist 3000] [--json]
 *
 * ## 为什么要分进程跑
 *
 * 三个引擎塞进一个进程会互相污染：mstore 的索引常驻堆、SQLite 的 page cache 在
 * 自己的 C 堆里、GC 压力彼此叠加。内存那一栏会变成「谁先跑谁占便宜」。所以主进程只
 * 负责 spawn 自己四次（--engine mstore|sqlite-full|sqlite-wal|sqlite-quick），
 * 每个引擎独占一个进程，收一行 JSON 回来汇总。
 *
 * ## 对等性前提（都是刻意选的，改之前先读）
 *
 * - **数据形状完全相同**：同一批 6 字段的行，同样的分布。ms = i*2，故意造出奇数空隙，
 *   这样「区间命中 0 行」是真的落进空隙，而不是「区间越界」。
 * - **SQLite 侧给默认索引的 5 个字段都建了索引**（dept / status / level / ms / bytes）。
 *   mstore 的默认行为就是对 dept/status/type/kind（枚举位图）与
 *   level/updated_at/ms/bytes（数值列）建索引；只给 SQLite 建主键会让对比失真。
 * - **索引在插入前建好**，也就是 SQLite 这边也要边写边维护索引——这是 mstore 唯一
 *   能跑的模式，给 SQLite 开「先灌数据后建索引」的后门就不叫对比了。
 * - **写入语义必须按「物理持久级别」对齐**，这是本基准最容易搞错的地方：
 *
 *     mstore     每条 bizPut 都等到 fsync 覆盖后才 resolve
 *     sqlite-full  DELETE + synchronous=FULL + **fullfsync=ON**
 *     sqlite-wal   WAL + synchronous=FULL + **fullfsync=ON**
 *     sqlite-quick WAL + synchronous=NORMAL（`fullfsync` 保持默认 0）
 *
 *   为什么必须显式写 `fullfsync=ON`：macOS 上 `fsync(2)` 只保证数据到了 OS 页缓存，
 *   不保证到物理介质，只有 `F_FULLFSYNC` 才保证。SQLite 默认 `fullfsync=0`，
 *   也就是**掉电可能丢最近若干已提交事务**；而 Node 的 `fs.fsyncSync` 走的正是
 *   `F_FULLFSYNC`。不写这一行，就会拿「真刷盘」去比「只到页缓存」——
 *   本机实测同样的 FULL 配置，差 966 行/秒 vs 17 行/秒，56 倍，全是持久级别差。
 *
 *   所以表里必须同时给出 sqlite-quick 那一档并明确标注它不保证持久，否则读者会
 *   以为「SQLite 就是快 56 倍」。它快是因为它答应的事情更少。
 *
 * ## 一个已知的不可比点
 *
 * mstore 的 key→位置、枚举位图、数值列全在内存里，查询是纯内存操作；SQLite 走磁盘
 * B-tree，靠 OS page cache 兜。所以「查询 mstore 快」这件事有一半是「索引常驻内存」
 * 换来的，代价写在内存那一栏和 docs/scale-10g.md 里。这张表要连着内存一起读。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.ts';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};

const ROWS = Number(arg('rows', '200000'));
const PERSIST = Number(arg('persist', '3000'));
const ENGINE = arg('engine', '');

const DEPTS = ['R&D', 'Design', 'QA', 'Ops', 'Sales'];
const STATUS = ['active', 'idle', 'done'];

const rowAt = (i: number): Record<string, unknown> => ({
  name: `用户${i}`,
  dept: DEPTS[i % 5]!,
  status: STATUS[i % 3]!,
  level: i % 9,
  ms: i * 2, // 偶数：奇数区间必然命中 0，是真空隙
  bytes: 100 + (i % 1000),
});

const med = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
};
const ms1 = (x: number): number => Math.round(x * 100) / 100;

interface Result {
  engine: string;
  rows: number;
  bytes: number;
  /** 逐条持久写 N 行的吞吐（行/秒） */
  persistOps: number;
  persistMs: number;
  /** 批量导入 ROWS 行（含索引维护）的总耗时 */
  bulkMs: number;
  /** 打开数据库 + 一次强制读取的耗时 */
  openMs: number;
  pointUs: number;
  enumUs: number;
  range0Us: number;
  range20Us: number;
  rssMb: number;
  heapMb: number;
  /** 是否保证掉电不丢已提交事务（物理持久级别） */
  durable: boolean;
  /** 逐条写时每行摊到几次 fsync */
  fsyncPerOp: number;
  note?: string;
}

// ────────────────────────────── mstore ──────────────────────────────

async function runMstore(dir: string): Promise<Result> {
  const file = path.join(dir, 'mstore.db');
  const db = Store.create(file);

  // 逐条持久写：每条都等到 fsync 覆盖
  const fs0 = db.io.fsyncCount;
  const t0 = performance.now();
  for (let i = 0; i < PERSIST; i++) await db.bizPut(`u_${i}`, rowAt(i));
  const persistMs = performance.now() - t0;
  const persistOps = (PERSIST / persistMs) * 1000;
  const fsyncPerOp = (db.io.fsyncCount - fs0) / PERSIST;

  // 批量导入剩下的（补到 ROWS）
  const t1 = performance.now();
  for (let at = PERSIST; at < ROWS; at += 2000) {
    const n = Math.min(2000, ROWS - at);
    await Promise.all(Array.from({ length: n }, (_, k) => db.bizPut(`u_${at + k}`, rowAt(at + k))));
  }
  await db.flush();
  const bulkMs = performance.now() - t1;

  // 点查
  const POINT = 20000;
  const keyAt = (n: number): string => `u_${(n * 7919) % ROWS}`;
  const pt: number[] = [];
  for (let i = 0; i < POINT; i++) {
    const s = performance.now();
    db.bizGet(keyAt(i));
    pt.push(performance.now() - s);
  }
  const pointUs = med(pt) * 1000;

  // 枚举过滤：dept='R&D'（20%）AND level>=5
  const en: number[] = [];
  for (let i = 0; i < 15; i++) {
    const s = performance.now();
    db.bizQuery({ eq: { dept: 'R&D' }, gte: { level: 5 } });
    en.push(performance.now() - s);
  }
  const enumUs = med(en) * 1000;

  // 区间：命中 0（落进奇数空隙）与命中 20%
  const r0: number[] = [];
  for (let i = 0; i < 15; i++) {
    const s = performance.now();
    db.bizQuery({ gte: { ms: 1 }, lte: { ms: 1 } });
    r0.push(performance.now() - s);
  }
  const range0Us = med(r0) * 1000;

  const r20: number[] = [];
  const hi = Math.round(ROWS * 2 * 0.2);
  for (let i = 0; i < 15; i++) {
    const s = performance.now();
    db.bizQuery({ gte: { ms: 0 }, lte: { ms: hi } });
    r20.push(performance.now() - s);
  }
  const range20Us = med(r20) * 1000;

  await db.close();
  const bytes = fs.statSync(file).size;

  // 冷启动：open 之后必须真的读一次，否则只是把 meta 读进内存
  const s = performance.now();
  const again = Store.open(file);
  again.bizQuery({ eq: { dept: 'QA' }, limit: 1 });
  const openMs = performance.now() - s;

  gc2();
  const m = process.memoryUsage();
  return {
    engine: 'mstore',
    rows: ROWS,
    bytes,
    persistOps,
    persistMs,
    bulkMs,
    openMs,
    pointUs,
    enumUs,
    range0Us,
    range20Us,
    rssMb: m.rss / 1048576,
    heapMb: (m.heapUsed + m.external) / 1048576,
    durable: true,
    fsyncPerOp,
    note: '每条 bizPut 等到 fsync 覆盖后才 resolve',
  };
}

// ────────────────────────────── SQLite ──────────────────────────────

async function runSqlite(dir: string, mode: 'full' | 'wal' | 'quick'): Promise<Result> {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(dir, `sqlite-${mode}.db`);
  const db = new DatabaseSync(file);

  if (mode === 'quick') {
    // 生产最常见，但**不保证物理持久**：只到 OS 页缓存，掉电丢最近若干事务
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
  } else if (mode === 'wal') {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=FULL');
    db.exec('PRAGMA fullfsync=ON');
  } else {
    db.exec('PRAGMA journal_mode=DELETE');
    db.exec('PRAGMA synchronous=FULL');
    db.exec('PRAGMA fullfsync=ON');
  }

  // 回读确认：pragma 设没生效，直接决定这一栏的写入数字有没有意义
  const fq = (db.prepare('PRAGMA fullfsync').get() as { fullfsync?: number }).fullfsync ?? -1;
  const sq = (db.prepare('PRAGMA synchronous').get() as { synchronous?: number }).synchronous ?? -1;
  const durable = fq === 1 && sq === 2;
  const note =
    mode === 'quick'
      ? 'WAL+NORMAL+fullfsync=0：不保证物理持久，掉电丢最近若干事务'
      : `fullfsync=${fq} synchronous=${sq}：与 mstore 同持久级别`;

  db.exec(`
    CREATE TABLE u(
      k TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      dept TEXT NOT NULL,
      status TEXT NOT NULL,
      level INTEGER NOT NULL,
      ms INTEGER NOT NULL,
      bytes INTEGER NOT NULL
    );
    CREATE INDEX idx_dept ON u(dept);
    CREATE INDEX idx_status ON u(status);
    CREATE INDEX idx_level ON u(level);
    CREATE INDEX idx_ms ON u(ms);
    CREATE INDEX idx_bytes ON u(bytes);
  `);

  const ins = db.prepare('INSERT INTO u(k,name,dept,status,level,ms,bytes) VALUES(?,?,?,?,?,?,?)');
  const bind = (i: number): unknown[] => {
    const r = rowAt(i) as { name: string; dept: string; status: string; level: number; ms: number; bytes: number };
    return [`u_${i}`, r.name, r.dept, r.status, r.level, r.ms, r.bytes];
  };

  // 逐条持久写：autocommit，每条一个事务
  const t0 = performance.now();
  for (let i = 0; i < PERSIST; i++) ins.run(...(bind(i) as never[]));
  const persistMs = performance.now() - t0;
  const persistOps = (PERSIST / persistMs) * 1000;

  // 批量：1000 行一个事务
  const t1 = performance.now();
  for (let at = PERSIST; at < ROWS; at += 1000) {
    const n = Math.min(1000, ROWS - at);
    db.exec('BEGIN');
    for (let k = 0; k < n; k++) ins.run(...(bind(at + k) as never[]));
    db.exec('COMMIT');
  }
  const bulkMs = performance.now() - t1;

  const pointStmt = db.prepare('SELECT name FROM u WHERE k=?');
  const enumStmt = db.prepare('SELECT k FROM u WHERE dept=? AND level>=?');
  const rangeStmt = db.prepare('SELECT k FROM u WHERE ms>=? AND ms<=?');

  const POINT = 20000;
  const keyAt = (n: number): string => `u_${(n * 7919) % ROWS}`;
  const pt: number[] = [];
  for (let i = 0; i < POINT; i++) {
    const s = performance.now();
    pointStmt.get(keyAt(i));
    pt.push(performance.now() - s);
  }
  const pointUs = med(pt) * 1000;

  const en: number[] = [];
  for (let i = 0; i < 15; i++) {
    const s = performance.now();
    enumStmt.all('R&D', 5);
    en.push(performance.now() - s);
  }
  const enumUs = med(en) * 1000;

  const r0: number[] = [];
  for (let i = 0; i < 15; i++) {
    const s = performance.now();
    rangeStmt.all(1, 1);
    r0.push(performance.now() - s);
  }
  const range0Us = med(r0) * 1000;

  const r20: number[] = [];
  const hi = Math.round(ROWS * 2 * 0.2);
  for (let i = 0; i < 15; i++) {
    const s = performance.now();
    rangeStmt.all(0, hi);
    r20.push(performance.now() - s);
  }
  const range20Us = med(r20) * 1000;

  db.close();
  let bytes = fs.statSync(file).size;
  const wal = `${file}-wal`;
  if (fs.existsSync(wal)) bytes += fs.statSync(wal).size;

  // 冷启动：打开 + 强制读（count(*) 会走索引，逼它真碰盘）
  const s = performance.now();
  const again = new DatabaseSync(file);
  again.prepare('SELECT count(*) c FROM u').get();
  const openMs = performance.now() - s;

  gc2();
  const m = process.memoryUsage();
  return {
    engine: `sqlite-${mode}`,
    rows: ROWS,
    bytes,
    persistOps,
    persistMs,
    bulkMs,
    openMs,
    pointUs,
    enumUs,
    range0Us,
    range20Us,
    rssMb: m.rss / 1048576,
    heapMb: (m.heapUsed + m.external) / 1048576,
    durable,
    fsyncPerOp: 1, // autocommit 下每个 INSERT 就是一个事务
    note,
  };
}

// ────────────────────────────── 主控 ──────────────────────────────

function gc2(): void {
  const g = (globalThis as { gc?: () => void }).gc;
  if (g) {
    g();
    g();
  }
}

function runChild(engine: string): Result | null {
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--experimental-sqlite',
      '--no-warnings',
      self,
      '--engine',
      engine,
      '--rows',
      String(ROWS),
      '--persist',
      String(PERSIST),
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  );
  const line = (r.stdout ?? '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
  if (!line) {
    console.error(`[${engine}] 子进程无输出`);
    console.error((r.stderr ?? '').slice(-800));
    return null;
  }
  return JSON.parse(line) as Result;
}

/**
 * 本机 write+fsync 延迟：所有写入数字都要靠它解释，先量出来。
 *
 * 注意这一栏量的是 `F_FULLFSYNC` —— Node 的 `fs.fsyncSync` 在 macOS 上走的就是它
 * （真刷到物理介质）。用 Python 的 `os.fsync` 量同一块盘只有 0.15ms，因为那只是
 * `fsync(2)`（到 OS 页缓存）。两个数差 100 倍，不是盘的问题，是「问的东西不一样」。
 */
function fsyncLatency(iter = 20): number {
  const p = path.join(os.tmpdir(), `mstore-fsync-${process.pid}.bin`);
  const fd = fs.openSync(p, 'w');
  const buf = Buffer.alloc(4096);
  const xs: number[] = [];
  for (let i = 0; i < iter; i++) {
    const t = performance.now();
    fs.writeSync(fd, buf, 0, 4096);
    fs.fsyncSync(fd);
    xs.push(performance.now() - t);
  }
  fs.closeSync(fd);
  fs.unlinkSync(p);
  return med(xs);
}

function table(rs: Result[]): string {
  const hdr = '| 指标 | ' + rs.map((r) => r.engine).join(' | ') + ' |';
  const sep = '|---|' + rs.map(() => '---:').join('|') + '|';
  const out: string[] = [hdr, sep];
  const fmt = (v: number, unit: string): string => (v >= 100 ? Math.round(v).toString() : ms1(v).toString()) + unit;

  out.push('| 物理持久（掉电不丢已提交） | ' + rs.map((r) => (r.durable ? '✓' : '**✗ 不保证**')).join(' | ') + ' |');
  out.push('| 磁盘占用 | ' + rs.map((r) => (r.bytes / 1048576).toFixed(1) + 'MB').join(' | ') + ' |');
  out.push('| 逐条持久写 | ' + rs.map((r) => Math.round(r.persistOps).toLocaleString() + ' 行/秒').join(' | ') + ' |');
  out.push('| 逐条写 fsync/行 | ' + rs.map((r) => ms1(r.fsyncPerOp).toString()).join(' | ') + ' |');
  out.push('| 批量导入 | ' + rs.map((r) => fmt((r.rows / r.bulkMs) * 1000, ' 行/秒')).join(' | ') + ' |');
  out.push('| 冷启动 | ' + rs.map((r) => fmt(r.openMs, 'ms')).join(' | ') + ' |');
  out.push('| 点查 | ' + rs.map((r) => fmt(r.pointUs, 'µs')).join(' | ') + ' |');
  out.push('| 枚举+数值过滤 | ' + rs.map((r) => fmt(r.enumUs, 'µs')).join(' | ') + ' |');
  out.push('| 区间命中 0 | ' + rs.map((r) => fmt(r.range0Us, 'µs')).join(' | ') + ' |');
  out.push('| 区间命中 20% | ' + rs.map((r) => fmt(r.range20Us, 'µs')).join(' | ') + ' |');
  out.push('| RSS | ' + rs.map((r) => Math.round(r.rssMb) + 'MB').join(' | ') + ' |');
  out.push('| 堆+external | ' + rs.map((r) => Math.round(r.heapMb) + 'MB').join(' | ') + ' |');
  return out.join('\n');
}

// ── 入口：--engine 是子进程模式，只跑一个引擎并吐一行 JSON ──

if (ENGINE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-vs-'));
  const mode: 'full' | 'wal' | 'quick' = ENGINE.includes('quick') ? 'quick' : ENGINE.includes('wal') ? 'wal' : 'full';
  const r = ENGINE === 'mstore' ? await runMstore(dir) : await runSqlite(dir, mode);
  console.log(JSON.stringify(r));
} else {
  const fy = fsyncLatency();
  console.log(`本机 F_FULLFSYNC 延迟中位数：${fy.toFixed(2)}ms（写 4KB + fsync，Node 走的就是这条）`);
  console.log(`行数 ${ROWS.toLocaleString()}，逐条持久写 ${PERSIST.toLocaleString()} 行`);
  console.log(`注意：「物理持久 ✗」那栏答应的事情更少，它快不代表它强。\n`);

  const results: Result[] = [];
  for (const e of ['mstore', 'sqlite-full', 'sqlite-wal', 'sqlite-quick']) {
    process.stdout.write(`跑 ${e} ... `);
    const r = runChild(e);
    if (!r) process.exit(1);
    console.log('done');
    results.push(r);
  }

  console.log('\n' + table(results));

  const byName = Object.fromEntries(results.map((r) => [r.engine, r]));
  const m = byName['mstore']!;
  const f = byName['sqlite-full']!;
  const wal = byName['sqlite-wal']!;
  const quick = byName['sqlite-quick']!;
  const x = (a: number, b: number): string => {
    const v = a / b;
    return v >= 1 ? `${v >= 10 ? Math.round(v) : ms1(v)}× 快` : `${ms1(1 / v)}× 慢`;
  };
  const line = (label: string, r: Result): string =>
    `  ${label.padEnd(28)} 写 ${x(m.persistOps, r.persistOps)} / 点查 ${x(r.pointUs, m.pointUs)} / ` +
    `枚举 ${x(r.enumUs, m.enumUs)} / 区间0 ${x(r.range0Us, m.range0Us)}`;

  console.log('\nmstore 相对各档 SQLite（写成「快/慢」指 mstore）：');
  console.log(line('sqlite-full  （真持久）', f));
  console.log(line('sqlite-wal   （真持久）', wal));
  console.log(line('sqlite-quick （不保证持久）', quick));
  console.log(`\n磁盘：mstore ${(m.bytes / 1048576).toFixed(1)}MB / sqlite ${(f.bytes / 1048576).toFixed(1)}MB ` +
    `（${ms1(m.bytes / f.bytes)}× 占位）`);
  console.log(`内存：mstore RSS ${Math.round(m.rssMb)}MB / sqlite RSS ${Math.round(f.rssMb)}MB`);
}
