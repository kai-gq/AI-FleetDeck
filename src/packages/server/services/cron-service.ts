/**
 * Cron Service
 * Thin wrapper around setInterval-based cron scheduling.
 * Parses cron expressions and fires callbacks at the scheduled times.
 *
 * Uses a simple polling approach (checks every 30s) since node-cron
 * is not yet a dependency. Sufficient for minute-level cron expressions.
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('CronService');

export interface CronJob {
  id: string;
  expression: string;
  timezone: string;
  callback: () => void;
  timer: NodeJS.Timeout | null;
  lastFired: number | null;
}

const activeJobs = new Map<string, CronJob>();

// ─── Cron Expression Parsing ───

interface CronField {
  values: Set<number>;
  isWildcard: boolean;
}

function parseField(field: string, min: number, max: number): CronField {
  if (field === '*') {
    return { values: new Set(), isWildcard: true };
  }

  const values = new Set<number>();
  const parts = field.split(',');

  for (const part of parts) {
    // Handle step values: */5, 1-30/2
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[2], 10);
      const range = stepMatch[1];
      let start = min;
      let end = max;

      if (range !== '*') {
        const rangeParts = range.split('-');
        start = parseInt(rangeParts[0], 10);
        end = rangeParts.length > 1 ? parseInt(rangeParts[1], 10) : max;
      }

      for (let i = start; i <= end; i += step) {
        values.add(i);
      }
      continue;
    }

    // Handle ranges: 1-5
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let i = start; i <= end; i++) {
        values.add(i);
      }
      continue;
    }

    // Handle day-of-week names: MON-FRI, SUN, etc.
    const dayNames: Record<string, number> = {
      SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
    };
    const dayRangeMatch = part.match(/^([A-Z]{3})-([A-Z]{3})$/);
    if (dayRangeMatch && dayNames[dayRangeMatch[1]] !== undefined && dayNames[dayRangeMatch[2]] !== undefined) {
      const start = dayNames[dayRangeMatch[1]];
      const end = dayNames[dayRangeMatch[2]];
      if (start <= end) {
        for (let i = start; i <= end; i++) values.add(i);
      } else {
        // Wrap around: FRI-MON = 5,6,0,1
        for (let i = start; i <= 6; i++) values.add(i);
        for (let i = 0; i <= end; i++) values.add(i);
      }
      continue;
    }

    if (dayNames[part] !== undefined) {
      values.add(dayNames[part]);
      continue;
    }

    // Simple number
    const num = parseInt(part, 10);
    if (!isNaN(num)) {
      values.add(num);
    }
  }

  return { values, isWildcard: false };
}

function parseCronExpression(expression: string): { minute: CronField; hour: CronField; dayOfMonth: CronField; month: CronField; dayOfWeek: CronField } | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  try {
    return {
      minute: parseField(parts[0], 0, 59),
      hour: parseField(parts[1], 0, 23),
      dayOfMonth: parseField(parts[2], 1, 31),
      month: parseField(parts[3], 1, 12),
      dayOfWeek: parseField(parts[4], 0, 6),
    };
  } catch {
    return null;
  }
}

function fieldMatches(field: CronField, value: number): boolean {
  if (field.isWildcard) return true;
  return field.values.has(value);
}

function shouldFireAt(expression: string, date: Date): boolean {
  const parsed = parseCronExpression(expression);
  if (!parsed) return false;

  return (
    fieldMatches(parsed.minute, date.getMinutes()) &&
    fieldMatches(parsed.hour, date.getHours()) &&
    fieldMatches(parsed.dayOfMonth, date.getDate()) &&
    fieldMatches(parsed.month, date.getMonth() + 1) &&
    fieldMatches(parsed.dayOfWeek, date.getDay())
  );
}

function getDateInTimezone(timezone: string): Date {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const get = (type: string) => parts.find(p => p.type === type)?.value || '0';

    return new Date(
      parseInt(get('year')),
      parseInt(get('month')) - 1,
      parseInt(get('day')),
      parseInt(get('hour')),
      parseInt(get('minute')),
      parseInt(get('second'))
    );
  } catch {
    // Fallback to UTC
    return new Date();
  }
}

// ─── Public API ───

const CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds

// Max safe setTimeout delay (2^31-1 ms ≈ 24.8 days). Longer waits are chained.
const MAX_SETTIMEOUT_MS = 2_147_483_647;

/**
 * Schedule a callback to fire exactly once at the given absolute datetime.
 * If the time is already in the past, the callback is fired immediately (next tick).
 * Returns a CronJob-compatible handle that can be stopped via `stop(job)`.
 */
