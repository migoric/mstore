/**
 * 内核快速用例：段分配、清空、回收、双 meta 恢复、列表游标。
 *
 * 与 store.test.ts 的分工：
 *   - store.test.ts 跑长流程（跨段 500 条、200 条清空），验证「规模上不出错」，跑得慢（≈52s）
 *   - 这个文件只压分支，全程批量提交（一次 fsync 提交一批），几秒跑完
 * 慢测试没法支撑变异测试（每个变异都要重跑一遍），所以分支覆盖必须落在这里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.ts';
import * as F from '../src/format.ts';
import type { Meta } from '../src/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-core-'));
let seq = 0;
const file = (): string => path.join(tmp, `c${seq++}.db`);

/** 一批并发提交：group commit 会把它们合并成极少次 fsync */
const batch = <T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]> =>
  Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

/** 读「此刻磁盘上」生效的那份 meta —— 不看内存，用来模拟「没来得及 close 就断电」 */
function metaOnDisk(f: string): Meta {
  const buf = fs.readFileSync(f);
  const a = F.decodeMeta(buf.subarray(F.META_A_OFF, F.META_A_OFF + F.META_SIZE));
  const b = F.decodeMeta(buf.subarray(F.META_B_OFF, F.META_B_OFF + F.META_SIZE));
  const alive = [a, b].filter((m): m is Meta => m !== null);
  assert.ok(alive.length > 0, '磁盘上至少要有一份可用 meta');
  return alive.sort((x, y) => y.gen - x.gen)[0]!;
}

/** 第一个存活 shell 段的偏移（改文件头用的） */
const firstShellOff = (f: string): number => {
  const seg = metaOnDisk(f).segs.find((s) => s.live && s.type === F.T.SHELL);
  assert.ok(seg, '应该有一个 shell 段');
  return seg!.off;
};

const segsOf = (db: Store, ns: string): number[] =>
  db.meta.segs.filter((s) => s.ns === F.nsId(ns) && s.live).map((s) => s.off);

test('put / get / del / count：seq 按提交顺序递增，删掉就查不到', async () => {
  const db = Store.create(file(), { segSize: 32 * 1024 });
  const rs = await batch(5, (i) => db.put('capture', `k${i}`, { i }));
  assert.deepEqual(rs.map((r) => r.seq), [1, 2, 3, 4, 5], '提交队列 FIFO，seq 必须连号');
  assert.equal(db.count('capture'), 5);
  assert.deepEqual(db.get('capture', 'k3')?.v, { i: 3 });
  assert.equal(db.get('capture', 'nope'), undefined);

  const d = await db.del('capture', 'k2');
  assert.ok(d.seq > 5, '删除也要占一个 seq');
  assert.equal(db.count('capture'), 4);
  assert.equal(db.get('capture', 'k2'), undefined);
  assert.equal(db.count('mock'), 0, '没写过的 ns 计数为 0');
  await db.del('capture', '另一个不存在的'); // 删不存在的 key 不该炸
  await db.close();
});

test('list：按写入顺序、默认 limit 50、after 命中与未命中', async () => {
  const db = Store.create(file(), { segSize: 64 * 1024 });
  await batch(60, (i) => db.put('capture', `c_${String(i).padStart(2, '0')}`, { i }));

  assert.equal(db.list('capture').length, 50, '默认 limit 50');
  assert.deepEqual(
    db.list('capture', { limit: 3 }).map((r) => r.key),
    ['c_00', 'c_01', 'c_02']
  );
  assert.deepEqual(
    db.list('capture', { limit: 3, after: 'c_00' }).map((r) => r.key),
    ['c_01', 'c_02', 'c_03'],
    'after 落在第 0 个也必须往后挪一格'
  );
  assert.deepEqual(
    db.list('capture', { limit: 2, after: '查无此键' }).map((r) => r.key),
    ['c_00', 'c_01'],
    'after 不存在时从头开始'
  );
  const ts = db.list('capture', { limit: 1 })[0]!.ts;
  assert.ok(ts > 0, '列表要带上写入时间戳');
  await db.close();
});

