/**
 * 任务17·A5 weekly-cost-report-service 单测（L2 桩测 + 真实事件库接线）
 *
 * 覆盖：分组聚合纯函数（agentId/projectId 分组、未标注 null、costUsd unavailable
 * 如实剥离、costSources/models、排序、非 resource/坏 body 跳过）、开关解析、
 * 最少数据闸门（零 resource 行不落盘）、成功落盘（md+json + ⑭ 事件）、
 * 降级永不上抛（查询抛错 / 写失败 / 意外异常）、窗口边界（7 天前的行不计）、
 * 目录与文件名隔离（不被 daily 晨报聚合消费）、cron 第 6 job（周一 09:00）。
 *
 * 数据目录由 test-setup.ts 重定向到临时沙箱；落盘用独立临时目录。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeEventDb, initEventDb } from '../data/event-db.js';
import { logEvent, querySystemLog, type SystemLogEntry } from '../data/system-log.js';
import { readLatestDailyReport, DAILY_REPORT_DIR } from './daily-log-report-service.js';
import {
  WEEKLY_REPORT_DIR,
  WEEKLY_REPORT_FILE_PREFIX,
  WEEKLY_REPORT_LOG_SOURCE,
  isWeeklyCostReportEnabled,
  renderWeeklyCostReport,
  runWeeklyCostReportScan,
  type WeeklyCostReport,
} from './weekly-cost-report-service.js';
import { aggregateResourceUsage } from '../log-analysis/stats.js';
import * as cronService from './cron-service.js';

/** 2026-10-05 周一 09:00 本地。 */
const NOW = () => new Date(2026, 9, 5, 9, 0, 0);
const NOW_MS = NOW().getTime();
const MIN = 60_000;
const DAY = 86_400_000;

beforeAll(() => {
  initEventDb();
});

afterAll(() => {
  closeEventDb();
});

afterEach(() => {
  vi.unstubAllEnvs();
  cronService.stopWeeklyCostReportJob();
});

let tmpDir = '';
let rowSeq = 0;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-report-'));
  rowSeq = 0;
});

function bodyOf(row: { body?: string }): Record<string, unknown> {
  return JSON.parse(row.body ?? '{}');
}

/** 周报事件行（升序，body 形态）。 */
function weeklyLogs(): Record<string, unknown>[] {
  return querySystemLog({ source: WEEKLY_REPORT_LOG_SOURCE, order: 'asc' })
    .filter((row) => bodyOf(row).cat === 'weekly-cost-report')
    .map(bodyOf);
}

interface RowFields {
  ts?: number;
  agentId?: string;
  projectId?: string;
  tokens?: { input?: number; output?: number };
  tokensTotal?: number;
  costUsd?: number;
  costSource?: string;
  model?: string;
}

function resourceRow(fields: RowFields): SystemLogEntry {
  rowSeq += 1;
  return {
    id: rowSeq,
    ts: fields.ts ?? NOW_MS - MIN,
    category: 'system',
    source: 'resource',
    level: 'info',
    agentId: fields.agentId,
    projectId: fields.projectId,
    body: JSON.stringify({
      cat: 'resource',
      model: fields.model,
      tokens: fields.tokens,
      tokensTotal: fields.tokensTotal,
      costUsd: fields.costUsd,
      costSource: fields.costSource,
    }),
  };
}

// ============================================================================
// 分组聚合纯函数
// ============================================================================

