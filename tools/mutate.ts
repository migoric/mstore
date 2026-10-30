/**
 * 变异测试：零依赖的极简实现。
 *
 * 思路：把源码里「一处运算符」改掉，然后跑单测。
 *   - 测试失败 → 这个变异被「杀死」（说明测试真的在验证这段逻辑）
 *   - 测试仍通过 → 变异「存活」（说明这段逻辑没有被断言覆盖）
 *
 * 单测覆盖率只说明「这行被执行过」，变异存活率才说明「这行被验证过」。
 *
 * 用法：
 *   node tools/mutate.ts --target src/bitmap.ts --tests test/bitmap.test.ts
 *   node tools/mutate.ts --target src/bizindex.ts --tests test/biz.test.ts --max 12
 *   node tools/mutate.ts --target src/store.ts --tests test/core.test.ts,test/biz.test.ts
 *   node tools/mutate.ts --target src/bizindex.ts --tests test/predicate.test.ts --workers 4
 *
 * ## 为什么要并行（2026-10-31 改）
 *
 * 每个变异体都要完整跑一遍测试。给 bizindex 加了 9 个 12000 行的用例之后，
 * 单轮从 0.5s 变成 20s，100 个变异体串行跑要 33 分钟——CI 直接超时，
 * 本地也没人愿意等。所以改成多进程：每个 worker 有自己的一份源码副本目录，
 * 互不干扰地改写 + 跑测试。
 *
 * 副本只复制 `src/` 与 `test/`（测试用 `node --test` 直接跑 TS，不需要 node_modules）。
 * 这样既不碰主工作区，也不会因为并行改写同一份文件而互相踩。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

interface Mutant {
  line: number;
  from: string;
  to: string;
  before: string;
  after: string;
}

const arg = (k: string, d?: string): string | undefined => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};

const OPERATORS: Array<{ from: RegExp; to: (m: string) => string; label: string }> = [
  { from: /===/g, to: () => '!==', label: '=== → !==' },
  { from: /!==/g, to: () => '===', label: '!== → ===' },
  { from: />=/g, to: () => '>', label: '>= → >' },
  { from: /<=/g, to: () => '<', label: '<= → <' },
  { from: /(?<![<>=!])>(?![>=])/g, to: () => '>=', label: '> → >=' },
  { from: /(?<![<>=!])<(?![<=])/g, to: () => '<=', label: '< → <=' },
  { from: /&&/g, to: () => '||', label: '&& → ||' },
  { from: /\|\|/g, to: () => '&&', label: '|| → &&' },
  { from: /\btrue\b/g, to: () => 'false', label: 'true → false' },
  { from: /\bfalse\b/g, to: () => 'true', label: 'false → true' },
];

const SKIP_LINE = /^\s*(\/\/|\*|\/\*|import\b|export type|export interface|@)/;
/** 行尾写 // equiv 的，表示「这个变异与语义等价」，跳过（例如 typed array 越界写会被静默忽略） */
const EQUIV_MARK = /\/\/\s*equiv\b/;

/** 判断 idx 是否落在字符串/模板字面量里 —— 否则会把错误信息里的 ">= 0" 也当成逻辑变异 */
function insideString(line: string, idx: number): boolean {
  let q: string | null = null;
  for (let i = 0; i < idx; i++) {
    const c = line[i]!;
    if (q) {
      if (c === q && line[i - 1] !== '\\') q = null;
    } else if (c === "'" || c === '"' || c === '`') {
      q = c;
    }
  }
  return q !== null;
}

/** 剥掉行尾注释（保持与字符串/模板字面量里的 // 区分） */
function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === q && line[i - 1] !== '\\') q = null;
    } else if (c === "'" || c === '"' || c === '`') {
      q = c;
    } else if (c === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}

function collect(file: string): Mutant[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out: Mutant[] = [];
  lines.forEach((raw, idx) => {
    const line = stripComment(raw);
    if (SKIP_LINE.test(line)) return;
    if (EQUIV_MARK.test(raw)) return;
    // 容错：把 `// equiv` 写在紧邻的上一行（纯注释行）也算标注。
    //
    // 规范写法是写在同一行行尾，我也知道。但这条规则在 2026-10-31 一天之内被踩了三次，
    // 每次都要重跑一整轮变异（50 秒到 30 分钟）才暴露，代价太高。
    // 上一行是纯注释时不存在歧义，直接认。
    const prev = idx > 0 ? lines[idx - 1]! : '';
    if (/^\s*\/\//.test(prev) && EQUIV_MARK.test(prev)) return;
    for (const op of OPERATORS) {
      op.from.lastIndex = 0;
      let m = op.from.exec(line);
      // 跳过落在字符串里的匹配，继续在同一行找下一个
      while (m && insideString(line, m.index)) m = op.from.exec(line);
      if (!m) continue;
      const at = m.index;
      const mutated = raw.slice(0, at) + op.to(m[0]) + raw.slice(at + m[0].length);
      out.push({ line: idx + 1, from: m[0], to: op.to(m[0]), before: line, after: mutated });
      break; // 每行只取一处变异，避免组合爆炸
    }
  });
  return out;
}

function runTestsSync(cwd: string, testFiles: string[], timeoutMs: number): { ok: boolean; out: string } {
  const r = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { ok: r.status === 0, out };
}

/** 异步版：并行 worker 要用它，spawnSync 会阻塞整个进程 */
function runTestsAsync(cwd: string, testFiles: string[], timeoutMs: number): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--test', ...testFiles], { cwd, stdio: 'ignore' });
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok });
    };
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      // 超时算「杀死」：变异体能让测试挂死，说明测试确实感知到了它
      done(false);
    }, timeoutMs);
    p.on('close', (code) => done(code === 0));
    p.on('error', () => done(false));
  });
}

