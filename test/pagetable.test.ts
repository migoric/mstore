/**
 * CoW 页表的单元测试。
 *
 * 用一个内存版 PageIo 顶上，不碰真文件 —— 页表的正确性全在「偏移怎么分配、
 * 目录怎么更新、缓冲什么时候落盘」这些逻辑上，跟磁盘无关。
 * 这样整个文件跑完只有几十毫秒，能支撑变异测试反复重跑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PageTable, reclaimableBytes } from '../src/pagetable.ts';
import type { PageIo } from '../src/pagetable.ts';
import type { Meta } from '../src/types.ts';

/** 线性分配的内存盘：off 从 0 开始往后长，读越界给空 */
class MemIo implements PageIo {
  buf = Buffer.alloc(4 << 20);
  // 页表用偏移 0 表示「目录项无效」，所以内存盘也要跳过 0 开始分配（真库前面有 2MB 头）
  used = 1;

  alloc(bytes: number): number {
    const off = this.used;
    this.used += bytes;
    return off;
  }

  readAt(off: number, len: number): Buffer {
    return this.buf.subarray(off, off + len);
  }

  writeAt(b: Buffer, off: number): void {
    b.copy(this.buf, off);
  }
}

interface Rig {
  io: MemIo;
  meta: Meta;
  table: PageTable;
  dirty: () => number;
}

function rig(opts: { pageSize?: number; rowsPerPage?: number } = {}): Rig {
  const io = new MemIo();
  const meta = {} as unknown as Meta;
  let dirtyCount = 0;
  const table = new PageTable(
    io,
    meta,
    (b) => io.alloc(b),
    () => {
      dirtyCount++;
    },
    opts
  );
  return { io, meta, table, dirty: () => dirtyCount };
}

const dirOf = (meta: Meta): number[] => (meta as Meta & { pageDir?: number[] }).pageDir ?? [];

/**
 * 造一个 value，使 `JSON.stringify({k, v})` 恰好 bytes 字节。
 * 边界测试必须精确到字节，靠手数名字太脆。
 */
function sized(k: string, bytes: number): RowEntryLike {
  const shell = Buffer.byteLength(JSON.stringify({ k, v: '' }));
  return { k, v: 'x'.repeat(bytes - shell) };
}
interface RowEntryLike {
  k: string;
  v: string;
}

test('新行先攒在内存：可见但不落盘，flush 之后页目录才有效', () => {
  const { io, meta, table, dirty } = rig({ rowsPerPage: 48 });
  table.put('k1', { a: 1 });

  assert.deepEqual(table.get('k1'), { a: 1 }, '未落盘也要能读到（读的是追加缓冲）');
  assert.equal(table.size(), 1);
  assert.equal(table.stats().pages, 0, '页目录里还是占位 0，不算有效页');
  assert.ok(dirty() > 0, '攒批也要标脏，否则 meta 不会写');

  table.flushOpen();
  const st = table.stats();
  assert.equal(st.pages, 1);
  assert.equal(st.rows, 1);
  assert.equal(st.bytes, 4096, '一页按整页计入体积');
  assert.ok(dirOf(meta)[0]! > 0, 'flush 之后目录指向真实偏移');
  assert.ok(io.readAt(dirOf(meta)[0]!, 4096).readUInt16LE(0) > 0, '页头写了 JSON 长度');
});

test('open 页内更新：只改缓冲，不触发整页重写', () => {
  const { table } = rig({ rowsPerPage: 48 });
  table.put('k1', { a: 1 });
  table.put('k1', { a: 2 });

  assert.deepEqual(table.get('k1'), { a: 2 });
  assert.equal(table.size(), 1, '更新不应新增行');
  assert.equal(table.stats().rewrites, 0, '追加缓冲内的更新不该产生页写');
});

test('关闭页更新走 CoW：写新偏移，旧页字节原样保留', () => {
  const { io, meta, table } = rig({ rowsPerPage: 1 }); // 一行一页，写完立刻关闭
  table.put('k1', { v: 'old' });
  const oldOff = dirOf(meta)[0]!;
  const oldBytes = Buffer.from(io.readAt(oldOff, 4096));

  table.put('k2', { v: 'other' }); // 开新的一页，让 k1 落在关闭页里
  table.put('k1', { v: 'new' });

  const newOff = dirOf(meta)[0]!;
  assert.notEqual(newOff, oldOff, '更新必须写到新偏移');
  assert.deepEqual(Buffer.from(io.readAt(oldOff, 4096)), oldBytes, '旧页一个字节都不能动');
  assert.deepEqual(table.get('k1'), { v: 'new' });
  assert.equal(table.size(), 2);
  assert.ok(table.stats().rewrites >= 2);
});

