/**
 * jarvis-core · 感知层信号源 6/6：用户行为（任务 30 补齐第 6 路，06-11 §5）
 *
 * 采集方式：只读注入端口 UserBehaviorPort（上游「用户活动账本」快照
 * UserActivitySnapshot 的适配器由接线层注入；本模块不 import 该服务）。
 * v1 宁缺毋滥，只产一个信号 user_returned：
 *   首次采集只建基线：lastActivityAt 为空或距 now ≥ awayThresholdMs → 置「离开」态
 *   （服务器重启期间用户离开，回来时要能报），但不产信号；
 *   距上次活动 ≥ awayThresholdMs → 记「离开」（不产信号）；
 *   「离开」态下距上次活动 ≤ activeWindowMs → 用户回来了 → 产 user_returned。
 * 触发：心跳型（只对账时跑）。评分分量初始值非实测（待 ⑭ 观测 / ⑮ 标定）。
 *
 * 与 time-context 的分工（防同一次「回来」双报，2026-10-06 接线时定）：
 *   - 「离开 ≥2h + 回来时说了话」归 time-context 的 time_user_returned（它按发言时戳判定）；
 *   - 「离开 <2h（任意方式回来）」与「离开 ≥2h 但回来没说话（输入/焦点）」归本源；
 *   - 离开时长不详（重启期账本空）按语音证据回来 → 也归 time-context（信息量低，宁缺）。
 * 判定口径：本次活动距最近一次发言 ≤ activeWindowMs = 「回来即说话」（语音证据）。
 *
 * 评分与播报档位（有意选择）：urgency 40 / relevance 75 / certainty 90 →
 * 0.5*40 + 0.3*75 + 0.2*90 = 61 分：≥ relevanceThreshold(60) 不至于 SILENT
 * （「回来了」该登记，不能消失），≤ immediateScore(85) 且非 timeSensitive 则永不
 * SPEAK（「你回来了」不需要用嘴说）。注意真实公式（shared/broadcast-gates.ts
 * decideBroadcast）里 STORE 仅由预算耗尽（budget_exhausted）触发：预算充足时本信号
 * 落 PREPARE（攒批到自然开口点），预算耗尽时落 STORE（只登记）——两者都不抢即时口播。
 */

import type { RawSignal } from '../signal-queue.js';
import { isRecord, toFiniteNumber } from './safe.js';
import { DEFAULT_AWAY_THRESHOLD_MINUTES } from './time-context.js';
import {
  SENSE_SIGNAL_SOURCES,
  SENSE_TRIGGERS,
  resolveSenseEnabled,
  type Sense,
  type SenseReading,
} from './types.js';

// ============================================================================
// 类型与端口
// ============================================================================

/** 用户行为探针读数（字段形态对齐上游 UserActivitySnapshot；本模块自成契约）。 */
export interface UserBehaviorProbe {
  /** 任一类用户活动（含语音回合）的时刻；无记录 = null。 */
  lastActivityAt: number | null;
  /** 用户最近一次说话的时刻；无记录 = null。 */
  lastSpeechAt: number | null;
}

/** 可注入端口（真实适配器由接线层注入；读账本快照，不产生副作用）。 */
export interface UserBehaviorPort {
  read(now: number): UserBehaviorProbe;
}

export interface UserBehaviorSenseOptions {
  port: UserBehaviorPort;
  /** 距上次活动 ≥ 此值视为「离开」；缺省 30 分钟（初始值非实测）。 */
  awayThresholdMs?: number;
  /** 距上次活动 ≤ 此值视为「在场/刚回来」；缺省 2 分钟（初始值非实测）。 */
  activeWindowMs?: number;
  /** 取时刻函数；缺省用 collect 入参 now（两者在接线层与心跳 ctx.now 同源）。 */
  now?: () => number;
}

/** 默认「离开」阈值：30 分钟（初始值非实测，待 ⑭/⑮ 标定）。 */
export const DEFAULT_AWAY_THRESHOLD_MS = 30 * 60_000;

/** 默认「在场/刚回来」窗口：2 分钟（初始值非实测，待 ⑭/⑮ 标定）。 */
export const DEFAULT_ACTIVE_WINDOW_MS = 2 * 60_000;

/** 与 time-context 的分工线（见文件头）：≥ 此长度的离开归 time-context（复用其阈值，防两份常量漂移）。 */
const TIME_CONTEXT_AWAY_MS = DEFAULT_AWAY_THRESHOLD_MINUTES * 60_000;