export function scheduleOnce(runAtIso: string, callback: () => void): CronJob {
  const id = `once_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runAtMs = new Date(runAtIso).getTime();

  const job: CronJob = {
    id,
    expression: `@once ${runAtIso}`,
    timezone: 'UTC',
    callback,
    timer: null,
    lastFired: null,
  };

  const fire = (reason: string) => {
    job.lastFired = Date.now();
    log.log(`One-shot cron ${id} fired (runAt=${runAtIso}, ${reason})`);
    activeJobs.delete(id);
    try {
      callback();
    } catch (err) {
      log.error(`One-shot cron ${id} callback error:`, err);
    }
  };

  const armTimer = () => {
    const remaining = runAtMs - Date.now();
    // Always schedule via setTimeout (delay clamped to >= 0) so the callback
    // never runs synchronously within scheduleOnce — callers often update state
    // after this returns, and a sync callback would race that.
    const delay = Math.max(0, Math.min(remaining, MAX_SETTIMEOUT_MS));
    job.timer = setTimeout(() => {
      if (remaining > MAX_SETTIMEOUT_MS) {
        // Chained wait: re-arm for the remaining interval
        armTimer();
        return;
      }
      fire('scheduled');
    }, delay);
  };

  armTimer();
  activeJobs.set(id, job);
  log.log(`Scheduled one-shot cron ${id} for ${runAtIso}`);

  return job;
}

export interface ScheduleOptions {
  /**
   * Seed value for `job.lastFired`. When set, the same-minute guard in the
   * interval check kicks in immediately — preventing a freshly-armed job
   * from re-firing in the very minute that triggered its (re)arming.
   *
   * Two real-world cases this defends against:
   *   1. A trigger fires, `fireTrigger` calls `updateTrigger({lastFiredAt})`,
   *      which re-arms the cron job. Without this seed, the new job's
   *      `lastFired === null` and the same minute's poll fires a second time.
   *   2. The server restarts inside the same minute it last fired. The
   *      persisted `trigger.lastFiredAt` keeps the new job from firing twice.
   */
  initialLastFired?: number | null;
}

export function schedule(
  expression: string,
  timezone: string,
  callback: () => void,
  options?: ScheduleOptions,
): CronJob {
  const id = `cron_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const job: CronJob = {
    id,
    expression,
    timezone,
    callback,
    timer: null,
    lastFired: options?.initialLastFired ?? null,
  };

  // Check at interval whether it's time to fire
  job.timer = setInterval(() => {
    const now = getDateInTimezone(timezone);
    const currentMinute = Math.floor(now.getTime() / 60000);

    // Only fire once per minute
    if (job.lastFired !== null && Math.floor(job.lastFired / 60000) === currentMinute) {
      return;
    }

    if (shouldFireAt(expression, now)) {
      job.lastFired = Date.now();
      log.log(`Cron job ${id} fired (expression: ${expression}, timezone: ${timezone})`);
      try {
        callback();
      } catch (err) {
        log.error(`Cron job ${id} callback error:`, err);
      }
    }
  }, CHECK_INTERVAL_MS);

  activeJobs.set(id, job);
  log.log(`Scheduled cron job ${id}: ${expression} (${timezone})`);

  return job;
}

export function stop(job: CronJob): void {
  if (job.timer) {
    clearInterval(job.timer);
    job.timer = null;
  }
  activeJobs.delete(job.id);
  log.log(`Stopped cron job ${job.id}`);
}

export function stopAll(): void {
  for (const job of activeJobs.values()) {
    if (job.timer) {
      clearInterval(job.timer);
      job.timer = null;
    }
  }
  activeJobs.clear();
  log.log('Stopped all cron jobs');
}

export function validate(expression: string): boolean {
  return parseCronExpression(expression) !== null;
}

export function getNextFireTimes(expression: string, timezone: string, count: number = 5): Date[] {
  const parsed = parseCronExpression(expression);
  if (!parsed) return [];

  const results: Date[] = [];
  const start = getDateInTimezone(timezone);
  // Start from next minute
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  // Check up to 366 days ahead to find next fire times
  const maxIterations = 366 * 24 * 60;
  let current = new Date(start);

  for (let i = 0; i < maxIterations && results.length < count; i++) {
    if (shouldFireAt(expression, current)) {
      results.push(new Date(current));
    }
    current.setMinutes(current.getMinutes() + 1);
  }

  return results;
}

// ─── 任务13·⑩：Bolba 到期提醒每日扫描注册点 ───

/** 每日 08:00（本地时区）扫一次 Bolba 在办任务的到期情况。 */
export const BOLBA_DUE_SCAN_CRON = '0 8 * * *';

