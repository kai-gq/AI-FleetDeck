/**
 * 任务17·A5 成本周报
 *
 * 职责：每周一 09:00（cron-service 第 6 job）对「近 7 天」窗口取
 * system_log 的 resource 行（source='resource'，⑭ 系统活动 4 落盘形态，零新采集），
 * 按 agentId / projectId 分组聚合 token 与费用（log-analysis/stats.aggregateResourceUsage）
 * → 落盘 {DATA_DIR}/reports/weekly/weekly-cost-report-<生成日>.{md,json} +
 * 登记 ⑭ 观测事件（source='weekly-cost-report'）。
 *
 * 口径（任务17 开工登记 2026-10-04）：
 *   - 开关 TC_JARVIS_WEEKLY_COST_REPORT（缺省开；'0'/'off'/'false' 关）；
 *   - 最少数据闸门：窗口内零 resource 行 → 直接跳过，不落盘；
 *   - costUsd 'unavailable' 如实剥离并标注（不按 0 计入合计）；
 *   - 失败降级永不上抛（调度层安全）：查询/落盘/任何意外异常 → 登记 + 跳过；
 *   - 不复用 daily 文件名（daily-log-report-service 的晨报聚合只认
 *     reports/daily/daily-log-report-*.json —— 本服务独立目录 + 独立前缀，防污染）；
 *   - v1 只落盘不播报（登记：播报通道待波次门后拍板）；
 *   - 任务22 编制段：报表尾部附「## 编制」（agent-ledger-service 台账；采集失败/空
 *     花名册 → 段省略，绝不影响报表主流程与最少数据闸门）。
 *
 * 边界：只读数据；不改 log-analysis 模块既有函数（buildLogStats 零改动）；不接委派通道。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { logEvent, querySystemLog, type SystemLogEntry } from '../data/system-log.js';
import { resolveTimeWindow, type LogWindow } from '../log-analysis/index.js';
import {
  aggregateResourceUsage,
  type ResourceGroupTotals,
} from '../log-analysis/stats.js';
import { createLogger } from '../utils/logger.js';
import {
  collectLiveRosterLedger,
  renderAgentLedgerSection,
  type AgentLedgerEntry,
} from './agent-ledger-service.js';

const log = createLogger('WeeklyCostReport');

// ─── 路径与常量 ───

/** 与 event-db / daily 日报同源的数据根目录（XDG_DATA_HOME || ~/.local/share + tide-commander）。 */
const DATA_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'tide-commander',
);

/** 周报落盘目录（独立于 reports/daily —— 晨报聚合只读 daily，互不污染）。 */
export const WEEKLY_REPORT_DIR = path.join(DATA_DIR, 'reports', 'weekly');
/** 周报文件名前缀（与 daily-log-report- 前缀区分；晨报聚合正则不匹配本前缀）。 */
export const WEEKLY_REPORT_FILE_PREFIX = 'weekly-cost-report-';
/** ⑭ 观测来源标识（category='system' + source + body.cat='weekly-cost-report'；不改任何枚举）。 */
export const WEEKLY_REPORT_LOG_SOURCE = 'weekly-cost-report';
/** resource 查询上限（防御性；触顶时报告内如实标注可能截断）。 */
export const WEEKLY_RESOURCE_QUERY_LIMIT = 10_000;

// ─── 开关（缺省开；与 ⑨ 晨报/日报同款最小形态） ───

export function isWeeklyCostReportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TC_JARVIS_WEEKLY_COST_REPORT?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'off' || raw === 'false');
}

// ─── 工具 ───

function formatLocalDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── 报告结构 ───

export interface WeeklyCostReport {
  generatedAt: number;
  window: LogWindow;
  /** 窗口内 resource 行数（只算 cat='resource'）。 */
  rows: number;
  /** 查询触顶（抓取行数 ≥ 上限）→ 数据可能截断，如实标注。 */
  truncated: boolean;
  byAgent: ResourceGroupTotals[];
  byProject: ResourceGroupTotals[];
  /** 数据缺失标注（costUsd unavailable 行数 / 截断等）。 */
  notes: string[];
  /** 任务22 编制台账（「## 编制」段数据源；采集失败/空花名册 → 缺省不输出）。 */
  ledger?: AgentLedgerEntry[];
}

function buildNotes(breakdown: { byAgent: ResourceGroupTotals[] }, truncated: boolean, fetchedRows: number): string[] {
  const notes: string[] = [];
  const unavailable = breakdown.byAgent.reduce((total, group) => total + group.costUnavailableRows, 0);
  if (unavailable > 0) {
    notes.push(`${unavailable} 行 costUsd 不可用（unavailable），已如实剥离、未计入费用合计`);
  }
  if (truncated) {
    notes.push(`抓取行数 ${fetchedRows} 触及查询上限 ${WEEKLY_RESOURCE_QUERY_LIMIT}，数据可能截断`);
  }
  return notes;
}

// ─── Markdown 渲染 ───

