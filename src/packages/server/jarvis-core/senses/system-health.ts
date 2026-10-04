/**
 * jarvis-core · 感知层信号源 2/6：系统健康（任务 30，06-11 §5）
 *
 * 采集项：磁盘剩余 / 服务进程存活 / 日志错误关键词 / 后台任务失败。
 * 触发：心跳 15min + 事件（由接线层决定对账/即时唤醒）。
 *
 * 端口 SystemHealthPort.probe() 注入原始体检数据；本模块只做阈值判定与归一化。
 * 阈值全部为初始值非实测（⑧ 回写 06-12 §8.2 待 ⑭ 观测 / ⑮ 标定）：
 *   磁盘剩余 < 10%            → disk_low
 *   服务 alive=false          → service_down
 *   日志错误数 ≥ 5（窗口内）  → log_error_burst
 *   后台任务 state=failed/error → background_task_failed
 * 同源去重按 dedupeWindowMs（默认 6h）分桶，持续故障不逐心跳刷屏；后台任务优先用
 * 任务 id 作稳定键（无 id 用时刻占位）。
 *
 * 生产通道接线延后（只读候选，未接线）：磁盘/进程探测、data/system-log.ts 的
 * querySystemLog/countSystemLog、services/background-tasks.ts。缺省端口 =
 * 空读数 + degraded('port_not_wired')。
 */

import type { RawSignal } from '../signal-queue.js';
import type { JarvisLogger } from '../executors.js';
import { createOnceLogger, isRecord, toFiniteNumber, toNonEmptyString } from './safe.js';
import {
  SENSE_SIGNAL_SOURCES,
  SENSE_TRIGGERS,
  resolveSenseEnabled,
  type Sense,
  type SenseDegrade,
  type SenseReading,
} from './types.js';

// ============================================================================
// 端口数据类型
// ============================================================================

export interface DiskProbe {
  /** 挂载点/盘符（日志与去重键用）。 */
  mount: string;
  /** 剩余百分比（0–100）；缺省时可由 freeBytes/totalBytes 推算。 */
  freePercent?: number;
  freeBytes?: number;
  totalBytes?: number;
}

export interface ServiceProbe {
  name: string;
  alive: boolean;
}

export interface LogErrorProbe {
  /** 观测窗口内错误日志条数。 */
  recentCount: number;
  /** 命中的错误关键词（展示用）。 */
  keywords?: readonly string[];
}

export interface BackgroundTaskProbe {
  id?: string;
  name: string;
  /** 任务状态；命中的失败态：'failed' | 'error'。 */
  state: string;
  error?: string;
  at?: number;
}

/** 一次系统体检读数（各段可选；缺段即不产生该类信号）。 */
export interface SystemHealthProbe {
  disks?: readonly DiskProbe[];
  services?: readonly ServiceProbe[];
  logErrors?: LogErrorProbe;
  backgroundTasks?: readonly BackgroundTaskProbe[];
}

/** 可注入端口（测试注入 mock；生产通道接线延后）。 */
export interface SystemHealthPort {
  probe: () => SystemHealthProbe | Promise<SystemHealthProbe>;
}

// ============================================================================
// 阈值（初始值非实测，⑧ 回写 06-12 §8.2）
// ============================================================================

export interface SystemHealthThresholds {
  /** 磁盘剩余低于它报警（%）。 */
  diskLowFreePercent: number;
  /** 窗口内错误日志达到它报警（条）。 */
  logErrorBurstCount: number;
  /** 同类信号去重分桶宽度（ms）：持续故障每桶最多一条。 */
  dedupeWindowMs: number;
}

/** 默认阈值：磁盘 10% / 日志 5 条 / 去重桶 6 小时（均初始值非实测）。 */
export const DEFAULT_SYSTEM_HEALTH_THRESHOLDS: SystemHealthThresholds = {
  diskLowFreePercent: 10,
  logErrorBurstCount: 5,
  dedupeWindowMs: 6 * 60 * 60 * 1000,
};

