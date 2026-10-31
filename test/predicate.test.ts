/**
 * 数值区间查询的块级剪枝。
 *
 * 这一组用例的重点不是「快」，而是「剪枝绝不能漏行」：
 * 剪错会静默丢数据，比慢一个数量级严重得多。所以每条用例都和 bruteForce 对拍，
 * 并且专门覆盖「统计过期」的情形（删除行、覆盖写、NaN）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bitmap } from '../src/bitmap.ts';
import { BizIndex, bruteForce } from '../src/bizindex.ts';
import type { Filter } from '../src/bizindex.ts';

/**
 * 块粒度在 bizindex 里是 4096。这里用 9000 行 = 跨 3 块，够覆盖块边界。
 *
 * 为什么不做成「可以注入更小的块大小」：块号用 `rowid >>> 12` 算，是常量折叠，
 * 改成实例属性后每次取块号都要多一次属性读取，热路径不值得为测试便利让步。
 * 代价是每个 build 要 put 9000 行，所以只读用例共用同一份（见 sharedIdx）。
 */
const BIG = 9000;

const DEPTS = ['R&D', 'Design', 'QA', 'Ops'];

function build(rows: number): { idx: BizIndex; rows: Array<{ key: string; value: Record<string, unknown> }> } {
  const idx = new BizIndex(['dept'], ['level', 'ms']);
  const mirror: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (let i = 0; i < rows; i++) {
    const value = { dept: DEPTS[i % 4], level: i % 9, ms: i };
    idx.put(`u_${i}`, value);
    mirror.push({ key: `u_${i}`, value });
  }
  return { idx, rows: mirror };
}

/** 只读用例共用一份数据：每次 build 9000 行是 1s 级的开销，9 个用例各建一次就是 9 秒 */
let shared: { idx: BizIndex; rows: Array<{ key: string; value: Record<string, unknown> }> } | null = null;
const sharedIdx = (): { idx: BizIndex; rows: Array<{ key: string; value: Record<string, unknown> }> } =>
  (shared ??= build(BIG));

const sameAs = (idx: BizIndex, mirror: Array<{ key: string; value: Record<string, unknown> }>, f: Filter): void => {
  assert.deepEqual(idx.query(f).keys, bruteForce(mirror, f));
};

test('区间查询跨块：结果与全表扫描一致', () => {
  const { idx, rows } = sharedIdx();
  // 正中段、末尾段、单点、整表
  for (const f of [
    { gte: { ms: 3000 }, lte: { ms: 5000 } },
    { gte: { ms: BIG - 10 }, lte: { ms: BIG + 10 } },
    { gte: { ms: 4095 }, lte: { ms: 4096 } }, // 正好跨块边界
    { gte: { ms: 0 }, lte: { ms: BIG - 1 } },
    { gte: { ms: -100 }, lte: { ms: BIG + 100 } },
  ] satisfies Filter[]) {
    sameAs(idx, rows, f);
  }
});

test('区间落在块之间的空隙里 → 空结果（剪枝真的剪掉了东西）', () => {
  const { idx, rows } = sharedIdx();
  const f: Filter = { gte: { ms: 1_000_000 }, lte: { ms: 1_000_100 } };
  assert.deepEqual(idx.query(f).keys, bruteForce(rows, f));
  assert.equal(idx.query(f).keys.length, 0);
});

test('删除行之后统计只放宽不收窄：不会漏掉仍在的行', () => {
  const { idx, rows } = build(BIG);
  // 删掉区间两端（正是块统计的极值来源），再查中间
  for (let i = 3000; i < 3100; i++) idx.delete(`u_${i}`);
  const alive = rows.filter((r) => !(Number(r.key.slice(2)) >= 3000 && Number(r.key.slice(2)) < 3100));
  for (const f of [
    { gte: { ms: 3000 }, lte: { ms: 3200 } },
    { gte: { ms: 2999 }, lte: { ms: 3001 } },
    { gte: { ms: 0 }, lte: { ms: BIG - 1 } },
  ] satisfies Filter[]) {
    assert.deepEqual(idx.query(f).keys, bruteForce(alive, f));
  }
});

test('覆盖写把极值改走：块统计不变窄，仍能查到新值', () => {
  const { idx, rows } = build(BIG);
  // 把 ms 最大值那一行改成很小的值，再把最小值改成很大的值。
  // 统计若跟着收窄，就会把「其实仍能命中」的块剪掉。
  idx.put('u_0', { dept: 'R&D', level: 0, ms: BIG * 10 }, idx.rowidOf('u_0'));
  idx.put(`u_${BIG - 1}`, { dept: 'QA', level: 0, ms: -BIG * 10 }, idx.rowidOf(`u_${BIG - 1}`));
  const mirror = rows.map((r) =>
    r.key === 'u_0'
      ? { key: r.key, value: { dept: 'R&D', level: 0, ms: BIG * 10 } }
      : r.key === `u_${BIG - 1}`
        ? { key: r.key, value: { dept: 'QA', level: 0, ms: -BIG * 10 } }
        : r
  );
  for (const f of [
    { gte: { ms: -BIG * 10 }, lte: { ms: -BIG * 10 } },
    { gte: { ms: BIG * 10 }, lte: { ms: BIG * 10 } },
    { gte: { ms: 5000 }, lte: { ms: 6000 } },
  ] satisfies Filter[]) {
    assert.deepEqual(idx.query(f).keys, bruteForce(mirror, f));
  }
});

