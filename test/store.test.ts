import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.ts';
import { crc32, crc32Impl } from '../src/crc32.ts';

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
