/**
 * 任务19·A·⑮ P2 每日日志分析日报
 *
 * 职责：每日 07:00（cron-service 注册，前置于 08:00 晨报）对「昨日」窗口跑一次
 * log-analysis（⑮ P1 模块，同款端口构造：缺省 Claude CLI invoker），把
 * LogAnalysisReport 落盘为 {DATA_DIR}/reports/daily/daily-log-report-<覆盖日>.{md,json}
 * 并登记 ⑭ 观测事件（source='daily-log-report'）。⑨ 晨报聚合经
 * readLatestDailyReport() 只读消费本产物（缺文件静默跳过）。
 *
 * 口径（任务19·A 开工登记）：
 *   - 开关 TC_JARVIS_DAILY_REPORT（缺省开；'0'/'off'/'false' 关）；
 *   - 最少数据闸门：昨日 system_log 零行 → 直接跳过，不发 LLM；
 *   - LLM/收集失败或产报告 degraded → 打日志跳过、不落盘；
 *   - 本体永不上抛（调度层安全），任何一步异常都降级为「登记 + 跳过」。
 *
 * 边界：只读数据；不改 log-analysis 模块；不接委派通道；不计 ⑫ 配额；
 * 建议仍只落盘等人拍板，不自动执行。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { countSystemLog, logEvent } from '../data/system-log.js';
import {
  resolveTimeWindow,
  renderLogAnalysisReport,
  runLogAnalysis,
  type LogAnalysisReport,
  type LogWindow,
  type RunLogAnalysisOptions,
} from '../log-analysis/index.js';
import { createLogger } from '../utils/logger.js';
import { truncateOrEmpty } from '../utils/index.js';

const log = createLogger('DailyLogReport');

// ─── 路径与常量 ───

/** 与 event-db 同源的数据根目录（XDG_DATA_HOME || ~/.local/share + tide-commander）。 */
const DATA_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'tide-commander',
);

/** 日报落盘目录（.md 人读 + .json 供 ⑨ 晨报聚合只读消费）。 */
export const DAILY_REPORT_DIR = path.join(DATA_DIR, 'reports', 'daily');
/** ⑭ 观测来源标识（category='system' + source + body.cat='daily-log-report'；不改任何枚举）。 */
export const DAILY_REPORT_LOG_SOURCE = 'daily-log-report';
/** 摘要字段展示上限（进晨报前收口）。 */
const SUMMARY_MAX = 200;

// ─── 开关（缺省开；与 ⑨ 晨报 TC_JARVIS_MORNING_REPORT 同款最小形态） ───

export function isDailyLogReportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TC_JARVIS_DAILY_REPORT?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'off' || raw === 'false');
}

// ─── 文件名与摘要工具 ───

function formatLocalDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 报告 → 晨报摘要（bounded；含降级标注）。 */
function digestSummaryOf(report: Partial<LogAnalysisReport>): string {
  const stats = report.stats;
  const core = stats
    ? `昨日日志 ${stats.total} 条（error ${stats.errorRows} / warn ${stats.warnRows}）；异常 ${report.anomalies?.length ?? 0} 项，瓶颈 ${report.bottlenecks?.length ?? 0} 项，建议 ${report.recommendations?.length ?? 0} 项`
    : '（报告统计缺失）';
  const degraded = report.degraded ? `[降级:${report.degraded}] ` : '';
  return truncateOrEmpty(`${degraded}${core}`, SUMMARY_MAX);
}

// ─── ⑨ 晨报只读数据源 ───

/** ⑨ 晨报聚合用的日报摘要（只读；readLatestDailyReport 永不抛，缺/坏文件返回 null）。 */
export interface DailyReportDigest {
  /** 产物文件绝对路径。 */
  file: string;
  /** 覆盖日（YYYY-MM-DD，取自文件名）。 */
  dateLabel: string;
  generatedAt?: number;
  summary: string;
  degraded?: string;
}

const REPORT_FILE_RE = /^daily-log-report-(\d{4}-\d{2}-\d{2})\.(json|md)$/;

function dateLabelFromName(fileName: string): string {
  return REPORT_FILE_RE.exec(fileName)?.[1] ?? '';
}

function listReportFiles(dir: string, ext: 'json' | 'md'): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => REPORT_FILE_RE.test(f) && f.endsWith(`.${ext}`)).sort();
  } catch {
    return [];
  }
}

