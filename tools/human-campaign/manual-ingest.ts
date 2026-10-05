/**
 * 人工抽验回填工具（HC-42 真麦抽验）
 *
 * 两用：
 *   1) --lookup：连只读 events.db 打出近 N 分钟的 dialog/delegation/routing 证据行
 *      （#id + 方向 + action + 文本截断），供人工在 fill 时引用真实行号对号入座；
 *   2) 默认：把 manual-fills.local.json（从 manual-fills.template.json 复制而来，gitignored）
 *      合并进战役报告 JSON——逐项 verdict 转成断言（pass=ok；fail/partial=不 ok），
 *      重算 summary 后回写报告；全部 fill 通过 → 退出码 0，有 fail/partial/未填 → 1。
 *
 * 用法（仓库根目录；见 MANUAL.md）：
 *   npx tsx tools/human-campaign/manual-ingest.ts --lookup [--minutes=45]
 *   npx tsx tools/human-campaign/manual-ingest.ts [--report=…] [--fills=…]
 *
 * 注意：本工具只改工具自己 reports/ 下的报告 JSON 与本地 fills 文件，不触碰 src、不写 DB。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AssertionResult, CampaignReport, ProbeResult } from './types.js';
import { reportsDir, toolDir } from './runner.js';
import { openReadOnlyLogQuery, resolveDbPath, type ReadOnlyLogQuery } from '../jarvis-canary/log-query.js';

// ─── fill 文件形状（与 manual-fills.template.json 对齐） ───

export interface ManualFillItem {
  id: string;
  /** pass | fail | partial | ''（空=未填） */
  verdict: string;
  note?: string;
}
export interface ManualFillProbe { items: ManualFillItem[] }
export interface ManualFills {
  filledBy?: string;
  filledAt?: string;
  probes: Record<string, ManualFillProbe>;
}

const VERDICTS = new Set(['pass', 'fail', 'partial']);

function fail(msg: string, code = 2): number {
  console.error(`manual-ingest 错误：${msg}`);
  return code;
}

// ─── --lookup：证据行协助 ───

async function lookup(args: { dbPath?: string; minutes: number }): Promise<number> {
  let lq: ReadOnlyLogQuery;
  try { lq = openReadOnlyLogQuery(resolveDbPath(args.dbPath)); }
  catch (err) { return fail(err instanceof Error ? err.message : String(err), 1); }
  const since = Date.now() - args.minutes * 60_000;
  const fmt = (e: { id: number; ts: number; body?: Record<string, unknown> }) =>
    `#${e.id} ${new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false })}`;
  const trim = (s: string, n = 64) => (s.length > n ? `${s.slice(0, n)}…` : s);

  const dialog = lq.query({ category: 'dialog', since, order: 'asc', limit: 400 });
  console.log(`── dialog（近 ${args.minutes} 分钟，${dialog.length} 条）──`);
  for (const e of dialog) {
    const dir = String(e.body?.direction ?? '?');
    const action = String(e.body?.action ?? '');
    const text = String(e.body?.text ?? '');
    console.log(`  ${fmt(e)} [${dir}]${action ? `(${action})` : ''} ${trim(text)}`);
  }
  const delegation = lq.query({ category: 'delegation', since, order: 'asc', limit: 400 });
  console.log(`── delegation（${delegation.length} 条）──`);
  for (const e of delegation) {
    const phase = String(e.body?.phase ?? '?');
    const to = String(e.body?.toAgentId ?? e.agentId ?? '');
    const kind = String(e.body?.kind ?? '');
    console.log(`  ${fmt(e)} [${phase}]${kind ? `(${kind})` : ''}${to ? ` →${to.slice(0, 8)}` : ''} ${trim(String(e.body?.message ?? ''), 48)}`);
  }
  const routing = lq.query({ category: 'system', since, order: 'asc', limit: 200 }).filter((e) => e.source === 'project-routing');
  console.log(`── project-routing（${routing.length} 条）──`);
  for (const e of routing) {
    console.log(`  ${fmt(e)} [${String(e.body?.kind ?? '?')}] project=${String(e.body?.projectId ?? '—')} boss=${String(e.body?.finalBossId ?? '—').slice(0, 8)} layer=${String(e.body?.layer ?? '—')}`);
  }
  console.log('');
  console.log('（把上面 #id 写进 manual-fills.local.json 各项的 note，便于报告溯源）');
  lq.close();
  return 0;
}

// ─── 合并 ───

function latestReport(): string | undefined {
  const dir = reportsDir();
  if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir).filter((f) => /^campaign-.*\.json$/.test(f))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

function verdictToAssertion(probeId: string, item: ManualFillItem): AssertionResult {
  const v = item.verdict.trim().toLowerCase();
  return {
    id: `${probeId}-manual-${item.id}`,
    desc: `人工判定：${item.id}`,
    ok: v === 'pass',
    expected: '人工判定 pass（fail/partial 均不通过）',
    actual: `${v}${item.note ? ` —— ${item.note}` : ''}`,
    evidence: [],
  };
}