test('body：原样进出，locator 落在段范围内，check 通过', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 64 * 1024 });
  const body = Buffer.from(JSON.stringify({ steps: Array.from({ length: 20 }, (_, i) => ({ i, out: 'x'.repeat(80) })) }));
  const { loc } = await db.putBody('agent', 'run_1', body, { agent: 'reviewer' });

  assert.deepEqual(db.getBody('agent', 'run_1'), body);
  assert.deepEqual(db.bodyAt(loc!), body, '拿 locator 直接读也要一致');
  assert.equal(db.getBody('agent', '没有 body 的键'), null);
  assert.equal(db.check().ok, true, JSON.stringify(db.check().issues));
  await db.close();

  const again = Store.open(f);
  assert.deepEqual(again.getBody('agent', 'run_1'), body, 'body 不靠重放，靠 shell 里的 locator');
  await again.close();
});

test('重开之后接着写同一个 shell 段，而不是另开一段', async () => {
  const f = file();
  let db = Store.create(f, { segSize: 64 * 1024 });
  await db.put('mock', 'a', 1);
  await db.close();

  db = Store.open(f);
  const before = db.stats().segs.shell;
  await db.put('mock', 'b', 2);
  assert.equal(db.stats().segs.shell, before, '应接上旧段继续追加');
  await db.close();

  const again = Store.open(f);
  assert.equal(again.count('mock'), 2);
  assert.deepEqual(again.get('mock', 'a')?.v, 1);
  await again.close();
});

test('shell 段写满自动开新段；单条记录超过段容量必须报错', async () => {
  const db = Store.create(file(), { segSize: 4096 });
  await batch(40, (i) => db.put('capture', `c_${i}`, { pad: 'x'.repeat(100), i }));
  assert.ok(db.stats().segs.shell >= 2, `应写满多段，实际 ${db.stats().segs.shell}`);
  assert.equal(db.count('capture'), 40);

  await assert.rejects(
    () => db.put('capture', 'big', { pad: 'x'.repeat(5000) }),
    /too large for shellCap/,
    '装不下的记录要明确报错，不能静默截断'
  );
  await db.close();
});

test('clearNs：只清自己的 ns，尾部死段直接截断归还空间', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 4096 });
  await batch(60, (i) => db.put('capture', `c_${i}`, { i, pad: 'x'.repeat(60) }));
  const sizeBefore = fs.statSync(f).size;

  const r = await db.clearNs('capture');
  assert.equal(db.count('capture'), 0);
  assert.ok(r.deadSegs >= 2, `应有多个段被标死，实际 ${r.deadSegs}`);
  assert.ok(r.truncated >= 1, '死段在物理尾部就该截断');
  assert.ok(r.freedBytes > 0, '截断必须真的还空间');
  assert.ok(fs.statSync(f).size < sizeBefore, `文件应变小：${sizeBefore} → ${fs.statSync(f).size}`);
  assert.equal(db.check().ok, true, JSON.stringify(db.check().issues));
  assert.deepEqual(db.meta.pending, [], '死段全在尾部、已经截掉了，不该再留 pending');

  const after = await db.put('capture', 'x', 1);
  assert.equal(after.seq, 1, '清空之后 seq 归零');
  await db.close();
});

test('中间死段不截断，登记成空洞后被下一次分配复用', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 16 * 1024 });
  await batch(40, (i) => db.put('capture', `c_${i}`, { i, pad: 'x'.repeat(60) }));
  await db.put('mock', 'u_1', { i: 1 }); // mock 段落在后面，把 capture 段顶在中间

  const capOffs = segsOf(db, 'capture');
  assert.equal(capOffs.length, 1);
  const sizeBefore = fs.statSync(f).size;

  const r = await db.clearNs('capture');
  assert.equal(r.truncated, 0, '死的不是物理尾段，不能截断');
  assert.equal(r.freedBytes, 0);
  assert.ok(db.meta.pending.length > 0, '中间死段应进 pending 等打洞');
  assert.equal(fs.statSync(f).size, sizeBefore, '不截断就不该改文件大小');

  await db.put('capture', 'again', 1);
  const reused = segsOf(db, 'capture');
  assert.equal(reused.length, 1);
  assert.equal(reused[0], capOffs[0], '新段应复用空洞的偏移，而不是继续往后长');
  await db.close();
});

