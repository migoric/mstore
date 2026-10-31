/**
 * 索引快照：命中、失效、损坏三条路径 + 与重放结果的一致性。
 *
 * 这里最重要的不是「快不快」，是「快照恢复的结果必须和逐页重放一模一样」。
 * 只要有一组筛选器对不上，就是数据正确性问题，性能数字再好也是负的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.ts';
import { crc32 } from '../src/crc32.ts';
import { PageTable } from '../src/pagetable.ts';
import { BizIndex } from '../src/bizindex.ts';
import { MemoryKeyDirectory } from '../src/keydir.ts';
import { encodeSnapshot, decodeSnapshot } from '../src/snapshot.ts';
import * as F from '../src/format.ts';
import type { Filter } from '../src/bizindex.ts';
import type { Meta } from '../src/types.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-snap-'));
let n = 0;
const file = (): string => path.join(dir, `s${++n}.db`);

const DEPTS = ['R&D', 'Design', 'QA', 'Ops', 'Sales'];
const STATUS = ['active', 'leave', 'gone'];

const row = (i: number): Record<string, unknown> => ({
  name: `用户${i}`,
  dept: DEPTS[i % 5],
  status: STATUS[i % 3],
  level: i % 9,
  salary: 8000 + (i % 40) * 500,
  note: i % 100 === 0 ? 'x'.repeat(60) : undefined,
});

async function seed(f: string, rows: number): Promise<void> {
  const db = Store.create(f);
  for (let at = 0; at < rows; at += 500) {
    await Promise.all(
      Array.from({ length: Math.min(500, rows - at) }, (_, k) => db.bizPut(`u_${at + k}`, row(at + k)))
    );
  }
  await db.close();
}

/** 批量并发提交：逐条 await 是「一条一次 fsync」（本机约 60ms），几十条就能拖出几秒 */
async function putRows(db: Store, keys: string[], make: (k: string, i: number) => unknown): Promise<void> {
  for (let at = 0; at < keys.length; at += 200) {
    await Promise.all(
      keys.slice(at, at + 200).map((k, j) => db.bizPut(k, make(k, at + j)))
    );
  }
}

/** 读「此刻磁盘上」生效的那份 meta —— 不经过 Store，用来模拟崩溃后的现场 */
function metaOnDisk(f: string): Meta {
  const buf = fs.readFileSync(f);
  const a = F.decodeMeta(buf.subarray(F.META_A_OFF, F.META_A_OFF + F.META_SIZE));
  const b = F.decodeMeta(buf.subarray(F.META_B_OFF, F.META_B_OFF + F.META_SIZE));
  const alive = [a, b].filter((m): m is Meta => m !== null);
  assert.ok(alive.length > 0, '磁盘上至少要有一份可用 meta');
  return alive.sort((x, y) => y.gen - x.gen)[0]!;
}

const FILTERS: Filter[] = [
  {},
  { eq: { dept: 'R&D' } },
  { eq: { dept: ['R&D', 'QA'] } },
  { eq: { dept: 'R&D', status: 'active' }, gte: { level: 4 } },
  { eq: { status: 'gone' }, lte: { level: 3 } },
  { gte: { salary: 12000 }, lte: { salary: 20000 } },
  { eq: { dept: 'Sales' }, gte: { salary: 10000 }, limit: 7 },
];

const snapshotOf = (f: string): { filters: string[]; rows: number; values: string[] } => {
  const db = Store.open(f);
  const filters = FILTERS.map((q) => db.bizQuery(q).keys.join());
  const keys = db.bizQuery({}).keys;
  const values = keys.slice(0, 50).map((k) => JSON.stringify(db.bizGet(k)));
  const rows = db.bizStats().pages.rows;
  void db.close();
  return { filters, rows, values };
};

