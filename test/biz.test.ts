import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.ts';
import { bruteForce } from '../src/bizindex.ts';
import type { Filter } from '../src/bizindex.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-biz-'));
let seq = 0;
const file = (): string => path.join(tmp, `b${seq++}.db`);

const DEPTS = ['R&D', 'Design', 'QA', 'Ops'];
const STATUS = ['active', 'leave', 'gone'];

function makeRow(i: number): Record<string, unknown> {
  return {
    name: `用户${i}`,
    dept: DEPTS[i % DEPTS.length],
    status: STATUS[i % STATUS.length],
    level: i % 9,
    updated_at: 1_700_000_000_000 - i * 1000,
    email: `u${i}@example.com`,
  };
}

async function seed(db: Store, n: number): Promise<void> {
  await Promise.all(Array.from({ length: n }, (_, i) => db.bizPut(`k_${i}`, makeRow(i))));
}

test('写入 / 读回 / 更新 / 删除', async () => {
  const f = file();
  const db = Store.create(f);
  await db.bizPut('k_1', { name: '张远', dept: 'R&D', status: 'active', level: 7 });
  assert.deepEqual(db.bizGet('k_1'), { name: '张远', dept: 'R&D', status: 'active', level: 7 });

  await db.bizPut('k_1', { name: '张远', dept: 'Design', status: 'leave', level: 8 });
  assert.deepEqual(db.bizGet('k_1'), { name: '张远', dept: 'Design', status: 'leave', level: 8 });
  assert.equal(db.biz.size, 1, '更新不应新增行');

  const r = await db.bizDel('k_1');
  assert.equal(r.removed, true);
  assert.equal(db.bizGet('k_1'), undefined);
  assert.equal(db.biz.size, 0);
  assert.equal((await db.bizDel('k_1')).removed, false, '重复删除返回 false');
  await db.close();
});

test('CoW：更新写新偏移，旧偏移的字节不变', async () => {
  const f = file();
  const db = Store.create(f);
  await db.bizPut('k_1', { dept: 'R&D', level: 1 });
  const dirAfterFirst = [...(db.meta.pageDir ?? [])];
  assert.equal(dirAfterFirst.length, 1);
  const oldOff = dirAfterFirst[0]!;
  const oldBytes = Buffer.from(db.io.readAt(oldOff, 4096));

  await db.bizPut('k_1', { dept: 'QA', level: 5 });
  const dirAfterSecond = db.meta.pageDir ?? [];
  assert.notEqual(dirAfterSecond[0], oldOff, '更新必须写到新偏移，不能覆盖旧页');

  const stillOld = db.io.readAt(oldOff, 4096);
  assert.deepEqual(Buffer.from(stillOld), oldBytes, '旧页内容必须原样保留（这就是崩溃安全的来源）');

  const fresh = db.io.readAt(dirAfterSecond[0]!, 4096);
  assert.notDeepEqual(Buffer.from(fresh), oldBytes, '新页应包含更新后的内容');
  assert.ok(db.pages.stats().rewrites >= 2);
  await db.close();
});

test('页装满后自动开新页；单行超页则报错', async () => {
  const f = file();
  const db = Store.create(f, { pageSize: 4096 });
  // 每行约 100B，48 行一页 → 200 行至少 4 页
  await Promise.all(Array.from({ length: 200 }, (_, i) => db.bizPut(`k_${i}`, { name: `n${i}`, dept: 'QA', level: i % 3 })));
  const st = db.pages.stats();
  assert.ok(st.pages >= 4, `应产生多页，实际 ${st.pages}`);
  assert.equal(st.rows, 200);

  // 一行 8KB 塞不进 4KB 页 → 必须明确报错，不能静默丢数据
  await assert.rejects(
    () => db.bizPut('big', { blob: 'x'.repeat(8192) }),
    /page overflow/,
    '超页的行应报错'
  );
  await db.close();
});

test('query：枚举等值 / 数组 / 数值范围 / 组合', async () => {
  const f = file();
  const db = Store.create(f);
  await seed(db, 60);

  assert.deepEqual(
    db.bizQuery({ eq: { dept: 'R&D' } }).keys,
    bruteForce(Array.from({ length: 60 }, (_, i) => ({ key: `k_${i}`, value: makeRow(i) })), { eq: { dept: 'R&D' } })
  );

  const two = db.bizQuery({ eq: { dept: ['R&D', 'QA'] } }).keys;
  assert.equal(two.length, 30, '两个部门各 15 行');

  const gte = db.bizQuery({ gte: { level: 7 } }).keys;
  assert.ok(gte.length > 0);
  for (const k of gte) {
    const v = db.bizGet(k) as { level: number };
    assert.ok(v.level >= 7, `${k} 的 level=${v.level} 不应通过 >=7`);
  }

  const combo = db.bizQuery({ eq: { dept: 'R&D' }, gte: { level: 5 }, lte: { level: 7 } }).keys;
  for (const k of combo) {
    const v = db.bizGet(k) as { dept: string; level: number };
    assert.equal(v.dept, 'R&D');
    assert.ok(v.level >= 5 && v.level <= 7);
  }
  await db.close();
});

