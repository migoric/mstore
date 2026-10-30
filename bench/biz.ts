/**
 * 业务数据压测：验证「位图过滤比全表扫快一个数量级」这条主张。
 *
 * 注意写放大：每次 put 都要整页重写（CoW），插入 N 行大约产生
 * 「页数 × 每页写入次数 × 4KB」的写量 —— 这是 CoW 的固有代价，
 * 换来的是「不做 WAL 也能崩溃安全」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.ts';
import { bruteForce } from '../src/bizindex.ts';
import type { Filter } from '../src/bizindex.ts';

const MB = 1048576;
const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const N = Number(arg('--rows', '50000'));
const QUERY_ITERS = Number(arg('--iters', '2000'));

const DEPTS = ['R&D', 'Design', 'QA', 'Ops', 'Sales', 'Support', 'Finance', 'Legal'];
const STATUS = ['active', 'leave', 'gone'];

const pct = (a: number[], p: number): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const fmt = (ms: number): string =>
  ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`;

function row(i: number): Record<string, unknown> {
  return {
    name: `用户${i}`,
    dept: DEPTS[i % DEPTS.length],
    status: STATUS[i % STATUS.length],
    level: i % 9,
    updated_at: 1_700_000_000_000 - i * 1000,
    email: `u${i}@example.com`,
  };
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-biz-bench-'));
  const file = path.join(dir, 'biz.db');

  console.log(`=== 写入：${N} 行业务数据（每行约 130B，页 4KB，48 行/页）===`);
  let db = Store.create(file, { shellCap: MB });
  const t0 = performance.now();
  const BATCH = 2000;
  for (let i = 0; i < N; i += BATCH) {
    await Promise.all(Array.from({ length: Math.min(BATCH, N - i) }, (_, j) => db.bizPut(`u_${i + j}`, row(i + j))));
  }
  const writeMs = performance.now() - t0;
  const st = db.pages.stats();
  const fileSize = fs.statSync(file).size;
  console.log(
    `  用时 ${writeMs.toFixed(0)} ms → ${Math.round(N / (writeMs / 1000))} 行/秒  页数 ${st.pages}  重写 ${st.rewrites} 次`
  );
  console.log(
    `  文件 ${(fileSize / MB).toFixed(1)} MB  有效负载约 ${((N * 130) / MB).toFixed(1)} MB  写放大约 ${(fileSize / ((N * 130) / 1)).toFixed(1)}×`
  );

  console.log('\n=== 查询：位图 vs 全表扫 ===');
  const mirror = Array.from({ length: N }, (_, i) => ({ key: `u_${i}`, value: row(i) }));
  const cases: Array<{ label: string; filter: Filter }> = [
    { label: 'dept=R&D', filter: { eq: { dept: 'R&D' } } },
    { label: 'dept∈{R&D,QA}', filter: { eq: { dept: ['R&D', 'QA'] } } },
    { label: 'dept=R&D + status + 5≤level≤8', filter: { eq: { dept: 'R&D' }, gte: { level: 5 }, lte: { level: 8 } } },
  ];

  for (const c of cases) {
    // 预热 200 次丢弃：第一次查询走的是还没被 JIT 编译的路径，
    // 不预热的话 p50 会被那几十微秒的编译时间抬高。
    for (let i = 0; i < 200; i++) db.bizQuery({ ...c.filter, limit: 50 });

    const lat: number[] = [];
    let hits = 0;
    for (let i = 0; i < QUERY_ITERS; i++) {
      const t = performance.now();
      hits = db.bizQuery({ ...c.filter, limit: 50 }).keys.length;
      lat.push(performance.now() - t);
    }
    const bt: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      bruteForce(mirror, c.filter);
      bt.push(performance.now() - t);
    }
    console.log(
      `  ${c.label.padEnd(34)} 位图 p50=${fmt(pct(lat, 50)).padStart(9)} p99=${fmt(pct(lat, 99)).padStart(9)}` +
        `   全表扫 p50=${fmt(pct(bt, 50)).padStart(9)}   命中前 50 条: ${hits}`
    );
  }

  console.log('\n=== 冷启动（关掉再开，量两条路）===');
  await db.close();

  const open1At = performance.now();
  db = Store.open(file);
  const wall1 = performance.now() - open1At;
  const s1 = db.stats().snapshot;
  console.log(
    `  第 1 次（进程内首次，含 JIT 编译）  ${wall1.toFixed(0)} ms  走 ${db.openPath}` +
      `${s1.note ? ` — ${s1.note}` : ''}  行 ${db.biz.size}  位图 ${db.bizStats().index.bitmaps} 个`
  );
  if (db.openPath !== 'snapshot') {
    console.log('  ⚠ 没命中索引快照：这份库走的是逐页重放，下面的数字不是快照的成本');
  }
  const q = db.bizQuery({ eq: { dept: 'QA' }, gte: { level: 3 } }).keys;
  console.log(`  重开后的查询仍可用：${q.length} 条`);
  await db.close();

  const open2At = performance.now();
  db = Store.open(file);
  const wall2 = performance.now() - open2At;
  console.log(`  第 2 次（JIT 已热，稳态）          ${wall2.toFixed(0)} ms  走 ${db.openPath}  行 ${db.biz.size}`);
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
