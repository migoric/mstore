import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bitmap } from '../src/bitmap.ts';

test('位图基本读写与越界', () => {
  const bm = new Bitmap(64);
  bm.set(0).set(31).set(32).set(63);
  assert.equal(bm.get(0), true);
  assert.equal(bm.get(1), false);
  assert.equal(bm.get(31), true);
  assert.equal(bm.get(32), true);
  assert.equal(bm.get(999), false, '越界读应返回 false 而不是抛错');
  assert.equal(bm.count(), 4);
  bm.clear(31);
  assert.equal(bm.get(31), false);
  assert.equal(bm.count(), 3);
  assert.throws(() => bm.set(-1), RangeError);
});

test('自动扩容后旧的位不丢', () => {
  const bm = new Bitmap(8);
  bm.set(3);
  bm.set(100);
  bm.set(1000);
  assert.equal(bm.get(3), true);
  assert.equal(bm.get(100), true);
  assert.equal(bm.get(1000), true);
  assert.equal(bm.count(), 3);
  assert.ok(bm.capacity >= 1001);
});

test('and / or / andNot / not', () => {
  const a = new Bitmap(64);
  const b = new Bitmap(64);
  [1, 2, 3, 10].forEach((i) => a.set(i));
  [2, 3, 11].forEach((i) => b.set(i));

  assert.deepEqual(a.and(b).toArray(), [2, 3]);
  assert.deepEqual(a.or(b).toArray(), [1, 2, 3, 10, 11]);
  assert.deepEqual(a.andNot(b).toArray(), [1, 10]);
  assert.deepEqual(a.not(16).toArray(), [0, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15]);
});

test('and/or 在两个位图长度不同时也不越界', () => {
  const small = new Bitmap(32);
  const big = new Bitmap(256);
  small.set(1);
  big.set(1);
  big.set(200);
  assert.deepEqual(small.and(big).toArray(), [1]);
  assert.deepEqual(big.and(small).toArray(), [1]);
  assert.deepEqual(small.or(big).toArray(), [1, 200]);
  assert.deepEqual(big.or(small).toArray(), [1, 200]);
});

test('forEach 按升序吐出，且只吐 capacity 以内', () => {
  const bm = new Bitmap(200);
  [199, 0, 64, 63, 128].forEach((i) => bm.set(i));
  assert.deepEqual(bm.toArray(), [0, 63, 64, 128, 199]);
  assert.equal(bm.first(), 0);
  assert.deepEqual(new Bitmap(10).toArray(), []);
});

test('count 与朴素计数一致（随机 2000 位）', () => {
  const bm = new Bitmap(2000);
  const truth = new Set<number>();
  let seed = 42;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (let i = 0; i < 2000; i++) {
    const bit = rnd() % 2000;
    if (i % 3 === 0) {
      bm.clear(bit);
      truth.delete(bit);
    } else {
      bm.set(bit);
      truth.add(bit);
    }
  }
  assert.equal(bm.count(), truth.size);
  assert.deepEqual(bm.toArray(), [...truth].sort((x, y) => x - y));
});

test('clone 之后互不影响', () => {
  const a = new Bitmap(64);
  a.set(5);
  const b = a.clone();
  b.set(6);
  assert.deepEqual(a.toArray(), [5]);
  assert.deepEqual(b.toArray(), [5, 6]);
});

test('容量 0 也要能安全地扩容（构造时不能算出 0 个 word）', () => {
  const bm = new Bitmap(0);
  assert.ok(bm.words.length >= 1, 'Uint32Array 长度至少 1');
  bm.set(5);
  assert.equal(bm.get(5), true);
  assert.equal(bm.count(), 1);
});

test('边界位：最后一个字的最末位与越界一位', () => {
  const bm = new Bitmap(32); // 恰好一个 word
  bm.set(31);
  assert.equal(bm.get(31), true);
  assert.equal(bm.count(), 1);
  bm.clear(31);
  assert.equal(bm.get(31), false);
  bm.clear(32); // 越界 clear 必须是 no-op，不能影响已有位
  bm.set(0);
  assert.equal(bm.count(), 1);
  assert.equal(bm.get(0), true);
});

test('capacity 精确维护：写入第 i 位后 capacity 应为 i+1', () => {
  const bm = new Bitmap(8);
  bm.set(20);
  assert.equal(bm.capacity, 21);
  bm.set(3);
  assert.equal(bm.capacity, 21, '写入更小的下标不应改变 capacity');
});

test('get 在「正好越过最后一个字」的位置返回 false', () => {
  const bm = new Bitmap(64);
  bm.set(63);
  const end = bm.words.length * 32;
  assert.equal(bm.get(end - 1), true);
  assert.equal(bm.get(end), false, '正好越界一位必须返回 false');
});

test('forEach 在整字全满时也能正常结束并给出正确结果', () => {
  const bm = new Bitmap(64);
  for (let i = 0; i < 64; i++) bm.set(i);
  assert.equal(bm.count(), 64);
  assert.equal(bm.toArray().length, 64);
  assert.deepEqual(bm.not(64).toArray(), [], '全 1 取反后应为空');
});