let bolbaDueReminderJob: CronJob | null = null;

/**
 * 任务13·⑩ 到期提醒扫描注册点（本文件 = 服务端调度总入口，注册仅此一处）。
 *
 * 业务实现懒加载：调度层不静态依赖业务层，也不成环
 * （bolba-due-reminder-service → voice-companion-service/bolba-bridge-service，
 * 均不 import 本文件）。幂等：重复调用返回同一任务句柄。
 */
export function startBolbaDueReminderJob(opts: { expression?: string; timezone?: string } = {}): CronJob {
  if (bolbaDueReminderJob) return bolbaDueReminderJob;
  bolbaDueReminderJob = schedule(
    opts.expression ?? BOLBA_DUE_SCAN_CRON,
    opts.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    () => {
      void import('./bolba-due-reminder-service.js')
        .then((m) => m.runBolbaDueReminderScan())
        .catch((err) => log.warn('Bolba 到期提醒扫描失败:', err));
    },
  );
  // 不保活进程：测试/CLI 进程不被这条 interval 挂住（stop() 亦照常可停）。
  bolbaDueReminderJob.timer?.unref();
  return bolbaDueReminderJob;
}

/** 停止并清空注册点（幂等；主脑若改统一启动接线可删文件尾自启，本函数保留）。 */
export function stopBolbaDueReminderJob(): void {
  if (!bolbaDueReminderJob) return;
  stop(bolbaDueReminderJob);
  bolbaDueReminderJob = null;
}

// 模块加载即注册（幂等、unref）。主脑可改为启动接线显式调用。
startBolbaDueReminderJob();

// ─── 任务12·⑨：Boss 晨报每日扫描注册点 ───

/** 晨报时段（06-11 §6.4 建议值：早上 08:00，可配；非实测最优）。 */
export const BOSS_MORNING_REPORT_CRON = '0 8 * * *';

let bossMorningReportJob: CronJob | null = null;

/**
 * 任务12·⑨ 晨报扫描注册点（本文件 = 服务端调度总入口，注册仅此一处）。
 *
 * 与任务13 到期提醒同为 08:00、各自独立队列（预算不共享，登记观察项）；
 * 不得改动 13 的 job 时间。业务实现懒加载：调度层不静态依赖业务层，也不成环
 * （boss-morning-report-service → voice-companion-service/data，均不 import 本文件）。
 * 幂等：重复调用返回同一任务句柄。
 */
export function startBossMorningReportJob(opts: { expression?: string; timezone?: string } = {}): CronJob {
  if (bossMorningReportJob) return bossMorningReportJob;
  bossMorningReportJob = schedule(
    opts.expression ?? BOSS_MORNING_REPORT_CRON,
    opts.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    () => {
      void import('./boss-morning-report-service.js')
        .then((m) => m.runBossMorningReportScan())
        .catch((err) => log.warn('Boss 晨报扫描失败:', err));
    },
  );
  // 不保活进程：测试/CLI 进程不被这条 interval 挂住（stop() 亦照常可停）。
  bossMorningReportJob.timer?.unref();
  return bossMorningReportJob;
}

/** 停止并清空注册点（幂等；主脑若改统一启动接线可删文件尾自启，本函数保留）。 */
export function stopBossMorningReportJob(): void {
  if (!bossMorningReportJob) return;
  stop(bossMorningReportJob);
  bossMorningReportJob = null;
}

// 模块加载即注册（幂等、unref）。主脑可改为启动接线显式调用。
startBossMorningReportJob();

// ─── 任务28·反思：夜间反思（02:00）注册点 ───

/** 夜间反思时段（06-11 §6.3 建议值：凌晨 02:00，可配；非实测最优）。 */
export const NIGHTLY_REFLECTION_CRON = '0 2 * * *';

let nightlyReflectionJob: CronJob | null = null;

/**
 * 任务28 夜间反思注册点（本文件 = 服务端调度总入口，注册仅此一处）。
 *
 * 业务实现懒加载：调度层不静态依赖业务层，也不成环
 * （nightly-reflection-service → jarvis-core/reflection + memory，均不 import 本文件）。
 * 幂等：重复调用返回同一任务句柄。
 *
 * LLM 端口未接线（真实通道延后登记）：会话 ≥5 的夜晚会如实记
 * failed/llm-port-unavailable（零操作零写入）；通道接通后只换服务侧注入，
 * 本调度形态不变。
 */
