/**
 * jarvis-core · 感知层信号源 4/6：时间上下文（任务 30，06-11 §5）
 *
 * 采集项：时段（deep-night/early-morning/morning/afternoon/evening）、工作日/周末、
 * 距上次用户说话时长。触发：心跳型（只在对账时跑）。
 *
 * 纯函数 readTimeContext 由注入时刻（now）计算，不读进程时钟；「距上次用户说话」
 * 经端口 TimeContextPort.lastUserSpeechAt() 注入（语音链路的 client 上报通道待接线）。
 * 产出信号（首次采集只建基线，不报时段/周末变化）：
 *   time_period_changed  时段跨段（dedupeKey 按 目标时段+本地日 → 同日幂等）
 *   time_weekend_changed 工作日↔周末切换
 *   time_user_away_long  距上次说话 ≥ 2h（初始值非实测；按该次发言时戳幂等）
 *   time_user_returned   长时间离开后用户再次说话（按新发言时戳幂等）
 * 评分分量初始值非实测（待 ⑭ 观测 / ⑮ 标定）。
 *
 * 端口缺省 = 时段/周末照常产出，仅「距上次说话」能力降级 + degraded('port_not_wired')。
 */

import type { RawSignal } from '../signal-queue.js';
import type { JarvisLogger } from '../executors.js';
import { createOnceLogger, localDayKey, localMinutesOfDay, toFiniteNumber } from './safe.js';
import {
  SENSE_SIGNAL_SOURCES,
  SENSE_TRIGGERS,
  resolveSenseEnabled,
  type Sense,
  type SenseDegrade,
  type SenseReading,
} from './types.js';

// ============================================================================
// 端口与读数
// ============================================================================

/** 可注入端口：最近一次用户说话时刻（epoch ms）；无记录返回 null。 */
export interface TimeContextPort {
  lastUserSpeechAt: () => number | null | undefined | Promise<number | null | undefined>;
}

export type DayPeriod = 'deep-night' | 'early-morning' | 'morning' | 'afternoon' | 'evening';

/** 时段边界（本地时间，分钟）：深夜 [23:00,05:00) 跨午夜。 */
export const PERIOD_BOUNDARIES = {
  earlyMorningStart: 5 * 60,
  morningStart: 8 * 60,
  afternoonStart: 12 * 60,
  eveningStart: 18 * 60,
  deepNightStart: 23 * 60,
} as const;

const PERIOD_LABELS: Readonly<Record<DayPeriod, string>> = {
  'deep-night': '深夜',
  'early-morning': '清晨',
  morning: '上午',
  afternoon: '下午',
  evening: '晚间',
};

export function periodOfMinutes(minutes: number): DayPeriod {
  if (minutes >= PERIOD_BOUNDARIES.deepNightStart || minutes < PERIOD_BOUNDARIES.earlyMorningStart) return 'deep-night';
  if (minutes < PERIOD_BOUNDARIES.morningStart) return 'early-morning';
  if (minutes < PERIOD_BOUNDARIES.afternoonStart) return 'morning';
  if (minutes < PERIOD_BOUNDARIES.eveningStart) return 'afternoon';
  return 'evening';
}

export interface TimeContextReading {
  at: number;
  period: DayPeriod;
  isWeekend: boolean;
  /** 距上次用户说话分钟数（无记录/未来时戳 → null）；未来时戳按 0 处理。 */
  minutesSinceLastUserSpeech: number | null;
}

/** 纯函数：由显式时刻与上次发言时戳计算时间上下文读数（不读时钟）。 */
export function readTimeContext(now: number, lastUserSpeechAt: number | null): TimeContextReading {
  const d = new Date(now);
  const day = d.getDay();
  const minutesSinceLastUserSpeech =
    lastUserSpeechAt === null ? null : Math.max(0, Math.floor((now - lastUserSpeechAt) / 60_000));
  return {
    at: now,
    period: periodOfMinutes(localMinutesOfDay(now)),
    isWeekend: day === 0 || day === 6,
    minutesSinceLastUserSpeech,
  };
}

// ============================================================================
// 信号构造（评分分量初始值非实测）
// ============================================================================

