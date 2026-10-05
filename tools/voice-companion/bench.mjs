#!/usr/bin/env node
/**
 * 「语音伙伴」感知延迟基准(bench)
 *
 * 走真实链路 POST /api/voice-companion/process { stream:true }(与语音页同一条路径),
 * 解析 NDJSON 逐句打点,按套件/动作统计:
 *   首句到达 tMs(服务端自请求受理起) · 首句字数 · final elapsedMs · 总墙钟
 *
 * 用法:
 *   node tools/voice-companion/bench.mjs                              # 默认 general,query 各 5 条
 *   node tools/voice-companion/bench.mjs --suites=general --n=3 --label=before
 *   node tools/voice-companion/bench.mjs --once "现在几点了？"          # 单条即测
 *   node tools/voice-companion/bench.mjs --suites=delegate --allow-dispatch   # 派真活,默认禁用!
 *   node tools/voice-companion/bench.mjs --compare bench/before.jsonl bench/after-tts.jsonl
 *   node tools/voice-companion/bench.mjs --reset                      # 仅重置会话(保留记忆)
 *   node tools/voice-companion/bench.mjs --dry-run                    # 只打印计划回合,不联网
 *
 * 注意:
 *   - 每次跑都是真实回合:会进秘书会话上下文与 dialog 日志;请在没有真人正在用时跑。
 *   - 结果落 tools/voice-companion/bench/<label>.jsonl(已 gitignore)。
 *   - 派活套件(delegate)会真派任务给主管,必须显式 --allow-dispatch 才发。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = path.join(__dirname, 'bench');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const flag = (name, fallback = null) => {
  const pre = `--${name}=`;
  const eq = args.find((a) => a.startsWith(pre)); // 支持 --k=v 与 --k v 两种写法
  if (eq) return eq.slice(pre.length);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const pad2 = (x) => String(x).padStart(2, '0');
const now = new Date();
const base = (flag('base', 'http://127.0.0.1:6200')).replace(/\/$/, '');
const gapMs = Math.max(0, Number(flag('gap', '3000')) || 0);
const timeoutMs = Math.max(10_000, Number(flag('timeout', '240000')) || 240_000);
const resetBefore = has('reset');
const resetAfter = has('reset-after');
const once = flag('once');
const label = flag(
  'label',
  `run-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`,
);
const force = has('force');

// ---------------------------------------------------------------------------
// 套件(提示词须自包含;general/query 不得触发派活)
// ---------------------------------------------------------------------------
const SUITES = {
  general: [
    '现在几点了？',
    '在吗？',
    '随便说一句，今天适合出门吗？',
    '帮我解释一下「事缓则圆」这个词是什么意思。',
    '讲个冷知识给我听听。',
  ],
  query: [
    '小陈手上那件事进行到哪一步了？',
    '小刘现在在忙什么？',
    '刚才派出去的任务是谁在办？',
    '主管那边现在什么情况？',
    '现在大家都在干什么？',
  ],
  delegate: [
    '让团队回我一句收到，别的什么都别做。',
    '让小刘回我一句「收到」确认一下，不要做别的。',
    '让小陈只回一句「收到」，不要执行任何操作。',
  ],
};
const ALL_SUITES = Object.keys(SUITES);

const compareArg = args.indexOf('--compare');

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const cnt = (s) => Array.from(String(s ?? '')).length;
const pctl = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
};
const fmtMs = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
const fmt = (v) => (v == null ? '—' : String(v));

async function postJson(pathname, body) {
  const resp = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: resp.status, json, text };
}

// ---------------------------------------------------------------------------
// 单个回合
// ---------------------------------------------------------------------------
async function runTurn(suite, prompt) {
  const t0 = Date.now();
  const row = {
    ts: new Date().toISOString(), suite, prompt,
    ok: false, action: null, spoke: null,
    firstSentenceMs: null, firstSentenceChars: null, sentenceCount: 0,
    finalElapsedMs: null, wallMs: null, responseChars: null, error: null,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base}/api/voice-companion/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: prompt, stream: true }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      row.error = `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`;
      return row;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finalMsg = null;
    let errorMsg = null;
    const handleLine = (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'sentence') {
        row.sentenceCount += 1;
        if (row.firstSentenceMs == null) {
          row.firstSentenceMs = msg.tMs ?? (Date.now() - t0);
          row.firstSentenceChars = cnt(msg.text);
        }
      } else if (msg.type === 'final') {
        finalMsg = msg;
      } else if (msg.type === 'error') {
        errorMsg = msg;
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) handleLine(line);
      }
    }
    if (buf.trim()) handleLine(buf.trim());
    row.wallMs = Date.now() - t0;
    if (finalMsg?.result) {
      const r = finalMsg.result;
      row.ok = r.success === true;
      row.action = r.action ?? null;
      row.spoke = finalMsg.spoke ?? r.spoke ?? null;
      row.finalElapsedMs = typeof r.elapsedMs === 'number' ? r.elapsedMs : null;
      row.responseChars = cnt(r.response ?? '');
      if (!row.ok && r.error) row.error = String(r.error).slice(0, 200);
    } else if (errorMsg) {
      row.error = `${errorMsg.code ?? 'ERROR'}: ${(errorMsg.error ?? errorMsg.details ?? '').slice(0, 200)}`;
    } else {
      row.error = 'stream ended without final';
    }
  } catch (err) {
    row.wallMs = Date.now() - t0;
    row.error = err?.name === 'AbortError' ? `timeout(${timeoutMs / 1000}s)` : String(err?.message ?? err);
  } finally {
    clearTimeout(timer);
  }
  return row;
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------
function groupRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.suite}/${r.action ?? (r.ok ? '?' : 'failed')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

function summaryOf(rows) {
  const ok = rows.filter((r) => r.ok);
  const first = ok.map((r) => r.firstSentenceMs).filter((v) => v != null);
  const firstChars = ok.map((r) => r.firstSentenceChars).filter((v) => v != null);
  // 总时长口径:用墙钟(服务端 elapsedMs 在双跳动作里只算末跳,不可比)
  const finals = ok.map((r) => r.wallMs).filter((v) => v != null);
  return {
    n: rows.length, ok: ok.length,
    firstP50: pctl(first, 50), firstP90: pctl(first, 90),
    firstCharsP50: pctl(firstChars, 50), firstCharsP90: pctl(firstChars, 90),
    finalP50: pctl(finals, 50), finalP90: pctl(finals, 90),
  };
}

function printSummary(rows) {
  console.log('\n── 汇总(仅 ok 行计入时延) ──');
  for (const [key, g] of groupRows(rows)) {
    const s = summaryOf(g);
    console.log(`\n${key}  ×${s.ok}/${s.n}`);
    console.log(`  首句 tMs    p50=${fmtMs(s.firstP50)}  p90=${fmtMs(s.firstP90)}`);
    console.log(`  首句字数    p50=${fmt(s.firstCharsP50)}  p90=${fmt(s.firstCharsP90)}`);
    console.log(`  总墙钟      p50=${fmtMs(s.finalP50)}  p90=${fmtMs(s.finalP90)}`);
  }
}

// ---------------------------------------------------------------------------
// 对比模式
// ---------------------------------------------------------------------------
function loadJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// 终端里中文按双宽算,简单对齐
const wWidth = (s) => [...String(s)].reduce((n, c) => n + (/[　-鿿＀-￯]/.test(c) ? 2 : 1), 0);
const padEndW = (s, n) => String(s) + ' '.repeat(Math.max(0, n - wWidth(s)));
const padStartW = (s, n) => ' '.repeat(Math.max(0, n - wWidth(s))) + String(s);

function compareMode(fileA, fileB) {
  const a = loadJsonl(fileA);
  const b = loadJsonl(fileB);
  const ga = groupRows(a);
  const gb = groupRows(b);
  const keys = [...new Set([...ga.keys(), ...gb.keys()])].sort();
  const ms = (v) => (v == null ? '—' : fmtMs(v));
  const num = (n) => (n == null ? '—' : String(n));
  const dms = (x, y) => (x == null || y == null ? '—' : `${y - x >= 0 ? '+' : ''}${fmtMs(y - x)}`);
  const dn = (x, y) => (x == null || y == null ? '—' : `${y - x >= 0 ? '+' : ''}${y - x}`);
  console.log(`[compare] A=${path.basename(fileA)}  B=${path.basename(fileB)}`);
  console.log(`\n${padEndW('分组', 34)} ${padEndW('指标', 14)} ${padStartW('A', 8)} ${padStartW('B', 8)} ${padStartW('Δ', 9)}`);
  for (const key of keys) {
    const sa = ga.has(key) ? summaryOf(ga.get(key)) : null;
    const sb = gb.has(key) ? summaryOf(gb.get(key)) : null;
    const row = (label, va, vb, delta) =>
      console.log(`${padEndW(label === '首句p50' ? key : '', 34)} ${padEndW(label, 14)} ${padStartW(va, 8)} ${padStartW(vb, 8)} ${padStartW(delta, 9)}`);
    row('首句p50', ms(sa?.firstP50), ms(sb?.firstP50), dms(sa?.firstP50, sb?.firstP50));
    row('首句p90', ms(sa?.firstP90), ms(sb?.firstP90), dms(sa?.firstP90, sb?.firstP90));
    row('首句字数p50', num(sa?.firstCharsP50), num(sb?.firstCharsP50), dn(sa?.firstCharsP50, sb?.firstCharsP50));
    row('墙钟p50', ms(sa?.finalP50), ms(sb?.finalP50), dms(sa?.finalP50, sb?.finalP50));
    row('ok/n', sa ? `${sa.ok}/${sa.n}` : '—', sb ? `${sb.ok}/${sb.n}` : '—', '');
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  if (has('help') || args.includes('-h')) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 18).join('\n'));
    return;
  }

  if (compareArg >= 0) {
    const a = args[compareArg + 1], b = args[compareArg + 2];
    if (!a || !b) throw new Error('用法:--compare <a.jsonl> <b.jsonl>');
    compareMode(a, b);
    return;
  }

  // 套件选取
  let suites = (flag('suites', 'general,query')).split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of suites) if (!SUITES[s]) throw new Error(`未知套件:${s}(可选:${ALL_SUITES.join(',')})`);
  if (suites.includes('delegate') && !has('allow-dispatch')) {
    console.warn('[bench] delegate 套件会真派任务,需 --allow-dispatch;本次已跳过该套件。');
    suites = suites.filter((s) => s !== 'delegate');
  }

  // --once 单独用时只跑这一条(未显式给 --suites);显式 --suites 时 adhoc 追加在前
  if (once && flag('suites') == null) suites = [];

  const n = Math.max(1, Number(flag('n', '5')) || 5);
  const turns = [];
  if (once) turns.push(['adhoc', once]);
  for (const s of suites) for (let i = 0; i < n; i++) turns.push([s, SUITES[s][i % SUITES[s].length]]);

  const outFile = path.join(BENCH_DIR, `${label}.jsonl`);
  if (fs.existsSync(outFile) && !force) {
    throw new Error(`结果已存在:${outFile}(换 --label 或加 --force)`);
  }

  if (has('dry-run')) {
    console.log(`[bench] dry-run label=${label} 输出=${outFile} 共 ${turns.length} 回合:`);
    for (const [s, p] of turns) console.log(`  ${s.padEnd(8)} ${p}`);
    return;
  }

  // 连通性预检
  try {
    const st = await fetch(`${base}/api/voice-companion/status`);
    if (!st.ok) throw new Error(`status HTTP ${st.status}`);
  } catch (err) {
    console.error(`[bench] ✗ 服务端不可达 ${base}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (resetBefore) {
    const r = await postJson('/api/voice-companion/reset', { keepMemory: true });
    console.log(`[bench] 会话已重置(保留记忆):HTTP ${r.status}`);
  }

  fs.mkdirSync(BENCH_DIR, { recursive: true });

  console.log(`[bench] label=${label} 套件=${suites.join(',') || '(无)'}${once ? '+adhoc' : ''} n=${n} base=${base}`);
  console.log(`[bench] ${turns.length} 个真实回合(进入秘书会话上下文),间隔 ${gapMs}ms,单回合超时 ${timeoutMs / 1000}s`);
  console.log('[bench] 请确认此刻没有真人正在使用语音页。\n');

  const rows = [];
  const lines = [];
  let consecutiveFail = 0;
  const tStart = Date.now();
  for (let i = 0; i < turns.length; i++) {
    const [suite, prompt] = turns[i];
    if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
    process.stdout.write(`[bench] ${i + 1}/${turns.length} ${suite} "${prompt.slice(0, 24)}" … `);
    const row = await runTurn(suite, prompt);
    rows.push(row);
    lines.push(JSON.stringify(row));
    fs.writeFileSync(outFile, lines.join('\n') + '\n');
    if (row.ok) {
      consecutiveFail = 0;
      console.log(`✓ action=${row.action} 首句=${fmtMs(row.firstSentenceMs)}(${fmt(row.firstSentenceChars)}字) 墙钟=${fmtMs(row.wallMs)}${row.spoke === false ? ' [整段补播模式]' : ''}`);
    } else {
      consecutiveFail += 1;
      console.log(`✗ ${row.error}`);
      if (consecutiveFail >= 2) {
        console.log('[bench] 连续 2 回合失败,提前中止(服务端异常?)');
        break;
      }
    }
  }

  printSummary(rows);
  const summary = {
    label, base, suites, n, gapMs, startedAt: new Date(tStart).toISOString(),
    finishedAt: new Date().toISOString(), outFile,
    groups: Object.fromEntries([...groupRows(rows)].map(([k, g]) => [k, summaryOf(g)])),
  };
  fs.writeFileSync(path.join(BENCH_DIR, `${label}.summary.json`), JSON.stringify(summary, null, 2));
  console.log(`\n[bench] 结果已写入 ${outFile}(+ ${label}.summary.json)`);

  if (resetAfter) {
    const r = await postJson('/api/voice-companion/reset', { keepMemory: true });
    console.log(`[bench] 会话已重置(保留记忆):HTTP ${r.status}`);
  }
  process.exitCode = rows.some((r) => !r.ok) ? 1 : 0;
}

main().catch((err) => {
  console.error(`[bench] ✗ ${err.message}`);
  process.exitCode = 1;
});