describe('aggregateResourceUsage（任务17·A5 数据面）', () => {
  it('按 agentId/projectId 独立分组：token 求和、costUsd 求和、costRows/costUnavailableRows 分账', () => {
    const breakdown = aggregateResourceUsage([
      resourceRow({ agentId: 'a1', projectId: 'p1', tokens: { input: 100, output: 50 }, tokensTotal: 150, costUsd: 0.25, costSource: 'provider', model: 'sonnet' }),
      resourceRow({ agentId: 'a1', projectId: 'p2', tokens: { input: 20, output: 10 }, tokensTotal: 30, costUsd: 0.05, costSource: 'estimated', model: 'sonnet' }),
      resourceRow({ agentId: 'a2', tokens: { input: 7, output: 3 }, tokensTotal: 10 }), // projectId 缺失
      resourceRow({ tokensTotal: 1 }), // agent/project 均缺失
    ]);

    expect(breakdown.rows).toBe(4);

    const a1 = breakdown.byAgent.find((g) => g.key === 'a1');
    expect(a1).toMatchObject({
      turns: 2,
      tokensInput: 120,
      tokensOutput: 60,
      tokensTotal: 180,
      costUsd: 0.3,
      costRows: 2,
      costUnavailableRows: 0,
    });
    expect(a1?.costSources).toEqual({ provider: 1, estimated: 1 });
    expect(a1?.models).toEqual({ sonnet: 2 });

    const a2 = breakdown.byAgent.find((g) => g.key === 'a2');
    expect(a2).toMatchObject({ tokensTotal: 10, costUsd: null, costRows: 0, costUnavailableRows: 1 });
    expect(a2?.costSources).toEqual({ unknown: 1 });
    expect(breakdown.byAgent.find((g) => g.key === null)).toMatchObject({ turns: 1, tokensTotal: 1, costUsd: null });

    // byProject 独立于 byAgent：p1/p2/未标注
    expect(breakdown.byProject.map((g) => g.key)).toEqual(['p1', 'p2', null]);
    expect(breakdown.byProject.find((g) => g.key === 'p2')).toMatchObject({ turns: 1, tokensTotal: 30, costUsd: 0.05 });
  });

  it('costUsd 部分不可用：合计只含可用行并四舍五入，unavailable 单独计数（不按 0 计入）', () => {
    const breakdown = aggregateResourceUsage([
      resourceRow({ agentId: 'a1', tokensTotal: 10, costUsd: 0.1234567, costSource: 'provider' }),
      resourceRow({ agentId: 'a1', tokensTotal: 20, costSource: 'unavailable' }),
      resourceRow({ agentId: 'a1', tokensTotal: 30, costUsd: Number.NaN }), // 非有限值同样剥离
    ]);
    const g = breakdown.byAgent[0];
    expect(g.costUsd).toBe(0.123457); // 四舍五入到 6 位
    expect(g.costRows).toBe(1);
    expect(g.costUnavailableRows).toBe(2);
    expect(g.costSources).toEqual({ provider: 1, unavailable: 1, unknown: 1 });
  });

  it('只认 cat=resource：非 resource / 坏 body / 空 rows 一律跳过（负断言）', () => {
    const breakdown = aggregateResourceUsage([
      { ts: 1, category: 'system', level: 'info', agentId: 'a1', body: JSON.stringify({ cat: 'dialog', tokensTotal: 999 }) },
      { ts: 2, category: 'system', source: 'resource', level: 'info', agentId: 'a1', body: '{not json' },
      { ts: 3, category: 'system', source: 'resource', level: 'info', agentId: 'a1' }, // 无 body
    ]);
    expect(breakdown.rows).toBe(0);
    expect(breakdown.byAgent).toEqual([]);
    expect(breakdown.byProject).toEqual([]);
  });

  it('排序：tokensTotal 降序；未标注（null）恒排末位；同值按 key 字典序', () => {
    const breakdown = aggregateResourceUsage([
      resourceRow({ agentId: 'b', tokensTotal: 10 }),
      resourceRow({ agentId: 'a', tokensTotal: 10 }),
      resourceRow({ agentId: 'big', tokensTotal: 100 }),
      resourceRow({ tokensTotal: 999 }), // 未标注
    ]);
    expect(breakdown.byAgent.map((g) => g.key)).toEqual(['big', 'a', 'b', null]);
  });
});

// ============================================================================
// 开关 / 闸门 / 降级（L2 桩）
// ============================================================================

