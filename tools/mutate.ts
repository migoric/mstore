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
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

function runTests(testFile: string, timeoutMs: number): { ok: boolean; out: string } {
  const r = spawnSync(process.execPath, ['--test', testFile], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { ok: r.status === 0, out };
}

function main(): void {
  const target = arg('--target');
  const tests = arg('--tests');
  const max = Number(arg('--max', '100'));
  const timeoutMs = Number(arg('--timeout', '120000'));
  if (!target || !tests) {
    console.error('用法: node tools/mutate.ts --target <file> --tests <testfile> [--max N]');
    process.exit(2);
  }
  if (!fs.existsSync(target) || !fs.existsSync(tests)) {
    console.error('文件不存在:', !fs.existsSync(target) ? target : tests);
    process.exit(2);
  }

  const original = fs.readFileSync(target, 'utf8');
  const lines = original.split('\n');
  const all = collect(target);
  // 均匀抽样，保证预算内能覆盖整份文件
  const step = Math.max(1, Math.ceil(all.length / max));
  const picked = all.filter((_, i) => i % step === 0).slice(0, max);

  console.log(`变异测试  target=${path.basename(target)}  tests=${path.basename(tests)}`);
  console.log(`候选 ${all.length} 个，抽样 ${picked.length} 个\n`);

  // 基线：未变异时必须全绿，否则后面结论无意义
  const base = runTests(tests, timeoutMs);
  if (!base.ok) {
    console.error('[中止] 基线测试没通过，先修测试再跑变异。');
    console.error(base.out.split('\n').filter((l) => l.includes('not ok')).slice(0, 5).join('\n'));
    process.exit(1);
  }

  let killed = 0;
  const survivors: Mutant[] = [];
  const t0 = Date.now();

  for (const [i, mut] of picked.entries()) {
    const mutated = [...lines];
    mutated[mut.line - 1] = mut.after;
    fs.writeFileSync(target, mutated.join('\n'));
    let res: { ok: boolean; out: string };
    try {
      res = runTests(tests, timeoutMs);
    } finally {
      fs.writeFileSync(target, original);
    }
    const status = res.ok ? '存活' : '杀死';
    if (!res.ok) killed++;
    else survivors.push(mut);
    process.stdout.write(
      `[${String(i + 1).padStart(2)}/${picked.length}] L${String(mut.line).padStart(4)}  ${mut.from} → ${mut.to}  ${status}\n`
    );
  }

  // 兜底：确保文件已还原
  if (fs.readFileSync(target, 'utf8') !== original) {
    fs.writeFileSync(target, original);
    console.error('警告：源码曾未还原，已强制写回。');
  }

  const score = picked.length === 0 ? 100 : (killed / picked.length) * 100;
  console.log(`\n结果：杀死 ${killed} / ${picked.length}，存活 ${survivors.length}，变异得分 ${score.toFixed(1)}%`);
  console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (survivors.length) {
    console.log('\n存活的变异（这些逻辑没有被断言覆盖，值得补测试）：');
    for (const s of survivors) {
      console.log(`  L${s.line}: ${s.before.trim()}`);
      console.log(`      → ${s.after.trim()}`);
    }
  }
  // 得分低于 70% 视为质量不达标
  process.exit(score >= 70 ? 0 : 1);
}

main();