export interface TimeContextSenseOptions {
  /** 独立开关；缺省读 TC_JARVIS_SENSE_TIME_CONTEXT（缺省开）。 */
  enabled?: boolean;
  /** 上次发言端口；缺省 = 该能力未接线（时段能力不受影响）。 */
  port?: TimeContextPort;
  /** 「离开很久」阈值（分钟）；默认 120（初始值非实测）。 */
  awayThresholdMinutes?: number;
  logger?: JarvisLogger;
  /** 开关判定用环境（测试）；缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
}

/** 默认「离开很久」阈值：120 分钟（初始值非实测，待 ⑭/⑮ 标定）。 */
export const DEFAULT_AWAY_THRESHOLD_MINUTES = 120;

// ============================================================================
// 信号源工厂
// ============================================================================

/** 创建时间上下文信号源（有状态：保留上次读数与已报离开的发言时戳）。 */
export function createTimeContextSense(options: TimeContextSenseOptions = {}): Sense {
  const enabled = resolveSenseEnabled('time-context', options.enabled, options.env);
  const awayThresholdMinutes = options.awayThresholdMinutes ?? DEFAULT_AWAY_THRESHOLD_MINUTES;
  const logOnce = createOnceLogger(options.logger);
  let previous: TimeContextReading | null = null;
  let awayReportedFor: number | null = null;
  /** 观察到的最新发言时戳（端口返回 null 时保留旧值，用于检测「再次说话」）。 */
  let lastSpeechSeen: number | null = null;

  const collect = async (now: number): Promise<SenseReading> => {
    if (!enabled) return { signals: [] };

    let degraded: SenseDegrade | undefined;
    let lastUserSpeechAt: number | null = null;

    if (!options.port) {
      degraded = { reason: 'port_not_wired', detail: '距上次用户说话通道未接（语音链路 client 上报待接线）' };
      logOnce('warn', 'port_not_wired', '时间上下文源：距上次说话通道未接（时段能力照常）');
    } else {
      try {
        const raw = await options.port.lastUserSpeechAt();
        if (raw === null || raw === undefined) {
          lastUserSpeechAt = null;
        } else {
          const value = toFiniteNumber(raw);
          if (value === undefined) {
            degraded = { reason: 'malformed_data', detail: '上次发言时戳非有限数值' };
          } else {
            lastUserSpeechAt = value;
          }
        }
      } catch (error) {
        degraded = { reason: 'port_error', error };
        logOnce('error', 'port_error', '时间上下文源读取上次发言失败（隔离，时段照常）:', error);
      }
    }

    const reading = readTimeContext(now, lastUserSpeechAt);
    const prev = previous;
    previous = reading;
    const dayKey = localDayKey(now);
    const signals: RawSignal[] = [];

    // 首次采集只建基线（时段/周末变化需要前值对比）。
    if (prev) {
      if (prev.period !== reading.period) {
        signals.push({
          source: SENSE_SIGNAL_SOURCES['time-context'],
          kind: 'time_period_changed',
          ts: now,
          dedupeKey: `time-period:${reading.period}@${dayKey}`,
          text: `时段进入${PERIOD_LABELS[reading.period]}（${reading.period}）`,
          payload: { from: prev.period, to: reading.period },
          urgency: 30,
          relevance: 60,
          certainty: 90,
        });
      }
      if (prev.isWeekend !== reading.isWeekend) {
        signals.push({
          source: SENSE_SIGNAL_SOURCES['time-context'],
          kind: 'time_weekend_changed',
          ts: now,
          dedupeKey: `time-weekend:${reading.isWeekend ? 'weekend' : 'workday'}@${dayKey}`,
          text: reading.isWeekend ? '进入周末' : '进入工作日',
          payload: { isWeekend: reading.isWeekend },
          urgency: 30,
          relevance: 60,
          certainty: 95,
        });
      }
    }

    const minutes = reading.minutesSinceLastUserSpeech;
    if (minutes !== null && lastUserSpeechAt !== null) {
      // 距离很久：按该次发言时戳幂等（同一离开事件不逐心跳重复产信号）。
      if (minutes >= awayThresholdMinutes && awayReportedFor !== lastUserSpeechAt) {
        awayReportedFor = lastUserSpeechAt;
        signals.push({
          source: SENSE_SIGNAL_SOURCES['time-context'],
          kind: 'time_user_away_long',
          ts: now,
          dedupeKey: `time-away:${lastUserSpeechAt}`,
          text: `用户已约 ${minutes} 分钟未说话`,
          payload: { minutes, lastUserSpeechAt },
          urgency: 45,
          relevance: 70,
          certainty: 80,
        });
      }
      // 长时间离开后再次说话：上轮读数已处于「离开」态，且发言时戳向前更新。
      if (
        prev &&
        prev.minutesSinceLastUserSpeech !== null &&
        prev.minutesSinceLastUserSpeech >= awayThresholdMinutes &&
        lastSpeechSeen !== null &&
        lastUserSpeechAt > lastSpeechSeen
      ) {
        signals.push({
          source: SENSE_SIGNAL_SOURCES['time-context'],
          kind: 'time_user_returned',
          ts: now,
          dedupeKey: `time-return:${lastUserSpeechAt}`,
          text: '用户回来了（长时间离开后再次说话）',
          payload: { lastUserSpeechAt },
          urgency: 55,
          relevance: 70,
          certainty: 70,
        });
      }
      lastSpeechSeen = lastUserSpeechAt;
    }

    return { signals, ...(degraded ? { degraded } : {}) };
  };

  return {
    name: 'time-context',
    source: SENSE_SIGNAL_SOURCES['time-context'],
    trigger: SENSE_TRIGGERS['time-context'],
    enabled,
    collect,
  };
}