test('reclaim：没有打洞助手时不动文件，pending 原样保留', async () => {
  const db = Store.create(file(), { segSize: 16 * 1024 });
  await batch(40, (i) => db.put('capture', `c_${i}`, { i, pad: 'x'.repeat(60) }));
  await db.put('mock', 'u_1', 1);
  await db.clearNs('capture');
  const pendingBefore = db.meta.pending.length;
  assert.ok(pendingBefore > 0);

  const r = db.reclaim();
  assert.equal(r.punched, 0, '本机没有 MSTORE_PUNCH_HELPER，不该谎报打通了');
  assert.equal(r.bytes, 0);
  assert.equal(db.meta.pending.length, pendingBefore, '没打通就得留在 pending 里下次再试');
  await db.close();
});

test('双 meta：坏掉一块仍能打开，两块都坏才报错', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 32 * 1024 });
  await db.put('mock', 'a', 1);
  await db.flush(); // 强制把 meta 落到一个槽
  await db.put('mock', 'b', 2);
  await db.flush(); // 再落到另一个槽，此时两块 meta 都是有效数据
  await db.close();
  const pristine = `${f}.pristine`;
  fs.copyFileSync(f, pristine);

  const wipe = (offsets: number[]): void => {
    const fd = fs.openSync(f, 'r+');
    for (const off of offsets) fs.writeSync(fd, Buffer.alloc(4096), 0, 4096, off);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  };

  wipe([F.META_A_OFF]);
  const one = Store.open(f);
  assert.equal(one.count('mock'), 2, 'meta.a 坏了应该回落到 meta.b');
  await one.close();

  fs.copyFileSync(pristine, f);
  wipe([F.META_A_OFF, F.META_B_OFF]);
  assert.throws(() => Store.open(f), /both meta blocks are corrupt/, '两块都坏必须明确报错');
});

test('stats：段数、死段数、记录数、seq 自洽', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 16 * 1024 });
  await db.put('mock', 'u_1', 1); // 先写 mock，让它落在中间，清空时才不会被尾部截断
  await batch(30, (i) => db.put('capture', `c_${i}`, { i, pad: 'x'.repeat(60) }));
  await db.putBody('agent', 'run_1', Buffer.from('x'.repeat(500)));
  await db.clearNs('mock');

  const st = db.stats();
  assert.equal(st.segs.shell >= 2, true, 'capture 占满一段以上');
  assert.ok(st.segs.body >= 1, 'body 段也算进去');
  assert.equal(st.deadSegs, 1, '只有 mock 那一段死了');
  assert.equal(st.records.capture, 30);
  assert.equal(st.records.agent, 1);
  assert.equal(st.records.mock, undefined, '清空后连条目都不该留着');
  assert.equal(st.seqs['2'], 30, 'capture 的 seq 水位');
  assert.equal(st.seqs['3'], 0, '清空把 seq 归零');
  assert.equal(st.segSize, 16 * 1024);
  assert.ok(st.bytesLogical > 0 && st.bytesAllocated > 0);
  assert.ok(st.fsyncs > 0);
  await db.close();
});

test('重开之后 seq 接着涨，不会从 1 重新开始', async () => {
  const f = file();
  let db = Store.create(f, { segSize: 16 * 1024 });
  await batch(3, (i) => db.put('capture', `c_${i}`, i));
  await db.close();

  db = Store.open(f);
  assert.equal(db.stats().seqs['2'], 3, '重放 shell 要把 seq 水位捞回来');
  const r = await db.put('capture', 'c_9', 9);
  assert.equal(r.seq, 4, 'seq 必须接着涨，否则会跟老记录撞号');
  await db.close();
});

test('reclaim：有打洞能力时，段表里真把死段摘掉', async () => {
  const db = Store.create(file(), { segSize: 16 * 1024 });
  await batch(20, (i) => db.put('capture', `c_${i}`, { i, pad: 'x'.repeat(60) }));
  await db.put('mock', 'u_1', 1);
  await db.clearNs('capture');
  const pending = db.meta.pending.length;
  assert.ok(pending > 0);

  // 本机没有打洞助手（Node 没 fcntl），塞个假的验证「打通之后」的段表变化
  (db.io as unknown as { punchHole: () => boolean }).punchHole = () => true;
  const r = db.reclaim();

  assert.equal(r.punched, pending);
  assert.ok(r.bytes > 0);
  assert.equal(db.meta.pending.length, 0, '打通成功的段不该留在 pending');
  assert.equal(
    db.meta.segs.filter((s) => s.ns === F.nsId('capture')).length,
    0,
    '打通的段要从段表里摘掉，否则下次分配会踩到它'
  );
  await db.close();
});

