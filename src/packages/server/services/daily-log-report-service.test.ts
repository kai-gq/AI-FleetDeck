/**
 * 任务19·A·⑮ P2 daily-log-report-service 单测（L2 桩测）
 *
 * 覆盖：开关解析、最少数据闸门（零行不发 LLM）、成功落盘（md+json）+ ⑭ 事件、
 * 各类降级（degrated/LLM 抛错/写失败/计数失败）永不上抛、readLatestDailyReport
 * 只读聚合（最新 json / md 兜底 / 缺目录 / 坏文件）、cron 07:00 注册点幂等。
 *
 * 说明：L3 真跑（真实 LLM + 真实昨日日志）留波次门一次性登记，不在本文件跑。
 * 数据目录由 test-setup.ts 重定向到临时沙箱；落盘用独立临时目录。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeEventDb, initEventDb } from '../data/event-db.js';
import { querySystemLog } from '../data/system-log.js';
import type { LogAnalysisReport } from '../log-analysis/index.js';
import {
  DAILY_REPORT_LOG_SOURCE,
  isDailyLogReportEnabled,
  readLatestDailyReport,
  runDailyLogReportScan,
} from './daily-log-report-service.js';
import * as cronService from './cron-service.js';

beforeAll(() => {
  initEventDb();
});

afterAll(() => {
  closeEventDb();
});

afterEach(() => {
  vi.unstubAllEnvs();
  cronService.stopDailyLogReportJob();
});

let tmpDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-'));
});

function bodyOf(row: { body?: string }): Record<string, unknown> {
  return JSON.parse(row.body ?? '{}');
}

/** 本来源的事件行（升序）。 */
function reportLogs(): Record<string, unknown>[] {
  return querySystemLog({ source: DAILY_REPORT_LOG_SOURCE, order: 'asc' })
    .filter((row) => bodyOf(row).cat === 'daily-log-report')
    .map(bodyOf);
}

/** 一份可通过 readLatestDailyReport 结构校验的最小 LogAnalysisReport。 */
function reportFixture(overrides: Partial<LogAnalysisReport> = {}): LogAnalysisReport {
  return {
    generatedAt: 1_758_000_000_000,
    window: { from: Date.parse('2026-10-04T00:00:00'), to: Date.parse('2026-10-05T00:00:00'), label: '10-04' },
    source: { systemLogRows: 5, auditLogRows: 0, serverLogLines: 0, warnings: [] },
    stats: {
      total: 5,
      byCategory: {},
      byLevel: {},
      bySource: {},
      errorRows: 1,
      warnRows: 1,
      resource: { turns: 0, tokensInput: 0, tokensOutput: 0, tokensTotal: 0, costUsd: 0, models: {} },
      durationMs: null,
      serverLogErrors: 0,
      serverLogWarns: 0,
    },
    anomalies: [{ title: 'a', evidence: [] }],
    bottlenecks: [],
    resources: [],
    recommendations: [],
    droppedRecommendations: [],
    ...overrides,
  };
}

/** Oct 5 07:00 本地 → 覆盖日为 Oct 4（昨日）；用于确定性文件命名。 */
const NOW_0705 = () => new Date(2026, 9, 5, 7, 0, 0);