export function startNightlyReflectionJob(opts: { expression?: string; timezone?: string } = {}): CronJob {
  if (nightlyReflectionJob) return nightlyReflectionJob;
  nightlyReflectionJob = schedule(
    opts.expression ?? NIGHTLY_REFLECTION_CRON,
    opts.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    () => {
      void import('./nightly-reflection-service.js')
        .then((m) => m.runNightlyReflectionScan())
        .catch((err) => log.warn('夜间反思运行失败:', err));
    },
  );
  // 不保活进程：测试/CLI 进程不被这条 interval 挂住（stop() 亦照常可停）。
  nightlyReflectionJob.timer?.unref();
  return nightlyReflectionJob;
}

/** 停止并清空注册点（幂等；主脑若改统一启动接线可删文件尾自启，本函数保留）。 */
export function stopNightlyReflectionJob(): void {
  if (!nightlyReflectionJob) return;
  stop(nightlyReflectionJob);
  nightlyReflectionJob = null;
}

// 模块加载即注册（幂等、unref）。主脑可改为启动接线显式调用。
startNightlyReflectionJob();

// ─── 任务19·A·⑮ P2：每日日志分析日报（07:00）注册点 ───

/** 日报生成时段（本文件 = 服务端调度总入口；07:00 前置于 08:00 晨报聚合，可配）。 */
export const DAILY_LOG_REPORT_CRON = '0 7 * * *';

let dailyLogReportJob: CronJob | null = null;

/**
 * 任务19·A·⑮ P2 日报注册点（注册仅此一处）。07:00 生成昨日日志分析报告落盘，
 * 08:00 的 ⑨ 晨报（任务12）经 readLatestDailyReport 只读聚合。
 *
 * 业务实现懒加载：调度层不静态依赖业务层，也不成环
 * （daily-log-report-service → log-analysis/data，均不 import 本文件）。
 * 开关 TC_JARVIS_DAILY_REPORT 在服务入口读（缺省开）。幂等：重复调用返回同一任务句柄。
 */
export function startDailyLogReportJob(opts: { expression?: string; timezone?: string } = {}): CronJob {
  if (dailyLogReportJob) return dailyLogReportJob;
  dailyLogReportJob = schedule(
    opts.expression ?? DAILY_LOG_REPORT_CRON,
    opts.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    () => {
      void import('./daily-log-report-service.js')
        .then((m) => m.runDailyLogReportScan())
        .catch((err) => log.warn('每日日志分析日报失败:', err));
    },
  );
  // 不保活进程：测试/CLI 进程不被这条 interval 挂住（stop() 亦照常可停）。
  dailyLogReportJob.timer?.unref();
  return dailyLogReportJob;
}

/** 停止并清空注册点（幂等；主脑若改统一启动接线可删文件尾自启，本函数保留）。 */
export function stopDailyLogReportJob(): void {
  if (!dailyLogReportJob) return;
  stop(dailyLogReportJob);
  dailyLogReportJob = null;
}

// 模块加载即注册（幂等、unref）。主脑可改为启动接线显式调用。
startDailyLogReportJob();

// ─── 任务17·A2：回执超时提醒（每 5 分钟）注册点 ───

/** 回执超时扫描周期（初始值待标定：阈值缺省 30 分钟，5 分钟粒度足够且开销可忽略）。 */
export const RECEIPT_TIMEOUT_CRON = '*/5 * * * *';

let receiptTimeoutJob: CronJob | null = null;

/**
 * 任务17·A2 回执超时扫描注册点（注册仅此一处）。经 08② 待回执登记表找
 * matchedAt 为空且超阈值的派活 → ⑩ 播报提醒（v1 不自动重派）。
 *
 * 业务实现懒加载：调度层不静态依赖业务层，也不成环
 * （receipt-timeout-service → pending-receipt-registry/voice-companion-service，
 * 均不 import 本文件）。开关 TC_JARVIS_RECEIPT_TIMEOUT 在服务入口读（缺省开）。
 * 幂等：重复调用返回同一任务句柄。
 */
export function startReceiptTimeoutJob(opts: { expression?: string; timezone?: string } = {}): CronJob {
  if (receiptTimeoutJob) return receiptTimeoutJob;
  receiptTimeoutJob = schedule(
    opts.expression ?? RECEIPT_TIMEOUT_CRON,
    opts.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    () => {
      void import('./receipt-timeout-service.js')
        .then((m) => m.runReceiptTimeoutScan())
        .catch((err) => log.warn('回执超时扫描失败:', err));
    },
  );
  // 不保活进程：测试/CLI 进程不被这条 interval 挂住（stop() 亦照常可停）。
  receiptTimeoutJob.timer?.unref();
  return receiptTimeoutJob;
}

