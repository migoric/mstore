/**
 * 数值区间查询：全表扫 vs 块级剪枝。
 *
 *   node --expose-gc bench/predicate.ts [--rows 1000000] [--field ms]
 *
 * 为什么要单独一个 A/B 脚本：光看「优化后多少毫秒」无法判断值不值。
 * 这里把旧算法（遍历存活位图、逐行比较数值）原样重写一遍，和新算法跑同一份数据，
 * 既比耗时也比结果——结果不一致就是剪枝把行剪掉了，那是数据正确性问题。
 *
 * 一个已经踩过的坑：区间条件必须落在 DEFAULT_NUM_FIELDS 里（level / updated_at / ms / bytes）。
 * 用别的字段名（比如 salary）查询会走「字段不存在 → 立刻返回空」的快路径，
 * 量出来是 0ms，看起来像巨大胜利，其实什么都没测。
 *
 * 第二个坑：A/B 不能「旧算法连跑 N 次、再新算法连跑 N 次」。后跑的那个算法要承受
 * 前面积累的 GC 压力，命中 100% 那档因此虚报了 0.9×（真实是 1.05×）。
 * 现在同一轮里交错跑，下一轮把顺序反掉。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.ts';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};

const ROWS = Number(arg('rows', '1000000'));
const FIELD = arg('field', 'ms');
const ITERS = Number(arg('iters', '40'));

const DEPTS = ['R&D', 'Design', 'QA', 'Ops', 'Sales'];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-pred-'));
const file = path.join(dir, 'pred.db');

const db = Store.create(file);
const t0 = performance.now();
for (let at = 0; at < ROWS; at += 2000) {
  await Promise.all(
    Array.from({ length: Math.min(2000, ROWS - at) }, (_, k) => {
      const i = at + k;
      return db.bizPut(`u_${i}`, {
        dept: DEPTS[i % 5],
        level: i % 9,
        ms: i,
      });
    })
  );
}
console.log(`${ROWS.toLocaleString()} 行写入 ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const idx = db.biz;
const nums = idx.snapshotNums().find((c) => c.field === FIELD);
if (!nums) throw new Error(`字段 ${FIELD} 不在数值索引里（默认字段：level / updated_at / ms / bytes）`);
const alive = idx.snapshotAlive();
const data = nums.data;
const total = data.length;

let sink: string[] = [];
const keysOf = (rowids: number[]): void => {
  sink = rowids.map((r) => idx.keyOf(r) ?? '');
};

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]!;
};

/**
 * 旧算法：遍历所有存活行，逐行比数值。limit 只截断结果，不减少扫描。
 *
 * 末尾那次 keyOf 映射是必须的：query() 的返回值里带 keys，两边要做等量的事才有可比性。
 * 少了它，命中率高的场景会把「生成 6 万个 key」的成本全算在新算法头上。
 */
const scanAll = (min: number, max: number, limit: number): number[] => {
  const out: number[] = [];
  alive.forEachWhile((r) => {
    if (out.length >= limit) return false;
    const v = data[r];
    if (v === undefined || Number.isNaN(v) || v < min || v > max) return true;
    out.push(r);
    return true;
  });
  // 必须真的把 key 收下来：只调用不收集的话 V8 会把这段优化掉，
  // 而 query() 那边是实打实分配了 N 个字符串数组，一对比就偏袒了旧算法。
  keysOf(out);
  return out;
};

interface Case {
  label: string;
  min: number;
  max: number;
  limit: number;
}
const cases: Case[] = [
  { label: '命中 20%（正中段）', min: Math.floor(ROWS * 0.4), max: Math.floor(ROWS * 0.6), limit: 1_000_000_000 },
  { label: '命中 20%（取前 50）', min: Math.floor(ROWS * 0.4), max: Math.floor(ROWS * 0.6), limit: 50 },
  { label: '命中 0.01%', min: Math.floor(ROWS * 0.5), max: Math.floor(ROWS * 0.5) + Math.max(1, Math.floor(ROWS / 10000)), limit: 1_000_000_000 },
  { label: '命中 0（区间落在空隙）', min: ROWS + 10, max: ROWS + 20, limit: 1_000_000_000 },
  { label: '命中 100%', min: -1, max: ROWS + 1, limit: 1_000_000_000 },
];

console.log('');
console.log('场景                        全表扫 p50    块剪枝 p50     加速    结果一致');
for (const c of cases) {
  // 预热
  scanAll(c.min, c.max, c.limit);
  idx.query({ gte: { [FIELD]: c.min }, lte: { [FIELD]: c.max }, limit: c.limit });

  const oldLat: number[] = [];
  const newLat: number[] = [];
  let oldOut: number[] = [];
  let newOut: number[] = [];
  // 交错测量：同一轮里 old → new 各跑一次，下一轮把顺序反过来。
  //
  // 之前的写法是「旧算法连跑 40 次，再新算法连跑 40 次」，结果命中 100% 那档报了 0.9×
  // （看起来新算法更慢）。交错之后同一份数据量出来是 1.05×——差的 15% 全部来自
  // 「第二轮跑的时候 GC 压力更大」。固定顺序的 A/B 就是在给后跑的那个算法扣分。
  for (let i = 0; i < ITERS; i++) {
    if (i % 2 === 0) {
      let t = performance.now();
      oldOut = scanAll(c.min, c.max, c.limit);
      oldLat.push(performance.now() - t);
      t = performance.now();
      newOut = idx.query({ gte: { [FIELD]: c.min }, lte: { [FIELD]: c.max }, limit: c.limit }).rowids;
      newLat.push(performance.now() - t);
    } else {
      let t = performance.now();
      newOut = idx.query({ gte: { [FIELD]: c.min }, lte: { [FIELD]: c.max }, limit: c.limit }).rowids;
      newLat.push(performance.now() - t);
      t = performance.now();
      oldOut = scanAll(c.min, c.max, c.limit);
      oldLat.push(performance.now() - t);
    }
  }
  const same = oldOut.length === newOut.length && oldOut.every((v, i) => v === newOut[i]);
  const a = pct(oldLat, 50);
  const b = pct(newLat, 50);
  console.log(
    `${c.label.padEnd(26)} ${(a.toFixed(2) + 'ms').padStart(11)} ${(b.toFixed(2) + 'ms').padStart(13)} ` +
      `${(a / Math.max(b, 0.001)).toFixed(1).padStart(7)}×   ${same ? `是（${newOut.length} 行）` : `否 ← 剪枝剪错，行数 ${oldOut.length} vs ${newOut.length}`}`
  );
  if (!same) process.exitCode = 1;
}

if (sink.length === -1) console.log('unreachable');
await db.close();
fs.rmSync(dir, { recursive: true, force: true });