export interface SystemHealthSenseOptions {
  /** 独立开关；缺省读 TC_JARVIS_SENSE_SYSTEM_HEALTH（缺省开）。 */
  enabled?: boolean;
  /** 体检端口；缺省 = 未接线（安全缺省 + 记因）。 */
  port?: SystemHealthPort;
  /** 阈值覆盖（部分字段）。 */
  thresholds?: Partial<SystemHealthThresholds>;
  logger?: JarvisLogger;
  /** 开关判定用环境（测试）；缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
}

// ============================================================================
// 归一化（畸形数据安全丢弃）
// ============================================================================

interface NormalizedProbe {
  disks: DiskProbe[];
  services: ServiceProbe[];
  logErrors: LogErrorProbe | null;
  backgroundTasks: BackgroundTaskProbe[];
  malformedCount: number;
}

function normalizeSystemHealthProbe(raw: unknown): NormalizedProbe {
  if (!isRecord(raw)) throw new TypeError('系统体检读数形态非法（需普通对象）');
  let malformedCount = 0;

  const disks: DiskProbe[] = [];
  if (raw.disks !== undefined) {
    if (!Array.isArray(raw.disks)) {
      malformedCount++;
    } else {
      for (const item of raw.disks) {
        if (!isRecord(item)) {
          malformedCount++;
          continue;
        }
        const mount = toNonEmptyString(item.mount);
        const freePercent = toFiniteNumber(item.freePercent);
        const freeBytes = toFiniteNumber(item.freeBytes);
        const totalBytes = toFiniteNumber(item.totalBytes);
        if (!mount || (freePercent === undefined && !(freeBytes !== undefined && totalBytes !== undefined && totalBytes > 0))) {
          malformedCount++;
          continue;
        }
        disks.push({ mount, freePercent, freeBytes, totalBytes });
      }
    }
  }

  const services: ServiceProbe[] = [];
  if (raw.services !== undefined) {
    if (!Array.isArray(raw.services)) {
      malformedCount++;
    } else {
      for (const item of raw.services) {
        if (!isRecord(item) || !toNonEmptyString(item.name) || typeof item.alive !== 'boolean') {
          malformedCount++;
          continue;
        }
        services.push({ name: toNonEmptyString(item.name)!, alive: item.alive });
      }
    }
  }

  let logErrors: LogErrorProbe | null = null;
  if (raw.logErrors !== undefined) {
    if (!isRecord(raw.logErrors) || toFiniteNumber(raw.logErrors.recentCount) === undefined) {
      malformedCount++;
    } else {
      const keywords = Array.isArray(raw.logErrors.keywords)
        ? raw.logErrors.keywords.map((k) => toNonEmptyString(k)).filter((k): k is string => k !== undefined)
        : undefined;
      logErrors = { recentCount: toFiniteNumber(raw.logErrors.recentCount)!, ...(keywords ? { keywords } : {}) };
    }
  }

  const backgroundTasks: BackgroundTaskProbe[] = [];
  if (raw.backgroundTasks !== undefined) {
    if (!Array.isArray(raw.backgroundTasks)) {
      malformedCount++;
    } else {
      for (const item of raw.backgroundTasks) {
        if (!isRecord(item) || !toNonEmptyString(item.name) || !toNonEmptyString(item.state)) {
          malformedCount++;
          continue;
        }
        backgroundTasks.push({
          name: toNonEmptyString(item.name)!,
          state: toNonEmptyString(item.state)!,
          id: toNonEmptyString(item.id),
          error: toNonEmptyString(item.error),
          at: toFiniteNumber(item.at),
        });
      }
    }
  }

  return { disks, services, logErrors, backgroundTasks, malformedCount };
}

/** 磁盘剩余百分比：优先 freePercent，其次 freeBytes/totalBytes 推算；无据返回 null。 */
export function diskFreePercentOf(disk: DiskProbe): number | null {
  if (typeof disk.freePercent === 'number' && Number.isFinite(disk.freePercent)) return disk.freePercent;
  const free = toFiniteNumber(disk.freeBytes);
  const total = toFiniteNumber(disk.totalBytes);
  if (free === undefined || total === undefined || total <= 0) return null;
  return (free / total) * 100;
}

// ============================================================================
// 信号构造（评分分量初始值非实测，待 ⑭/⑮ 标定）
// ============================================================================

function diskSignal(disk: DiskProbe, freePercent: number, now: number, bucket: number): RawSignal {
  const pct = Math.round(freePercent * 10) / 10;
  return {
    source: SENSE_SIGNAL_SOURCES['system-health'],
    kind: 'system_disk_low',
    ts: now,
    dedupeKey: `system-health:disk_low:${disk.mount}@${bucket}`,
    text: `磁盘 ${disk.mount} 剩余 ${pct}%`,
    payload: { mount: disk.mount, freePercent: pct },
    urgency: 85,
    relevance: 75,
    certainty: 85,
  };
}

// ============================================================================
// 信号源工厂
// ============================================================================

/** 创建系统健康信号源（无状态：每次 collect 独立体检）。 */
export function createSystemHealthSense(options: SystemHealthSenseOptions = {}): Sense {
  const enabled = resolveSenseEnabled('system-health', options.enabled, options.env);
  const thresholds: SystemHealthThresholds = { ...DEFAULT_SYSTEM_HEALTH_THRESHOLDS, ...options.thresholds };
  const logOnce = createOnceLogger(options.logger);

  const collect = async (now: number): Promise<SenseReading> => {
    if (!enabled) return { signals: [] };
    if (!options.port) {
      logOnce('warn', 'port_not_wired', '系统健康源未接线：跳过采集（登记为生产通道接线延后）');
      return {
        signals: [],
        degraded: { reason: 'port_not_wired', detail: '系统体检端口未接（磁盘/进程/日志/后台任务通道待接线）' },
      };
    }

    let raw: unknown;
    try {
      raw = await options.port.probe();
    } catch (error) {
      logOnce('error', 'port_error', '系统健康源体检失败（隔离，不吞循环）:', error);
      return { signals: [], degraded: { reason: 'port_error', error } };
    }

    let probe: NormalizedProbe;
    try {
      probe = normalizeSystemHealthProbe(raw);
    } catch (error) {
      logOnce('error', 'malformed', '系统健康源体检读数形态非法（隔离）:', error);
      return { signals: [], degraded: { reason: 'malformed_data', detail: '体检读数形态非法', error } };
    }

    const bucket = Math.floor(now / thresholds.dedupeWindowMs);
    const signals: RawSignal[] = [];

    for (const disk of probe.disks) {
      const freePercent = diskFreePercentOf(disk);
      if (freePercent !== null && freePercent < thresholds.diskLowFreePercent) {
        signals.push(diskSignal(disk, freePercent, now, bucket));
      }
    }

    for (const service of probe.services) {
      if (!service.alive) {
        signals.push({
          source: SENSE_SIGNAL_SOURCES['system-health'],
          kind: 'system_service_down',
          ts: now,
          dedupeKey: `system-health:service_down:${service.name}@${bucket}`,
          text: `服务 ${service.name} 未存活`,
          payload: { service: service.name },
          urgency: 90,
          relevance: 80,
          certainty: 95,
        });
      }
    }

    if (probe.logErrors && probe.logErrors.recentCount >= thresholds.logErrorBurstCount) {
      const keywords = probe.logErrors.keywords?.join('/');
      signals.push({
        source: SENSE_SIGNAL_SOURCES['system-health'],
        kind: 'system_log_error_burst',
        ts: now,
        dedupeKey: `system-health:log_error_burst@${bucket}`,
        text: `日志错误 ${probe.logErrors.recentCount} 条${keywords ? `（${keywords}）` : ''}`,
        payload: { count: probe.logErrors.recentCount, keywords: probe.logErrors.keywords ?? [] },
        urgency: 80,
        relevance: 70,
        certainty: 70,
      });
    }

    for (const task of probe.backgroundTasks) {
      const state = task.state.toLowerCase();
      if (state !== 'failed' && state !== 'error') continue;
      const at = task.at ?? now;
      signals.push({
        source: SENSE_SIGNAL_SOURCES['system-health'],
        kind: 'system_background_task_failed',
        ts: now,
        dedupeKey: task.id
          ? `system-health:background_task_failed:${task.id}`
          : `system-health:background_task_failed:${task.name}@${at}`,
        text: `后台任务失败：${task.name}${task.error ? `（${task.error}）` : ''}`,
        payload: { name: task.name, state: task.state, ...(task.id ? { id: task.id } : {}) },
        urgency: 80,
        relevance: 75,
        certainty: 90,
      });
    }

    const degraded: SenseDegrade | undefined =
      probe.malformedCount > 0
        ? { reason: 'malformed_data', detail: `丢弃畸形体检条目 ${probe.malformedCount} 条` }
        : undefined;
    return { signals, ...(degraded ? { degraded } : {}) };
  };

  return {
    name: 'system-health',
    source: SENSE_SIGNAL_SOURCES['system-health'],
    trigger: SENSE_TRIGGERS['system-health'],
    enabled,
    collect,
  };
}