test('查询结果与全表扫描完全一致（随机 400 次增删改）', async () => {
  const f = file();
  const db = Store.create(f);
  const mirror = new Map<string, Record<string, unknown>>();
  let seedNum = 7;
  const rnd = (n: number): number => {
    seedNum = (seedNum * 1103515245 + 12345) & 0x7fffffff;
    return seedNum % n;
  };

  // 先确定性地生成操作序列（镜像表同步更新），再一次性提交：
  // committer 的队列是 FIFO，批量提交与逐条提交的最终状态一致
  const ops: Array<() => Promise<unknown>> = [];
  for (let step = 0; step < 400; step++) {
    const key = `k_${rnd(80)}`;
    if (rnd(5) === 0 && mirror.has(key)) {
      mirror.delete(key);
      ops.push(() => db.bizDel(key));
    } else {
      const value = makeRow(rnd(100));
      mirror.set(key, value);
      ops.push(() => db.bizPut(key, value));
    }
  }
  await Promise.all(ops.map((fn) => fn()));

  const rows = [...mirror.entries()].map(([key, value]) => ({ key, value }));
  const cases: Filter[] = [
    {},
    { eq: { dept: 'R&D' } },
    { eq: { dept: ['QA', 'Ops'] } },
    { eq: { status: 'active' } },
    { gte: { level: 4 } },
    { lte: { level: 2 } },
    { eq: { dept: 'Design' }, gte: { level: 3 }, lte: { level: 6 } },
    { eq: { dept: 'R&D', status: 'leave' } },
  ];
  for (const filter of cases) {
    const got = db.bizQuery(filter).keys;
    const want = bruteForce(rows, filter);
    assert.deepEqual([...got].sort(), [...want].sort(), `筛选器不一致：${JSON.stringify(filter)}`);
  }
  assert.equal(db.biz.size, mirror.size);
  await db.close();
});

test('重开库：页目录持久化，索引与查询结果不变', async () => {
  const f = file();
  let db = Store.create(f);
  await seed(db, 40);
  const before = db.bizQuery({ eq: { dept: 'R&D' }, gte: { level: 3 } }).keys;
  const pagesBefore = db.pages.stats().pages;
  await db.close();

  db = Store.open(f);
  assert.equal(db.biz.size, 40, '行数应从页表恢复');
  assert.equal(db.pages.stats().pages, pagesBefore, '页目录应从 meta 恢复');
  const after = db.bizQuery({ eq: { dept: 'R&D' }, gte: { level: 3 } }).keys;
  assert.deepEqual(after, before, '重建出来的位图索引必须给出相同结果');
  assert.equal((db.bizGet('k_7') as { name: string }).name, '用户7');
  await db.close();
});

test('分页游标：after + limit 等价于切片', async () => {
  const f = file();
  const db = Store.create(f);
  await seed(db, 50);
  const all = db.bizQuery({ eq: { dept: 'QA' } }).keys;
  assert.ok(all.length >= 12);
  const first = db.bizQuery({ eq: { dept: 'QA' }, limit: 5 }).keys;
  assert.deepEqual(first, all.slice(0, 5));
  const second = db.bizQuery({ eq: { dept: 'QA' }, after: first.at(-1), limit: 5 }).keys;
  assert.deepEqual(second, all.slice(5, 10));
  await db.close();
});

test('清空业务数据：行与索引一起归零，页目录重置', async () => {
  const f = file();
  const db = Store.create(f);
  await seed(db, 30);
  assert.equal(db.biz.size, 30);
  const r = await db.bizClear();
  assert.equal(r.rows, 30);
  assert.equal(db.biz.size, 0);
  assert.deepEqual(db.bizQuery({ eq: { dept: 'QA' } }).keys, []);
  assert.equal((db.meta.pageDir ?? []).length, 0);
  await db.close();

  const again = Store.open(f);
  assert.equal(again.biz.size, 0, '清空必须持久化');
  await again.close();
});

test('索引一致性：每个枚举值的位图 ≡ 全表扫描', async () => {
  const f = file();
  const db = Store.create(f);
  await seed(db, 64);
  const stats = db.bizStats();
  assert.equal(stats.index.rows, 64);
  assert.ok(stats.index.bitmaps >= DEPTS.length + STATUS.length);

  for (const dept of DEPTS) {
    const viaBitmap = db.bizQuery({ eq: { dept } }).keys;
    const viaScan = Array.from({ length: 64 }, (_, i) => `k_${i}`).filter((k) => (db.bizGet(k) as { dept: string }).dept === dept);
    assert.deepEqual(viaBitmap, viaScan, `${dept} 的位图与扫描不一致`);
  }
  await db.close();
});