test('NaN / 缺字段的行不被区间条件命中，也不影响同块其他行', () => {
  const idx = new BizIndex(['dept'], ['ms']);
  const mirror: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (let i = 0; i < 5000; i++) {
    // 每 10 行一个没有 ms 的行
    const value = i % 10 === 0 ? { dept: 'R&D' } : { dept: 'R&D', ms: i };
    idx.put(`k${i}`, value);
    mirror.push({ key: `k${i}`, value });
  }
  for (const f of [{ gte: { ms: 0 } }, { lte: { ms: 5000 } }, { gte: { ms: 100 }, lte: { ms: 200 } }] satisfies Filter[]) {
    assert.deepEqual(idx.query(f).keys, bruteForce(mirror, f));
  }
  // 确认没有被「空 ms」污染成全量命中
  assert.ok(idx.query({ gte: { ms: 4990 } }).keys.length < 20);
});

test('限流与游标在剪枝路径下行为不变', () => {
  const { idx, rows } = sharedIdx();
  const full = bruteForce(rows, { gte: { ms: 2000 }, lte: { ms: 9000 } });
  for (const limit of [1, 7, 50, 5000]) {
    assert.deepEqual(idx.query({ gte: { ms: 2000 }, lte: { ms: 9000 }, limit }).keys, full.slice(0, limit));
  }
  // after：从某个 key 之后开始
  const after = full[100]!;
  assert.deepEqual(idx.query({ gte: { ms: 2000 }, lte: { ms: 9000 }, after }).keys, full.slice(101));
});

test('未知数值字段 → 空结果（不是抛错，旧行为就是这样）', () => {
  const { idx } = build(100);
  assert.deepEqual(idx.query({ gte: { salary: 1 } }).keys, []);
  assert.deepEqual(idx.query({ lte: { nope: 1 } }).keys, []);
});

test('两个数值字段同时约束：块剪枝取交集，结果与全表扫描一致', () => {
  const { idx, rows } = sharedIdx();
  const cases: Filter[] = [
    { gte: { ms: 3000, level: 4 } },
    { gte: { ms: 3000 }, lte: { ms: 6000, level: 5 } },
    { gte: { ms: 0, level: 0 }, lte: { ms: BIG } },
  ];
  for (const f of cases) sameAs(idx, rows, f);
});

test('两个不同列（走通用逐行判定）时，limit 与游标同样生效', () => {
  const { idx, rows } = sharedIdx();
  // 两个不同列不会合并成单条比较链，走的是通用分支——那条分支的限流/游标
  // 如果没有单独覆盖，把 `>=` 改成 `>`、把 `!==` 改成 `===` 都不会红。
  const f: Filter = { gte: { ms: 3000, level: 4 }, lte: { ms: 8000 } };
  const full = bruteForce(rows, f);
  assert.ok(full.length > 10, `这个夹具要能命中足够多行才有意义，实际 ${full.length}`);
  for (const limit of [1, 3, 9]) {
    assert.deepEqual(idx.query({ ...f, limit }).keys, full.slice(0, limit));
  }
  const after = full[2]!;
  assert.deepEqual(idx.query({ ...f, after }).keys, full.slice(3));
});

test('clear 之后块统计一起归零，不再命中旧行', () => {
  // 用 100 行就够：这条测的是「统计被重置」，不是跨块行为
  const { idx } = build(100);
  idx.clear();
  assert.equal(idx.size, 0);
  assert.equal(idx.rowidOf('u_0'), undefined, 'clear 必须同时移除目录 key');
  assert.deepEqual(idx.query({ gte: { ms: 0 } }).keys, []);
  // 重新写入后仍可查
  idx.put('a', { dept: 'QA', ms: 42 });
  assert.deepEqual(idx.query({ gte: { ms: 0 }, lte: { ms: 100 } }).keys, ['a']);
});

// ---------------- 剪枝必须「真的发生」 ----------------
//
// 只断言结果正确是不够的：剪枝失效时结果依然对，只是慢。
// 变异测试在这里一口气放过 22 个变异体，全是「结果不变、只丢性能」的那种。
// 所以这些用例断言的是 lastScan —— 扫了几个块、走的哪条路。