test('open 页内更新变大装不下：把这一行搬出去，不丢数据', () => {
  const { table } = rig({ pageSize: 256, rowsPerPage: 48 });
  const small = 's'.repeat(10);
  const big = 'b'.repeat(220);
  table.put('a', small);
  table.put('c', small);
  table.put('a', big); // 变大后 256B 页装不下 → 先落盘剩余行，再开新页

  assert.equal(table.size(), 2, '搬出去不应产生重复行');
  assert.equal(table.get('a'), big);
  assert.equal(table.get('c'), small, '同页其他行必须还在');

  table.flushOpen();
  assert.equal(table.stats().rows, 2);
});

test('同一页放进变大的行：openBytes 跟着 delta 走，不重复计数', () => {
  const { table } = rig({ pageSize: 4096, rowsPerPage: 48 });
  table.put('a', 'short');
  table.put('a', 'a-much-longer-value-than-before'); // 仍在同一页内
  table.put('b', 'plain');
  table.flushOpen();

  assert.equal(table.stats().rows, 2);
  assert.equal(table.get('a'), 'a-much-longer-value-than-before');
  assert.equal(table.get('b'), 'plain');
});

test('单行超过一页：明确报错，绝不静默丢数据', () => {
  const { table } = rig({ pageSize: 4096 });
  assert.throws(() => table.put('huge', { v: 'x'.repeat(5000) }), /page overflow/);
  assert.equal(table.size(), 0, '报错后不能留下半行');
  assert.equal(table.has('huge'), false);
});

test('关闭页更新到超页：encode 也必须拦住', () => {
  const { table } = rig({ pageSize: 4096, rowsPerPage: 1 });
  table.put('k1', { v: 'x' });
  table.put('k2', { v: 'y' }); // k1 落到关闭页
  assert.throws(() => table.put('k1', { v: 'z'.repeat(5000) }), /page overflow/);
  assert.deepEqual(table.get('k1'), { v: 'x' }, '失败的更新不能破坏旧值');
});

test('按行数轮转：满 rowsPerPage 就落盘并关闭当前页', () => {
  const { table } = rig({ pageSize: 4096, rowsPerPage: 2 });
  table.put('a', 1);
  table.put('b', 2);
  assert.equal(table.stats().pages, 1, '前两行写完即落盘');
  assert.equal(table.stats().rewrites, 1);
  table.put('c', 3);
  assert.equal(table.stats().pages, 1, '第三行开的新页还没落盘');
  table.flushOpen();
  assert.equal(table.stats().pages, 2);
  assert.equal(table.stats().rows, 3);
});

test('按字节轮转：一行都塞不下就开新页', () => {
  const { table } = rig({ pageSize: 256, rowsPerPage: 1000 }); // 行数上限调高，只让字节数生效
  for (let i = 0; i < 10; i++) table.put(`k${i}`, 'x'.repeat(40));
  table.flushOpen();
  assert.ok(table.stats().pages >= 2, `应按字节分成多页，实际 ${table.stats().pages}`);
  assert.equal(table.stats().rows, 10);
  for (let i = 0; i < 10; i++) assert.equal(table.get(`k${i}`), 'x'.repeat(40));
});

test('删除：open 页内直接摘掉，关闭页走重写', () => {
  const { table } = rig({ pageSize: 4096, rowsPerPage: 3 });
  table.put('a', 1);
  table.put('b', 2);
  table.put('c', 3); // 满 3 行 → 落盘关闭

  assert.equal(table.delete('b'), true, '关闭页删除要重写该页');
  assert.equal(table.has('b'), false);
  assert.equal(table.get('b'), undefined);
  assert.equal(table.size(), 2);

  table.put('d', 4); // 新开一页
  assert.equal(table.delete('d'), true, 'open 页删除只改缓冲');
  assert.equal(table.size(), 2, 'a、c 还在');
  assert.equal(table.delete('nope'), false, '删不存在的 key 返回 false');
});

test('删除后页目录仍然有效：重开能读回剩下的行', () => {
  const { io, meta, table } = rig({ pageSize: 4096, rowsPerPage: 3 });
  table.put('a', { n: 1 });
  table.put('b', { n: 2 });
  table.put('c', { n: 3 });
  table.delete('b');
  table.flushOpen();

  const again = new PageTable(io, meta, (x) => io.alloc(x), () => {}, {});
  again.load();
  assert.equal(again.size(), 2);
  assert.deepEqual(again.get('a'), { n: 1 });
  assert.deepEqual(again.get('c'), { n: 3 });
  assert.equal(again.has('b'), false);
});

