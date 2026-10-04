#!/usr/bin/env node
/**
 * wave-gate —— 波次门编排队（任务37）
 *
 * 把手工五连收敛为一条命令、单一退出码：
 *   ① npm run lint:types                     （tsc --noEmit）
 *   ② 全量 vitest（test:ci 口径）             —— 只负责执行与计数（产出 JSON 报告）
 *   ③ node tools/test-baseline/check.mjs --report <②的 JSON> —— 失败白名单判定权在此门
 *   ④ node tools/i18n/audit.mjs --strict ...  （FAIL/WARN 计数）
 *   ⑤ npx tsx tools/jarvis-canary/run.ts --level=smoke（或 l3/l2，见 --canary）
 *
 * 设计要点：
 *   - ② 与 ③ 共用同一次 vitest 运行（check.mjs --report 复用 JSON），避免全量跑两遍；
 *   - ② 的"通过"含义 = suite 跑完并产出可解析报告（本仓有白名单内既有失败，
 *     原始 vitest 退出码非 0 属预期）；测试失败是否阻塞由 ③ 判定；
 *   - 每次完整运行把关键计数追加 tools/wave-gate/trend.jsonl（gitignored），
 *     并与上一行做 delta 打印（数字变化高亮）；
 *   - 零新依赖：只用 node 内置模块 + 子进程调用既有命令；
 *   - --self-test 用内置样例验证各解析函数 / delta / 退出码聚合，不真跑全量。
 *
 * 详见同目录 README.md。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const TREND_PATH = path.join(HERE, 'trend.jsonl');
const PKG_PATH = path.join(REPO_ROOT, 'package.json');

/** package.json test:ci 解析失败时的兜底（与 check.mjs EXCLUDES 镜像保持一致）。 */
const EXCLUDES_FALLBACK = [
  'src/packages/client/hooks/__tests__/useSnapshots.test.ts',
  'src/packages/client/hooks/__tests__/useKeyboardShortcuts.test.ts',
];

/** 趋势行里参与 delta 对照的数值字段（顺序即打印顺序）。 */
const TREND_NUMERIC_KEYS = [
  'lintErrors',
  'testTotal',
  'testPassed',
  'testFailed',
  'whitelistBaselineFailures',
  'whitelistEntries',
  'i18nFails',
];

// ──────────────────────────────── 输出小工具 ────────────────────────────────

const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(text, code) {
  return USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text;
}
const green = (t) => paint(t, '32');
const red = (t) => paint(t, '31');
const yellow = (t) => paint(t, '33');
const cyan = (t) => paint(t, '36');
const dim = (t) => paint(t, '2');

function fmtSec(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function tailLines(text, n = 25) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-n).join('\n');
}

// ──────────────────────────────── 解析函数 ────────────────────────────────
// 全部为纯函数（输入字符串/对象，输出结构化结果），便于 --self-test。

/** ① lint:types：tsc 报错行形如 `src/x.ts(1,2): error TS2322: ...`，计数 error TS<码>。 */
export function parseLintErrors(text) {
  const m = String(text ?? '').match(/error TS\d+/g);
  return m ? m.length : 0;
}

