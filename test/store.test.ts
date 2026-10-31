import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.ts';
import { crc32, crc32Impl } from '../src/crc32.ts';
import * as F from '../src/format.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-test-'));
let seq = 0;
const file = (): string => path.join(tmp, `t${seq++}.db`);

test('crc32 增量拼接等于一次算完', () => {
  const b = Buffer.from('mstore-'.repeat(1000));
  const half = Math.floor(b.length / 2);
  const a = crc32(b.subarray(0, half));
  assert.equal(crc32(b.subarray(half), a), crc32(b));
  assert.ok(['zlib.crc32', 'js-table'].includes(crc32Impl));
});

test('创建 / 写入 / 重开 / 读回', async () => {
  const f = file();
  let db = Store.create(f, { segSize: 64 * 1024 });
  for (let i = 0; i < 100; i++) await db.put('biz', `u_${i}`, { name: `用户${i}`, level: i % 9 });
  await db.close();

  db = Store.open(f);
  assert.equal(db.count('biz'), 100);
  const e = db.get('biz', 'u_42');
  assert.deepEqual(e?.v, { name: '用户42', level: 42 % 9 });
  assert.equal(db.list('biz', { limit: 3 }).length, 3);
  const rows = db.list('biz', { limit: 3 });
  const next = db.list('biz', { limit: 3, after: rows[2]!.key });
  assert.equal(next[0]!.key, 'u_3');
  await db.close();
});

test('body 原样存取（不 base64、不 parse）', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 64 * 1024 });
  const body = Buffer.from(JSON.stringify({ steps: Array.from({ length: 50 }, (_, i) => ({ i, out: 'x'.repeat(100) })) }));
  await db.putBody('agent', 'run_1', body, { agent: 'reviewer', status: 'done' });
  assert.deepEqual(db.getBody('agent', 'run_1'), body);
  await db.close();

  const db2 = Store.open(f);
  assert.deepEqual(db2.getBody('agent', 'run_1'), body);
  await db2.close();
});

test('跨段写入：记录数远超单段容量', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 16 * 1024 });
  const n = 500;
  for (let i = 0; i < n; i++) await db.put('capture', `c_${i}`, { host: 'api.example.com', status: 200, i });
  const st = db.stats();
  assert.ok(st.segs.shell >= 2, `应产生多个段，实际 ${st.segs.shell}`);
  await db.close();

  const db2 = Store.open(f);
  assert.equal(db2.count('capture'), n);
  const last = db2.get('capture', 'c_499');
  assert.equal((last?.v as { status: number }).status, 200);
  await db2.close();
});

test('check 通过；破坏一个字节后 check 报错', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 64 * 1024 });
  for (let i = 0; i < 20; i++) await db.put('mock', `m_${i}`, { rule: `^/api/${i}` });
  const r1 = db.check();
  assert.equal(r1.ok, true, JSON.stringify(r1.issues));
  const seg = db.stats().segs.shell;
  assert.ok(seg >= 1);
  await db.close();

  // 把第一个段的 payload 中间改一个字节
  const fd = fs.openSync(f, 'r+');
  const off = 4096 + 1024 * 1024 * 2 + 64 + 10; // 第一个段 payload 内
  const one = Buffer.alloc(1);
  fs.readSync(fd, one, 0, 1, off);
  one[0] = one[0]! ^ 0xff;
  fs.writeSync(fd, one, 0, 1, off);
  fs.fsyncSync(fd);
  fs.closeSync(fd);

  const db2 = Store.open(f);
  const r2 = db2.check();
  assert.equal(r2.ok, false, '应该检测到 CRC 不一致');
  assert.ok(r2.issues.some((i) => i.detail.includes('CRC')));
  await db2.close();
});

test('清空 ns：记录归零、段标记 dead、尾部截断', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 32 * 1024 });
  for (let i = 0; i < 200; i++) await db.put('capture', `c_${i}`, { i, body: 'x'.repeat(40) });
  for (let i = 0; i < 20; i++) await db.put('biz', `u_${i}`, { i });
  const sizeBefore = fs.statSync(f).size;
  const r = await db.clearNs('capture');
  const sizeAfter = fs.statSync(f).size;
  assert.equal(db.count('capture'), 0);
  assert.equal(db.count('biz'), 20, '其他 ns 不受影响');
  assert.ok(r.deadSegs > 0);
  assert.ok(sizeAfter <= sizeBefore, `截断应缩小或持平：${sizeBefore} → ${sizeAfter}`);
  assert.equal(db.check().ok, true);
  await db.close();
});

test('open 页行迁移保留 rowid，不产生幽灵存活行', async () => {
  const db = Store.create(file(), { pageSize: 256 });
  const small = 's'.repeat(10);
  await db.bizPut('a', small);
  await db.bizPut('b', small);
  const before = db.biz.rowidOf('a');
  await db.bizPut('a', 'b'.repeat(220));

  assert.equal(db.biz.rowidOf('a'), before, '只换逻辑页，不能换 rowid');
  assert.equal(db.biz.size, 2, '更新一行不能把 liveCount 加成三行');
  assert.deepEqual(db.bizQuery({}).keys.sort(), ['a', 'b']);
  assert.equal(db.check().ok, true);
  await db.close();
});