/**
 * 读最新一期日报摘要（⑨ 晨报聚合入口，只读）。
 * 优先最近的 .json（可结构化摘要）；无可用 json 时退到最近的 .md 首行。
 * 目录缺失/文件损坏/任何异常 → null（调用方静默跳过，绝不因日报缺失打断晨报）。
 */
export function readLatestDailyReport(dir: string = DAILY_REPORT_DIR): DailyReportDigest | null {
  const jsonFiles = listReportFiles(dir, 'json');
  for (let i = jsonFiles.length - 1; i >= 0; i--) {
    const fileName = jsonFiles[i];
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8')) as LogAnalysisReport;
      if (!parsed || typeof parsed !== 'object' || !parsed.stats) continue;
      return {
        file: path.join(dir, fileName),
        dateLabel: dateLabelFromName(fileName) || formatLocalDay(parsed.window?.from ?? Date.now()),
        generatedAt: parsed.generatedAt,
        summary: digestSummaryOf(parsed),
        degraded: parsed.degraded,
      };
    } catch {
      continue; // 损坏的 json 跳过，尝试更早一期
    }
  }

  const mdFiles = listReportFiles(dir, 'md');
  if (mdFiles.length > 0) {
    const fileName = mdFiles[mdFiles.length - 1];
    try {
      const content = fs.readFileSync(path.join(dir, fileName), 'utf8');
      const firstLine = content.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
      return {
        file: path.join(dir, fileName),
        dateLabel: dateLabelFromName(fileName),
        summary: truncateOrEmpty(firstLine, SUMMARY_MAX),
      };
    } catch {
      return null;
    }
  }
  return null;
}

// ─── 扫描主流程 ───

export interface DailyLogReportDeps {
  /** 时刻注入（测试用；缺省进程时钟）。 */
  now?: () => Date;
  /** 昨日行数闸门（测试注入；缺省 countSystemLog(since/until)）。 */
  countRows?: (window: LogWindow) => number;
  /** 日志分析执行（测试注入 stub；缺省 runLogAnalysis —— 同款缺省 LLM 端口构造）。 */
  runAnalysis?: (opts: RunLogAnalysisOptions) => Promise<LogAnalysisReport>;
  /** 落盘目录覆盖（测试用临时目录）。 */
  reportDir?: string;
  /** 写文件注入（测试用；缺省 fs.writeFileSync）。 */
  writeFile?: (file: string, content: string) => void;
  /** 建目录注入（测试用；缺省 fs.mkdirSync recursive）。 */
  ensureDir?: (dir: string) => void;
}

export type DailyLogReportSkipReason =
  | 'disabled'
  | 'no-data'
  | 'count-error'
  | 'analysis-error'
  | 'collect-error'
  | 'llm-error'
  | 'parse-error'
  | 'write-error';

export interface DailyLogReportResult {
  /** 跳过（含开关关闭/无数据/降级/写失败）；未跳过 = 已落盘。 */
  skipped: boolean;
  /** 开关关闭。 */
  disabled?: boolean;
  reason?: DailyLogReportSkipReason;
  window?: LogWindow;
  /** 闸门实测的昨日行数。 */
  rows?: number;
  /** 未跳过时的完整报告。 */
  report?: LogAnalysisReport;
  textFile?: string;
  jsonFile?: string;
}

interface DailyReportLogFields {
  op: 'generate' | 'skip';
  ok: boolean;
  at: number;
  reason?: string;
  window?: { from: number; to: number; label?: string };
  rows?: number;
  files?: { md: string; json: string };
  sections?: { anomalies: number; bottlenecks: number; resources: number; recommendations: number };
  degraded?: string;
  error?: string;
}

/** ⑭ 日报事件登记（append-only；logEvent 自身静默降级，绝不影响主链路）。 */
function logDailyReport(fields: DailyReportLogFields): number | undefined {
  try {
    return logEvent('system', {
      source: DAILY_REPORT_LOG_SOURCE,
      level: fields.ok ? undefined : 'warn',
      body: {
        cat: 'daily-log-report',
        op: fields.op,
        ok: fields.ok,
        at: fields.at,
        reason: fields.reason,
        window: fields.window,
        rows: fields.rows,
        files: fields.files,
        sections: fields.sections,
        degraded: fields.degraded,
        error: fields.error,
      },
    });
  } catch {
    return undefined; // 失败隔离：观测写入绝不打断日报主流程
  }
}