/** 从 package.json 文本提取 test:ci 的 --exclude 列表（口径唯一真源，避免三处手抄漂移）。 */
export function readTestCiExcludes(pkgJsonText) {
  try {
    const scripts = JSON.parse(pkgJsonText).scripts ?? {};
    const cmd = scripts['test:ci'] ?? '';
    const out = [];
    const re = /--exclude[= ]("[^"]+"|'[^']+'|\S+)/g;
    let m;
    while ((m = re.exec(cmd)) !== null) {
      out.push(m[1].replace(/^["']|["']$/g, ''));
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * ② vitest JSON 报告（vitest json reporter 与 jest 同形）→ 计数。
 * 根字段（numTotalTests 等）优先；缺失时按 testResults[].assertionResults[].status 兜底。
 */
export function parseVitestReportObject(report) {
  if (report && typeof report.numTotalTests === 'number') {
    return {
      total: report.numTotalTests,
      passed: report.numPassedTests ?? 0,
      failed: report.numFailedTests ?? 0,
      pending: report.numPendingTests ?? 0,
    };
  }
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const tr of report?.testResults ?? []) {
    for (const a of tr.assertionResults ?? []) {
      if (a.status === 'passed') passed += 1;
      else if (a.status === 'failed') failed += 1;
      else pending += 1; // pending / todo / skipped 统一记入待定
    }
  }
  return { total: passed + failed + pending, passed, failed, pending };
}

/** ③ 基线对照：`[test-baseline] 失败 60 / 白名单 60` → { failures, entries }。 */
export function parseBaselineCounts(text) {
  const m = /\[test-baseline\]\s*失败\s*(\d+)\s*\/\s*白名单\s*(\d+)/.exec(String(text ?? ''));
  return m ? { failures: Number(m[1]), entries: Number(m[2]) } : null;
}

/** ④ i18n audit 尾行：`totals: 3 FAIL · 1 WARN · 22 INFO`（取最后一次出现）。 */
export function parseI18nTotals(text) {
  const re = /totals:\s*(\d+)\s*FAIL\s*·\s*(\d+)\s*WARN\s*·\s*(\d+)\s*INFO/g;
  let m;
  let last = null;
  while ((m = re.exec(String(text ?? ''))) !== null) last = m;
  return last ? { fails: Number(last[1]), warns: Number(last[2]), infos: Number(last[3]) } : null;
}

/** ⑤ 金丝雀摘要行：`汇总: 共 2 | 通过 1 | 失败 0 | 跳过 0 | 计划 1 | 用时 Nms`。 */
export function parseCanarySummary(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /汇总:\s*共\s*(\d+)\s*\|\s*通过\s*(\d+)\s*\|\s*失败\s*(\d+)\s*\|\s*跳过\s*(\d+)\s*\|\s*计划\s*(\d+)/.exec(lines[i]);
    if (m) {
      return {
        total: Number(m[1]),
        pass: Number(m[2]),
        fail: Number(m[3]),
        skip: Number(m[4]),
        planned: Number(m[5]),
      };
    }
  }
  return null;
}

/** ⑤ 金丝雀报告落盘路径行：`报告已写入: E:\...\reports\x.json`（取最后一次出现）。 */
export function parseCanaryReportPath(text) {
  const re = /报告已写入[:：]\s*(.+?)\s*$/gm;
  let m;
  let last = null;
  while ((m = re.exec(String(text ?? ''))) !== null) last = m;
  return last ? last[1] : null;
}

/** 统一的 canarySummary 字符串（进趋势文件；跨运行可比）。 */
export function formatCanarySummary(kind, s) {
  if (!s) return null;
  return `${kind} total=${s.total} pass=${s.pass} fail=${s.fail} skip=${s.skip} planned=${s.planned}`;
}

/**
 * delta 计算：返回 [{ key, before, after, changed, diff }]。
 * 仅当两边都是数字且不等时 changed=true；null/缺失一律视作"无对照"（changed=false）。
 */
export function computeDelta(prev, cur, keys = TREND_NUMERIC_KEYS) {
  return keys.map((key) => {
    const before = prev ? prev[key] : null;
    const after = cur ? cur[key] : null;
    const bothNumeric = typeof before === 'number' && typeof after === 'number';
    const changed = bothNumeric && before !== after;
    return { key, before, after, changed, diff: changed ? after - before : 0 };
  });
}

/** 退出码聚合：任一非零即 1，全零即 0。 */
export function aggregateExitCode(codes) {
  return codes.some((c) => c !== 0) ? 1 : 0;
}

// ──────────────────────────────── 子进程执行 ────────────────────────────────

/**
 * 跑一条门命令。shell: true（Windows 下即 cmd.exe）——与 check.mjs 的 execSync 同模式。
 * 返回 { code, stdout, stderr, elapsedMs, error }；code 语义：124 超时 / 127 启动失败 / 其余为真实退出码。
 */
export function runCommand(command, { timeoutMs = 30 * 60 * 1000, capture = true, label = '' } = {}) {
  const started = Date.now();
  const res = spawnSync(command, {
    cwd: REPO_ROOT,
    shell: true,
    encoding: 'utf-8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    maxBuffer: 128 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
  const elapsedMs = Date.now() - started;
  let code;
  if (res.error && res.error.code === 'ETIMEDOUT') code = 124;
  else if (res.error) code = 127;
  else code = typeof res.status === 'number' ? res.status : 1;
  const error = res.error ? `启动/超时错误：${res.error.message}` : null;
  if (error) console.error(`[wave-gate] ${label || command} ${error}`);
  return {
    code,
    stdout: capture ? String(res.stdout ?? '') : '',
    stderr: capture ? String(res.stderr ?? '') : '',
    elapsedMs,
    error,
  };
}

// ──────────────────────────────── 各门实现 ────────────────────────────────

function gateLint() {
  const r = runCommand('npm run lint:types', { timeoutMs: 10 * 60 * 1000, label: 'lint:types' });
  const text = `${r.stdout}\n${r.stderr}`;
  const lintErrors = parseLintErrors(text);
  const ok = r.code === 0 && lintErrors === 0;
  return {
    id: 'lint',
    title: 'lint:types（tsc --noEmit）',
    ok,
    code: ok ? 0 : r.code === 0 ? 1 : r.code,
    elapsedMs: r.elapsedMs,
    metrics: { lintErrors },
    note: `TS 错误 ${lintErrors}`,
    tail: ok ? null : tailLines(text),
  };
}

function gateVitest(opts, tmpReportPath) {
  // 复用已有报告：不跑 vitest，直接把指定 JSON 当 ② 的产物
  if (opts.vitestReport) {
    const p = path.resolve(REPO_ROOT, opts.vitestReport);
    if (!fs.existsSync(p)) {
      return {
        id: 'vitest',
        title: '全量 vitest（复用报告）',
        ok: false,
        code: 2,
        elapsedMs: 0,
        metrics: { testTotal: null, testPassed: null, testFailed: null },
        note: `--vitest-report 指定的报告不存在：${p}`,
        tail: null,
        reportPath: null,
      };
    }
    return finishVitestGate(p, 0, null, 0, true);
  }

  const pkgText = fs.existsSync(PKG_PATH) ? fs.readFileSync(PKG_PATH, 'utf-8') : '';
  const excludes = readTestCiExcludes(pkgText);
  const list = excludes.length > 0 ? excludes : EXCLUDES_FALLBACK;
  const excludeArgs = list.map((e) => `--exclude "${e}"`).join(' ');
  const cmd = `npx vitest run ${excludeArgs} --reporter=json --outputFile="${tmpReportPath}"`;
  const r = runCommand(cmd, { timeoutMs: 60 * 60 * 1000, capture: true, label: 'vitest' });
  return finishVitestGate(tmpReportPath, r.code, `${r.stdout}\n${r.stderr}`, r.elapsedMs, false);
}

function finishVitestGate(reportPath, rawCode, rawText, elapsedMs, reuse) {
  let counts = null;
  let parseError = null;
  if (fs.existsSync(reportPath)) {
    try {
      counts = parseVitestReportObject(JSON.parse(fs.readFileSync(reportPath, 'utf-8')));
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!counts) {
    return {
      id: 'vitest',
      title: reuse ? '全量 vitest（复用报告）' : '全量 vitest（test:ci 口径）',
      ok: false,
      code: 2,
      elapsedMs,
      metrics: { testTotal: null, testPassed: null, testFailed: null },
      note: parseError
        ? `报告解析失败：${parseError}`
        : `未产出可解析的 vitest JSON 报告（原始退出码 ${rawCode}）`,
      tail: rawText ? tailLines(rawText, 30) : null,
      reportPath: null,
    };
  }
  // ② 的判定权：suite 跑完 + 报告可解析；用例失败本身交给 ③ 基线白名单对照裁决
  const ok = true;
  const noteParts = [`用例 ${counts.total} = 通过 ${counts.passed} + 失败 ${counts.failed} + 待定 ${counts.pending}`];
  if (!reuse && rawCode !== 0) {
    noteParts.push(`vitest 原始退出码 ${rawCode}（白名单内既有失败属预期，判定权 → ③）`);
  }
  return {
    id: 'vitest',
    title: reuse ? '全量 vitest（复用报告）' : '全量 vitest（test:ci 口径）',
    ok,
    code: 0,
    elapsedMs,
    metrics: { testTotal: counts.total, testPassed: counts.passed, testFailed: counts.failed },
    note: noteParts.join('；'),
    tail: null,
    reportPath,
  };
}

function gateBaseline(reportPath) {
  if (!reportPath || !fs.existsSync(reportPath)) {
    return {
      id: 'baseline',
      title: '基线白名单对照（test-baseline）',
      ok: false,
      code: 2,
      elapsedMs: 0,
      metrics: { whitelistBaselineFailures: null, whitelistEntries: null },
      note: '无 vitest 报告可对照（② 失败）',
      tail: null,
    };
  }
  const r = runCommand(`node tools/test-baseline/check.mjs --report "${reportPath}"`, {
    timeoutMs: 10 * 60 * 1000,
    label: 'test-baseline',
  });
  const text = `${r.stdout}\n${r.stderr}`;
  const counts = parseBaselineCounts(text);
  const ok = r.code === 0;
  const consistent = /✅ 与基线一致/.test(text);
  let note;
  if (counts) {
    note = `失败 ${counts.failures} / 白名单 ${counts.entries}${ok ? ' · 零新增零垃圾' : ''}`;
  } else {
    note = `未解析到对照行（退出码 ${r.code}）`;
  }
  if (!consistent && ok) note += '（未匹配到 ✅ 行）';
  return {
    id: 'baseline',
    title: '基线白名单对照（test-baseline）',
    ok,
    code: r.code,
    elapsedMs: r.elapsedMs,
    metrics: {
      whitelistBaselineFailures: counts ? counts.failures : null,
      whitelistEntries: counts ? counts.entries : null,
    },
    note,
    tail: ok ? null : tailLines(text, 40),
  };
}

function gateI18n() {
  const r = runCommand('node tools/i18n/audit.mjs --strict --allowlist tools/i18n/allowlist.json', {
    timeoutMs: 15 * 60 * 1000,
    label: 'i18n-audit',
  });
  const text = `${r.stdout}\n${r.stderr}`;
  const totals = parseI18nTotals(text);
  const ok = r.code === 0;
  const note = totals
    ? `FAIL ${totals.fails} · WARN ${totals.warns} · INFO ${totals.infos}`
    : `未解析到 totals 行（退出码 ${r.code}）`;
  return {
    id: 'i18n',
    title: 'i18n audit --strict',
    ok,
    code: r.code,
    elapsedMs: r.elapsedMs,
    metrics: { i18nFails: totals ? totals.fails : null },
    note,
    tail: ok ? null : tailLines(text, 40),
  };
}

function gateCanary(kind) {
  const cmds = {
    smoke: 'npx tsx tools/jarvis-canary/run.ts --level=smoke',
    l3: 'npx tsx tools/jarvis-canary/run.ts --level=full --scenario=delegation',
    l2: 'npx tsx tools/jarvis-canary/l2-sandbox.ts',
  };
  const timeoutMs = kind === 'smoke' ? 20 * 60 * 1000 : 45 * 60 * 1000;
  const r = runCommand(cmds[kind], { timeoutMs, label: `jarvis-canary ${kind}` });
  const text = `${r.stdout}\n${r.stderr}`;
  const summary = parseCanarySummary(text);
  const reportPathRaw = parseCanaryReportPath(text);
  let summaryFromReport = null;
  let reportRel = null;
  if (reportPathRaw && fs.existsSync(reportPathRaw)) {
    reportRel = path.relative(REPO_ROOT, reportPathRaw).replace(/\\/g, '/');
    try {
      const report = JSON.parse(fs.readFileSync(reportPathRaw, 'utf-8'));
      if (report?.summary) summaryFromReport = report.summary;
    } catch {
      // 报告 JSON 读不动时退回 stdout 汇总行
    }
  }
  const s = summaryFromReport ?? summary;
  const titleMap = { smoke: 'jarvis-canary smoke', l3: 'jarvis-canary L3 派活链（--level=full --scenario=delegation）', l2: 'jarvis-canary L2 沙箱（l2-sandbox）' };
  const note = s
    ? `共 ${s.total} · 通过 ${s.pass} · 失败 ${s.fail} · 跳过 ${s.skip} · 计划 ${s.planned}${reportRel ? ` · 报告 ${reportRel}` : ''}`
    : `退出码 ${r.code}（未解析到汇总行）`;
  return {
    id: 'canary',
    title: titleMap[kind],
    ok: r.code === 0,
    code: r.code,
    elapsedMs: r.elapsedMs,
    metrics: {
      canarySummary: formatCanarySummary(kind, s),
      canaryExit: r.code,
    },
    note,
    tail: r.code === 0 ? null : tailLines(text, 40),
  };
}

// ──────────────────────────────── 趋势文件 ────────────────────────────────

function gitField(args) {
  const r = runCommand(`git ${args}`, { timeoutMs: 15 * 1000, capture: true });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

function readLastTrendLine() {
  if (!fs.existsSync(TREND_PATH)) return null;
  const lines = fs
    .readFileSync(TREND_PATH, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function byId(gates, id) {
  return gates.find((g) => g.id === id) ?? null;
}

export function buildTrendLine(gates) {
  const g = (id) => byId(gates, id);
  const m = (id, key) => {
    const gate = g(id);
    const v = gate?.metrics ? gate.metrics[key] : null;
    return typeof v === 'number' ? v : null;
  };
  return {
    ts: new Date().toISOString(),
    commit: gitField('rev-parse --short HEAD'),
    branch: gitField('rev-parse --abbrev-ref HEAD'),
    lintErrors: m('lint', 'lintErrors'),
    testTotal: m('vitest', 'testTotal'),
    testPassed: m('vitest', 'testPassed'),
    testFailed: m('vitest', 'testFailed'),
    whitelistBaselineFailures: m('baseline', 'whitelistBaselineFailures'),
    whitelistEntries: m('baseline', 'whitelistEntries'),
    i18nFails: m('i18n', 'i18nFails'),
    canarySummary: g('canary')?.metrics?.canarySummary ?? null,
  };
}

function formatValue(v) {
  return v === null || v === undefined ? dim('—') : String(v);
}

function printDelta(prev, cur) {
  if (!prev) {
    console.log(dim('[wave-gate] 趋势：首行数据，暂无对照。'));
    return;
  }
  console.log(cyan('[wave-gate] 趋势对照（上一行 → 本次）：'));
  for (const d of computeDelta(prev, cur)) {
    let right = formatValue(d.after);
    if (d.changed) {
      const arrow = d.diff > 0 ? '↑' : '↓';
      right = yellow(`${d.after} (${arrow}${d.diff > 0 ? '+' : ''}${d.diff})`);
    }
    console.log(`  ${d.key.padEnd(24)} ${formatValue(d.before)} → ${right}`);
  }
  const prevCanary = prev.canarySummary ?? null;
  const curCanary = cur.canarySummary ?? null;
  if (prevCanary !== curCanary) {
    console.log(`  ${'canarySummary'.padEnd(24)} ${formatValue(prevCanary)} → ${yellow(formatValue(curCanary))}`);
  } else {
    console.log(`  ${'canarySummary'.padEnd(24)} ${formatValue(curCanary)}`);
  }
}

// ──────────────────────────────── 参数与主流程 ────────────────────────────────

export function parseGateArgs(argv) {
  const o = {
    quick: false,
    skipCanary: false,
    canary: 'smoke',
    vitestReport: null,
    noTrend: false,
    selfTest: false,
    help: false,
    errors: [],
  };
  for (const a of argv) {
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--self-test') o.selfTest = true;
    else if (a === '--quick') o.quick = true;
    else if (a === '--skip-canary') o.skipCanary = true;
    else if (a === '--no-trend') o.noTrend = true;
    else if (a === '--canary=smoke' || a === '--canary=l3' || a === '--canary=l2') o.canary = a.split('=')[1];
    else if (a.startsWith('--vitest-report=')) o.vitestReport = a.slice('--vitest-report='.length) || null;
    else o.errors.push(`无法识别的参数：${a}`);
  }
  if (o.quick && o.vitestReport) o.errors.push('--quick 与 --vitest-report 不能合用（quick 不跑测试门）');
  return o;
}

function printHelp() {
  console.log(`wave-gate —— 波次门编排队（五门一条命令、单一退出码）

用法:
  node tools/wave-gate/gate.mjs                    # 全量五门
  node tools/wave-gate/gate.mjs --quick            # 快检：仅 ① lint:types + ④ i18n audit
  node tools/wave-gate/gate.mjs --skip-canary      # 四门（跳过金丝雀）
  node tools/wave-gate/gate.mjs --canary=l3        # 金丝雀换 L3 派活链（--level=full --scenario=delegation）
  node tools/wave-gate/gate.mjs --canary=l2        # 金丝雀换 L2 沙箱（l2-sandbox，stub LLM）
  node tools/wave-gate/gate.mjs --vitest-report=<path>  # 复用已有 vitest JSON，不重跑全量（②③ 用）
  node tools/wave-gate/gate.mjs --no-trend         # 不追加趋势文件
  node tools/wave-gate/gate.mjs --self-test        # 用内置样例自测解析/delta/退出码聚合

退出码: 0 全绿 · 1 至少一门失败 · 2 参数错误。
详见 tools/wave-gate/README.md。`);
}

function printGateResult(index, total, gate) {
  const badge = gate.ok ? green('✅ 通过') : red('❌ 失败');
  const codeText = dim(`exit=${gate.code}`);
  console.log(`[${index}/${total}] ${gate.title.padEnd(38)} ${badge} ${codeText} ${fmtSec(gate.elapsedMs)} | ${gate.note}`);
  if (gate.tail) {
    console.log(dim(indent(gate.tail, '      ')));
  }
}

function indent(text, pad) {
  return text
    .split('\n')
    .map((l) => `${pad}${l}`)
    .join('\n');
}

function runSelfTest() {
  const fails = [];
  let count = 0;
  const check = (name, cond, detail = '') => {
    count += 1;
    if (cond) {
      console.log(`  ✔ ${name}`);
    } else {
      fails.push(`${name}${detail ? `（${detail}）` : ''}`);
      console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
    }
  };
  const eq = (name, actual, expected) =>
    check(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);

  console.log('[wave-gate] --self-test（内置样例，不真跑任何门）');

  // ① lint 解析
  const lintDirty = "src/a.ts(3,7): error TS2322: Type 'x' is not assignable to type 'y'.\nsrc/b.ts(9,1): error TS1005: ';' expected.\nFound 2 errors in 2 files.";
  const lintClean = '> tide-commander@1.222.0 lint:types\n> tsc --noEmit\n';
  eq('parseLintErrors 脏输出=2', parseLintErrors(lintDirty), 2);
  eq('parseLintErrors 干净输出=0', parseLintErrors(lintClean), 0);

  // test:ci 口径提取
  const pkgSample = JSON.stringify({ scripts: { 'test:ci': 'vitest run --exclude a/b.test.ts --exclude "c d/e.test.ts"' } });
  eq('readTestCiExcludes 提取', readTestCiExcludes(pkgSample), ['a/b.test.ts', 'c d/e.test.ts']);
  eq('readTestCiExcludes 坏 JSON 兜底', readTestCiExcludes('{oops'), []);

  // ② vitest 报告解析
  eq(
    'parseVitestReportObject 根字段',
    parseVitestReportObject({ numTotalTests: 2820, numPassedTests: 2753, numFailedTests: 60, numPendingTests: 7 }),
    { total: 2820, passed: 2753, failed: 60, pending: 7 },
  );
  eq(
    'parseVitestReportObject 兜底遍历',
    parseVitestReportObject({
      testResults: [
        { assertionResults: [{ status: 'passed' }, { status: 'failed' }, { status: 'pending' }] },
        { assertionResults: [{ status: 'passed' }] },
      ],
    }),
    { total: 4, passed: 2, failed: 1, pending: 1 },
  );

  // ③ 基线对照行
  const baselineSample = '[test-baseline] 失败 60 / 白名单 60\n[test-baseline] ✅ 与基线一致：零新增失败、零垃圾条目。';
  eq('parseBaselineCounts', parseBaselineCounts(baselineSample), { failures: 60, entries: 60 });
  eq('parseBaselineCounts 缺行=null', parseBaselineCounts('没有这行'), null);

  // ④ i18n totals（取最后一次出现）
  eq('parseI18nTotals', parseI18nTotals('totals: 3 FAIL · 1 WARN · 22 INFO'), { fails: 3, warns: 1, infos: 22 });
  eq('parseI18nTotals 取尾行', parseI18nTotals('totals: 9 FAIL · 9 WARN · 9 INFO\n中间\ntotals: 0 FAIL · 0 WARN · 2849 INFO'), {
    fails: 0,
    warns: 0,
    infos: 2849,
  });
  eq('parseI18nTotals 缺行=null', parseI18nTotals('totals 没对齐'), null);

  // ⑤ 金丝雀汇总/报告路径
  const canarySample =
    '=== jarvis-canary 金丝雀真链路冒烟 ===\n汇总: 共 2 | 通过 1 | 失败 0 | 跳过 0 | 计划 1 | 用时 15388ms\n报告已写入: C:\\repo\\tools\\jarvis-canary\\reports\\x.json';
  eq('parseCanarySummary', parseCanarySummary(canarySample), { total: 2, pass: 1, fail: 0, skip: 0, planned: 1 });
  eq('parseCanaryReportPath', parseCanaryReportPath(canarySample), 'C:\\repo\\tools\\jarvis-canary\\reports\\x.json');
  eq('formatCanarySummary', formatCanarySummary('smoke', { total: 2, pass: 1, fail: 0, skip: 0, planned: 1 }), 'smoke total=2 pass=1 fail=0 skip=0 planned=1');
  eq('parseCanarySummary 缺行=null', parseCanarySummary('无摘要'), null);

  // delta 计算
  const prev = {
    lintErrors: 0,
    testTotal: 2820,
    testPassed: 2753,
    testFailed: 60,
    whitelistBaselineFailures: 60,
    whitelistEntries: 60,
    i18nFails: 0,
    canarySummary: 'smoke total=2 pass=1 fail=0 skip=0 planned=1',
  };
  const cur = { ...prev, testTotal: 2821, testFailed: 61, i18nFails: 2, canarySummary: 'smoke total=2 pass=0 fail=1 skip=0 planned=0' };
  const delta = computeDelta(prev, cur);
  const d = (k) => delta.find((x) => x.key === k);
  check('delta testFailed 变化 +1', d('testFailed').changed && d('testFailed').diff === 1);
  check('delta testTotal 变化 +1', d('testTotal').changed && d('testTotal').diff === 1);
  check('delta i18nFails 变化 +2', d('i18nFails').changed && d('i18nFails').diff === 2);
  check('delta lintErrors 无变化', d('lintErrors').changed === false);
  check('delta 空对照不算变化', computeDelta(null, cur).every((x) => x.changed === false));

  // 退出码聚合
  eq('聚合: 全零=0', aggregateExitCode([0, 0, 0, 0, 0]), 0);
  eq('聚合: 任一非零=1', aggregateExitCode([0, 0, 1, 0, 0]), 1);
  eq('聚合: 超时/解析失败也算失败', aggregateExitCode([2, 0, 0, 0, 0]), 1);
  eq('聚合: 空=0', aggregateExitCode([]), 0);

  // 参数解析
  const pa = parseGateArgs(['--quick', '--skip-canary', '--canary=l3', '--vitest-report=x.json', '--no-trend']);
  check('parseGateArgs 各开关', pa.quick && pa.skipCanary && pa.canary === 'l3' && pa.vitestReport === 'x.json' && pa.noTrend);
  check('parseGateArgs 未知参数报错', parseGateArgs(['--nope']).errors.length === 1);
  check('parseGateArgs quick+vitest-report 冲突', parseGateArgs(['--quick', '--vitest-report=x']).errors.length === 1);
  check('parseGateArgs self-test', parseGateArgs(['--self-test']).selfTest);

  console.log('');
  if (fails.length === 0) {
    console.log(green(`[wave-gate] 自测通过 ${count}/${count} ✅`));
    return 0;
  }
  console.log(red(`[wave-gate] 自测失败 ${fails.length}/${count}：`));
  for (const f of fails) console.log(red(`  - ${f}`));
  return 1;
}

function main() {
  const opts = parseGateArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }
  if (opts.selfTest) return runSelfTest();
  if (opts.errors.length > 0) {
    for (const e of opts.errors) console.error(red(`[wave-gate] 参数错误：${e}`));
    console.error('用 --help 查看用法。');
    return 2;
  }

  const started = Date.now();
  const gates = [];
  const tmpReportPath = path.join(os.tmpdir(), `tc-wave-gate-${Date.now()}.json`);

  // ① lint
  console.log(cyan('[wave-gate] ① lint:types …'));
  gates.push(gateLint());

  if (!opts.quick) {
    // ② 全量 vitest（test:ci 口径）
    console.log(cyan(opts.vitestReport ? '[wave-gate] ② 全量 vitest（复用报告）…' : '[wave-gate] ② 全量 vitest（test:ci 口径，含两个 --exclude）…'));
    const g2 = gateVitest(opts, tmpReportPath);
    gates.push(g2);
    // ③ 基线白名单对照（复用 ② 的 JSON）
    console.log(cyan('[wave-gate] ③ 基线白名单对照（复用 ② 报告）…'));
    gates.push(gateBaseline(g2.reportPath));
  }

  // ④ i18n
  console.log(cyan('[wave-gate] ④ i18n audit --strict …'));
  gates.push(gateI18n());

  // ⑤ 金丝雀
  if (!opts.quick && !opts.skipCanary) {
    console.log(cyan(`[wave-gate] ⑤ jarvis-canary（${opts.canary}）…`));
    gates.push(gateCanary(opts.canary));
  }

  // 清理临时报告
  try {
    if (fs.existsSync(tmpReportPath)) fs.unlinkSync(tmpReportPath);
  } catch {
    // 清理失败不影响门结果
  }

  console.log('');
  console.log(cyan('=== wave-gate 门结果 ==='));
  gates.forEach((g, i) => printGateResult(i + 1, gates.length, g));

  const exitCode = aggregateExitCode(gates.map((g) => g.code));
  const failedNames = gates.filter((g) => !g.ok).map((g) => g.id);

  // 趋势（--quick 默认不追加；--no-trend 全禁）
  if (!opts.quick && !opts.noTrend) {
    console.log('');
    try {
      const prev = readLastTrendLine();
      const cur = buildTrendLine(gates);
      fs.mkdirSync(path.dirname(TREND_PATH), { recursive: true });
      fs.appendFileSync(TREND_PATH, `${JSON.stringify(cur)}\n`, 'utf-8');
      printDelta(prev, cur);
      console.log(dim(`[wave-gate] 已追加趋势行：${path.relative(REPO_ROOT, TREND_PATH).replace(/\\/g, '/')}`));
    } catch (err) {
      console.error(red(`[wave-gate] 趋势写入失败（不影响门结果）：${err instanceof Error ? err.message : String(err)}`));
    }
  }

  const totalMs = Date.now() - started;
  console.log('');
  if (exitCode === 0) {
    console.log(green(`[wave-gate] ✅ 全绿：${gates.length} 门全过，总用时 ${fmtSec(totalMs)}`));
  } else {
    console.log(red(`[wave-gate] ❌ 非零退出：${failedNames.join(' / ')} 失败，总用时 ${fmtSec(totalMs)}`));
  }
  return exitCode;
}

// 入口守卫：仅当直接执行本文件时跑 main（导出供未来测试引用）
if (process.argv[1] && /gate\.mjs$/i.test(process.argv[1].replace(/\\/g, '/'))) {
  process.exitCode = main();
}
