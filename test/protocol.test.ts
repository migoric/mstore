/**
 * stdio NDJSON 协议的集成测试：真的起一个 `cli.ts serve` 子进程，走管道收发。
 *
 * 为什么要单独测这一层：macOS 客户端完全靠这套协议活着，
 * 而 sidecar 的错误（方法名打错、result 形状变了）在单测里看不出来，
 * 到了界面层才会表现成「空白列表」，排查成本极高。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Store } from '../src/store.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-proto-'));
const CLI = path.join(import.meta.dirname, '..', 'cli.ts');

interface Client {
  hello: Record<string, unknown>;
  send(req: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 直接往管道里写一行原文，用来喂坏 JSON */
  raw(line: string): void;
  stop(): Promise<void>;
}

/** 起 sidecar、握手、返回一个按 id 对号的请求器 */
async function connect(file: string): Promise<Client> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [CLI, 'serve', file], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let buf = '';
  const waiters = new Map<number, (v: Record<string, unknown>) => void>();
  let hello: Record<string, unknown> = {};
  let nextId = 1;

  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.hello) {
        hello = msg.hello as Record<string, unknown>;
        continue;
      }
      const id = msg.id as number;
      waiters.get(id)?.(msg);
      waiters.delete(id);
    }
  });

  // 等 hello（sidecar 起来第一件事就是发它）
  for (let i = 0; i < 200 && !hello.pid; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(hello.pid, 'sidecar 必须先发 hello');

  return {
    hello,
    send(req) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`超时：${JSON.stringify(req)}`)), 10_000);
        waiters.set(id, (v) => {
          clearTimeout(timer);
          resolve(v);
        });
        child.stdin.write(JSON.stringify({ ...req, id }) + '\n');
      });
    },
    raw(line) {
      child.stdin.write(line + '\n');
    },
    async stop() {
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((r) => child.once('exit', () => r()));
    },
  };
}

const mkdb = (name: string): string => {
  const f = path.join(tmp, `${name}.db`);
  const db = Store.create(f, { segSize: 256 * 1024 });
  db.close();
  return f;
};

test('hello 带上 pid / crc / stats', async () => {
  const f = mkdb('hello');
  const c = await connect(f);
  assert.equal(typeof c.hello.pid, 'number');
  assert.equal(c.hello.crc, 'zlib.crc32');
  const stats = c.hello.stats as Record<string, unknown>;
  assert.ok(stats.file, 'hello 要带库信息，界面首屏就靠它');
  await c.stop();
});

test('KV：put / get / list / body / info / check / clear 往返', async () => {
  const f = mkdb('kv');
  const c = await connect(f);

  const put = await c.send({ op: 'put', ns: 'capture', key: 'r1', value: { url: '/a', status: 200 } });
  assert.equal(put.ok, true);
  assert.equal((put.result as { seq: number }).seq, 1);

  const got = await c.send({ op: 'get', ns: 'capture', key: 'r1' });
  assert.deepEqual((got.result as { value: unknown }).value, { url: '/a', status: 200 });

  const list = await c.send({ op: 'list', ns: 'capture', limit: 10 });
  assert.equal((list.result as unknown[]).length, 1);

  const body = Buffer.from('x'.repeat(1024));
  const wrote = await c.send({ op: 'putbody', ns: 'agent', key: 'run_1', base64: body.toString('base64') });
  assert.equal(wrote.ok, true);

  const readBack = await c.send({ op: 'body', ns: 'agent', key: 'run_1' });
  const bodyRes = readBack.result as { base64: string; len: number };
  assert.equal(bodyRes.len, 1024);
  assert.deepEqual(Buffer.from(bodyRes.base64, 'base64'), body, 'body 必须原样往返，不能多一个字节');

  const ranged = await c.send({ op: 'body.range', ns: 'agent', key: 'run_1', off: 10, len: 17 });
  const rangeRes = ranged.result as { base64: string; len: number; off: number; total: number };
  assert.equal(rangeRes.len, 17);
  assert.equal(rangeRes.off, 10);
  assert.equal(rangeRes.total, 1024);
  assert.deepEqual(Buffer.from(rangeRes.base64, 'base64'), body.subarray(10, 27));

  const info = await c.send({ op: 'info' });
  assert.equal(((info.result as { records: Record<string, number> }).records).capture, 1);

  const chk = await c.send({ op: 'check' });
  assert.equal((chk.result as { ok: boolean }).ok, true);

  const cleared = await c.send({ op: 'clear', ns: 'capture' });
  assert.ok((cleared.result as { deadSegs: number }).deadSegs >= 1);
  assert.equal(((await c.send({ op: 'info' })).result as { records: Record<string, number> }).records.capture, undefined);
  await c.stop();
});