export async function ingest(fillsPath: string, reportPath: string | undefined): Promise<number> {
  if (!fs.existsSync(fillsPath)) {
    return fail(`回填文件不存在：${fillsPath}\n请先复制模板：manual-fills.template.json → manual-fills.local.json，按 MANUAL.md 填写。`);
  }
  let fills: ManualFills;
  try { fills = JSON.parse(fs.readFileSync(fillsPath, 'utf8')) as ManualFills; }
  catch (err) { return fail(`回填文件解析失败：${err instanceof Error ? err.message : String(err)}`); }
  if (!fills.probes || typeof fills.probes !== 'object') return fail('回填文件缺 probes 字段（见 manual-fills.template.json）');

  const rp = reportPath ?? latestReport();
  if (!rp || !fs.existsSync(rp)) return fail(`找不到战役报告（--report= 指定，或先跑一波生成 reports/campaign-*.json）`);
  let report: CampaignReport;
  try { report = JSON.parse(fs.readFileSync(rp, 'utf8')) as CampaignReport; }
  catch (err) { return fail(`报告解析失败：${err instanceof Error ? err.message : String(err)}`); }

  let total = 0, passed = 0, failedVerdicts = 0, missing = 0;
  for (const [probeId, fill] of Object.entries(fills.probes)) {
    const result = report.results.find((r) => r.id === probeId) as ProbeResult | undefined;
    if (!result) { console.warn(`  跳过 ${probeId}：报告中无此探针（报告=${path.basename(rp)}）`); continue; }
    const items = fill.items ?? [];
    if (items.length === 0) { console.warn(`  跳过 ${probeId}：没有任何 items`); continue; }
    const filled = items.filter((it) => VERDICTS.has(it.verdict.trim().toLowerCase()));
    missing += items.length - filled.length;
    failedVerdicts += filled.filter((it) => it.verdict.trim().toLowerCase() !== 'pass').length;
    total += items.length;
    passed += filled.filter((it) => it.verdict.trim().toLowerCase() === 'pass').length;

    result.assertions = filled.map((it) => verdictToAssertion(probeId, it));
    if (filled.length === items.length) {
      const allPass = filled.every((it) => it.verdict.trim().toLowerCase() === 'pass');
      result.status = allPass ? 'pass' : 'fail';
      result.skipReason = undefined;
    } else {
      // 部分回填：保持 manual，等补齐后再 ingest
      result.status = 'manual';
      console.warn(`  ${probeId}：${items.length - filled.length}/${items.length} 项未填，保持 manual`);
    }
    const stamp = [fills.filledBy ? `回填人：${fills.filledBy}` : '', fills.filledAt ? `回填时间：${fills.filledAt}` : ''].filter(Boolean).join('；');
    result.notes.push(`人工回填（${stamp || '未署名'}）→ ${result.status}`);
  }

  // 重算 summary（与 buildReport 同口径）
  const s = { total: report.results.length, pass: 0, fail: 0, skip: 0, planned: 0, manual: 0 };
  for (const r of report.results) s[r.status] += 1;
  report.summary = s;

  fs.writeFileSync(rp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`已合并回填 → ${rp}`);
  console.log(`  人工项：${passed}/${total} pass；fail/partial ${failedVerdicts}；未填 ${missing}`);
  console.log(`  报告汇总：total=${s.total} pass=${s.pass} fail=${s.fail} skip=${s.skip} planned=${s.planned} manual=${s.manual}`);
  return failedVerdicts === 0 && missing === 0 && total > 0 ? 0 : 1;
}

// ─── CLI ───

export function parseIngestArgs(argv: string[]): { fillsPath: string; reportPath?: string; dbPath?: string; minutes: number; lookup: boolean; errors: string[] } {
  let fillsPath = path.join(toolDir(), 'manual-fills.local.json');
  let reportPath: string | undefined, dbPath: string | undefined;
  let minutes = 45, lookup = false;
  const errors: string[] = [];
  for (const arg of argv) {
    if (arg === '--lookup') { lookup = true; continue; }
    if (arg === '--help' || arg === '-h') { errors.length = 0; return { fillsPath, reportPath, dbPath, minutes, lookup, errors: ['__help__'] }; }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) { errors.push(`无法识别的参数：${arg}`); continue; }
    const [, key, value = ''] = m;
    if (key === 'report') reportPath = value || undefined;
    else if (key === 'fills') fillsPath = value || fillsPath;
    else if (key === 'db') dbPath = value || undefined;
    else if (key === 'minutes') { const n = Number(value); if (!Number.isFinite(n) || n <= 0) errors.push(`--minutes 需要正数，收到：${value}`); else minutes = Math.floor(n); }
    else errors.push(`无法识别的参数：${arg}`);
  }
  return { fillsPath, reportPath, dbPath, minutes, lookup, errors };
}

async function main(): Promise<number> {
  const parsed = parseIngestArgs(process.argv.slice(2));
  if (parsed.errors.includes('__help__')) {
    console.log(`用法：
  npx tsx tools/human-campaign/manual-ingest.ts --lookup [--minutes=45] [--db=…]
  npx tsx tools/human-campaign/manual-ingest.ts [--report=…] [--fills=…]
退出码：0=全部人工项 pass；1=fail/partial/未填；2=参数或文件错误`);
    return 0;
  }
  if (parsed.errors.length > 0) { for (const e of parsed.errors) console.error(`参数错误：${e}`); return 2; }
  if (parsed.lookup) return lookup({ dbPath: parsed.dbPath, minutes: parsed.minutes });
  return ingest(parsed.fillsPath, parsed.reportPath);
}

if (process.argv[1] && /manual-ingest\.ts$/.test(process.argv[1])) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => { console.error('manual-ingest 未捕获异常:', err); process.exitCode = 1; });
}