test('close 幂等：重复 close 直接返回，不炸', async () => {
  const db = Store.create(file(), { segSize: 16 * 1024 });
  await db.put('mock', 'a', 1);
  await db.close();
  assert.equal(db.closed, true);
  await db.close(); // 第二次应该什么都不做
});

test('check：shell / body 段数分别对得上，正常库不报 rows drift', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 4096 });
  await batch(60, (i) => db.put('capture', `c_${i}`, { i, pad: 'x'.repeat(60) }));
  await db.putBody('agent', 'run_1', Buffer.from('x'.repeat(300)));

  const shells = db.meta.segs.filter((s) => s.live && s.type === F.T.SHELL).length;
  const bodies = db.meta.segs.filter((s) => s.live && s.type === F.T.BODY).length;
  assert.ok(shells >= 2, `capture 要写满多段，实际 ${shells}`);
  assert.equal(bodies, 1);

  const rep = db.check();
  assert.equal(rep.ok, true, JSON.stringify(rep.issues));
  assert.equal(rep.shellSegs, shells, 'shell 段不能把 body 也算进来');
  assert.equal(rep.bodySegs, bodies);
  assert.equal(rep.segs, db.meta.segs.length);
  // 一条 issue 都不该有：len drift / rows drift / trailing partial line 这类告警
  // 一旦在干净库上冒出来，真正的告警就被淹没了
  assert.deepEqual(rep.issues, [], '干净的库一条 issue 都不该有');
  await db.close();
});

// ---------------- 崩溃窗口与自检的判据 ----------------

test('一条坏行不能带走后面所有行，也不该被误报成「尾部半行」', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 4096 });
  await db.put('capture', 'a', 1);
  await db.put('capture', 'b', 2);
  await db.close();

  const off = firstShellOff(f);
  const fd = fs.openSync(f, 'r+');
  fs.writeSync(fd, Buffer.from('\n'), 0, 1, off + F.SEG_HEADER_SIZE); // 把第一条记录的首字节改成换行
  fs.closeSync(fd);

  const again = Store.open(f);
  assert.equal(again.count('capture'), 1, '第一条坏了，第二条必须还能读出来');
  assert.deepEqual(again.get('capture', 'b')?.v, 2);
  const rep = again.check();
  assert.equal(
    rep.issues.some((i) => i.detail.includes('trailing partial line')),
    false,
    '页里明明还有完整的换行，报「尾部半行」就是判断错了'
  );
  await again.close();
});

test('新分配段必须立刻写进 meta，不能等心跳', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 4096 });
  await db.put('capture', 'a', { pad: 'x'.repeat(3000) });
  const gen = db.meta.gen;
  await db.put('capture', 'b', { pad: 'x'.repeat(3000) }); // 一段装不下，必然新开段

  assert.equal(db.meta.segs.filter((s) => s.live && s.type === F.T.SHELL).length, 2);
  assert.ok(db.meta.gen > gen, '段表变了必须立刻落盘，否则崩溃后整段数据没人认领');
  await db.close();
});

test('刚写过的 meta 不会被下一次纯追加的提交重复写', async () => {
  const db = Store.create(file(), { segSize: 16 * 1024 });
  await db.put('mock', 'a', 1); // 分配段 → 写一次 meta
  const gen = db.meta.gen;
  await db.put('mock', 'b', 2); // 同一段内追加，只动了 seq
  assert.equal(db.meta.gen, gen, '心跳窗内的追加不该重复写 meta，否则写放大跟着提交数线性涨');
  await db.close();
});

test('clearNs 的成功不能等到 close：此刻磁盘上就该看不到这些段了', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 4096 });
  await batch(20, (i) => db.put('capture', `c_${i}`, { i, pad: 'x'.repeat(60) }));
  await db.clearNs('capture');

  const live = metaOnDisk(f).segs.filter((s) => s.live && s.ns === F.nsId('capture'));
  assert.equal(live.length, 0, '清空返回成功，磁盘上的段表就必须已经没有它们');
  await db.close();
});