test('load 从 meta.pageDir 恢复索引，跳过占位 0', () => {
  const { io, meta, table } = rig({ pageSize: 4096, rowsPerPage: 2 });
  table.put('a', 'A');
  table.put('b', 'B');
  table.put('c', 'C'); // 开了一页但没落盘 → 目录里有占位 0
  assert.equal(table.stats().pages, 1);
  assert.equal(table.size(), 3);

  const fresh = new PageTable(io, meta, (x) => io.alloc(x), () => {}, {});
  fresh.load();
  assert.equal(fresh.size(), 2, '未落盘的那一行不参与恢复');
  assert.equal(fresh.get('a'), 'A');
  assert.equal(fresh.get('b'), 'B');
  assert.equal(fresh.has('c'), false);
});

test('entries 覆盖已落盘页 + 未落盘的追加缓冲', () => {
  const { table } = rig({ pageSize: 4096, rowsPerPage: 2 });
  table.put('a', 1);
  table.put('b', 2);
  table.put('c', 3); // 缓冲里
  const got = [...table.entries()];
  assert.equal(got.length, 3);
  assert.deepEqual(got, [
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]);
});

test('keys 与 has 跟随索引', () => {
  const { table } = rig({ rowsPerPage: 48 });
  table.put('x', 1);
  table.put('y', 2);
  assert.deepEqual(table.keys().sort(), ['x', 'y']);
  assert.equal(table.has('x'), true);
  table.delete('x');
  assert.equal(table.has('x'), false);
  assert.deepEqual(table.keys(), ['y']);
});

test('从快照恢复：keys 里的洞直接跳过，不会被当成一行装回去', () => {
  const a = rig({ rowsPerPage: 48 });
  a.table.put('k0', { i: 0 });
  a.table.put('k1', { i: 1 });
  a.table.put('k2', { i: 2 });
  a.table.flushOpen();
  const dir = a.table.snapshotDir().slice();

  const b = new PageTable(a.io, a.meta, (x) => a.io.alloc(x), () => {}, { rowsPerPage: 48 });
  // 中间那一项是洞：删掉的行留下的 rowid，快照里就是 undefined
  b.restoreSnapshot(dir, ['k0', undefined, 'k2'], [0, 0, 0]);

  assert.equal(b.size(), 2, '洞不算一行');
  assert.equal(b.has('k0'), true);
  assert.equal(b.has('k2'), true);
  assert.deepEqual(b.get('k0'), { i: 0 }, '恢复出来的逻辑页要能真的读回数据');
  assert.deepEqual(b.keys().sort(), ['k0', 'k2']);
});

test('clear 只重置目录，页数归零且目录写回 meta', () => {
  const { meta, table } = rig({ rowsPerPage: 2 });
  table.put('a', 1);
  table.put('b', 2);
  assert.equal(table.stats().pages, 1);

  table.clear();
  assert.equal(table.size(), 0);
  assert.equal(table.stats().pages, 0);
  assert.equal(table.stats().bytes, 0);
  assert.deepEqual([...table.entries()], []);
  assert.deepEqual(dirOf(meta), [], '空目录也要写回 meta，否则重开会把旧页读回来');

  table.put('c', 3);
  assert.equal(table.size(), 1, 'clear 之后还能继续写');
  assert.equal(table.get('c'), 3);
});

test('reclaimableBytes：已分配减当前目录占用，永不为负', () => {
  const { table } = rig({ rowsPerPage: 2 });
  table.put('a', 1);
  table.put('b', 2);
  table.put('c', 3);
  table.put('d', 4);
  const st = table.stats();
  assert.equal(st.bytes, 8192, '两页各 4KB');
  assert.equal(reclaimableBytes(table, st, 12288), 4096, '多出来的 4KB 是垃圾');
  assert.equal(reclaimableBytes(table, st, 4096), 0, '不足时给 0，不给负数');
});

// ---------------- 渲染边界：正好装满一页 ----------------
// 页容量 cap = pageSize - 4；整页 JSON = 8（空壳）+ 各行 + 逗号。下面的用例都卡在「等于」