describe('开关 TC_JARVIS_WEEKLY_COST_REPORT', () => {
  it('缺省开；0/off/false（含大小写空白）关', () => {
    expect(isWeeklyCostReportEnabled({})).toBe(true);
    expect(isWeeklyCostReportEnabled({ TC_JARVIS_WEEKLY_COST_REPORT: undefined })).toBe(true);
    expect(isWeeklyCostReportEnabled({ TC_JARVIS_WEEKLY_COST_REPORT: '' })).toBe(true);
    expect(isWeeklyCostReportEnabled({ TC_JARVIS_WEEKLY_COST_REPORT: '1' })).toBe(true);
    expect(isWeeklyCostReportEnabled({ TC_JARVIS_WEEKLY_COST_REPORT: '0' })).toBe(false);
    expect(isWeeklyCostReportEnabled({ TC_JARVIS_WEEKLY_COST_REPORT: ' off ' })).toBe(false);
    expect(isWeeklyCostReportEnabled({ TC_JARVIS_WEEKLY_COST_REPORT: 'FALSE' })).toBe(false);
  });

  it('关闭 → 不查询不落盘，skipped+disabled，登记 skip/disabled', async () => {
    vi.stubEnv('TC_JARVIS_WEEKLY_COST_REPORT', '0');
    const queryRows = vi.fn(() => [resourceRow({ agentId: 'a1', tokensTotal: 1 })]);
    const writeFile = vi.fn();
    const r = await runWeeklyCostReportScan({ now: NOW, queryRows, writeFile, reportDir: tmpDir });

    expect(r).toMatchObject({ skipped: true, disabled: true, reason: 'disabled' });
    expect(queryRows).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(weeklyLogs().some((row) => row.op === 'skip' && row.reason === 'disabled')).toBe(true);
  });
});

describe('最少数据闸门与降级（L2 桩）', () => {
  it('零 resource 行 → 跳过 no-data、不落盘', async () => {
    const writeFile = vi.fn();
    const r = await runWeeklyCostReportScan({
      now: NOW,
      queryRows: () => [
        { ts: NOW_MS - MIN, category: 'system', level: 'info', body: JSON.stringify({ cat: 'dialog' }) },
      ],
      writeFile,
      reportDir: tmpDir,
    });
    expect(r).toMatchObject({ skipped: true, reason: 'no-data', rows: 0 });
    expect(writeFile).not.toHaveBeenCalled();
    expect(weeklyLogs().some((row) => row.op === 'skip' && row.ok === true && row.reason === 'no-data')).toBe(true);
  });

  it('查询抛错 → skipped/query-error、不上抛', async () => {
    const r = await runWeeklyCostReportScan({
      now: NOW,
      queryRows: () => { throw new Error('EBUSY'); },
      reportDir: tmpDir,
    });
    expect(r).toMatchObject({ skipped: true, reason: 'query-error' });
    expect(weeklyLogs().some((row) => row.op === 'skip' && row.ok === false && row.error === 'EBUSY')).toBe(true);
  });

  it('写失败 → skipped/write-error、不上抛', async () => {
    const r = await runWeeklyCostReportScan({
      now: NOW,
      queryRows: () => [resourceRow({ agentId: 'a1', tokensTotal: 5, costUsd: 0.01 })],
      ensureDir: () => { throw new Error('EACCES'); },
      reportDir: tmpDir,
    });
    expect(r).toMatchObject({ skipped: true, reason: 'write-error' });
    expect(weeklyLogs().some((row) => row.op === 'skip' && row.reason === 'write-error')).toBe(true);
  });

  it('意外异常（时钟注入抛错）→ unexpected-error 兜底、绝不上抛', async () => {
    const r = await runWeeklyCostReportScan({
      now: () => { throw new Error('clock broken'); },
      reportDir: tmpDir,
    });
    expect(r).toMatchObject({ skipped: true, reason: 'unexpected-error' });
    expect(weeklyLogs().some((row) => row.op === 'skip' && row.reason === 'unexpected-error')).toBe(true);
  });
});

// ============================================================================
// 成功落盘 + 目录隔离
// ============================================================================

