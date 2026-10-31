import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Io } from '../src/io.ts';
import { MemoryKeyDirectory, PersistentKeyDirectory, encodeKeyDirectory, readKeyPageDir } from '../src/keydir.ts';
import { Store } from '../src/store.ts';
import * as F from '../src/format.ts';
import type { KeyIndexMeta } from '../src/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-keydir-'));
let seq = 0;
const file = (): string => path.join(tmp, `k${seq++}.db`);

function memoryRows(n: number): MemoryKeyDirectory {
  const dir = new MemoryKeyDirectory();
  for (let i = 0; i < n; i++) {
    const key = i % 100 === 0 ? `用户_${i}` : `k_${String(i).padStart(5, '0')}`;
    dir.set(key, { logical: Math.floor(i / 40), rowid: i });
  }
  return dir;
}

function persist(dir: MemoryKeyDirectory, pageDir: number[] = [4096]): { io: Io; meta: KeyIndexMeta; payload: Buffer } {
  const io = Io.open(file(), { create: true });
  const encoded = encodeKeyDirectory(dir, pageDir, 0, 1);
  io.writeAt(encoded.payload, 0);
  return { io, meta: { seg: 1, ...encoded.meta }, payload: encoded.payload };
}

test('内存目录允许首行 rowid=0，并保留 logical / rowid 双向映射', () => {
  const dir = new MemoryKeyDirectory();
  dir.set('a', { logical: 0 });
  assert.equal(dir.get('a')?.rowid, undefined);
  dir.set('a', { rowid: 0 });
  assert.deepEqual(dir.get('a'), { logical: 0, rowid: 0 });
  assert.equal(dir.getKey(0), 'a');
  dir.delete('a');
  assert.equal(dir.get('a'), undefined);
  assert.equal(dir.getKey(0), undefined);
});

test('同一个 key 换 rowid 时，旧 rowid 的反查必须清掉', () => {
  const dir = new MemoryKeyDirectory();
  dir.set('a', { rowid: 1 });
  assert.equal(dir.getKey(1), 'a');
  dir.set('a', { rowid: 2 });
  assert.equal(dir.getKey(1), undefined, '旧 rowid 1 不能再反查到 a');
  assert.equal(dir.getKey(2), 'a');
  assert.equal(dir.get('a')?.rowid, 2);
});

test('持久化多块索引支持全量点查、rowid 反查、Unicode 与增量增删', () => {
  const { io, meta } = persist(memoryRows(1000));
  const dir = new PersistentKeyDirectory(io, meta);
  assert.ok(meta.primaryCount > 1);
  assert.ok(meta.reverseCount > 1);
  for (let i = 0; i < 1000; i += 37) {
    const key = i % 100 === 0 ? `用户_${i}` : `k_${String(i).padStart(5, '0')}`;
    assert.deepEqual(dir.get(key), { logical: Math.floor(i / 40), rowid: i });
    assert.equal(dir.getKey(i), key);
  }
  assert.equal(dir.get('missing'), undefined);
  assert.equal(dir.getKey(5000), undefined);

  dir.set('new', { logical: 26, rowid: 1000 });
  assert.equal(dir.size, 1001);
  dir.delete('k_00002');
  assert.equal(dir.size, 1000);
  assert.equal(dir.get('k_00002'), undefined);
  assert.equal(dir.getKey(2), undefined);
  assert.deepEqual(dir.get('new'), { logical: 26, rowid: 1000 });
  assert.equal(dir.getKey(1000), 'new');
  assert.equal([...dir.entries()].length, 1000);
  io.close();
});

test('记录恰好装满 4096 字节块时，下一块从正确 key 开始', () => {
  const mem = new MemoryKeyDirectory();
  mem.set('a', { logical: 0, rowid: 0 });
  // 块账（修复后）：8B 块头 + (10+1) + (10+4067) = 4096，恰好装满
  mem.set('b'.repeat(4067), { logical: 0, rowid: 1 });
  mem.set('c', { logical: 0, rowid: 2 });
  const { io, meta } = persist(mem);
  const dir = new PersistentKeyDirectory(io, meta) as unknown as { firstKeys: string[] };
  assert.equal(meta.primaryCount, 2);
  assert.deepEqual(dir.firstKeys, ['a', 'c']);
  io.close();
});

test('首条 key 记录也计入 4096 字节块预算', () => {
  const mem = new MemoryKeyDirectory();
  mem.set('a', { logical: 0, rowid: 0 });
  mem.set('b'.repeat(4078), { logical: 0, rowid: 1 });
  mem.set('c', { logical: 0, rowid: 2 });
  const { io, meta, payload } = persist(mem);
  const dir = new PersistentKeyDirectory(io, meta) as unknown as { primaryOffsets: number[] };
  for (const off of dir.primaryOffsets) {
    assert.ok(payload.readUInt32LE(off) + 8 <= 4096, '实际块长不能超过声明预算');
  }
  io.close();
});