test('业务表：info / put / query / get / del / clear', async () => {
  const f = mkdb('biz');
  const c = await connect(f);

  const rows = [
    { k: 'u_1', dept: 'R&D', status: 'active', level: 7 },
    { k: 'u_2', dept: 'R&D', status: 'leave', level: 3 },
    { k: 'u_3', dept: 'QA', status: 'active', level: 8 },
  ];
  for (const r of rows) {
    const res = await c.send({ op: 'biz.put', key: r.k, value: { dept: r.dept, status: r.status, level: r.level } });
    assert.equal(res.ok, true);
  }

  const info = await c.send({ op: 'biz.info' });
  const pages = (info.result as { pages: { rows: number; pages: number } }).pages;
  assert.equal(pages.rows, 3, '页表行数要对得上');
  assert.equal(pages.pages, 1, '三行应该都在同一页');

  const q = await c.send({ op: 'biz.query', filter: { eq: { dept: 'R&D' } } });
  const qr = q.result as { matched: number; took_us: number; rows: Array<{ key: string; value: { level: number } }> };
  assert.equal(qr.matched, 2);
  assert.deepEqual(qr.rows.map((r) => r.key), ['u_1', 'u_2'], '结果按 rowid 升序');
  assert.ok(qr.took_us >= 0);

  const combo = await c.send({ op: 'biz.query', filter: { eq: { dept: 'R&D' }, gte: { level: 5 } } });
  assert.deepEqual((combo.result as { rows: Array<{ key: string }> }).rows.map((r) => r.key), ['u_1']);

  const limited = await c.send({ op: 'biz.query', filter: {}, limit: 2 });
  const lr = limited.result as { matched: number; rows: unknown[] };
  assert.equal(lr.matched, 3, 'matched 是全量命中数');
  assert.equal(lr.rows.length, 2, 'limit 只截断返回的行');

  const one = await c.send({ op: 'biz.get', key: 'u_3' });
  assert.deepEqual((one.result as { value: unknown }).value, { dept: 'QA', status: 'active', level: 8 });

  const del = await c.send({ op: 'biz.del', key: 'u_2' });
  assert.equal((del.result as { removed: boolean }).removed, true);
  assert.equal((await c.send({ op: 'biz.query', filter: { eq: { dept: 'R&D' } } })).result instanceof Object, true);
  assert.equal(((await c.send({ op: 'biz.query', filter: { eq: { dept: 'R&D' } } })).result as { matched: number }).matched, 1);

  const cleared = await c.send({ op: 'biz.clear' });
  assert.equal((cleared.result as { rows: number }).rows, 2);
  assert.equal(((await c.send({ op: 'biz.query', filter: {} })).result as { matched: number }).matched, 0);
  await c.stop();
});

test('quit 响应返回前 close 与索引快照已经完成', async () => {
  const f = mkdb('quit');
  const c = await connect(f);
  const put = await c.send({ op: 'biz.put', key: 'u_1', value: { dept: 'R&D', level: 7 } });
  assert.equal(put.ok, true);
  const quit = await c.send({ op: 'quit' });
  assert.equal(quit.ok, true);
  await c.stop();

  const db = Store.open(f);
  assert.equal(db.openPath, 'snapshot', '客户端收到 quit 响应时，磁盘必须已经可立即用快照打开');
  assert.deepEqual(db.bizGet('u_1'), { dept: 'R&D', level: 7 });
  await db.close();
});

test('协议健壮性：坏 JSON 与未知方法都不该把 sidecar 带死', async () => {
  const f = mkdb('bad');
  const c = await connect(f);

  const unknown = await c.send({ op: 'nope' });
  assert.equal(unknown.ok, false);
  assert.match(String(unknown.error), /unknown op/);

  // 坏 JSON 没有 id，回包也没 id，只能写进去之后再确认进程还活着
  c.raw('{ 这不是 json');
  const alive = await c.send({ op: 'info' });
  assert.equal(alive.ok, true, '一个坏请求不能影响后续请求');
  await c.stop();
});
