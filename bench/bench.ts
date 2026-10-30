/**
 * 压测：把「设计总纲」里那几条主张逐个用数字验证。
 *
 *   1. 逐条提交 vs group commit —— 差多少倍
 *   2. 点查 / 列表延迟（p50 / p99）
 *   3. body 直读（不同尺寸，不 parse）
 *   4. 清空（段标记 + 尾部截断）
 *   5. 冷启动（open 重放索引）
 *   6. 体积与稀疏占用
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.ts';
import { crc32Impl } from '../src/crc32.ts';
import type { Locator } from '../src/types.ts';

const MB = 1048576;
const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const pct = (arr: number[], p: number): number => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i]!;
};
const fmt = (ms: number): string => (ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-bench-'));

async function benchWrites(seqN: number, concN: number): Promise<void> {
  console.log('\n=== 1. 写入：逐条提交 vs group commit ===');
  const payload = { name: 'bench', dept: 'R&D', level: 3, note: 'x'.repeat(120) };

  // 逐条（每次 await 后单独一次 commit/fsync）
  {
    const f = path.join(tmp, 'seq.db');
    const db = Store.create(f, { shellCap: 256 * 1024 });
    const t0 = performance.now();
    for (let i = 0; i < seqN; i++) await db.put('biz', `s_${i}`, payload);
    const ms = performance.now() - t0;
    const st = db.stats();
    await db.close();
    console.log(
      `  逐条 await ${seqN} 条: ${ms.toFixed(0)} ms  → ${(seqN / (ms / 1000)).toFixed(0)} 条/秒  fsync=${st.fsyncs}`
    );
  }

  // 并发（同一窗口内合并成一次 fsync）
  {
    const f = path.join(tmp, 'conc.db');
    const db = Store.create(f, { shellCap: 256 * 1024 });
    const t0 = performance.now();
    await Promise.all(Array.from({ length: concN }, (_, i) => db.put('biz', `c_${i}`, payload)));
    const ms = performance.now() - t0;
    const st = db.stats();
    await db.close();
    const rep = st.committer as { commits: number; avgBatch: number; maxBatch: number; fsyncMsEwma: number };
    console.log(
      `  并发 ${concN} 条: ${ms.toFixed(0)} ms  → ${(concN / (ms / 1000)).toFixed(0)} 条/秒  fsync=${st.fsyncs}` +
        `  平均批=${rep.avgBatch} 最大批=${rep.maxBatch} fsync ewma=${rep.fsyncMsEwma}ms`
    );
  }
}

async function benchReads(file: string): Promise<void> {
  console.log('\n=== 2. 读：点查 / 列表 ===');
  const t0 = performance.now();
  const db = Store.open(file);
  const openMs = performance.now() - t0;
  const st = db.stats();
  console.log(`  冷启动 open: ${openMs.toFixed(1)} ms  (重放 ${st.records.capture ?? 0} 抓包 + ${st.records.agent ?? 0} run + ${st.records.biz ?? 0} 业务)`);

  // 曾经这里不检查数据是否存在：库里的 capture 是 0 条，于是 20000 次点查全部
  // 走 miss 分支（返回 null 极快），报出 p50=0µs —— 看起来快得不真实，实际什么都没测到。
  const keys = db.list('capture', { limit: 500 }).map((r) => r.key);
  if (keys.length === 0) {
    await db.close();
    throw new Error(
      '这个库里没有 capture 记录：点查与列表会全部 miss，量到的不是读延迟。\n' +
        '  先造数据: node bench/gen.ts --out <file> --cap 5000'
    );
  }

  const n = 20000;
  // performance.now() 在 macOS 上的分辨率约 1µs（实测读数会被 round 到整数微秒），
  // 单次点查是纯内存 Map.get，落在 0 —— 早先这里报的是「p50=0µs」，
  // 看着惊人其实什么都没测到。改成批内累加：每批 2000 次测总时长，再折算到 ns/op。
  const BATCH = 2000;
  const batches = Math.floor(n / BATCH);
  for (let i = 0; i < n; i++) db.get('capture', keys[i % keys.length]!); // 预热
  const perOp: number[] = [];
  for (let b = 0; b < batches; b++) {
    const t = performance.now();
    for (let i = 0; i < BATCH; i++) {
      const e = db.get('capture', keys[(b * BATCH + i) % keys.length]!);
      if (!e) throw new Error('点查 miss：list 里有、get 拿不到');
    }
    perOp.push(((performance.now() - t) * 1e6) / BATCH); // ns/op
  }
  const nsFmt = (x: number): string => (x < 1000 ? `${x.toFixed(0)} ns` : `${(x / 1000).toFixed(2)} µs`);
  console.log(
    `  点查 ${n} 次（${keys.length} 个真实 key，每批 ${BATCH}）: p50=${nsFmt(pct(perOp, 50))} p99=${nsFmt(pct(perOp, 99))}`
  );

  const lat2: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const after = keys[(i * 37) % keys.length]!;
    const t = performance.now();
    const rows = db.list('capture', { limit: 50, after });
    if (rows.length === 0) throw new Error(`列表为空：after=${after}`);
    lat2.push(performance.now() - t);
  }
  console.log(`  列表 50 条 ×2000: p50=${fmt(pct(lat2, 50))} p99=${fmt(pct(lat2, 99))}`);

  console.log('\n=== 3. body 直读（原样字节，不 parse）===');
  // 挑最小的一个 capture body：大的那个（agent run）单独列，避免两件事混在一起
  let smallest: { key: string; loc: Locator } | null = null;
  for (const key of keys) {
    const e = db.get('capture', key);
    if (!e?.b) continue;
    if (!smallest || e.b.l < smallest.loc.l) smallest = { key, loc: e.b };
  }
  const targets: Array<{ key: string; loc: Locator }> = [];
  if (smallest) targets.push(smallest);
  const run = db.get('agent', 'run_0');
  if (run?.b) targets.push({ key: 'run_0', loc: run.b });

  if (targets.length === 0) throw new Error('没有可直读的 body');
  for (const { key, loc } of targets) {
    const lat3: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      db.bodyAt(loc);
      lat3.push(performance.now() - t);
    }
    console.log(
      `  ${key.padEnd(8)} ${String((loc.l / 1024).toFixed(0)).padStart(6)} KB: p50=${fmt(pct(lat3, 50))} p99=${fmt(pct(lat3, 99))}`
    );
  }

  await db.close();
}

async function benchClear(file: string): Promise<void> {
  console.log('\n=== 4. 清空 capture（段标记 + 尾部截断）===');
  // 在副本上清空。早先直接清原库，后果有两个：压测库被永久破坏（第二次跑 bench 时
  // capture 已经是 0 条，报出「清空 0 条」还以为是 O(段数) 快得不真实），
  // 而且得重跑 gen 才能再测一次。压测不该有副作用。
  const copy = path.join(tmp, 'clear.db');
  fs.copyFileSync(file, copy);
  const db = Store.open(copy);
  const before = fs.statSync(copy).size;
  const beforeRec = db.count('capture');
  if (beforeRec === 0) {
    await db.close();
    throw new Error('副本里 capture 也是 0 条：请重新 node bench/gen.ts 造库');
  }
  const t0 = performance.now();
  const r = await db.clearNs('capture');
  const ms = performance.now() - t0;
  const after = fs.statSync(copy).size;
  console.log(
    `  清空 ${beforeRec} 条: ${ms.toFixed(2)} ms  段 dead=${r.deadSegs} 截断=${r.truncated}  文件 ${(before / MB).toFixed(1)}MB → ${(after / MB).toFixed(1)}MB`
  );
  const c = db.check();
  console.log(`  自检: ok=${c.ok} issues=${c.issues.length}`);
  const left = db.count('capture');
  console.log(`  清空后剩余 ${left} 条（应为 0）`);
  await db.close();
  fs.rmSync(copy, { force: true });
}

function report(file: string): void {
  const st = fs.statSync(file);
  console.log('\n=== 5. 体积 ===');
  console.log(`  逻辑 ${(st.size / MB).toFixed(1)} MB / 实际占用 ${((st.blocks * 512) / MB).toFixed(1)} MB`);
  console.log(`  CRC 实现: ${crc32Impl}`);
  console.log(`  Node ${process.version} / V8 ${process.versions.v8} / ${process.arch}`);
}

async function main(): Promise<void> {
  const file = arg('--file', 'data/bench.db');
  const seqN = Number(arg('--seq', '300'));
  const concN = Number(arg('--conc', '5000'));
  if (!fs.existsSync(file)) {
    console.error(`先造数据: node bench/gen.ts --out ${file}`);
    process.exitCode = 1;
    return;
  }
  report(file);
  await benchWrites(seqN, concN);
  await benchReads(file);
  await benchClear(file);
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