test('快照命中：open 走 snapshot，查询结果与重放逐字节相同', async () => {
  const f = file();
  await seed(f, 1200);

  const viaSnap = Store.open(f);
  assert.equal(viaSnap.openPath, 'snapshot');
  assert.equal(viaSnap.openNote, '');
  const snapStats = viaSnap.stats().snapshot;
  assert.equal(snapStats.rows, 1200, '快照要带回「装了多少行」，这是它恢复规模的唯一外部可见量');
  assert.equal(snapStats.current, true);
  assert.ok(snapStats.bytes > 0);
  assert.ok(snapStats.openMs >= 0);
  const snapFilters = FILTERS.map((q) => viaSnap.bizQuery(q).keys.join());
  const snapRows = viaSnap.bizStats().pages.rows;
  const snapValues = viaSnap.bizQuery({}).keys.slice(0, 50).map((k) => JSON.stringify(viaSnap.bizGet(k)));
  await viaSnap.close();

  const viaReplay = Store.open(f, { snapshot: false });
  assert.equal(viaReplay.openPath, 'replay');
  assert.equal(viaReplay.openNote, 'disabled');
  assert.equal(viaReplay.stats().snapshot.rows, 0, '没走快照就没有「快照规模」可言');
  const replayFilters = FILTERS.map((q) => viaReplay.bizQuery(q).keys.join());
  assert.deepEqual(snapFilters, replayFilters, '快照路径与重放路径的查询结果必须完全一致');
  assert.equal(snapRows, viaReplay.bizStats().pages.rows);
  assert.deepEqual(snapValues, viaReplay.bizQuery({}).keys.slice(0, 50).map((k) => JSON.stringify(viaReplay.bizGet(k))));
  await viaReplay.close();

  assert.ok(snapRows > 0);
});

test('stats 里的 snap 段计数只算快照段，不与 shell / body 混算', async () => {
  const f = file();
  await seed(f, 80);
  const db = Store.open(f);
  const s = db.stats();
  assert.equal(db.openPath, 'snapshot');
  assert.equal(s.segs.snapshot, 1, `应该正好有一个快照段：${JSON.stringify(s.segs)}`);
  await db.close();
});

test('快照结构坏但 CRC 对得上：拒绝并清空半成品，回退重放', async () => {
  const f = file();
  await seed(f, 120);
  const snap = metaOnDisk(f).snap!;

  // 把 magic 抹掉，并同步更新 meta 里的 CRC——这样会越过 CRC 校验那一关，
  // 真正走到 decodeSnapshot 抛错的分支。这是最容易留下半成品索引的路径：
  // 解码是边读边填的，抛错时内存里可能已经填了一半。
  const fd = fs.openSync(f, 'r+');
  const buf = Buffer.alloc(snap.len);
  fs.readSync(fd, buf, 0, snap.len, snap.off);
  buf.write('XXXX', 0, 'latin1');
  fs.writeSync(fd, buf, 0, buf.length, snap.off);
  fs.closeSync(fd);

  const db = Store.open(f, { snapshot: false });
  db.meta.snap!.crc = crc32(buf);
  await db.flush();
  await db.close();

  const r = Store.open(f);
  assert.equal(r.openPath, 'replay');
  assert.match(r.openNote, /rejected/);
  // 半成品必须被清干净：行数、查询结果都要和原始数据一致
  assert.equal(r.bizStats().pages.rows, 120);
  assert.equal(r.bizQuery({ gte: { level: 0 } }).keys.length, 120);
  await r.close();
});

test('快照写完之后段表里只留一份，旧的被回收掉', async () => {
  const f = file();
  const db = Store.create(f);
  await putRows(db, Array.from({ length: 200 }, (_, i) => `u_${i}`), (_k, i) => row(i));
  db.writeSnapshot();
  const first = db.meta.snap!.seg;

  await putRows(db, Array.from({ length: 200 }, (_, i) => `u_${i + 200}`), (_k, i) => row(i + 200));
  assert.equal(db.writeSnapshot(), true, 'epoch 变了要写新快照');
  assert.notEqual(db.meta.snap!.seg, first, '应该换成新段');

  const live = db.meta.segs.filter((s) => s.type === F.T.SNAP && s.live);
  assert.equal(live.length, 1, '旧快照必须退役，否则文件里会堆一串没人认领的快照');
  await db.close();
});

test('epoch 没变时重复写快照是免费的', async () => {
  const f = file();
  const db = Store.create(f);
  await db.bizPut('a', row(1));
  assert.equal(db.writeSnapshot(), true);
  const gen = db.meta.snap!.seg;
  assert.equal(db.writeSnapshot(), false, '什么都没改，不该重写');
  assert.equal(db.meta.snap!.seg, gen);
  await db.close();
});