function formatCost(group: ResourceGroupTotals): string {
  if (group.costUsd === null) return 'unavailable';
  const sources = (['provider', 'estimated'] as const)
    .map((name) => (group.costSources[name] ? `${name}:${group.costSources[name]}` : ''))
    .filter(Boolean)
    .join('/');
  return `$${group.costUsd.toFixed(6)}${sources ? `（${sources}）` : ''}`;
}

function renderTable(keyHeader: string, groups: readonly ResourceGroupTotals[]): string[] {
  if (groups.length === 0) return ['（窗口内无数据）'];
  return [
    `| ${keyHeader} | turns | tokens in | tokens out | tokens total | costUsd |`,
    '|---|---:|---:|---:|---:|---|',
    ...groups.map((group) =>
      `| ${group.key ?? '未标注'} | ${group.turns} | ${group.tokensInput} | ${group.tokensOutput} | ${group.tokensTotal} | ${formatCost(group)} |`,
    ),
  ];
}

/** 周报 → Markdown（人读；结构化数据以 json 为准）。 */
export function renderWeeklyCostReport(report: WeeklyCostReport): string {
  const lines: string[] = [
    `# 成本周报（${formatLocalDay(report.window.from)} ~ ${formatLocalDay(report.window.to)}）`,
    '',
    `- 生成时刻：${new Date(report.generatedAt).toLocaleString()}`,
    `- 窗口：${report.window.label ?? `${report.window.from} ~ ${report.window.to}`}`,
    `- resource 行：${report.rows}${report.truncated ? '（可能截断）' : ''}`,
    '',
    '## 按 Agent',
    '',
    ...renderTable('Agent', report.byAgent),
    '',
    '## 按项目',
    '',
    ...renderTable('项目', report.byProject),
  ];
  if (report.ledger && report.ledger.length > 0) {
    lines.push('', renderAgentLedgerSection(report.ledger));
  }
  if (report.notes.length > 0) {
    lines.push('', '## 数据说明', '', ...report.notes.map((note) => `- ${note}`));
  }
  return `${lines.join('\n')}\n`;
}

// ─── ⑭ 事件登记 ───

interface WeeklyReportLogFields {
  op: 'generate' | 'skip';
  ok: boolean;
  at: number;
  reason?: string;
  window?: { from: number; to: number; label?: string };
  rows?: number;
  agents?: number;
  projects?: number;
  files?: { md: string; json: string };
  notes?: string[];
  /** 任务22 编制段计数（建议采纳率 → ⑮ 标定用）。 */
  ledger?: { total: number; observe: number; archive: number };
  error?: string;
}

/** 周报事件登记（append-only；logEvent 自身静默降级，绝不影响主链路）。 */
function logWeeklyReport(fields: WeeklyReportLogFields): void {
  try {
    logEvent('system', {
      source: WEEKLY_REPORT_LOG_SOURCE,
      level: fields.ok ? undefined : 'warn',
      body: {
        cat: 'weekly-cost-report',
        op: fields.op,
        ok: fields.ok,
        at: fields.at,
        reason: fields.reason,
        window: fields.window,
        rows: fields.rows,
        agents: fields.agents,
        projects: fields.projects,
        files: fields.files,
        notes: fields.notes,
        ledger: fields.ledger,
        error: fields.error,
      },
    });
  } catch {
    // 失败隔离：观测写入绝不打断周报主流程
  }
}

// ─── 扫描主流程 ───

export interface WeeklyCostReportDeps {
  /** 时刻注入（测试用；缺省进程时钟）。 */
  now?: () => Date;
  /** 数据面查询（测试注入；缺省 querySystemLog({source:'resource', since, until})）。 */
  queryRows?: (window: LogWindow) => SystemLogEntry[];
  /** 落盘目录覆盖（测试用临时目录）。 */
  reportDir?: string;
  /** 写文件注入（测试用；缺省 fs.writeFileSync）。 */
  writeFile?: (file: string, content: string) => void;
  /** 建目录注入（测试用；缺省 fs.mkdirSync recursive）。 */
  ensureDir?: (dir: string) => void;
  /** 任务22 编制台账采集注入（测试用；缺省 collectLiveRosterLedger 实时采集）。 */
  collectLedger?: (now: number) => AgentLedgerEntry[];
}

export type WeeklyCostReportSkipReason = 'disabled' | 'no-data' | 'query-error' | 'write-error' | 'unexpected-error';

export interface WeeklyCostReportResult {
  /** 跳过（含开关关闭/空窗/降级/写失败）；未跳过 = 已落盘。 */
  skipped: boolean;
  disabled?: boolean;
  reason?: WeeklyCostReportSkipReason;
  window?: LogWindow;
  /** 窗口内 resource 行数（只算 cat='resource'）。 */
  rows?: number;
  agents?: number;
  projects?: number;
  report?: WeeklyCostReport;
  textFile?: string;
  jsonFile?: string;
}

/**
 * 跑一次成本周报（cron 周一 09:00 触发）。任何异常都不上抛（调度层安全）。
 */