describe('成功路径：md+json 落盘与目录隔离', () => {
  function twoAgentRows(): SystemLogEntry[] {
    return [
      resourceRow({ agentId: 'agent-A', projectId: 'proj-X', tokens: { input: 1000, output: 200 }, tokensTotal: 1200, costUsd: 0.5, costSource: 'provider', model: 'sonnet' }),
      resourceRow({ agentId: 'agent-B', projectId: 'proj-X', tokens: { input: 50, output: 10 }, tokensTotal: 60, costUsd: 0.02, costSource: 'estimated', model: 'haiku' }),
      resourceRow({ agentId: 'agent-C', tokensTotal: 5, costSource: 'unavailable' }),
    ];
  }

  it('落盘 md+json：json 分组/费用正确、unavailable 如实标注、md 含两组表格；⑭ 事件 generate', async () => {
    const r = await runWeeklyCostReportScan({ now: NOW, queryRows: twoAgentRows, reportDir: tmpDir });

    expect(r).toMatchObject({ skipped: false, rows: 3, agents: 3, projects: 2 });
    expect(r.textFile).toBe(path.join(tmpDir, `${WEEKLY_REPORT_FILE_PREFIX}2026-10-05.md`));
    expect(r.jsonFile).toBe(path.join(tmpDir, `${WEEKLY_REPORT_FILE_PREFIX}2026-10-05.json`));

    const report = JSON.parse(fs.readFileSync(r.jsonFile!, 'utf8')) as WeeklyCostReport;
    // last7d 窗口口径：to=今日 09:00、from=to−7 天（逐字锚定）
    expect(report.window.to).toBe(NOW_MS);
    expect(report.window.from).toBe(NOW_MS - 7 * DAY);
    expect(report.byAgent.find((g) => g.key === 'agent-A')).toMatchObject({
      turns: 1, tokensTotal: 1200, costUsd: 0.5, costRows: 1, costUnavailableRows: 0,
    });
    const c = report.byAgent.find((g) => g.key === 'agent-C');
    expect(c).toMatchObject({ costUsd: null, costUnavailableRows: 1 });
    expect(report.byProject.find((g) => g.key === 'proj-X')).toMatchObject({ turns: 2, tokensTotal: 1260, costUsd: 0.52 });
    expect(report.notes.some((n) => n.includes('costUsd 不可用'))).toBe(true);

    const md = fs.readFileSync(r.textFile!, 'utf8');
    expect(md).toContain('# 成本周报（2026-09-28 ~ 2026-10-05）');
    expect(md).toContain('## 按 Agent');
    expect(md).toContain('| agent-A | 1 | 1000 | 200 | 1200 | $0.500000（provider:1） |');
    expect(md).toContain('| agent-C | 1 | 0 | 0 | 5 | unavailable |');
    expect(md).toContain('## 数据说明');

    const row = weeklyLogs().find((r2) => r2.op === 'generate');
    expect(row).toMatchObject({ ok: true, rows: 3, agents: 3, projects: 2 });
    expect(row?.files).toEqual({ md: r.textFile, json: r.jsonFile });
  });

  it('renderWeeklyCostReport 空分组如实说「窗口内无数据」', () => {
    const empty: WeeklyCostReport = {
      generatedAt: NOW_MS,
      window: { from: NOW_MS - 7 * DAY, to: NOW_MS, label: 'lbl' },
      rows: 0,
      truncated: false,
      byAgent: [],
      byProject: [],
      notes: [],
    };
    const md = renderWeeklyCostReport(empty);
    expect(md).toContain('（窗口内无数据）');
    expect(md).not.toContain('| Agent |');
  });

  it('目录/文件名隔离：weekly 产物不被 daily 晨报聚合消费（readLatestDailyReport → null）', async () => {
    await runWeeklyCostReportScan({ now: NOW, queryRows: twoAgentRows, reportDir: tmpDir });

    // 文件前缀与 daily 正则天然不匹配；且注入的 weekly 目录 ≠ 默认 daily 目录
    expect(WEEKLY_REPORT_DIR).not.toBe(DAILY_REPORT_DIR);
    expect(WEEKLY_REPORT_DIR.endsWith(path.join('reports', 'weekly'))).toBe(true);
    expect(DAILY_REPORT_DIR.endsWith(path.join('reports', 'daily'))).toBe(true);
    expect(fs.readdirSync(tmpDir).every((f) => f.startsWith(WEEKLY_REPORT_FILE_PREFIX))).toBe(true);
    expect(fs.readdirSync(tmpDir).some((f) => /^daily-log-report-\d{4}-\d{2}-\d{2}\./.test(f))).toBe(false);

    // 晨报聚合入口只读 daily 正则命中的文件：把 weekly 目录喂给它也必须返回 null（防污染）
    expect(readLatestDailyReport(tmpDir)).toBeNull();
  });
});

