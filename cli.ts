#!/usr/bin/env node
/**
 * mstore CLI —— 这四条命令就是设计总纲 §16 说的「可读性预算」的落地：
 * 任何二进制内容都必须能在 ≤3 条命令内变成文本。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Store } from './src/store.ts';
import { crc32Impl } from './src/crc32.ts';
import { cloneFile } from './src/io.ts';
import { NS_NAME } from './src/format.ts';
import type { NsName } from './src/types.ts';

const MB = 1024 * 1024;

function usage(): void {
  console.log(`mstore — 单文件本地存储

用法:
  mstore init <file.db> [--seg-size 16]      创建库（段大小单位 MB）
  mstore info <file.db>                      库信息 / 段统计 / 提交统计
  mstore check <file.db> [--json]            自检（段头、CRC、索引、locator）
  mstore put <file.db> <ns> <key> <json>     写一条记录
  mstore get <file.db> <ns> <key>            读一条记录
  mstore list <file.db> <ns> [--limit 20]    列表
  mstore dump <file.db> <ns>                 导出该 ns 为 NDJSON（stdout）
  mstore cat <file.db> <ns> <key>            body 原样输出（stdout）
  mstore export <file.db> <dir>              全库导出为 NDJSON 文件
  mstore backup <file.db> <dst.db>           APFS clone 时点快照
  mstore clear <file.db> <ns>                清空一个 ns（标记段组 dead）
  mstore reclaim <file.db>                   回收 pending 段（需 MSTORE_PUNCH_HELPER）
  mstore serve <file.db>                     stdio NDJSON 协议（给 macOS 客户端用）

ns: biz | capture | mock | agent`);
}

function argAfter(argv: string[], flag: string, def?: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : def;
}

function openStore(file: string): Store {
  if (!fs.existsSync(file)) throw new Error(`no such store: ${file}`);
  return Store.open(file);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') return usage();

  switch (cmd) {
    case 'init': {
      const file = argv[1];
      if (!file) return usage();
      if (fs.existsSync(file)) throw new Error(`already exists: ${file}`);
      const segMB = Number(argAfter(argv, '--seg-size', '16'));
      const t0 = performance.now();
      const db = Store.create(file, { segSize: segMB * MB });
      await db.close();
      const st = fs.statSync(file);
      console.log(
        `created ${file}  seg=${segMB}MB  logical=${(st.size / MB).toFixed(2)}MB  ${(performance.now() - t0).toFixed(1)}ms  crc=${crc32Impl}`
      );
      return;
    }

    case 'info': {
      const db = openStore(argv[1] ?? '');
      const s = db.stats();
      const st = fs.statSync(s.file);
      console.log(`file        ${s.file}`);
      console.log(`logical     ${(st.size / MB).toFixed(2)} MB   占用 ${(st.blocks * 512 / MB).toFixed(2)} MB`);
      console.log(`segSize     ${(s.segSize / MB).toFixed(0)} MB`);
      console.log(`segs        shell=${s.segs.shell} body=${s.segs.body} dead=${s.deadSegs} pending=${s.pendingReclaim}`);
      console.log(`records     ${JSON.stringify(s.records)}`);
      console.log(`seqs        ${JSON.stringify(s.seqs)}`);
      console.log(`crc         ${s.crcImpl}`);
      console.log(`fsyncs      ${s.fsyncs}`);
      console.log(`committer   ${JSON.stringify(s.committer)}`);
      await db.close();
      return;
    }

    case 'check': {
      const db = openStore(argv[1] ?? '');
      const r = db.check();
      if (argv.includes('--json')) {
        console.log(JSON.stringify(r, null, 2));
      } else {
        console.log(`ok=${r.ok}  segs=${r.segs} (shell=${r.shellSegs} body=${r.bodySegs} dead=${r.deadSegs})  records=${r.records}  locators=${r.orphanQuery}`);
        for (const i of r.issues) console.log(`  [${i.level}] ${i.where}: ${i.detail}`);
        if (r.issues.length === 0) console.log('  无问题');
      }
      await db.close();
      process.exitCode = r.ok ? 0 : 1;
      return;
    }

    case 'put': {
      const [, file, ns, key, json] = argv;
      if (!file || !ns || !key) return usage();
      const db = openStore(file);
      const value = json ? JSON.parse(json) : null;
      const r = await db.put(ns as NsName, key, value);
      await db.close();
      console.log(`ok seq=${r.seq}`);
      return;
    }

    case 'get': {
      const [, file, ns, key] = argv;
      const db = openStore(file!);
      const e = db.get(ns as NsName, key!);
      console.log(e ? JSON.stringify({ value: e.v, body: e.b ?? null, seg: e.segId, ts: e.ts }) : 'null');
      await db.close();
      return;
    }

    case 'list': {
      const [, file, ns] = argv;
      const db = openStore(file!);
      const limit = Number(argAfter(argv, '--limit', '20'));
      for (const row of db.list(ns as NsName, { limit })) {
        console.log(`${row.key}\t${JSON.stringify(row.value)}`);
      }
      await db.close();
      return;
    }

    case 'dump': {
      const [, file, ns] = argv;
      const db = openStore(file!);
      for (const row of db.list(ns as NsName, { limit: Number.MAX_SAFE_INTEGER })) {
        process.stdout.write(JSON.stringify({ k: row.key, v: row.value, t: row.ts }) + '\n');
      }
      await db.close();
      return;
    }

    case 'cat': {
      const [, file, ns, key] = argv;
      const db = openStore(file!);
      const buf = db.getBody(ns as NsName, key!);
      await db.close();
      if (!buf) {
        console.error('no body');
        process.exitCode = 1;
        return;
      }
      process.stdout.write(buf);
      return;
    }

    case 'export': {
      const [, file, dir] = argv;
      const db = openStore(file!);
      fs.mkdirSync(dir!, { recursive: true });
      for (const nsId of [1, 2, 3, 4]) {
        const name = NS_NAME[nsId]!;
        const rows = db.list(name as NsName, { limit: Number.MAX_SAFE_INTEGER });
        if (rows.length === 0) continue;
        const out = path.join(dir!, `${name}.ndjson`);
        const ws = fs.createWriteStream(out);
        for (const row of rows) ws.write(JSON.stringify({ k: row.key, v: row.value, t: row.ts }) + '\n');
        await new Promise<void>((r) => ws.end(() => r()));
        console.log(`${name}: ${rows.length} 条 → ${out}`);
      }
      await db.close();
      return;
    }

    case 'backup': {
      const [, file, dst] = argv;
      const db = openStore(file!);
      await db.flush();
      const t0 = performance.now();
      const r = cloneFile(file!, dst!);
      await db.close();
      const st = fs.statSync(dst!);
      console.log(
        `${r.cloned ? 'clonefile' : 'copy'} ${dst}  ${(st.size / MB).toFixed(2)}MB  ${(performance.now() - t0).toFixed(2)}ms`
      );
      return;
    }

    case 'clear': {
      const [, file, ns] = argv;
      const db = openStore(file!);
      const t0 = performance.now();
      const r = await db.clearNs(ns as NsName);
      await db.close();
      console.log(
        `cleared ${ns}: dead=${r.deadSegs} truncated=${r.truncated} freed=${(r.freedBytes / MB).toFixed(2)}MB  ${(performance.now() - t0).toFixed(2)}ms`
      );
      return;
    }

    case 'reclaim': {
      const db = openStore(argv[1] ?? '');
      const r = db.reclaim();
      await db.flush();
      await db.close();
      console.log(`punched=${r.punched} bytes=${(r.bytes / MB).toFixed(2)}MB (未设置 MSTORE_PUNCH_HELPER 时为 0)`);
      return;
    }

    case 'serve':
      return serve(openStore(argv[1] ?? ''));

    default:
      return usage();
  }
}

/** stdio NDJSON 协议：一行一个请求、一行一个响应。给 mstore-db 用 */
async function serve(db: Store): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  const send = (o: unknown): void => {
    process.stdout.write(JSON.stringify(o) + '\n');
  };
  send({ hello: { pid: process.pid, crc: crc32Impl, stats: db.stats() } });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: { id?: number; op: string; ns?: NsName; key?: string; value?: unknown; limit?: number; after?: string };
    try {
      req = JSON.parse(line);
    } catch {
      send({ ok: false, error: 'bad json' });
      continue;
    }
    const id = req.id;
    try {
      switch (req.op) {
        case 'info':
          send({ id, ok: true, result: db.stats() });
          break;
        case 'list':
          send({ id, ok: true, result: db.list(req.ns as NsName, { limit: req.limit ?? 20, after: req.after }) });
          break;
        case 'get': {
          const e = db.get(req.ns as NsName, req.key!);
          send({ id, ok: true, result: e ? { value: e.v, body: e.b ?? null, seg: e.segId, ts: e.ts } : null });
          break;
        }
        case 'body': {
          const buf = db.getBody(req.ns as NsName, req.key!);
          send({ id, ok: true, result: buf ? { base64: buf.toString('base64'), len: buf.length } : null });
          break;
        }
        case 'put': {
          const r = await db.put(req.ns as NsName, req.key!, req.value);
          send({ id, ok: true, result: r });
          break;
        }
        case 'check':
          send({ id, ok: true, result: db.check() });
          break;
        case 'clear': {
          const r = await db.clearNs(req.ns as NsName);
          send({ id, ok: true, result: r });
          break;
        }
        case 'backup': {
          await db.flush();
          const r = cloneFile(db.io.path, String(req.value));
          send({ id, ok: true, result: r });
          break;
        }
        case 'quit':
          send({ id, ok: true });
          await db.close();
          return;
        default:
          send({ id, ok: false, error: `unknown op: ${req.op}` });
      }
    } catch (e) {
      send({ id, ok: false, error: String(e instanceof Error ? e.message : e) });
    }
  }
  await db.close();
}

main().catch((e: unknown) => {
  console.error('mstore:', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