/**
 * 跑一次日报（cron 07:00 触发）。任何异常都不上抛（调度层安全）。
 */
export async function runDailyLogReportScan(
  deps: DailyLogReportDeps = {},
): Promise<DailyLogReportResult> {
  const at = (deps.now ?? (() => new Date()))().getTime();

  // 开关在入口读（缺省开；关 = 不计数、不分析、不落盘）。
  if (!isDailyLogReportEnabled()) {
    logDailyReport({ op: 'skip', ok: false, at, reason: 'disabled' });
    log.log('每日日志分析日报已关闭（TC_JARVIS_DAILY_REPORT）');
    return { skipped: true, disabled: true, reason: 'disabled' };
  }

  const window = resolveTimeWindow({ preset: 'yesterday', now: at });

  // 最少数据闸门：昨日 system_log 零行 → 不发 LLM（防凭空分析/省预算）。
  const countRows = deps.countRows ?? ((w: LogWindow) => countSystemLog({ since: w.from, until: w.to }));
  let rows: number;
  try {
    rows = countRows(window);
  } catch (err) {
    log.warn(`昨日行数闸门失败，跳过日报：${errMessage(err)}`);
    logDailyReport({ op: 'skip', ok: false, at, reason: 'count-error', window, error: errMessage(err) });
    return { skipped: true, reason: 'count-error', window };
  }
  if (rows <= 0) {
    log.log(`昨日（${window.label ?? ''}）无日志行，跳过日报`);
    logDailyReport({ op: 'skip', ok: true, at, reason: 'no-data', window, rows: 0 });
    return { skipped: true, reason: 'no-data', window, rows: 0 };
  }

  // 分析：缺省即 ⑮ P1 runLogAnalysis（同款缺省 Claude CLI 端口构造）；其自身
  // 只降级不抛，但注入实现可能抛 —— 一律降级为「登记 + 跳过」，永不上抛。
  const runAnalysis = deps.runAnalysis ?? runLogAnalysis;
  let report: LogAnalysisReport;
  try {
    report = await runAnalysis({ from: window.from, to: window.to });
  } catch (err) {
    log.warn(`日志分析失败，跳过日报：${errMessage(err)}`);
    logDailyReport({ op: 'skip', ok: false, at, reason: 'analysis-error', window, rows, error: errMessage(err) });
    return { skipped: true, reason: 'analysis-error', window, rows };
  }

  // 报告降级（no-data/collect-error/llm-error/parse-error）→ 打日志跳过、不落盘。
  if (report.degraded) {
    log.warn(`日志分析降级（${report.degraded}），跳过日报落盘`);
    logDailyReport({ op: 'skip', ok: false, at, reason: report.degraded, window, rows, degraded: report.degraded });
    return { skipped: true, reason: report.degraded, window, rows, report };
  }

  // 落盘：md（人读）+ json（⑨ 晨报只读消费）。写失败 → 登记跳过。
  const reportDir = deps.reportDir ?? DAILY_REPORT_DIR;
  const dayLabel = formatLocalDay(window.from);
  const mdFile = path.join(reportDir, `daily-log-report-${dayLabel}.md`);
  const jsonFile = path.join(reportDir, `daily-log-report-${dayLabel}.json`);
  const ensureDir = deps.ensureDir ?? ((dir: string) => fs.mkdirSync(dir, { recursive: true }));
  const writeFile = deps.writeFile ?? ((file: string, content: string) => fs.writeFileSync(file, content, 'utf8'));
  try {
    ensureDir(reportDir);
    writeFile(mdFile, renderLogAnalysisReport(report));
    writeFile(jsonFile, JSON.stringify(report, null, 2));
  } catch (err) {
    log.warn(`日报落盘失败，跳过：${errMessage(err)}`);
    logDailyReport({ op: 'skip', ok: false, at, reason: 'write-error', window, rows, error: errMessage(err) });
    return { skipped: true, reason: 'write-error', window, rows, report };
  }

  logDailyReport({
    op: 'generate',
    ok: true,
    at,
    window,
    rows,
    files: { md: mdFile, json: jsonFile },
    sections: {
      anomalies: report.anomalies.length,
      bottlenecks: report.bottlenecks.length,
      resources: report.resources.length,
      recommendations: report.recommendations.length,
    },
  });
  log.log(`每日日志分析日报已生成：${mdFile}`);

  return { skipped: false, window, rows, report, textFile: mdFile, jsonFile };
}
