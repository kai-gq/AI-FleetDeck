/**
 * 报告构建 / 落盘 / 控制台摘要
 *
 * 失败时打印"缺失证据明细"：哪个场景、期望什么事件、实际查到什么、证据行。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CanaryReport, ScenarioResult } from './types.js';

export function buildReport(init: {
  level: 'smoke' | 'full';
  dryRun: boolean;
  scenarioFilter: string[];
  baseUrl: string;
  dbPath?: string;
  globalErrors: string[];
  results: ScenarioResult[];
  startedAt: number;
}): CanaryReport {
  const finishedAt = Date.now();
  const summary = { total: init.results.length, pass: 0, fail: 0, skip: 0, planned: 0 };
  for (const r of init.results) {
    if (r.status === 'pass') summary.pass += 1;
    else if (r.status === 'fail') summary.fail += 1;
    else if (r.status === 'skip') summary.skip += 1;
    else summary.planned += 1;
  }
  return {
    tool: 'jarvis-canary',
    version: 1,
    startedAt: new Date(init.startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    elapsedMs: finishedAt - init.startedAt,
    level: init.level,
    dryRun: init.dryRun,
    scenarioFilter: init.scenarioFilter,
    baseUrl: init.baseUrl,
    dbPath: init.dbPath,
    environment: { node: process.version, platform: process.platform },
    globalErrors: init.globalErrors,
    results: init.results,
    summary,
  };
}

/**
 * 退出码：全局错误/失败 → 1；有 skip 且未 --allow-skip → 1；否则 0（planned 视同通过）。
 * dry-run 例外：skip 只可能来自"能力未交付"（如任务16），不应阻断预检通过。
 */
export function computeExitCode(report: CanaryReport, opts: { allowSkip: boolean }): number {
  if (report.globalErrors.length > 0) return 1;
  if (report.summary.fail > 0) return 1;
  if (report.summary.skip > 0 && !opts.allowSkip && !report.dryRun) return 1;
  return 0;
}

export function writeReport(reportPath: string, report: CanaryReport): string {
  const abs = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(report, null, 2), 'utf-8');
  return abs;
}

export function defaultReportPath(timestamp = Date.now()): string {
  const stamp = new Date(timestamp).toISOString().replace(/[:.]/g, '-');
  return path.join('tools', 'jarvis-canary', 'reports', `${stamp}.json`);
}

// ─── 控制台输出 ───

const STATUS_LABEL: Record<ScenarioResult['status'], string> = {
  pass: '通过',
  fail: '失败',
  skip: '跳过',
  planned: '计划',
};

function formatEvidence(e: CanaryReport['results'][number]['assertions'][number]['evidence'][number]): string {
  const parts: string[] = [];
  if (e.logId !== undefined) parts.push(`#${e.logId}`);
  if (e.tsIso) parts.push(e.tsIso);
  if (e.category) parts.push(e.category);
  if (e.source) parts.push(`src=${e.source}`);
  const fields = Object.entries(e.fields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  if (fields.length > 0) parts.push(fields.join(' '));
  return parts.join(' | ');
}

export function printSummary(report: CanaryReport, reportPathAbs?: string): void {
  const lines: string[] = [];
  lines.push('');
  lines.push('=== jarvis-canary 金丝雀真链路冒烟 ===');
  lines.push(`级别 ${report.level}${report.dryRun ? '（dry-run：只做连通+前置检查，不发消息）' : ''} | 服务器 ${report.baseUrl}` + (report.dbPath ? ` | DB ${report.dbPath}` : ''));
  lines.push('');

  for (const r of report.results) {
    const glyph = r.status === 'pass' ? '[通过]' : r.status === 'fail' ? '[失败]' : r.status === 'skip' ? '[跳过]' : '[计划]';
    lines.push(`${glyph} ${r.name}  ${r.title}  ${r.elapsedMs}ms`);
    for (const n of r.notes) lines.push(`    - ${n}`);
    for (const a of r.assertions) {
      if (!a.ok) {
        lines.push(`    ✗ ${a.id} ${a.desc}`);
        lines.push(`      期望: ${a.expected}`);
        lines.push(`      实际: ${a.actual}`);
        for (const e of a.evidence) lines.push(`      证据: ${formatEvidence(e)}`);
      }
    }
    for (const p of r.prereqs) {
      if (!p.ok) lines.push(`    ✗ 前置 ${p.id}（${p.desc}）: ${p.detail}`);
    }
    if (r.status === 'skip' && r.notes.length === 0) lines.push('    - （无说明）');
  }

  // 缺失证据明细
  const missing: string[] = [];
  for (const r of report.results) {
    if (r.status !== 'fail') continue;
    const failed = r.assertions.filter((a) => !a.ok);
    for (const a of failed) {
      missing.push(`  · 场景 ${r.name} / 断言 ${a.id}（${a.desc}）`);
      missing.push(`      期望事件: ${a.expected}`);
      missing.push(`      实际查到: ${a.actual}`);
    }
    if (failed.length > 0 && r.observed.length > 0) {
      missing.push(`      窗口内实际观测（最多50条）:`);
      for (const row of r.observed) {
        missing.push(`        - ${JSON.stringify(row)}`);
      }
    }
    const failedPre = r.prereqs.filter((p) => !p.ok);
    for (const p of failedPre) {
      missing.push(`  · 场景 ${r.name} / 前置 ${p.id}（${p.desc}）`);
      missing.push(`      ${p.detail}`);
    }
  }
  if (missing.length > 0) {
    lines.push('');
    lines.push('--- 缺失证据明细 ---');
    lines.push(...missing);
  }

  if (report.globalErrors.length > 0) {
    lines.push('');
    lines.push('--- 全局错误 ---');
    for (const e of report.globalErrors) lines.push(`  ✗ ${e}`);
  }

  lines.push('');
  lines.push(`汇总: 共 ${report.summary.total} | 通过 ${report.summary.pass} | 失败 ${report.summary.fail} | 跳过 ${report.summary.skip} | 计划 ${report.summary.planned} | 用时 ${report.elapsedMs}ms`);
  if (reportPathAbs) lines.push(`报告已写入: ${reportPathAbs}`);
  console.log(lines.join('\n'));
}

export function printOverallToConsole(text: string): void {
  console.log(text);
}
