/**
 * 造一个演示库：三类数据都放一点，用来跑 CLI 和 macOS 客户端。
 *
 *   node bench/demo.ts [--out data/demo.db] [--biz 3000] [--cap 2000] [--runs 20]
 *
 * 业务行特意做成「枚举 + 数值」都有，方便试位图查询：
 *   dept ∈ {R&D, Design, QA, Ops, Sales}   status ∈ {active, leave, gone}   level 0–8
 */
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.ts';

const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const out = arg('--out', 'data/demo.db');
const N_BIZ = Number(arg('--biz', '3000'));
const N_CAP = Number(arg('--cap', '2000'));
const N_RUN = Number(arg('--runs', '20'));

const DEPTS = ['R&D', 'Design', 'QA', 'Ops', 'Sales'];
const STATUS = ['active', 'leave', 'gone'];

if (fs.existsSync(out)) fs.unlinkSync(out);
fs.mkdirSync(path.dirname(out), { recursive: true });

const t0 = performance.now();
const db = Store.create(out, { segSize: 1024 * 1024 });

// 业务行：一次并发提交（group commit 会合并成极少次 fsync）
await Promise.all(
  Array.from({ length: N_BIZ }, (_, i) =>
    db.bizPut(`u_${i}`, {
      name: `用户${i}`,
      email: `u${i}@example.com`,
      dept: DEPTS[i % DEPTS.length],
      status: STATUS[i % STATUS.length],
      level: i % 9,
      salary: 8000 + (i % 40) * 500,
      updated_at: 1_760_000_000_000 - i * 60_000,
    })
  )
);

/** 分批并发提交：逐条 await 是「一条一次 fsync」，2000 条要 40 秒 */
async function inBatches<T>(n: number, size: number, fn: (i: number) => Promise<T>): Promise<void> {
  for (let at = 0; at < n; at += size) {
    await Promise.all(Array.from({ length: Math.min(size, n - at) }, (_, k) => fn(at + k)));
  }
}

// 抓包：只追加
await inBatches(N_CAP, 500, (i) =>
  db.put('capture', `req_${i}`, {
    method: i % 7 === 0 ? 'POST' : 'GET',
    url: `https://api.example.com/v1/items/${i}`,
    status: 200,
    ms: 12 + (i % 90),
    req_body: i % 7 === 0 ? { id: i, note: 'x'.repeat(40) } : null,
  })
);

// agent 执行结果：schema 不固定的大 JSON
for (let i = 0; i < N_RUN; i++) {
  const body = Buffer.from(
    JSON.stringify({
      run: `run_${i}`,
      steps: Array.from({ length: 30 }, (_, k) => ({ k, tool: 'read', path: `/tmp/f${k}.txt`, out: 'x'.repeat(200) })),
    })
  );
  await db.putBody('agent', `run_${i}`, body, { agent: 'reviewer', status: 'done', score: 0.7 + (i % 3) / 10 });
}

const stats = db.stats();
const biz = db.bizStats();
await db.close();

const size = fs.statSync(out).size;
console.log(`${out}  ${(size / 1048576).toFixed(2)}MB  ${(performance.now() - t0).toFixed(0)}ms`);
console.log(`  biz      ${biz.pages.rows} 行 / ${biz.pages.pages} 页 / ${biz.index.bitmaps} 个位图`);
console.log(`  capture  ${stats.records.capture ?? 0} 条`);
console.log(`  agent    ${stats.records.agent ?? 0} 个 body`);
console.log(`  segs     shell=${stats.segs.shell} body=${stats.segs.body}`);