test('reclaim 的结果要能被紧接着的下一次提交带进 meta', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 16 * 1024 });
  await batch(20, (i) => db.put('capture', `c_${i}`, { i, pad: 'x'.repeat(60) }));
  await db.put('mock', 'u_1', 1);
  await db.clearNs('capture');

  (db.io as unknown as { punchHole: () => boolean }).punchHole = () => true;
  assert.ok(db.reclaim().punched > 0);
  await db.put('mock', 'after', 2); // 心跳窗内的一次提交

  assert.equal(metaOnDisk(f).pending.length, 0, '打洞结果不能只留在内存里，下次崩了就白打一次洞');
  await db.close();
});

test('段头行数漂移只算告警，不算数据损坏', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 16 * 1024 });
  await db.put('capture', 'a', 1);
  await db.put('capture', 'b', 2);
  await db.close();

  const off = firstShellOff(f);
  const wrong = Buffer.alloc(4);
  wrong.writeUInt32LE(99, 0);
  const fd = fs.openSync(f, 'r+');
  fs.writeSync(fd, wrong, 0, 4, off + 12); // rows 字段改成 99（payload 与 CRC 都没动）
  fs.closeSync(fd);

  const again = Store.open(f);
  const rep = again.check();
  assert.equal(rep.issues.filter((i) => i.detail.includes('rows drift')).length, 1, '要报出这一次漂移');
  assert.equal(rep.ok, true, '行数漂移只是告警，数据本身是好的');
  await again.close();
});

test('重放时以 shell 里最大的 seq 为准（meta 可能落后于数据）', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 16 * 1024 });
  await db.put('capture', 'a', 1);
  await db.close();

  // 把第一条记录的 q 从 1 改成 9（同宽度，不改变长度），模拟「段写下去了但 meta 还是旧的」
  const off = firstShellOff(f);
  const buf = fs.readFileSync(f);
  const at = buf.indexOf(Buffer.from('"q":1'), off + F.SEG_HEADER_SIZE);
  assert.ok(at > 0, '应该在段 payload 里找到 seq 字段');
  buf.write('9', at + 4, 'utf8');
  fs.writeFileSync(f, buf);

  const again = Store.open(f);
  assert.equal(again.stats().seqs['2'], 9, '应该认 shell 里出现过的最大 q');
  const r = await again.put('capture', 'b', 2);
  assert.equal(r.seq, 10, 'seq 要从 9 往上接，否则新记录会跟老记录撞号');
  await again.close();
});

test('截断尾段只摘掉它自己，之前登记的空洞必须留着', async () => {
  const db = Store.create(file(), { segSize: 16 * 1024 });
  await db.put('mock', 'm', 1); // 中间段，标死后会进 pending
  // 中间夹一个存活段：否则尾段一截断，mock 段又成了新尾段，会被连环截掉
  await db.putBody('agent', 'run_1', Buffer.from('x'.repeat(500)));
  await batch(20, (i) => db.put('capture', `c_${i}`, { i, pad: 'x'.repeat(60) }));
  await db.clearNs('mock');
  const holes = db.meta.pending.slice();
  assert.equal(holes.length, 1, '中间死段要登记成待打洞的空洞');

  await db.clearNs('capture'); // 这一段在物理尾部，会被截断
  assert.deepEqual(db.meta.pending, holes, '截断尾段只该摘掉尾段自己，不能把先前登记的空洞一起清掉');
  assert.equal(
    db.stats().segs.free,
    1,
    '同一个空洞只能登记一次：重复登记会让两次分配落到重叠区间，互相覆盖'
  );
  await db.close();
});

test('seq 水位靠心跳落盘：段没变、只有 seq 变了也要写', async () => {
  const f = file();
  const db = Store.create(f, { segSize: 16 * 1024 });
  await db.put('mock', 'a', 1); // 分配段 → 立刻写一次 meta
  await new Promise((r) => setTimeout(r, 600)); // 等过 500ms 心跳窗
  await db.put('mock', 'b', 2); // 同一段内追加，只有 seq 变了

  assert.equal(
    metaOnDisk(f).seqs['3'],
    2,
    'seq 水位不落盘，崩溃重启后 seq 会回退，新记录就会跟老记录撞号'
  );
  await db.close();
});