/** 停止并清空注册点（幂等；主脑若改统一启动接线可删文件尾自启，本函数保留）。 */
export function stopReceiptTimeoutJob(): void {
  if (!receiptTimeoutJob) return;
  stop(receiptTimeoutJob);
  receiptTimeoutJob = null;
}

// 模块加载即注册（幂等、unref）。主脑可改为启动接线显式调用。
startReceiptTimeoutJob();

// ─── 任务17·A5：成本周报（周一 09:00）注册点 ───

/** 成本周报时段（每周一 09:00 本地时区；初始值待标定）。 */
export const WEEKLY_COST_REPORT_CRON = '0 9 * * 1';

let weeklyCostReportJob: CronJob | null = null;

/**
 * 任务17·A5 成本周报注册点（注册仅此一处）。近 7 天 resource 行按
 * agentId/projectId 分组 → 落 reports/weekly/（独立目录 + 独立文件名前缀，
 * 不复用 daily 文件名正则——防晨报聚合污染）。
 *
 * 业务实现懒加载：调度层不静态依赖业务层，也不成环
 * （weekly-cost-report-service → log-analysis/data，均不 import 本文件）。
 * 开关 TC_JARVIS_WEEKLY_COST_REPORT 在服务入口读（缺省开）。
 * 幂等：重复调用返回同一任务句柄。
 */
export function startWeeklyCostReportJob(opts: { expression?: string; timezone?: string } = {}): CronJob {
  if (weeklyCostReportJob) return weeklyCostReportJob;
  weeklyCostReportJob = schedule(
    opts.expression ?? WEEKLY_COST_REPORT_CRON,
    opts.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    () => {
      void import('./weekly-cost-report-service.js')
        .then((m) => m.runWeeklyCostReportScan())
        .catch((err) => log.warn('成本周报失败:', err));
    },
  );
  // 不保活进程：测试/CLI 进程不被这条 interval 挂住（stop() 亦照常可停）。
  weeklyCostReportJob.timer?.unref();
  return weeklyCostReportJob;
}

/** 停止并清空注册点（幂等；主脑若改统一启动接线可删文件尾自启，本函数保留）。 */
export function stopWeeklyCostReportJob(): void {
  if (!weeklyCostReportJob) return;
  stop(weeklyCostReportJob);
  weeklyCostReportJob = null;
}

// 模块加载即注册（幂等、unref）。主脑可改为启动接线显式调用。
startWeeklyCostReportJob();

// ─── 任务33：活动监视器每日评估（00:10）注册点 ───

/**
 * 评估时段（每日 00:10 本地时区；初始值非实测）。放在 0 点后 10 分钟：
 * 昨日自然日完整闭账后再评，避免边界行归属漂移；同日重复触发由相位机
 * 「already-evaluated-today」幂等保护。
 */
export const SENTINEL_SCAN_CRON = '10 0 * * *';

let sentinelScanJob: CronJob | null = null;

/**
 * 任务33 活动监视器注册点（注册仅此一处）。评「昨日」：生产 StatsPort
 * （broadcast 计数 + 负评价/撤回投诉）→ 相位机 → 持久化 + ⑭ 事件；
 * 降级指令经 sentinel-service 的 /process 事件闸口落地 v1。
 *
 * 业务实现懒加载：调度层不静态依赖业务层，也不成环
 * （sentinel-service → jarvis-core/sentinel，均不 import 本文件）。
 * 开关 TC_JARVIS_SENTINEL 在 sentinel-service 内读（缺省开）。幂等：重复调用
 * 返回同一任务句柄。
 */
export function startSentinelScanJob(opts: { expression?: string; timezone?: string } = {}): CronJob {
  if (sentinelScanJob) return sentinelScanJob;
  sentinelScanJob = schedule(
    opts.expression ?? SENTINEL_SCAN_CRON,
    opts.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    () => {
      void import('./sentinel-service.js')
        .then((m) => m.runSentinelDailyScan())
        .catch((err) => log.warn('活动监视器每日评估失败:', err));
    },
  );
  // 不保活进程：测试/CLI 进程不被这条 interval 挂住（stop() 亦照常可停）。
  sentinelScanJob.timer?.unref();
  return sentinelScanJob;
}

/** 停止并清空注册点（幂等；主脑若改统一启动接线可删文件尾自启，本函数保留）。 */
export function stopSentinelScanJob(): void {
  if (!sentinelScanJob) return;
  stop(sentinelScanJob);
  sentinelScanJob = null;
}

// 模块加载即注册（幂等、unref）。主脑可改为启动接线显式调用。
startSentinelScanJob();