// ============================================================================
// 信号源工厂
// ============================================================================

/**
 * 创建用户行为信号源（有状态：闭包持「是否处于离开态」与离开前最后活动时刻）。
 * collect 契约与其余五源一致：**永不抛出**——端口抛错/畸形数据只该源降级记因。
 */
export function createUserBehaviorSense(
  port: UserBehaviorPort,
  options: Omit<UserBehaviorSenseOptions, 'port'> = {},
): Sense {
  const enabled = resolveSenseEnabled('user-behavior', undefined);
  const awayThresholdMs = options.awayThresholdMs ?? DEFAULT_AWAY_THRESHOLD_MS;
  const activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  let wasAway = false;
  let initialized = false;
  /** 离开前最后一次活动时刻（推「离开了约 N 分钟」；null = 无记录，时长不详）。 */
  let preAwayActivityAt: number | null = null;

  const collect = async (now: number): Promise<SenseReading> => {
    if (!enabled) return { signals: [] };
    const at = options.now ? options.now() : now;

    let probe: unknown;
    try {
      probe = port.read(at);
    } catch (error) {
      return { signals: [], degraded: { reason: 'port_error', error } };
    }
    if (!isRecord(probe)) {
      return { signals: [], degraded: { reason: 'malformed_data', detail: '用户行为探针形态非法（需对象）' } };
    }
    const lastActivityAt =
      probe.lastActivityAt === null || probe.lastActivityAt === undefined ? null : toFiniteNumber(probe.lastActivityAt);
    // lastActivityAt 定「离开/回来」；lastSpeechAt 只参与与 time-context 的分工判定（见文件头）。
    const lastSpeechAt =
      probe.lastSpeechAt === null || probe.lastSpeechAt === undefined ? null : toFiniteNumber(probe.lastSpeechAt);
    if (lastActivityAt === undefined || lastSpeechAt === undefined) {
      return { signals: [], degraded: { reason: 'malformed_data', detail: '用户行为时戳非有限数值' } };
    }

    const gap = lastActivityAt === null ? Number.POSITIVE_INFINITY : at - lastActivityAt;

    // 首次采集只建基线：重启期间用户若处「离开」态，回来时要能报。
    if (!initialized) {
      initialized = true;
      wasAway = gap >= awayThresholdMs;
      if (wasAway) preAwayActivityAt = lastActivityAt;
      return { signals: [] };
    }

    // 离开（含已在离开态）：更新最后活动参照，不产信号（同一离开事件不逐心跳重复报）。
    if (gap >= awayThresholdMs) {
      wasAway = true;
      preAwayActivityAt = lastActivityAt;
      return { signals: [] };
    }

    // 回来了：离开态 + 刚有活动（窗口内）。
    if (wasAway && gap <= activeWindowMs) {
      wasAway = false;
      const awayMs =
        preAwayActivityAt !== null && lastActivityAt !== null && lastActivityAt > preAwayActivityAt
          ? lastActivityAt - preAwayActivityAt
          : null;

      // 与 time-context 的分工（见文件头）：语音证据（这次活动就是说话）+ ≥2h 长离开
      // （或时长不详）→ 归 time-context 的 time_user_returned；消离开态但不产，防双报。
      const speechEvidenced =
        lastActivityAt !== null && lastSpeechAt !== null && lastActivityAt - lastSpeechAt <= activeWindowMs;
      if (speechEvidenced && (awayMs === null || awayMs >= TIME_CONTEXT_AWAY_MS)) {
        return { signals: [] };
      }

      const minutes = awayMs === null ? null : Math.max(1, Math.round(awayMs / 60_000));
      const signal: RawSignal = {
        source: SENSE_SIGNAL_SOURCES['user-behavior'],
        kind: 'user_returned',
        ts: at,
        dedupeKey: `user-returned@${Math.floor(at / 60_000)}`,
        text: minutes === null ? '老板回来了(离开时长不详)' : `老板回来了(离开了约 ${minutes} 分钟)`,
        payload: { awayMs },
        // 评分见文件头「评分与播报档位」：61 分，只登记不抢即时口播。
        urgency: 40,
        relevance: 75,
        certainty: 90,
      };
      return { signals: [signal] };
    }

    return { signals: [] };
  };

  return {
    name: 'user-behavior',
    source: SENSE_SIGNAL_SOURCES['user-behavior'],
    trigger: SENSE_TRIGGERS['user-behavior'],
    enabled,
    collect,
  };
}
