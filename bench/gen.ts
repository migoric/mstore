/**
 * 造测试数据：三类数据各来一批，尽量贴近真实形态。
 *   biz      人员/业务行（固定字段，小）
 *   capture  抓包（元数据 + body）
 *   agent    run（外壳 + 大 JSON body，永不 parse）
 */
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.ts';

const MB = 1048576;

const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const out = arg('--out', 'data/bench.db');
const nBiz = Number(arg('--biz', '2000'));
const nCap = Number(arg('--cap', '5000'));
const nRuns = Number(arg('--runs', '100'));
const bodyKB = Number(arg('--body', '200'));

const HOSTS = ['api.example.com', 'auth.example.com', 'cdn.example.com', 'pay.example.com'];
const PATHS = ['/v1/users', '/v1/items', '/v1/orders', '/v1/auth/refresh', '/static/app.js'];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
const AGENTS = ['reviewer', 'coder', 'researcher', 'planner'];
const STATUS = [200, 201, 204, 400, 404, 500];

function randOf<T>(a: T[], i: number): T {
  return a[i % a.length]!;
}

function makeBody(kb: number, seed: number): Buffer {
  const steps = Math.max(4, Math.floor((kb * 1024) / 220));
  const doc = {
    run_id: `run_${seed}`,
    steps: Array.from({ length: steps }, (_, i) => ({
      i,
      tool: i % 3 === 0 ? 'read_file' : i % 3 === 1 ? 'grep' : 'edit_file',
      path: `/src/mod${i}.ts`,
      out: 'const value = await readFile(p); // '.repeat(4),
      ms: 8 + (i % 40),
      tok: 200 + i,
    })),
  };
  return Buffer.from(JSON.stringify(doc));
}

async function batched<T>(items: T[], size: number, fn: (item: T, i: number) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    await Promise.all(slice.map((it, j) => fn(it, i + j)));
  }
}

async function main(): Promise<void> {
  if (fs.existsSync(out)) fs.rmSync(out);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const t0 = performance.now();
  const db = Store.create(out, { shellCap: 1 * MB });

  // 1) 业务数据
  await batched(Array.from({ length: nBiz }, (_, i) => i), 500, (i) =>
    db.put('biz', `u_${i}`, {
      name: `用户${i}`,
      dept: ['R&D', 'Design', 'QA', 'Ops'][i % 4],
      level: i % 9,
      status: ['active', 'leave', 'gone'][i % 3],
      email: `user${i}@example.com`,
      updated_at: Date.now() - i * 1000,
    })
  );

  // 2) 抓包：元数据进 shell，响应体进 body 段（原样字节）
  await batched(Array.from({ length: nCap }, (_, i) => i), 200, async (i) => {
    const kb = 1 + (i % 24);
    const body = Buffer.from(
      JSON.stringify({ ok: true, i, items: Array.from({ length: kb }, (_, k) => ({ id: k, name: `item${k}` })) })
    );
    await db.putBody(
      'capture',
      `c_${i}`,
      body,
      {
        ts: Date.now() - i * 250,
        method: randOf(METHODS, i),
        host: randOf(HOSTS, i),
        path: randOf(PATHS, i),
        status: randOf(STATUS, i),
        ms: 5 + (i % 300),
        bytes: body.length,
      }
    );
  });

  // 3) agent run：大 JSON，sidecar 永不 parse
  await batched(Array.from({ length: nRuns }, (_, i) => i), 20, async (i) => {
    const body = makeBody(bodyKB, i);
    await db.putBody(
      'agent',
      `run_${i}`,
      body,
      {
        agent: randOf(AGENTS, i),
        status: i % 11 === 0 ? 'failed' : 'done',
        started_at: Date.now() - i * 60000,
        ms: 1200 + i * 7,
        bytes: body.length,
      }
    );
  });

  await db.flush();
  const st = db.stats();
  const fileSt = fs.statSync(out);
  await db.close();

  const ms = performance.now() - t0;
  console.log(`生成完成 ${out}  用时 ${(ms / 1000).toFixed(1)}s`);
  console.log(
    `  记录: ${JSON.stringify(st.records)}  (biz=${nBiz} capture=${nCap} agent=${nRuns})`
  );
  console.log(
    `  文件: 逻辑 ${(fileSt.size / 1048576).toFixed(1)} MB / 占用 ${((fileSt.blocks * 512) / 1048576).toFixed(1)} MB`
  );
  console.log(`  段: shell=${st.segs.shell} body=${st.segs.body}  fsync=${st.fsyncs}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