// ============================================================================
// 真实事件库接线（默认数据面：querySystemLog source='resource' + last7d 窗口）
// ============================================================================

describe('默认数据面接线（真实事件库，L2 集成）', () => {
  it('logEvent(source resource) → 周报：仅窗口内行计入，7 天前的旧行被窗口排除', async () => {
    logEvent('system', {
      source: 'resource',
      agentId: 'agent-wk',
      projectId: 'proj-wk',
      ts: NOW_MS - MIN,
      body: { cat: 'resource', model: 'sonnet', tokens: { input: 900, output: 100 }, tokensTotal: 1000, costUsd: 0.42, costSource: 'provider' },
    });
    // 窗口外（8 天前）：不得计入
    logEvent('system', {
      source: 'resource',
      agentId: 'agent-old',
      projectId: 'proj-old',
      ts: NOW_MS - 8 * DAY,
      body: { cat: 'resource', tokensTotal: 999_999, costUsd: 99, costSource: 'provider' },
    });

    const r = await runWeeklyCostReportScan({ now: NOW, reportDir: tmpDir });

    expect(r.skipped).toBe(false);
    const report = JSON.parse(fs.readFileSync(r.jsonFile!, 'utf8')) as WeeklyCostReport;
    expect(report.byAgent.find((g) => g.key === 'agent-wk')).toMatchObject({ tokensTotal: 1000, costUsd: 0.42 });
    expect(report.byAgent.find((g) => g.key === 'agent-old')).toBeUndefined();
    expect(report.byProject.find((g) => g.key === 'proj-old')).toBeUndefined();
  });
});

// ============================================================================
// cron 注册点
// ============================================================================

describe('startWeeklyCostReportJob', () => {
  it('模块加载自启；重复调用幂等（同一句柄）；表达式周一 09:00 且解析合法', () => {
    const first = cronService.startWeeklyCostReportJob();
    const second = cronService.startWeeklyCostReportJob();
    expect(first).toBe(second);
    expect(first.expression).toBe(cronService.WEEKLY_COST_REPORT_CRON);
    expect(first.expression).toBe('0 9 * * 1');
    expect(first.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    expect(first.timer).not.toBeNull();

    const next = cronService.getNextFireTimes(first.expression, first.timezone, 3);
    expect(next.length).toBe(3);
    expect(next.every((d) => d.getDay() === 1 && d.getHours() === 9 && d.getMinutes() === 0)).toBe(true);
  });

  it('stopWeeklyCostReportJob 可停且清空注册点，再次启动拿到新句柄', () => {
    const first = cronService.startWeeklyCostReportJob();
    cronService.stopWeeklyCostReportJob();
    expect(first.timer).toBeNull();
    const second = cronService.startWeeklyCostReportJob();
    expect(second).not.toBe(first);
    expect(second.timer).not.toBeNull();
  });

  it('既有 5 个 job 常量零改动（回归）', () => {
    expect(cronService.BOLBA_DUE_SCAN_CRON).toBe('0 8 * * *');
    expect(cronService.BOSS_MORNING_REPORT_CRON).toBe('0 8 * * *');
    expect(cronService.NIGHTLY_REFLECTION_CRON).toBe('0 2 * * *');
    expect(cronService.DAILY_LOG_REPORT_CRON).toBe('0 7 * * *');
    expect(cronService.RECEIPT_TIMEOUT_CRON).toBe('*/5 * * * *');
  });
});
