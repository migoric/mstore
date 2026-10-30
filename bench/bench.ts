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

  const n = 20000;
  const lat: number[] = [];
  for (let i = 0; i < n; i++) {
    const key = `c_${i % 5000}`;
    const t = performance.now();
    db.get('capture', key);
    lat.push(performance.now() - t);
  }
  console.log(`  点查 ${n} 次: p50=${fmt(pct(lat, 50))} p99=${fmt(pct(lat, 99))}`);

  const lat2: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const t = performance.now();
    db.list('capture', { limit: 50, after: `c_${i}` });
    lat2.push(performance.now() - t);
  }
  console.log(`  列表 50 条 ×2000: p50=${fmt(pct(lat2, 50))} p99=${fmt(pct(lat2, 99))}`);

  console.log('\n=== 3. body 直读（原样字节，不 parse）===');
  for (const key of ['c_0', 'c_20', 'run_0']) {
    const e = db.get(key.startsWith('run') ? 'agent' : 'capture', key);
    if (!e?.b) continue;
    const lat3: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      db.bodyAt(e.b);
      lat3.push(performance.now() - t);
    }
    console.log(`  ${key.padEnd(6)} ${String((e.b.l / 1024).toFixed(0)).padStart(6)} KB: p50=${fmt(pct(lat3, 50))} p99=${fmt(pct(lat3, 99))}`);
  }

  await db.close();
}

async function benchClear(file: string): Promise<void> {
  console.log('\n=== 4. 清空 capture（段标记 + 尾部截断）===');
  const db = Store.open(file);
  const before = fs.statSync(file).size;
  const beforeRec = db.count('capture');
  const t0 = performance.now();
  const r = await db.clearNs('capture');
  const ms = performance.now() - t0;
  const after = fs.statSync(file).size;
  console.log(
    `  清空 ${beforeRec} 条: ${ms.toFixed(2)} ms  段 dead=${r.deadSegs} 截断=${r.truncated}  文件 ${(before / MB).toFixed(1)}MB → ${(after / MB).toFixed(1)}MB`
  );
  const c = db.check();
  console.log(`  自检: ok=${c.ok} issues=${c.issues.length}`);
  await db.close();
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
