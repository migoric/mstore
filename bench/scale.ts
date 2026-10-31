/**
 * 规模可行性实验：当前架构能撑到多大，先崩的是哪一块。
 *
 *   node --expose-gc bench/scale.ts --rows 1000000
 *   node --expose-gc bench/scale.ts --rows 3000000 --json
 *
 * 目的不是比快慢，是算出三个「每行成本」，再用它们外推到 10GB：
 *
 *   1. 磁盘每行字节  → 10GB 对应多少行
 *   2. 内存每行字节  → 那个行数需要多少内存（这是 10GB 目标的真门槛）
 *   3. open 每行微秒  → 那个行数的冷启动要多久
 *
 * 为什么必须 --expose-gc：不强制 GC 就量到一堆垃圾，数字会随上一步操作漂。
 * 没有 --expose-gc 时脚本会照跑，但在输出里标注「内存数字含垃圾，不可信」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.ts';
import type { Filter } from '../src/bizindex.ts';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};

const ROWS = Number(arg('rows', '300000'));
const JSON_OUT = process.argv.includes('--json');
const KEEP = process.argv.includes('--keep');
const TARGET_GB = 10;

const DEPTS = ['R&D', 'Design', 'QA', 'Ops', 'Sales'];
const STATUS = ['active', 'leave', 'gone'];

const canGC = typeof (globalThis as { gc?: () => void }).gc === 'function';

/**
 * 强制 GC 后取内存。没有 --expose-gc 时退化为直接读，但要标记不可信。
 *
 * 三个口径必须分开看，混在一起会得出荒谬结论（踩过）：
 *   - heapUsed：JS 堆对象（Map/string/普通数组）。key 映射落盘后这里只剩稀疏索引。
 *   - external：TypedArray（Float64Array/Uint32Array）的底层 buffer。数值列与位图
 *     都在这，heapUsed 看不见它们——只看 heapUsed 会误报「索引内存 0GB」。
 *   - rss：进程真实驻留内存（含文件页缓存），是「这台机器到底要吃多少」的最终答案。
 */
const mem = (): { heap: number; external: number; rss: number } => {
  if (canGC) (globalThis as { gc?: () => void }).gc!();
  const m = process.memoryUsage();
  return { heap: m.heapUsed, external: m.external, rss: m.rss };
};

const MB = 1048576;
const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]!;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-scale-'));
const file = path.join(dir, 'scale.db');

if (!JSON_OUT) {
  console.log(`目标 ${ROWS.toLocaleString()} 行 · gc=${canGC ? 'on' : 'off'}`);
}

const base = mem();

// ---- 写 ----
const db = Store.create(file);
const tWrite0 = performance.now();
const BATCH = 2000;
for (let at = 0; at < ROWS; at += BATCH) {
  await Promise.all(
    Array.from({ length: Math.min(BATCH, ROWS - at) }, (_, k) => {
      const i = at + k;
      // ms 必须是默认数值字段（DEFAULT_NUM_FIELDS）之一，否则区间查询会走
      // 「字段不存在 → 返回空」的快路径，测出来的不是区间扫描，是空结果。
      // 2026-10-31 就在这里踩过：用 salary 测了半天，其实那个字段从未入索引。
      return db.bizPut(`u_${i}`, {
        name: `用户${i}`,
        dept: DEPTS[i % 5],
        status: STATUS[i % 3],
        level: i % 9,
        ms: i,
      });
    })
  );
}
const writeMs = performance.now() - tWrite0;

const afterWrite = mem();
const statsW = db.stats();
const segCount = statsW.segs.snapshot ?? 0;

const tClose = performance.now();
await db.close();
const closeMs = performance.now() - tClose;

const bytes = fs.statSync(file).size;
const bytesPerRow = bytes / ROWS;

// ---- 打开（每轮一个独立进程内的新 Store）----
interface OpenRun {
  ms: number;
  path: string;
  note: string;
  heap: number;
  external: number;
  rss: number;
}
const openOnce = async (snapshot: boolean): Promise<OpenRun> => {
  const before = mem();
  const s = Store.open(file, { snapshot });
  const st = s.stats();
  const after = mem();
  const out = {
    ms: st.snapshot.openMs,
    path: s.openPath,
    note: st.snapshot.note,
    heap: after.heap - before.heap,
    external: after.external - before.external,
    rss: after.rss - before.rss,
  };
  await s.close();
  return out;
};

// 预热：JIT + 文件页缓存，丢掉
await openOnce(true);
await openOnce(false);

const snaps: OpenRun[] = [];
const replays: OpenRun[] = [];
for (let r = 0; r < 3; r++) {
  snaps.push(await openOnce(true));
  replays.push(await openOnce(false));
}

const snapMs = pct(snaps.map((x) => x.ms), 50);
const replayMs = pct(replays.map((x) => x.ms), 50);
const snapHeap = pct(snaps.map((x) => x.heap), 50);
const snapExternal = pct(snaps.map((x) => x.external), 50);
const snapRss = pct(snaps.map((x) => x.rss), 50);