export async function runWeeklyCostReportScan(
  deps: WeeklyCostReportDeps = {},
): Promise<WeeklyCostReportResult> {
  try {
    return scan(deps);
  } catch (err) {
    // 兜底失败隔离：注入实现/落盘/任何意外异常 → 登记 + 跳过，绝不上抛。
    log.warn(`成本周报异常降级：${errMessage(err)}`);
    logWeeklyReport({ op: 'skip', ok: false, at: Date.now(), reason: 'unexpected-error', error: errMessage(err) });
    return { skipped: true, reason: 'unexpected-error' };
  }
}

function scan(deps: WeeklyCostReportDeps): WeeklyCostReportResult {
  const at = (deps.now ?? (() => new Date()))().getTime();

  // 开关在入口读（缺省开；关 = 不查询、不落盘）。
  if (!isWeeklyCostReportEnabled()) {
    logWeeklyReport({ op: 'skip', ok: false, at, reason: 'disabled' });
    log.log('成本周报已关闭（TC_JARVIS_WEEKLY_COST_REPORT）');
    return { skipped: true, disabled: true, reason: 'disabled' };
  }

  const window = resolveTimeWindow({ preset: 'last7d', now: at });

  // 数据面：零新采集 —— 只读 ⑭ 系统活动 4 的 resource 行（近 7 天）。
  const queryRows = deps.queryRows ?? ((w: LogWindow) => querySystemLog({
    source: 'resource',
    since: w.from,
    until: w.to,
    order: 'asc',
    limit: WEEKLY_RESOURCE_QUERY_LIMIT,
  }));
  let rows: SystemLogEntry[];
  try {
    rows = queryRows(window);
  } catch (err) {
    log.warn(`resource 数据查询失败，跳过周报：${errMessage(err)}`);
    logWeeklyReport({ op: 'skip', ok: false, at, reason: 'query-error', window, error: errMessage(err) });
    return { skipped: true, reason: 'query-error', window };
  }

  const breakdown = aggregateResourceUsage(rows);

  // 最少数据闸门：窗口内零 resource 行 → 不落盘（防凭空造报告）。
  if (breakdown.rows <= 0) {
    log.log(`近 7 天（${window.label ?? ''}）无 resource 行，跳过周报`);
    logWeeklyReport({ op: 'skip', ok: true, at, reason: 'no-data', window, rows: 0 });
    return { skipped: true, reason: 'no-data', window, rows: 0 };
  }

  const truncated = rows.length >= WEEKLY_RESOURCE_QUERY_LIMIT;
  // 任务22 编制台账（⑮ 报表段；采集失败/空 → 段省略，绝不打断周报主流程）。
  let ledger: AgentLedgerEntry[] = [];
  try {
    ledger = (deps.collectLedger ?? collectLiveRosterLedger)(at);
  } catch (err) {
    log.warn(`编制台账采集失败（周报编制段省略）：${errMessage(err)}`);
  }
  const report: WeeklyCostReport = {
    generatedAt: at,
    window,
    rows: breakdown.rows,
    truncated,
    byAgent: breakdown.byAgent,
    byProject: breakdown.byProject,
    notes: buildNotes(breakdown, truncated, rows.length),
    ...(ledger.length > 0 ? { ledger } : {}),
  };

  // 落盘：md（人读）+ json（结构化）。目录/前缀均独立于 daily 日报（防晨报聚合污染）。
  const reportDir = deps.reportDir ?? WEEKLY_REPORT_DIR;
  const dayLabel = formatLocalDay(at);
  const mdFile = path.join(reportDir, `${WEEKLY_REPORT_FILE_PREFIX}${dayLabel}.md`);
  const jsonFile = path.join(reportDir, `${WEEKLY_REPORT_FILE_PREFIX}${dayLabel}.json`);
  const ensureDir = deps.ensureDir ?? ((dir: string) => fs.mkdirSync(dir, { recursive: true }));
  const writeFile = deps.writeFile ?? ((file: string, content: string) => fs.writeFileSync(file, content, 'utf8'));
  try {
    ensureDir(reportDir);
    writeFile(mdFile, renderWeeklyCostReport(report));
    writeFile(jsonFile, JSON.stringify(report, null, 2));
  } catch (err) {
    log.warn(`周报落盘失败，跳过：${errMessage(err)}`);
    logWeeklyReport({ op: 'skip', ok: false, at, reason: 'write-error', window, error: errMessage(err) });
    return { skipped: true, reason: 'write-error', window, rows: breakdown.rows, report };
  }

  logWeeklyReport({
    op: 'generate',
    ok: true,
    at,
    window,
    rows: breakdown.rows,
    agents: breakdown.byAgent.length,
    projects: breakdown.byProject.length,
    files: { md: mdFile, json: jsonFile },
    notes: report.notes,
    ...(ledger.length > 0
      ? {
          ledger: {
            total: ledger.length,
            observe: ledger.filter((e) => e.advice === 'observe').length,
            archive: ledger.filter((e) => e.advice === 'archive-candidate').length,
          },
        }
      : {}),
  });
  log.log(`成本周报已生成：${mdFile}`);

  return {
    skipped: false,
    window,
    rows: breakdown.rows,
    agents: breakdown.byAgent.length,
    projects: breakdown.byProject.length,
    report,
    textFile: mdFile,
    jsonFile,
  };
}