describe('开关 TC_JARVIS_DAILY_REPORT', () => {
  it('缺省开；0/off/false（含大小写空白）关', () => {
    expect(isDailyLogReportEnabled({})).toBe(true);
    expect(isDailyLogReportEnabled({ TC_JARVIS_DAILY_REPORT: undefined })).toBe(true);
    expect(isDailyLogReportEnabled({ TC_JARVIS_DAILY_REPORT: '' })).toBe(true);
    expect(isDailyLogReportEnabled({ TC_JARVIS_DAILY_REPORT: '1' })).toBe(true);
    expect(isDailyLogReportEnabled({ TC_JARVIS_DAILY_REPORT: '0' })).toBe(false);
    expect(isDailyLogReportEnabled({ TC_JARVIS_DAILY_REPORT: ' off ' })).toBe(false);
    expect(isDailyLogReportEnabled({ TC_JARVIS_DAILY_REPORT: 'FALSE' })).toBe(false);
  });

  it('关闭 → 不计数不分析不落盘，skipped+disabled，登记 skip/disabled', async () => {
    vi.stubEnv('TC_JARVIS_DAILY_REPORT', '0');
    const countRows = vi.fn(() => 99);
    const runAnalysis = vi.fn();
    const r = await runDailyLogReportScan({ countRows, runAnalysis });

    expect(r).toMatchObject({ skipped: true, disabled: true, reason: 'disabled' });
    expect(countRows).not.toHaveBeenCalled();
    expect(runAnalysis).not.toHaveBeenCalled();
    expect(reportLogs().some((row) => row.op === 'skip' && row.reason === 'disabled')).toBe(true);
  });
});

describe('最少数据闸门与降级（L2 桩）', () => {
  it('昨日零行 → 不发 LLM、不落盘，skip/no-data', async () => {
    const runAnalysis = vi.fn();
    const r = await runDailyLogReportScan({
      now: NOW_0705,
      countRows: () => 0,
      runAnalysis,
      reportDir: path.join(tmpDir, 'reports'),
    });

    expect(r).toMatchObject({ skipped: true, reason: 'no-data', rows: 0 });
    expect(runAnalysis).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, 'reports'))).toBe(false);
    expect(reportLogs().some((row) => row.op === 'skip' && row.reason === 'no-data')).toBe(true);
  });

  it('计数抛错 → skip/count-error，永不上抛', async () => {
    const r = await runDailyLogReportScan({
      now: NOW_0705,
      countRows: () => { throw new Error('db down'); },
      reportDir: path.join(tmpDir, 'reports'),
    });
    expect(r).toMatchObject({ skipped: true, reason: 'count-error' });
    expect(reportLogs().some((row) => row.op === 'skip' && row.reason === 'count-error')).toBe(true);
  });

  it('分析降级（llm-error）→ 打日志跳过、不落盘，永不上抛', async () => {
    const r = await runDailyLogReportScan({
      now: NOW_0705,
      countRows: () => 12,
      runAnalysis: async () => reportFixture({ degraded: 'llm-error' }),
      reportDir: path.join(tmpDir, 'reports'),
    });

    expect(r).toMatchObject({ skipped: true, reason: 'llm-error', rows: 12 });
    expect(fs.existsSync(path.join(tmpDir, 'reports'))).toBe(false);
    expect(reportLogs().some((row) => row.op === 'skip' && row.reason === 'llm-error' && row.degraded === 'llm-error')).toBe(true);
  });

  it('分析实现抛错 → skip/analysis-error，永不上抛', async () => {
    const r = await runDailyLogReportScan({
      now: NOW_0705,
      countRows: () => 12,
      runAnalysis: async () => { throw new Error('invoker crashed'); },
      reportDir: path.join(tmpDir, 'reports'),
    });
    expect(r).toMatchObject({ skipped: true, reason: 'analysis-error' });
    expect(r.skipped).toBe(true);
    expect(reportLogs().some((row) => row.op === 'skip' && row.reason === 'analysis-error' && String(row.error).includes('invoker crashed'))).toBe(true);
  });

  it('写盘失败 → skip/write-error，永不上抛', async () => {
    const r = await runDailyLogReportScan({
      now: NOW_0705,
      countRows: () => 12,
      runAnalysis: async () => reportFixture(),
      reportDir: path.join(tmpDir, 'reports'),
      ensureDir: () => {},
      writeFile: () => { throw new Error('EACCES'); },
    });
    expect(r).toMatchObject({ skipped: true, reason: 'write-error' });
    expect(reportLogs().some((row) => row.op === 'skip' && row.reason === 'write-error')).toBe(true);
  });
});

