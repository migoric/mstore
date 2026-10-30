/**
 * 冷启动对比：索引快照 vs 逐页重放。
 *
 *   node bench/open.ts [--rows 30000] [--rounds 3] [--keep]
 *
 * 只做一件事：同一份数据用两条路打开，比 open 耗时，并验证两条路的查询结果完全相同。
 * 「结果一致」这条断言比耗时更重要——快照一旦和重放不一致，就是数据正确性问题，
 * 不是性能问题了。
 *
 * 两条测量纪律（踩过才知道）：
 *   1. 每一轮必须 `await close()`。早先这里写的是 `void close()`，于是下一轮 open
 *      和上一轮的「写快照 + 写 meta」并发跑，量出来的是 I/O 竞争，不是冷启动。
 *   2. 先跑一轮丢弃做预热。第一轮的 JIT 编译时间会算进 openMs，30k 行能差 17ms。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.ts';
import type { Filter } from '../src/bizindex.ts';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};

const ROWS = Number(arg('rows', '30000'));
const ROUNDS = Math.max(1, Number(arg('rounds', '3')));
const KEEP = process.argv.includes('--keep');

const DEPTS = ['R&D', 'Design', 'QA', 'Ops', 'Sales'];
const STATUS = ['active', 'leave', 'gone'];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-open-'));
const file = path.join(dir, 'bench.db');

const db = Store.create(file);
const t0 = performance.now();
const BATCH = 2000;
for (let at = 0; at < ROWS; at += BATCH) {
  await Promise.all(
    Array.from({ length: Math.min(BATCH, ROWS - at) }, (_, k) => {
      const i = at + k;
      return db.bizPut(`u_${i}`, {
        name: `用户${i}`,
        dept: DEPTS[i % 5],
        status: STATUS[i % 3],
        level: i % 9,
        salary: 8000 + (i % 40) * 500,
      });
    })
  );
}
const tWrite = performance.now() - t0;
const tClose = performance.now();
await db.close();
const closeMs = performance.now() - tClose;

const size = fs.statSync(file).size;
console.log(`写入 ${ROWS} 行 ${tWrite.toFixed(0)}ms · close（内含写快照）${closeMs.toFixed(0)}ms · 文件 ${(size / 1048576).toFixed(2)}MB`);

const FILTERS: Filter[] = [
  { eq: { dept: 'R&D' } },
  { eq: { dept: ['R&D', 'QA'] } },
  { eq: { dept: 'R&D', status: 'active' }, gte: { level: 4 } },
  { eq: { status: 'gone' }, lte: { level: 3 } },
  { gte: { salary: 12000 }, lte: { salary: 20000 } },
];

interface Round {
  ms: number;
  path: string;
  note: string;
  results: string[];
}

const run = async (snapshot: boolean): Promise<Round> => {
  const s = Store.open(file, { snapshot });
  const st = s.stats();
  const results = FILTERS.map((f) => s.bizQuery(f).keys.join());
  const out = { ms: st.snapshot.openMs, path: s.openPath, note: st.snapshot.note, results };
  // 必须等它关完：close 里要写 meta 和快照，不等就会和下一轮 open 抢 I/O
  await s.close();
  return out;
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

// 预热一轮丢弃：JIT + 文件页缓存
await run(true);
await run(false);

const snaps: Round[] = [];
const replays: Round[] = [];
for (let r = 0; r < ROUNDS; r++) {
  snaps.push(await run(true));
  replays.push(await run(false));
}

console.log('');
console.log(`路径        中位耗时      各轮                         说明`);
for (const [label, rounds] of [
  ['快照', snaps],
  ['重放', replays],
] as const) {
  const times = rounds.map((x) => x.ms);
  const detail = times.map((t) => t.toFixed(1)).join(' / ');
  const first = rounds[0]!;
  console.log(
    `${label}        ${`${median(times).toFixed(2)}ms`.padStart(7)}       ${detail.padEnd(24)}   ` +
      `${first.path}${first.note ? ` (${first.note})` : ''}`
  );
}
const speedup = median(replays.map((x) => x.ms)) / median(snaps.map((x) => x.ms));
console.log(`加速        ${speedup.toFixed(1)}×（按中位数）`);

let same = true;
for (const r of [...snaps, ...replays]) {
  for (let i = 0; i < FILTERS.length; i++) {
    if (r.results[i] !== snaps[0]!.results[i]) same = false;
  }
}
console.log(
  `结果一致    ${same ? `是（${FILTERS.length} 组筛选器 × ${ROUNDS + 1} 轮，逐字节相同）` : '否 —— 这是 bug，先修再谈性能'}`
);

if (!KEEP) fs.rmSync(dir, { recursive: true, force: true });
else console.log(`保留 ${file}`);
if (!same) process.exitCode = 1;