test('未落盘 CoW 页存在时，尾段回收不能回退高水位覆盖 live 页', async () => {
  const db = Store.create(file(), { pageSize: 256 });
  await Promise.all(Array.from({ length: 60 }, (_, i) => db.bizPut(`u_${i}`, { i })));
  await db.put('capture', 'tail', { i: 1 });

  await Promise.all([
    db.bizPut('u_0', { i: 0 }),
    db.clearNs('capture'),
  ]);
  const lastPageEnd = Math.max(...db.pages.snapshotDir()) + 256;
  assert.ok(db.meta.hwm >= lastPageEnd, `hwm=${db.meta.hwm} 不能落在 live 页末尾 ${lastPageEnd} 之前`);
  assert.deepEqual(db.bizGet('u_0'), { i: 0 });
  await db.close();

  const again = Store.open(db.io.path, { pageSize: 256 });
  assert.deepEqual(again.bizGet('u_0'), { i: 0 });
  assert.equal(again.check().ok, true);
  await again.close();
});

test('free span 剩余恰好阈值时保留而不是删除', async () => {
  const db = Store.create(file(), { segSize: 64 * 1024 });
  // 制造一个非尾部的空洞：capture 段后面还压着一个 live mock 段，clearNs 才不会截断它
  await db.put('capture', 'a', { i: 1 });
  await db.put('mock', 'keep', { i: 2 });
  await db.clearNs('capture');
  // 空洞 = 64 + 65536 = 65600。frameBody 会加 4 字节长度头，所以 body 61372 → cap 61376。
  // need = 64 + 61376 = 61440，剩余 65600 - 61440 = 4160 = SEG_HEADER_SIZE(64) + 4096，恰等于阈值。
  await db.putBody('mock', 'b', Buffer.alloc(61_372));
  assert.equal(db.meta.freeSpans?.length, 1, '剩余恰等于阈值时 span 必须保留');
  assert.equal(db.meta.freeSpans?.[0]?.len, F.SEG_HEADER_SIZE + 4096);
  await db.close();
});

test('group commit 把 N 次写合并成少数 fsync', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 1024 * 1024 });
  const N = 300;
  const before = db.io.fsyncCount;
  await Promise.all(Array.from({ length: N }, (_, i) => db.put('biz', `k_${i}`, { i })));
  const used = db.io.fsyncCount - before;
  assert.ok(used < N / 2, `fsync 应远小于记录数：${used} < ${N / 2}`);
  assert.equal(db.count('biz'), N);
  await db.close();
});

test('串行逐条提交不在提交窗口上空等', async () => {
  const db = Store.create(file(), { segSize: 1024 * 1024 });
  // 去掉磁盘墙钟时间，只测调度：旧实现每条会先等一个 window，新实现应立即 drain。
  db.io.writeAt = () => 0;
  db.io.fsyncAsync = () => Promise.resolve();
  const w = db.committer.window;
  const N = 10;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) await db.put('biz', `s_${i}`, { i });
  const elapsed = performance.now() - t0;
  assert.ok(
    elapsed < N * w * 0.8,
    `串行 ${N} 条调度耗时 ${elapsed.toFixed(0)}ms，提交窗口 ${w}ms —— 每条都在等满窗口`
  );
  assert.equal(db.count('biz'), N);
  await db.close();
});

test('close 等待 fsync 时拒绝新写入，并等待已接受操作完成', async () => {
  const db = Store.create(file());
  let release = (): void => {};
  let markStarted = (): void => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const realFsync = db.io.fsyncAsync.bind(db.io);
  db.io.fsyncAsync = () => {
    markStarted();
    return new Promise<void>((resolve) => { release = resolve; });
  };
  const accepted = db.bizPut('accepted', { level: 1 });
  await started;
  const closing = db.close();
  await assert.rejects(db.bizPut('too-late', { level: 2 }), /closing|closed/);
  assert.equal(db.bizGet('too-late'), undefined);
  release();
  db.io.fsyncAsync = realFsync;
  await accepted;
  await closing;
});

test('fsync 等待期间读和事件循环仍可运行，ack 仍等刷盘完成', async () => {
  const db = Store.create(file());
  const realFsync = db.io.fsyncAsync.bind(db.io);
  let markStarted = (): void => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let release = (): void => {};
  db.io.fsyncAsync = () => {
    markStarted();
    return new Promise<void>((resolve) => { release = resolve; });
  };

  const pending = db.bizPut('hot', { dept: 'R&D', level: 7 });
  await started;
  assert.deepEqual(db.bizGet('hot'), { dept: 'R&D', level: 7 }, '数据已执行，读不能被 fsync 阻塞');
  let ticked = false;
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      ticked = true;
      resolve();
    }, 0);
  });
  assert.equal(ticked, true, 'fsync 等待不能卡住事件循环');

  let settled = false;
  void pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, '刷盘未完成时不能提前 ack');
  release();
  await pending;
  db.io.fsyncAsync = realFsync;
  await db.close();
});