// ---- 查询（逐条计时太长，按批计时再折算）----
const q = Store.open(file);
const FILTERS: Filter[] = [
  { eq: { dept: 'R&D' } },
  { eq: { dept: ['R&D', 'QA'] } },
  { eq: { dept: 'R&D', status: 'active' }, gte: { level: 4 } },
  // 真实区间查询：ms 递增，命中中间 20%。这是块剪枝该发力的场景。
  { gte: { ms: 400000 }, lte: { ms: 600000 } },
  // 命中 0.1%：剪枝效果的天花板
  { gte: { ms: 999000 }, lte: { ms: 999100 } },
  // 不存在的数值字段：应立刻返回空，不许扫全表
  { gte: { salary: 12000 }, lte: { salary: 20000 } },
];
const qStats = FILTERS.map((f) => {
  // 预热 3 次，再连跑 30 次取中位
  for (let i = 0; i < 3; i++) q.bizQuery({ ...f, limit: 50 });
  const lat: number[] = [];
  let matched = 0;
  for (let i = 0; i < 30; i++) {
    const t = performance.now();
    matched = q.bizQuery({ ...f, limit: 50 }).keys.length;
    lat.push(performance.now() - t);
  }
  return { label: JSON.stringify(f), p50: pct(lat, 50), p99: pct(lat, 99), matched };
});
const idxRows = (() => {
  // 索引本身在 open 时已经建好，这里只记一下位图/枚举的规模，方便对照
  const st = q.bizStats();
  return { bitmaps: st.index.bitmaps, rows: st.index.rows, nums: st.index.nums.length };
})();
await q.close();

// ---- 外推 ----
const GB = 1024 * MB;
const rowsAt10G = (TARGET_GB * GB) / bytesPerRow;
const heapPerRow = Math.max(0, snapHeap) / ROWS;
const externalPerRow = Math.max(0, snapExternal) / ROWS;
// 数值列/位图的内存是结构确定的，不必依赖 external 测量（external 里混着 transient
// 快照 buffer，实测会高估数倍）：数值列每列 Float64Array = 8 B/行，位图每张 1 bit/行。
const structPerRow = idxRows.nums * 8 + idxRows.bitmaps / 8;
const memAt10G = (rowsAt10G * heapPerRow) / GB;
const externalAt10G = (rowsAt10G * externalPerRow) / GB;
const structAt10G = (rowsAt10G * structPerRow) / GB;
const openAt10G = (rowsAt10G * snapMs) / ROWS / 1000;

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        rows: ROWS,
        writeMs,
        closeMs,
        bytes,
        bytesPerRow,
        snapMs,
        replayMs,
        snapHeap,
        snapExternal,
        snapRss,
        heapPerRow,
        externalPerRow,
        structPerRow,
        rowsAt10G,
        memAt10G,
        externalAt10G,
        structAt10G,
        openAt10G,
        queries: qStats,
        idxRows,
        canGC,
        segCount,
        afterWriteRss: afterWrite.rss - base.rss,
      },
      null,
      2
    )
  );
} else {
  console.log('');
  console.log(`写入                ${(writeMs / 1000).toFixed(1)}s  ${(ROWS / (writeMs / 1000)).toFixed(0)} 行/秒`);
  console.log(`close（含写快照）    ${closeMs.toFixed(0)}ms`);
  console.log(`文件                ${(bytes / MB).toFixed(1)}MB  ${bytesPerRow.toFixed(1)} 字节/行`);
  console.log('');
  console.log(`open 快照           ${snapMs.toFixed(1)}ms   +heap ${(snapHeap / MB).toFixed(1)}MB  +external ${(snapExternal / MB).toFixed(1)}MB  +rss ${(snapRss / MB).toFixed(1)}MB`);
  console.log(`open 重放           ${replayMs.toFixed(1)}ms   ${replays[0]!.path}`);
  console.log(`加速                ${(replayMs / snapMs).toFixed(1)}×`);
  console.log('');
  for (const s of qStats) {
    console.log(`查询 ${s.label.padEnd(52)} p50=${s.p50.toFixed(1)}ms p99=${s.p99.toFixed(1)}ms  命中 ${s.matched}`);
  }
  console.log('');
  console.log(`每行成本·key 映射(heap)    ${heapPerRow.toFixed(1)} B/行  ${canGC ? '' : '（无 gc，含垃圾，不可信）'}`);
  console.log(`每行成本·数值列/位图(结构) ${structPerRow.toFixed(1)} B/行（${idxRows.nums} 数值列×8B + ${idxRows.bitmaps} 位图×1bit）`);
  console.log(`位图规模            ${idxRows.bitmaps} 个位图 / ${idxRows.rows} 行`);
  console.log('');
  console.log(`=== 外推到 ${TARGET_GB}GB ===`);
  console.log(`行数                ${Math.round(rowsAt10G).toLocaleString()}`);
  console.log(`key 映射内存(heap)  ${memAt10G.toFixed(2)}GB`);
  console.log(`数值列/位图(结构)   ${structAt10G.toFixed(2)}GB`);
  console.log(`冷启动（线性外推）  ${openAt10G.toFixed(1)}s`);
}

if (!KEEP) fs.rmSync(dir, { recursive: true, force: true });
else console.log(`保留 ${file}`);