test('崩溃现场：数据写了但快照没跟上，打开时走重放而不是用旧快照', async () => {
  const f = file();
  const db = Store.create(f);
  await putRows(db, Array.from({ length: 50 }, (_, i) => `u_${i}`), (_k, i) => row(i));
  await db.close(); // 快照 epoch = 50

  const w = Store.open(f);
  assert.equal(w.openPath, 'snapshot');
  await w.bizPut('u_new', row(999)); // epoch +1，meta 随这次结构变更落盘，但快照没重写

  const disk = metaOnDisk(f);
  assert.equal(disk.snap!.epoch, 50, '磁盘上的快照还是旧的');
  assert.equal(disk.bizEpoch, 51, 'meta 的 epoch 已经涨了');

  const r = Store.open(f);
  assert.equal(r.openPath, 'replay', 'epoch 对不上就必须回退重放，不能用旧快照');
  assert.match(r.openNote, /stale/);
  assert.ok(r.bizGet('u_new'), '回退路径必须能看到刚才写的那一行');
  assert.equal(r.bizStats().pages.rows, 51);
  await r.close();
  await w.close();
});

test('快照 CRC 被改坏：回退重放，数据一个字节都不能少', async () => {
  const f = file();
  await seed(f, 300);
  const before = snapshotOf(f); // 顺便保证退出时快照是干净的

  const snap = metaOnDisk(f).snap;
  assert.ok(snap, '应该已经写出快照');
  const fd = fs.openSync(f, 'r+');
  const junk = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  fs.writeSync(fd, junk, 0, 4, snap!.off + 16); // 改 payload 中段
  fs.closeSync(fd);

  const db = Store.open(f);
  assert.equal(db.openPath, 'replay');
  assert.match(db.openNote, /CRC mismatch/);
  const filters = FILTERS.map((q) => db.bizQuery(q).keys.join());
  assert.deepEqual(filters, before.filters, '快照坏了不能影响结果，只能影响快慢');
  assert.equal(db.bizStats().pages.rows, before.rows);
  await db.close();
});

test('快照段被标死：回退重放，不炸也不读空', async () => {
  const f = file();
  await seed(f, 200);
  const db = Store.open(f, { snapshot: false });
  const snapSeg = db.meta.snap!.seg;
  const seg = db.meta.segs.find((s) => s.id === snapSeg)!;
  seg.live = false;

  // 自检必须把「快照指向一个死段」明确报出来。不报的话，性能回退（下次走重放）
  // 在线上会完全没有线索——只是「变慢了」。
  const c = db.check();
  assert.ok(
    c.issues.some((x) => x.level === 'error' && /missing\/dead/.test(x.detail)),
    `自检应报出快照指向死段，实际 issues=${JSON.stringify(c.issues)}`
  );

  await db.flush();
  await db.close();

  const r = Store.open(f);
  assert.equal(r.openPath, 'replay');
  assert.match(r.openNote, /missing or dead/);
  assert.equal(r.bizStats().pages.rows, 200);
  await r.close();
});

test('meta 里的快照长度被改小：明确拒绝，不半信半疑地恢复', async () => {
  const f = file();
  await seed(f, 150);
  const snap = metaOnDisk(f).snap!;

  // 把 meta 里的快照长度改小：段头与 meta 会对不上，load 时 readAt 少读，
  // decode 会看到「块 overrun file」→ 拒绝
  const db = Store.open(f, { snapshot: false });
  db.meta.snap!.len = 64;
  await db.flush();
  await db.close();

  const r = Store.open(f);
  assert.equal(r.openPath, 'replay');
  assert.match(r.openNote, /rejected|CRC/);
  assert.equal(r.bizStats().pages.rows, 150);
  await r.close();
  assert.ok(snap.len > 64);
});

test('meta 里的快照长度被改大到越过文件尾：读不出来就拒绝，不留半截索引', async () => {
  const f = file();
  await seed(f, 150);

  // 「读出来了但校验不过」和「根本读不出来」是两条不同的岔路：
  // 前者靠 CRC 挡，后者靠 readAt 精确读满的语义挡（少读一个字节就抛错）。
  // 只测前面那条，后面那条把 return false 改成 true 也不会红。
  const db = Store.open(f, { snapshot: false });
  db.meta.snap!.len = 1 << 24;
  await db.flush();
  await db.close();

  const r = Store.open(f);
  assert.equal(r.openPath, 'replay');
  assert.match(r.openNote, /truncated/);
  assert.equal(r.bizStats().pages.rows, 150, '回退重放必须把 150 行一行不少地装回来');
  assert.equal(r.bizGet('u_0') !== undefined, true, '回退之后数据要真的能读');
  await r.close();
});

