/**
 * 冷启动对比：索引快照 vs 逐页重放。
 *
 *   node bench/open.ts [--rows 30000] [--keep]
 *
 * 只做一件事：同一份数据用两条路打开，比 open 耗时，并验证两条路的查询结果完全相同。
 * 「结果一致」这条断言比耗时更重要——快照一旦和重放不一致，就是数据正确性问题，
 * 不是性能问题了。
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

const run = (snapshot: boolean): { ms: number; path: string; note: string; results: string[] } => {
  const s = Store.open(file, { snapshot });
  const st = s.stats();
  const results = FILTERS.map((f) => s.bizQuery(f).keys.join());
  const out = { ms: st.snapshot.openMs, path: s.openPath, note: st.snapshot.note, results };
  // close 会重写快照，这里只是为了让下一次 open 的状态可预测
  void s.close();
  return out;
};

const withSnap = run(true);
const noSnap = run(false);

console.log('');
console.log('路径        耗时        说明');
console.log(`快照        ${withSnap.ms.toFixed(2).padStart(7)}ms   ${withSnap.path}${withSnap.note ? ` (${withSnap.note})` : ''}`);
console.log(`重放        ${noSnap.ms.toFixed(2).padStart(7)}ms   ${noSnap.path}${noSnap.note ? ` (${noSnap.note})` : ''}`);
console.log(`加速        ${(noSnap.ms / withSnap.ms).toFixed(1)}×`);

let same = true;
for (let i = 0; i < FILTERS.length; i++) {
  if (withSnap.results[i] !== noSnap.results[i]) same = false;
}
console.log(`结果一致    ${same ? '是（5 组筛选器逐字节相同）' : '否 —— 这是 bug，先修再谈性能'}`);

if (!KEEP) fs.rmSync(dir, { recursive: true, force: true });
else console.log(`保留 ${file}`);
if (!same) process.exitCode = 1;