/** 给一个 worker 准备独立的工作目录：只复制 src 与 test，够跑 node --test */
function makeWorkspace(root: string, id: number): string {
  const dir = path.join(root, `w${id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync('src', path.join(dir, 'src'), { recursive: true });
  fs.cpSync('test', path.join(dir, 'test'), { recursive: true });
  return dir;
}

async function main(): Promise<void> {
  const target = arg('--target');
  const tests = arg('--tests');
  const max = Number(arg('--max', '100'));
  const timeoutMs = Number(arg('--timeout', '60000'));
  const minScore = Number(arg('--min', '70'));
  const cpus = Math.max(1, os.cpus().length);
  const workers = Math.max(1, Math.min(Number(arg('--workers', String(Math.min(4, cpus)))), 8));
  if (!target || !tests) {
    console.error('用法: node tools/mutate.ts --target <file> --tests <a.ts[,b.ts]> [--max N] [--workers N] [--min 分数]');
    process.exit(2);
  }
  const testFiles = tests.split(',').map((s) => s.trim()).filter(Boolean);
  for (const f of [target, ...testFiles]) {
    if (fs.existsSync(f)) continue;
    console.error('文件不存在:', f);
    process.exit(2);
  }

  const original = fs.readFileSync(target, 'utf8');
  const lines = original.split('\n');
  const all = collect(target);
  // 均匀抽样，保证预算内能覆盖整份文件
  const step = Math.max(1, Math.ceil(all.length / max));
  const picked = all.filter((_, i) => i % step === 0).slice(0, max);

  const label = testFiles.map((f) => path.basename(f)).join('+');
  console.log(`变异测试  target=${path.basename(target)}  tests=${label}  workers=${workers}`);
  console.log(`候选 ${all.length} 个，抽样 ${picked.length} 个\n`);

  // 基线：未变异时必须全绿，否则后面结论无意义
  const base = runTestsSync('.', testFiles, timeoutMs);
  if (!base.ok) {
    console.error('[中止] 基线测试没通过，先修测试再跑变异。');
    console.error(base.out.split('\n').filter((l) => l.includes('not ok')).slice(0, 5).join('\n'));
    process.exit(1);
  }

  const t0 = Date.now();
  const beforeHash = hashOf(original);

  // 所有 worker 一律在副本里跑，包括 --workers 1。
  //
  // 原来单 worker 走「原地改写主工作区」快路径，结果 2026-10-31 我按 Ctrl-C 掐掉一次
  // 跑了 31 分钟的串行变异，`finally` 没机会执行，主工作区的 bizindex.ts 里
  // `ok = false` 被留成了 `ok = true`——bruteForce 从此把所有行都当成命中，
  // 之后两个小时都在追一个「剪枝漏行」的假 bug。宁可多复制几十 KB，也不碰主工作区。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-mutate-'));
  const dirs = Array.from({ length: workers }, (_, i) => makeWorkspace(root, i));
  const killedFlags: boolean[] = new Array(picked.length).fill(false);
  let next = 0;
  let finished = 0;

  const runWorker = async (dir: string): Promise<void> => {
    const targetInDir = path.join(dir, target);
    while (true) {
      const idx = next++;
      if (idx >= picked.length) return;
      const mut = picked[idx]!;
      const mutated = [...lines];
      mutated[mut.line - 1] = mut.after;
      fs.writeFileSync(targetInDir, mutated.join('\n'));
      let res: { ok: boolean };
      try {
        res = await runTestsAsync(dir, testFiles, timeoutMs);
      } finally {
        fs.writeFileSync(targetInDir, original);
      }
      killedFlags[idx] = !res.ok;
      finished++;
      process.stdout.write(
        `[${String(finished).padStart(3)}/${picked.length}] L${String(mut.line).padStart(4)}  ` +
          `${mut.from} → ${mut.to}  ${res.ok ? '存活' : '杀死'}\n`
      );
    }
  };

  try {
    await Promise.all(dirs.map((d) => runWorker(d)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 兜底校验：主工作区一个字都不许变。变了就说明工具有 bug，得分不可信。
  const afterHash = hashOf(fs.readFileSync(target, 'utf8'));
  if (beforeHash !== afterHash) {
    console.error('\n[中止] 主工作区源码在本次变异跑动中被改动，结果不可信。');
    console.error(`  ${target} 前后 sha256 不一致`);
    process.exit(1);
  }

  const survivors = picked.filter((_, i) => !killedFlags[i]);
  report(picked.length - survivors.length, picked.length, survivors, t0, minScore);
}

function hashOf(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function report(killed: number, total: number, survivors: Mutant[], t0: number, minScore: number): void {
  const score = total === 0 ? 100 : (killed / total) * 100;
  console.log(`\n结果：杀死 ${killed} / ${total}，存活 ${survivors.length}，变异得分 ${score.toFixed(1)}%`);
  console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (score < minScore) console.log(`\n得分低于门槛 ${minScore}%，判定失败（--min 可调）`);
  if (survivors.length) {
    console.log('\n存活的变异（这些逻辑没有被断言覆盖，值得补测试）：');
    for (const s of survivors) {
      console.log(`  L${s.line}: ${s.before.trim()}`);
      console.log(`      → ${s.after.trim()}`);
    }
  }
  // 质量门禁：默认 70% 视为不达标。CI 传 --min 95，把「悄悄掉分」也拦下来——
  // 全局要求 100% 不现实（store 有 1 个空洞阈值的等值边界无法测），
  // 但 95% 这条线足够让「新写的分支没断言」立刻红，不会攒到没人记得。
  process.exit(score >= minScore ? 0 : 1);
}

await main();