test('关掉快照时 writeSnapshot 明确返回 false，不偷偷写一份', async () => {
  const f = file();
  const db = Store.create(f, { snapshot: false });
  await putRows(db, Array.from({ length: 20 }, (_, i) => `u_${i}`), (_k, i) => row(i));

  // 返回值是调用方能看见的唯一信号：真有一天 sync 循环按它决定「还要不要再试」，
  // 关掉快照却回 true 会让它白转一圈
  assert.equal(db.writeSnapshot(), false);
  assert.equal(db.meta.snap, undefined, '关掉快照就不该留下指针');
  await db.close();

  const r = Store.open(f, { snapshot: false });
  assert.equal(r.openPath, 'replay');
  assert.equal(r.bizStats().pages.rows, 20);
  await r.close();
});

test('删除行之后重开：删掉的不复活，新行的 rowid 不跟老行撞号', async () => {
  const f = file();
  const db = Store.create(f);
  await putRows(db, Array.from({ length: 30 }, (_, i) => `u_${i}`), (_k, i) => row(i));
  await Promise.all([0, 3, 6, 9, 12, 15, 18, 21, 24, 27].map((i) => db.bizDel(`u_${i}`)));
  const liveBefore = db.bizStats().pages.rows;
  await db.close();

  const r = Store.open(f);
  assert.equal(r.openPath, 'snapshot');
  assert.equal(r.bizStats().pages.rows, liveBefore, '删掉的行不能复活');
  assert.equal(r.bizGet('u_0'), undefined);
  assert.ok(r.bizGet('u_1'));

  const added = await r.bizPut('u_new', row(777));
  assert.equal(added.rowid, 30, 'rowid 必须从 30 接着涨（快照要带回 nextRowid），否则新行会覆盖老行的位');
  assert.equal(r.bizQuery({ eq: { dept: DEPTS[777 % 5]! } }).keys.includes('u_new'), true, '新行必须能被位图查到');
  await r.close();
});

test('bizClear 之后打开：快照失效、行数为 0、再写还能用', async () => {
  const f = file();
  const db = Store.create(f);
  await putRows(db, Array.from({ length: 40 }, (_, i) => `u_${i}`), (_k, i) => row(i));
  await db.bizClear();
  await db.close();

  const r = Store.open(f);
  assert.equal(r.bizStats().pages.rows, 0);
  assert.equal(r.bizQuery({}).keys.length, 0);
  const added = await r.bizPut('after', row(1));
  assert.equal(added.rowid, 0, '清空之后 rowid 从 0 重新开始');
  assert.equal(r.bizQuery({ eq: { dept: 'Design' } }).keys.length, 1);
  await r.close();
});

test('自检：快照指针正常时不报错，过期时只报 warn', async () => {
  const f = file();
  const db = Store.create(f);
  await putRows(db, Array.from({ length: 60 }, (_, i) => `u_${i}`), (_k, i) => row(i));
  await db.flush();
  assert.deepEqual(db.check().issues, [], '刚写完快照，自检不该有任何 issue');

  await db.bizPut('u_60', row(60)); // 让快照过期
  const stale = db.check().issues.filter((i) => i.where === 'snapshot');
  assert.equal(stale.length, 1);
  assert.equal(stale[0]!.level, 'warn');
  assert.equal(db.check().ok, true, '快照过期不是数据错误，只是下次启动会慢一点');
  await db.close();
});

test('空库不写快照：不浪费一个段', async () => {
  const f = file();
  const db = Store.create(f);
  await db.put('mock', 'a', 1); // 只写 KV，业务表还是空的
  assert.equal(db.writeSnapshot(), false, '空库不该写快照，必须明确返回 false');
  await db.close();
  assert.equal(metaOnDisk(f).snap, undefined);

  const r = Store.open(f);
  assert.equal(r.openPath, 'replay');
  assert.equal(r.openNote, 'no snapshot');
  await r.close();
});