test('无数值条件时不走剪枝路径（path=full）', () => {
  const { idx } = sharedIdx();
  idx.query({ eq: { dept: 'R&D' } });
  assert.equal(idx.lastScan.path, 'full');
  assert.equal(idx.lastScan.scanned, idx.lastScan.blocks);
  idx.query({});
  assert.equal(idx.lastScan.path, 'full');
});

test('命中 0 的区间查询：一个块都不扫', () => {
  const { idx } = sharedIdx();
  const out = idx.query({ gte: { ms: 1_000_000 }, lte: { ms: 1_000_100 } });
  assert.equal(out.keys.length, 0);
  assert.equal(idx.lastScan.path, 'pruned');
  assert.ok(idx.lastScan.candidates < idx.lastScan.blocks, `候选块应远少于总块：${JSON.stringify(idx.lastScan)}`);
  assert.equal(idx.lastScan.scanned, 0, '候选块为 0 时不该扫任何数据块');
});

test('窄区间只扫少数块，且 candidates/scanned 都被记录下来', () => {
  const { idx } = sharedIdx();
  idx.query({ gte: { ms: 4000 }, lte: { ms: 4100 } });
  const s = idx.lastScan;
  assert.equal(s.path, 'pruned');
  assert.ok(s.candidates >= 1 && s.candidates <= 2, `窄区间应只涉及 1–2 块：${JSON.stringify(s)}`);
  assert.equal(s.scanned, s.candidates);
});

test('宽区间（命中接近 100%）退回全量路径，不做无谓剪枝', () => {
  const { idx } = sharedIdx();
  idx.query({ gte: { ms: -1 }, lte: { ms: BIG + 1 } });
  const s = idx.lastScan;
  assert.equal(s.path, 'full', '一块都剪不掉时应该退回全量遍历');
  // blocks 报的是「真的落过行的块」（9000 行 = 3 块），不含按 2 的幂翻倍时尾上那些空块
  assert.equal(s.blocks, 3, `9000 行只填满 3 块：${JSON.stringify(s)}`);
  assert.ok(s.candidates * 4 >= s.blocks * 3, `候选块应超过 3/4：${JSON.stringify(s)}`);
});

test('候选块正好占 3/4 时退回全量路径（阈值是 >= 不是 >）', () => {
  // 16384 行 = 正好 4 块。查询命中前 3 块 → cand=3、filled=4，
  // 3×4 === 4×3 正好落在阈值边界上。写成 `>` 会在这个点上选择「剪枝」，
  // 而这时一块都剪不掉，只剩下每块重算掩码的纯开销。
  const { idx } = build(16384);
  const out = idx.query({ gte: { ms: 0 }, lte: { ms: 12287 } });
  assert.equal(out.keys.length, 12288, '块 0/1/2 全部命中');
  assert.equal(idx.lastScan.blocks, 4);
  assert.equal(idx.lastScan.candidates, 3);
  assert.equal(idx.lastScan.path, 'full', '正好 3/4 必须退回全量');
});

test('limit 提前退出后不再扫后面的块', () => {
  const { idx } = sharedIdx();
  // 候选必须是 2 块：1 块的话「提前停」和「不提前停」扫出来一样，测不出区别。
  // 而且候选不能超过总块的 3/4，否则会走全量路径（blocks=4 时阈值很紧）。
  idx.query({ gte: { ms: 0 }, lte: { ms: 4100 }, limit: 5 });
  const s = idx.lastScan;
  assert.equal(s.path, 'pruned');
  assert.equal(s.candidates, 2, `应恰好 2 个候选块：${JSON.stringify(s)}`);
  assert.equal(s.scanned, 1, `应在第一个块就停：${JSON.stringify(s)}`);
});

test('快照缺块统计时就地重建，剪枝不会因此失效', () => {
  // 直接构造一份不带 bmin/bmax 的快照，模拟旧版本写出来的数据
  const idx = new BizIndex(['dept'], ['ms']);
  const keys: string[] = [];
  const alive = new Bitmap(BIG + 8);
  for (let i = 0; i < BIG; i++) {
    keys[i] = `s_${i}`;
    alive.set(i);
  }
  const data = new Float64Array(BIG);
  for (let i = 0; i < BIG; i++) data[i] = i;
  idx.restoreSnapshot({
    keys,
    enums: [],
    nums: [{ field: 'ms', data }], // 故意不给 bmin/bmax
    alive,
    state: { nextRowid: BIG, liveCount: BIG, capacity: BIG },
  });
  const out = idx.query({ gte: { ms: 1_000_000 }, lte: { ms: 1_000_100 } });
  assert.equal(out.keys.length, 0);
  assert.equal(idx.lastScan.path, 'pruned');
  assert.ok(idx.lastScan.candidates < idx.lastScan.blocks, '统计应被重建，否则候选块会等于总块数');
});
