/**
 * 战役报告：构造 / 落盘 / 终端摘要
 *
 * 报告写 tools/human-campaign/reports/campaign-<ISO>.json（目录 gitignored）。
 * 失败探针附「缺失证据明细」：断言 expected/actual/evidence + 窗口 observed 摘要。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CampaignReport, ProbeResult } from './types.js';
import { reportsDir } from './runner.js';

export function buildReport(init: {
  startedAt: number;
  finishedAt: number;
  wave?: CampaignReport['wave'];
  dryRun: boolean;
  baseUrl: string;
  dbPath?: string;
  globalErrors: string[];
  results: ProbeResult[];
}): CampaignReport {
  const s = { total: init.results.length, pass: 0, fail: 0, skip: 0, planned: 0, manual: 0 };
  for (const r of init.results) s[r.status] += 1;
  return {
    tool: 'human-campaign',
    version: 1,
    startedAt: new Date(init.startedAt).toISOString(),
    finishedAt: new Date(init.finishedAt).toISOString(),
    elapsedMs: init.finishedAt - init.startedAt,
    wave: init.wave,
    dryRun: init.dryRun,
    baseUrl: init.baseUrl,
    dbPath: init.dbPath,
    environment: { node: process.version, platform: process.platform },
    globalErrors: init.globalErrors,
    results: init.results,
    summary: s,
  };
}

export function defaultReportPath(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(reportsDir(), `campaign-${iso}.json`);
}

export function writeCampaignReport(report: CampaignReport, reportPath?: string): string {
  const p = reportPath ?? defaultReportPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return p;
}

const STATUS_LABEL: Record<string, string> = {
  pass: '✔ PASS',
  fail: '✘ FAIL',
  skip: '－ SKIP',
  planned: '… PLAN',
  manual: '☞ MANUAL',
};

export function renderProbeLine(r: ProbeResult): string {
  const base = `${STATUS_LABEL[r.status] ?? r.status}  ${r.id}  ${r.title}${r.skipReason ? `（${r.skipReason}）` : ''}`;
  return base;
}

export function printReport(report: CampaignReport, verbose: boolean): void {
  const waveLabel = report.wave ? `C${report.wave}` : '全部';
  /* eslint-disable no-console */
  console.log('');
  console.log(`══ 真人战役 ${waveLabel} ${report.dryRun ? '（dry-run）' : ''} ══`);
  for (const r of report.results) {
    console.log(renderProbeLine(r));
    if (r.status === 'fail') {
      for (const a of r.assertions) {
        if (a.ok) continue;
        console.log(`    ✘ ${a.id} ${a.desc}`);
        console.log(`      期望: ${a.expected}`);
        console.log(`      实际: ${a.actual}`);
        for (const ev of a.evidence) {
          console.log(`      证据: log#${ev.logId ?? '?'} ${ev.tsIso ?? ''} ${ev.category ?? ''} ${JSON.stringify(ev.fields)}`);
        }
      }
      if (r.observed.length > 0) {
        console.log(`    窗口事件（前 ${Math.min(r.observed.length, 12)} 条）:`);
        for (const row of r.observed.slice(0, 12)) console.log(`      ${JSON.stringify(row)}`);
      }
    }
    if (verbose && r.notes.length > 0) {
      for (const n of r.notes) console.log(`    · ${n}`);
    }
  }
  const s = report.summary;
  console.log(`── 汇总：total=${s.total} pass=${s.pass} fail=${s.fail} skip=${s.skip} planned=${s.planned} manual=${s.manual}；耗时 ${(report.elapsedMs / 1000).toFixed(1)}s`);
  if (report.globalErrors.length > 0) {
    for (const e of report.globalErrors) console.log(`  全局错误: ${e}`);
  }
  /* eslint-enable no-console */
}

/** wave 级门禁判定：fail>0 → 阻塞；非 optional SKIP 默认阻塞（--allow-skip 放行）；optional SKIP / manual / planned 不阻塞 */
export function gateVerdict(report: CampaignReport, allowSkip: boolean): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (report.globalErrors.length > 0) reasons.push(`全局错误 ${report.globalErrors.length} 条`);
  const failed = report.results.filter((r) => r.status === 'fail');
  if (failed.length > 0) reasons.push(`FAIL ${failed.map((r) => r.id).join(', ')}`);
  const skipped = report.results.filter((r) => r.status === 'skip' && !r.optional);
  if (skipped.length > 0 && !allowSkip) reasons.push(`SKIP ${skipped.map((r) => r.id).join(', ')}（未加 --allow-skip）`);
  return { ok: reasons.length === 0, reasons };
}