test('页目录物理偏移超过 4GB 仍能无损往返', () => {
  const offsets = [0, 2 ** 32 + 12345, Number.MAX_SAFE_INTEGER];
  const io = {
    readAt: () => Buffer.alloc(4096),
    writeAt: () => {},
  };
  const source = new PageTable(io, { pageDir: offsets } as Meta, () => 0, () => {});
  source.load();
  const encoded = encodeSnapshot(source, new BizIndex([], []));

  const restoredPages = new PageTable(io, {} as Meta, () => 0, () => {});
  const restoredBiz = new BizIndex([], []);
  decodeSnapshot(encoded, restoredPages, restoredBiz);
  assert.deepEqual(restoredPages.snapshotDir(), offsets);
});

test('默认内存快照恢复全部 key、rowid、值和行数', () => {
  const data = Buffer.alloc(8192);
  const io = {
    readAt: (off: number, len: number) => data.subarray(off, off + len),
    writeAt: (buf: Buffer, off: number) => { buf.copy(data, off); },
  };
  const directory = new MemoryKeyDirectory();
  const pages = new PageTable(io, {} as Meta, () => 4096, () => {}, { directory });
  const biz = new BizIndex(['dept'], [], directory);
  pages.put('a', { dept: 'R&D' });
  biz.put('a', { dept: 'R&D' });
  pages.flushOpen();
  const encoded = encodeSnapshot(pages, biz);

  const restoredDirectory = new MemoryKeyDirectory();
  const restoredPages = new PageTable(io, {} as Meta, () => 0, () => {}, { directory: restoredDirectory });
  const restoredBiz = new BizIndex(['dept'], [], restoredDirectory);
  const info = decodeSnapshot(encoded, restoredPages, restoredBiz);
  assert.deepEqual(restoredPages.get('a'), { dept: 'R&D' });
  assert.equal(restoredBiz.rowidOf('a'), 0);
  assert.equal(restoredBiz.keyOf(0), 'a');
  assert.equal(info.rows, 1);
});

test('新编码器把缺 rowid 的页表 key 写成 LOOSE，而不是伪造 rowid 0', () => {
  const data = Buffer.alloc(8192);
  const io = {
    readAt: (off: number, len: number) => data.subarray(off, off + len),
    writeAt: (buf: Buffer, off: number) => { buf.copy(data, off); },
  };
  const pages = new PageTable(io, {} as Meta, () => 4096, () => {});
  pages.put('loose', { value: 1 });
  pages.flushOpen();
  const encoded = encodeSnapshot(pages, new BizIndex([], []));

  const restored = new PageTable(io, {} as Meta, () => 0, () => {});
  const info = decodeSnapshot(encoded, restored, new BizIndex([], []));
  assert.equal(info.loose, 1);
  assert.deepEqual([...restored.snapshotEntries()], [['loose', { logical: 0, rowid: undefined }]]);
});

test('旧格式 LOOSE 记录仍能恢复到统一目录', () => {
  const io = {
    readAt: () => Buffer.alloc(4096),
    writeAt: () => {},
  };
  const encoded = encodeSnapshot(new PageTable(io, {} as Meta, () => 0, () => {}), new BizIndex([], []));
  let at = 12;
  while (at < encoded.length) {
    if (encoded.readUInt8(at) === 3) break;
    at += 8 + encoded.readUInt32LE(at + 4);
  }
  const oldLen = encoded.readUInt32LE(at + 4);
  const record = Buffer.alloc(8);
  record.writeUInt32LE(0, 0);
  record.writeUInt32LE(6, 4);
  const legacy = Buffer.from('legacy', 'utf8');
  const end = at + 8 + oldLen;
  const patched = Buffer.concat([encoded.subarray(0, end), record, legacy, encoded.subarray(end)]);
  patched.writeUInt32LE(oldLen + record.length + legacy.length, at + 4);
  patched.writeUInt32LE(1, at + 8);

  const restoredPages = new PageTable(io, {} as Meta, () => 0, () => {});
  const info = decodeSnapshot(patched, restoredPages, new BizIndex([], []));
  assert.equal(info.loose, 1);
  assert.deepEqual([...restoredPages.snapshotEntries()], [['legacy', { logical: 0, rowid: undefined }]]);
});