test('读取第 65 个块后仍严格保留 64 个缓存块', () => {
  const mem = new MemoryKeyDirectory();
  const keys: string[] = [];
  for (let i = 0; i < 65; i++) {
    const key = `${i}_` + 'x'.repeat(4090);
    keys.push(key);
    mem.set(key, { logical: 0, rowid: i });
  }
  const { io, meta } = persist(mem);
  const dir = new PersistentKeyDirectory(io, meta);
  for (const key of keys) assert.ok(dir.get(key));
  assert.equal(dir.cachedBlocks, 64);
  io.close();
});

test('二进制页目录保留 0、4GB 以上和 MAX_SAFE_INTEGER 偏移', () => {
  const offsets = [0, 2 ** 32 + 12345, Number.MAX_SAFE_INTEGER];
  const { io, meta } = persist(memoryRows(1), offsets);
  assert.deepEqual(readKeyPageDir(io, meta), offsets);
  io.close();
});

test('块 CRC 损坏在读取时明确报错，页脚或头部损坏在打开时拒绝', () => {
  const a = persist(memoryRows(1000));
  const dir = new PersistentKeyDirectory(a.io, a.meta);
  a.io.writeAt(Buffer.from([0xff]), a.meta.primaryOff + 8);
  assert.throws(() => dir.get('k_00001'), /key block CRC mismatch/);
  a.io.close();

  const b = persist(memoryRows(10));
  b.io.writeAt(Buffer.from([0xff]), b.meta.indexOff);
  assert.throws(() => new PersistentKeyDirectory(b.io, b.meta), /footer CRC mismatch/);
  b.io.close();

  const c = persist(memoryRows(10));
  c.io.writeAt(Buffer.from('BAD'), c.meta.off);
  assert.throws(() => new PersistentKeyDirectory(c.io, c.meta), /unsupported key index header/);
  c.io.close();
});

test('Store 重开使用持久化目录，增量写删后可再次恢复', async () => {
  const f = file();
  let db = Store.create(f);
  await Promise.all(Array.from({ length: 200 }, (_, i) => db.bizPut(`u_${i}`, { dept: i % 2 ? 'QA' : 'R&D', level: i % 9 })));
  await db.close();

  db = Store.open(f);
  assert.equal(db.directory.persistent, true);
  assert.equal(db.openPath, 'snapshot');
  const openBytes = db.io.bytesRead;
  assert.equal(db.stats().segs.keys, 1);
  assert.equal(db.check().ok, true, JSON.stringify(db.check().issues));
  assert.equal(db.directory.size, 200);
  assert.ok(openBytes < db.meta.keys!.len + db.meta.snap!.len + 100_000, '打开不能顺序读取全部 key 块');
  await db.bizPut('u_0', { dept: 'R&D', level: 99 });
  await db.bizDel('u_1');
  await db.bizPut('new', { dept: 'QA', level: 1 });
  await db.close();

  db = Store.open(f, { snapshot: false });
  assert.equal(db.openPath, 'replay');
  assert.equal(db.directory.persistent, true);
  assert.equal(db.directory.size, 200);
  assert.deepEqual(db.bizGet('u_0'), { dept: 'R&D', level: 99 });
  assert.equal(db.bizGet('u_1'), undefined);
  assert.deepEqual(db.bizGet('new'), { dept: 'QA', level: 1 });
  assert.equal(db.directory.getKey(199), 'u_199');
  const added = await db.bizPut('after-replay', { dept: 'QA', level: 2 });
  assert.equal(added.rowid, 201, 'replay 必须恢复 nextRowid，不能从 0 重新撞号');
  assert.equal(db.bizQuery({}).keys.includes('after-replay'), true);
  assert.equal(new Set(db.bizQuery({}).keys).size, db.biz.size);
  assert.equal(db.check().ok, true);
  await db.close();
});

test('key 页目录损坏时 Store 回退页扫描，不携带错误物理偏移', async () => {
  const f = file();
  let db = Store.create(f);
  await Promise.all(Array.from({ length: 20 }, (_, i) => db.bizPut(`u_${i}`, { dept: 'QA', level: i })));
  await db.close();
  const meta = db.meta.keys!;
  const fd = fs.openSync(f, 'r+');
  fs.writeSync(fd, Buffer.from([0xff]), 0, 1, meta.dirOff);
  fs.closeSync(fd);

  db = Store.open(f);
  assert.equal(db.directory.persistent, false);
  assert.deepEqual(db.bizGet('u_0'), { dept: 'QA', level: 0 });
  assert.equal(db.biz.size, 20);
  await db.close();
});

test('key 索引重复写跳过，bizClear 后旧段与指针全部退役', async () => {
  const f = file();
  const db = Store.create(f);
  await db.bizPut('a', { dept: 'R&D' });
  assert.equal(db.writeKeyIndex(), true, '首次物化必须写入');
  assert.equal(db.writeKeyIndex(), false, 'epoch 没变时不能重复写');
  await db.bizClear();
  assert.equal(db.writeKeyIndex(), false, '空目录不能写索引段');
  await db.close();

  const again = Store.open(f);
  assert.equal(again.directory.size, 0);
  assert.equal(again.meta.keys, undefined);
  assert.equal(again.meta.segs.some((s) => s.type === F.T.KEYS && s.live), false);
  await again.close();
});