describe('成功落盘（md + json）与事件', () => {
  it('生成 daily-log-report-<覆盖日>.md/.json，登记 generate + 分段计数', async () => {
    const report = reportFixture({
      recommendations: [{ title: 'r1', action: 'do', evidence: [] }],
    });
    const reportDir = path.join(tmpDir, 'reports', 'daily');
    const r = await runDailyLogReportScan({
      now: NOW_0705,
      countRows: () => 42,
      runAnalysis: async () => report,
      reportDir,
    });

    expect(r.skipped).toBe(false);
    const mdFile = path.join(reportDir, 'daily-log-report-2026-10-04.md');
    const jsonFile = path.join(reportDir, 'daily-log-report-2026-10-04.json');
    expect(r.textFile).toBe(mdFile);
    expect(r.jsonFile).toBe(jsonFile);
    expect(fs.existsSync(mdFile)).toBe(true);
    expect(fs.existsSync(jsonFile)).toBe(true);
    expect(fs.readFileSync(mdFile, 'utf8')).toContain('优化建议');
    expect(JSON.parse(fs.readFileSync(jsonFile, 'utf8'))).toMatchObject({ stats: { total: 5 } });

    const gen = reportLogs().find((row) => row.op === 'generate');
    expect(gen).toMatchObject({
      ok: true,
      rows: 42,
      sections: { anomalies: 1, bottlenecks: 0, resources: 0, recommendations: 1 },
      files: { md: mdFile, json: jsonFile },
    });
  });
});

describe('readLatestDailyReport（⑨ 晨报只读聚合）', () => {
  it('优先最近一期 json：摘要含统计与建议数、dateLabel 取文件名', () => {
    const dir = path.join(tmpDir, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'daily-log-report-2026-10-03.json'),
      JSON.stringify(reportFixture({ stats: { ...reportFixture().stats, total: 7 } })),
    );
    fs.writeFileSync(
      path.join(dir, 'daily-log-report-2026-10-04.json'),
      JSON.stringify(reportFixture({
        stats: { ...reportFixture().stats, total: 120, errorRows: 3, warnRows: 9 },
        recommendations: [{ title: 'r', action: 'a', evidence: [] }],
      })),
    );

    const digest = readLatestDailyReport(dir);
    expect(digest).not.toBeNull();
    expect(digest?.dateLabel).toBe('2026-10-04');
    expect(digest?.summary).toContain('昨日日志 120 条');
    expect(digest?.summary).toContain('建议 1 项');
  });

  it('json 全部损坏 → md 首行兜底；缺目录/空目录 → null', () => {
    const dir = path.join(tmpDir, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'daily-log-report-2026-10-04.json'), '{broken json');
    fs.writeFileSync(path.join(dir, 'daily-log-report-2026-10-03.md'), '# 日报标题\n正文');

    const digest = readLatestDailyReport(dir);
    expect(digest).toMatchObject({ dateLabel: '2026-10-03', summary: '# 日报标题' });

    expect(readLatestDailyReport(path.join(tmpDir, 'nope'))).toBeNull();
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir);
    expect(readLatestDailyReport(emptyDir)).toBeNull();
  });

  it('降级报告摘要带 [降级:] 标注（供晨报如实转述）', () => {
    const dir = path.join(tmpDir, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'daily-log-report-2026-10-04.json'),
      JSON.stringify(reportFixture({ degraded: 'parse-error' })),
    );
    expect(readLatestDailyReport(dir)?.summary).toContain('[降级:parse-error]');
  });
});

describe('cron 07:00 注册点（任务19·A）', () => {
  it('表达式 0 7 * * *；模块加载自启；重复调用幂等；可停可重启', () => {
    expect(cronService.DAILY_LOG_REPORT_CRON).toBe('0 7 * * *');
    const first = cronService.startDailyLogReportJob();
    const second = cronService.startDailyLogReportJob();
    expect(first).toBe(second);
    expect(first.expression).toBe('0 7 * * *');
    expect(first.timer).not.toBeNull();

    cronService.stopDailyLogReportJob();
    expect(first.timer).toBeNull();
    const third = cronService.startDailyLogReportJob();
    expect(third).not.toBe(first);
    expect(third.timer).not.toBeNull();
  });
});