test('写入的位正好落在「第 words.length 个字的第 0 位」时必须扩容', () => {
  const bm = new Bitmap(32);
  assert.equal(bm.words.length, 1);
  bm.set(32); // 32 就是第二个字的第 0 位
  assert.equal(bm.words.length, 2, '必须扩容，不能把位丢掉');
  assert.equal(bm.get(32), true);
  assert.equal(bm.count(), 1);
});

test('forEachWhile：cb 返回 false 立刻停（不是走完整张位图）', () => {
  const bm = new Bitmap(128);
  for (let i = 0; i < 10; i++) bm.set(i * 3);
  const seen: number[] = [];
  bm.forEachWhile((i) => {
    seen.push(i);
    return seen.length < 3;
  });
  assert.deepEqual(seen, [0, 3, 6], '第三个之后必须停止');
});

test('forEachWhile：全量遍历与 forEach 完全一致', () => {
  const bm = new Bitmap(200);
  [7, 0, 33, 64, 199].forEach((i) => bm.set(i));
  const a: number[] = [];
  bm.forEach((i) => a.push(i));
  const b: number[] = [];
  bm.forEachWhile((i) => {
    b.push(i);
    return true;
  });
  assert.deepEqual(b, a);
});

test('capacity 小于 words*32 时，超出的位不应被吐出', () => {
  const words = new Uint32Array([0xffffffff]); // 32 位全 1
  const bm = Bitmap.from(words, 5); // 但逻辑容量只有 5
  assert.deepEqual(bm.toArray(), [0, 1, 2, 3, 4]);
  const seen: number[] = [];
  bm.forEachWhile((i) => {
    seen.push(i);
    return true;
  });
  assert.deepEqual(seen, [0, 1, 2, 3, 4], '超出 capacity 的位必须被过滤');
});

// ---------------- forEachWhileRange（区间剪枝的底座） ----------------

const collectRange = (bm: Bitmap, from: number, to: number): number[] => {
  const out: number[] = [];
  bm.forEachWhileRange(from, to, (i) => {
    out.push(i);
    return true;
  });
  return out;
};

test('forEachWhileRange：只吐 [from, to) 内的位', () => {
  const bm = new Bitmap(200);
  for (let i = 0; i < 200; i += 3) bm.set(i);
  const all = bm.toArray();
  assert.deepEqual(collectRange(bm, 0, 200), all);
  assert.deepEqual(collectRange(bm, 30, 60), all.filter((i) => i >= 30 && i < 60));
  assert.deepEqual(collectRange(bm, 31, 33), all.filter((i) => i >= 31 && i < 33));
});

test('forEachWhileRange：端点正好对齐 32 的边界', () => {
  const bm = new Bitmap(256);
  for (let i = 0; i < 256; i++) bm.set(i);
  // from 对齐：`-1 << 0` 是 0xFFFFFFFF，不能把整个字抹掉
  assert.deepEqual(collectRange(bm, 32, 96), Array.from({ length: 64 }, (_, k) => 32 + k));
  assert.deepEqual(collectRange(bm, 0, 32), Array.from({ length: 32 }, (_, k) => k));
  // to 对齐：`1 << 32` 在 JS 里等于 1，必须特判
  assert.deepEqual(collectRange(bm, 224, 256), Array.from({ length: 32 }, (_, k) => 224 + k));
  assert.deepEqual(collectRange(bm, 64, 64), []);
});

test('forEachWhileRange：分段遍历拼起来 ≡ 全量遍历', () => {
  const bm = new Bitmap(1000);
  let seed = 7;
  for (let i = 0; i < 1000; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    if (seed % 3 === 0) bm.set(i);
  }
  const all = bm.toArray();
  // 用不规则的段长切，专门制造非对齐边界
  const pieces: number[] = [];
  let at = 0;
  let step = 17;
  while (at < 1000) {
    const to = Math.min(1000, at + step);
    pieces.push(...collectRange(bm, at, to));
    at = to;
    step = (step * 3 + 5) % 97 || 1;
  }
  assert.deepEqual(pieces, all);
});

test('forEachWhileRange：to 超过 capacity 时按 capacity 截断', () => {
  const bm = new Bitmap(10);
  for (let i = 0; i < 10; i++) bm.set(i);
  assert.deepEqual(collectRange(bm, 0, 999), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(collectRange(bm, 8, 999), [8, 9]);
});

test('forEachWhileRange：cb 返回 false 立刻停下', () => {
  const bm = new Bitmap(500);
  for (let i = 0; i < 500; i++) bm.set(i);
  const seen: number[] = [];
  bm.forEachWhileRange(100, 400, (i) => {
    seen.push(i);
    return i < 103;
  });
  assert.deepEqual(seen, [100, 101, 102, 103]);
});

test('forEachWhileRange：空位图 / 越界区间都是安全空操作', () => {
  const bm = new Bitmap(64);
  assert.deepEqual(collectRange(bm, 0, 64), []);
  assert.deepEqual(collectRange(bm, 999, 1000), []);
  assert.deepEqual(collectRange(bm, 10, 5), []);
});