test('单行正好装满一页：必须接受（> 而不是 >=）', () => {
  const { io, meta, table } = rig({ pageSize: 4096 });
  const row = sized('a', 4092 - 8); // 8 + 4084 = 4092 = cap
  table.put(row.k, row.v);
  table.flushOpen();

  assert.equal(table.stats().pages, 1);
  assert.equal(table.stats().rows, 1);
  const len = io.readAt(dirOf(meta)[0]!, 4096).readUInt16LE(0);
  assert.equal(len, 4092, '页里写下的 JSON 长度正好占满可用空间');

  const again = new PageTable(io, meta, (x) => io.alloc(x), () => {}, {});
  again.load();
  assert.equal(again.get('a'), row.v, '装满的页也要能读回来');
});

test('追加的行正好装满一页：留在同一页，不提前开新页', () => {
  const { table } = rig({ pageSize: 4096 });
  const a = sized('a', 2040);
  const b = sized('b', 2043); // 8 + 2040 + 2043 + 1 = 4092 = cap
  table.put(a.k, a.v);
  table.put(b.k, b.v);
  table.flushOpen();

  assert.equal(table.stats().pages, 1, '正好装满是一页，不是两页');
  assert.equal(table.stats().rewrites, 1);
  assert.equal(table.get('a'), a.v);
  assert.equal(table.get('b'), b.v);
});

test('更新后正好装满一页：留在原页，不搬出去', () => {
  const { table } = rig({ pageSize: 4096 });
  const a = sized('a', 2000);
  const b = sized('b', 2000);
  table.put(a.k, a.v);
  table.put(b.k, b.v);
  assert.equal(table.stats().rewrites, 0);

  const grown = sized('a', 2083); // 8 + 2083 + 2000 + 1 = 4092 = cap
  table.put(grown.k, grown.v);

  assert.equal(table.stats().rewrites, 0, '正好装得下就不该重写页');
  assert.equal(table.get('a'), grown.v);
  assert.equal(table.get('b'), b.v);
});

// ---------------- 落盘语义：攒批之后必须真的持久化 ----------------

test('open 页内的更新必须落盘：flush 之后重开是新值', () => {
  const { io, meta, table } = rig({ pageSize: 4096, rowsPerPage: 48 });
  table.put('k1', { v: 'old' });
  table.put('k1', { v: 'new' }); // 只在追加缓冲里改成新值
  table.flushOpen();

  const again = new PageTable(io, meta, (x) => io.alloc(x), () => {}, {});
  again.load();
  assert.deepEqual(again.get('k1'), { v: 'new' }, '只改内存不落盘就等于丢更新');
});

test('没改动时重复 flush 不该重复写页', () => {
  const { table } = rig({ pageSize: 4096, rowsPerPage: 48 });
  table.put('k1', 1);
  table.flushOpen();
  table.flushOpen();
  table.flushOpen();
  assert.equal(table.stats().rewrites, 1, '心跳式 flush 不能把写放大乘上心跳次数');
});

test('删除 open 页的第一行：不能因为下标是 0 就漏掉', () => {
  const { io, meta, table } = rig({ pageSize: 4096, rowsPerPage: 48 });
  table.put('a', 1);
  table.put('b', 2);
  table.put('c', 3);

  assert.equal(table.delete('a'), true);
  assert.deepEqual([...table.entries()], [
    ['b', 2],
    ['c', 3],
  ]);
  table.flushOpen();

  const again = new PageTable(io, meta, (x) => io.alloc(x), () => {}, {});
  again.load();
  assert.equal(again.has('a'), false, '删掉的行不能从磁盘上复活');
  assert.equal(again.size(), 2);
});

test('删除 open 页的行必须落盘：flush 之后重开不会复活', () => {
  const { io, meta, table } = rig({ pageSize: 4096, rowsPerPage: 48 });
  table.put('a', 1);
  table.put('b', 2);
  table.delete('b');
  table.flushOpen();

  const again = new PageTable(io, meta, (x) => io.alloc(x), () => {}, {});
  again.load();
  assert.equal(again.size(), 1);
  assert.equal(again.has('b'), false);
});

test('页头长度超出整页：报 corrupt page，不让 JSON.parse 乱抛', () => {
  const { io, meta, table } = rig({ pageSize: 4096, rowsPerPage: 48 });
  table.put('a', 1);
  table.flushOpen();
  const off = dirOf(meta)[0]!;

  io.buf.writeUInt16LE(4095, off); // 4095 + 2 > 4096，页里根本没这么多字节
  const broken = new PageTable(io, meta, (x) => io.alloc(x), () => {}, {});
  assert.throws(() => broken.load(), /corrupt page/, '坏页必须被认出来，不能被当成空页静默吞掉');
});

