/**
 * jarvis-core · 感知层聚合出口（任务 30，06-11 §5 工程要点）
 *
 * 职责：把各路 Sense 的归一化原始信号聚合成 09·A 契约 Signal 列表，并给每源一份
 * 采集摘要（开关/是否采集/降级原因），供 ⑦ 观测与接线层判断。
 *
 * 故障隔离（复用任务 26 collectSignalsSafely 的「永不抛出」语义）：
 * - 关闭源在聚合前剔除：不采集、不产出、不报错（独立开关的零成本语义）；
 * - 启用源逐个经 withTimeout 读取，单源抛错/超时只降级该源（failures + 摘要降级），
 *   其余源照常；
 * - 单源读数畸形/单条信号畸形：安全丢弃并给该源记因，不牵连他源；
 * - 聚合函数整体永不抛出（含注入 logger 自身抛错的病态兜底）。
 *
 * 归一化：RawSignal（ts/dedupeKey 由各源或队列补齐）→ shared/broadcast-gates 的
 * Signal；非法 source/kind 的条目按畸形丢弃并计数（normalizeSignal 会抛 TypeError）。
 *
 * 边界：本文件不 import 任何现有服务实现；不改 jarvis-core/index.ts barrel，
 * 使用方按路径直导入（如 `senses/aggregate.js`）。
 */

import type { Signal, SignalSource } from '../../../shared/broadcast-gates.js';
import { collectSignalsSafely, jarvisLogger, type JarvisLogger, type ObserveFailure } from '../executors.js';
import { normalizeSignal, type RawSignal } from '../signal-queue.js';
import { DEFAULT_SENSE_TIMEOUT_MS, SenseTimeoutError, guardLogger, isRecord, withTimeout } from './safe.js';
import {
  SENSE_NAMES,
  SENSE_SIGNAL_SOURCES,
  SENSE_TRIGGERS,
  type Sense,
  type SenseDegradeReason,
  type SenseName,
  type SenseTrigger,
} from './types.js';
// 六源工厂（user-behavior 传端口才装配，见 createDefaultSenses）
import { createAgentStateSense, type AgentStatePort } from './agent-state.js';
import { createSystemHealthSense, type SystemHealthPort } from './system-health.js';
import { createProjectEventsSense, type ProjectEventsPort } from './project-events.js';
import { createTimeContextSense, type TimeContextPort } from './time-context.js';
import { createMemorySignalsSense, type MemorySignalsPort } from './memory-signals.js';
import { createUserBehaviorSense, type UserBehaviorPort } from './user-behavior.js';

// ============================================================================
// 类型
// ============================================================================

/** 单源采集摘要（观测/测试断言用）。 */
export interface SenseSummary {
  name: SenseName;
  source: SignalSource;
  trigger: SenseTrigger;
  enabled: boolean;
  /** 是否成功取得读数（关闭 / 读取失败 = false）。 */
  collected: boolean;
  /** 本源归一化后入包的信号条数。 */
  signalCount: number;
  /** 本源被丢弃的畸形信号条数（含读数整体畸形）。 */
  malformedCount: number;
  degraded: boolean;
  degradeReason?: SenseDegradeReason;
  detail?: string;
}

export interface SenseCollection {
  /** 归一化后的 09·A 信号（可直接 SignalQueue.enqueue/consume 消费）。 */
  signals: Signal[];
  /** 每源摘要（按传入顺序）。 */
  readings: SenseSummary[];
  /** 逐源读取失败（对齐 collectSignalsSafely 的 failures）。 */
  failures: ObserveFailure[];
  /** 任一源降级/失败（观测用；不代表聚合函数失败）。 */
  degraded: boolean;
}

export interface SenseCollectionOptions {
  /** 判定时刻（epoch ms，显式注入；与心跳 ctx.now 同源）。 */
  now: number;
  /** 单源超时（ms）；默认 DEFAULT_SENSE_TIMEOUT_MS（5s，初始值非实测）。 */
  timeoutMs?: number;
  logger?: JarvisLogger;
  /** 逐源失败钩子（对齐 collectSignalsSafely）；钩子自身抛错被隔离。 */
  onSourceError?: (failure: ObserveFailure) => void;
}

const DEGRADE_REASONS: readonly SenseDegradeReason[] = ['port_not_wired', 'port_error', 'malformed_data', 'timeout'];

function isSenseDegradeReason(value: unknown): value is SenseDegradeReason {
  return typeof value === 'string' && (DEGRADE_REASONS as readonly string[]).includes(value);
}

function errorOfDegrade(value: unknown): unknown {
  return isRecord(value) && 'error' in value ? value.error : undefined;
}

/** 失败原因归类：带超时标记 → timeout；其余 → port_error。 */
function reasonOfFailure(error: unknown): SenseDegradeReason {
  if (error instanceof SenseTimeoutError) return 'timeout';
  if (isRecord(error) && error.code === 'sense-timeout') return 'timeout';
  return 'port_error';
}

function detailOfError(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return undefined;
  }
}

/** 内部：collectSignalsSafely 的逐源包装（标签化保证摘要关联稳定）。 */
interface TaggedReading {
  sense: Sense;
  reading: unknown;
}

// ============================================================================
// 聚合出口
// ============================================================================

/**
 * 逐源隔离地采集并归一化。**永不抛出**；单源失败只在该源摘要（与 failures）体现。
 */
export async function collectSensesSafely(
  senses: readonly Sense[],
  options: SenseCollectionOptions,
): Promise<SenseCollection> {
  const logger = guardLogger(options.logger ?? jarvisLogger);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SENSE_TIMEOUT_MS;
  const signals: Signal[] = [];
  const failures: ObserveFailure[] = [];
  const summaries = new Map<Sense, SenseSummary>();
  for (const sense of senses) {
    summaries.set(sense, {
      name: sense.name,
      source: sense.source,
      trigger: sense.trigger,
      enabled: sense.enabled,
      collected: false,
      signalCount: 0,
      malformedCount: 0,
      degraded: false,
    });
  }

  const active = senses.filter((sense) => sense.enabled);
  let tagged: TaggedReading[] = [];
  if (active.length > 0) {
    try {
      const sources = active.map((sense) => ({
        name: sense.name,
        read: async (): Promise<TaggedReading> => ({
          sense,
          reading: await withTimeout(sense.collect(options.now), timeoutMs, sense.name),
        }),
      }));
      const outcome = await collectSignalsSafely<TaggedReading>(sources, {
        logger,
        ...(options.onSourceError ? { onSourceError: options.onSourceError } : {}),
      });
      tagged = outcome.signals;
      for (const failure of outcome.failures) failures.push(failure);
    } catch (error) {
      // 病态兜底（26 契约下不应发生；logger 已 guardLogger 防护，此处为最后一道保险）：
      // 逐源降级，绝不上抛。
      for (const sense of active) failures.push({ source: sense.name, error });
      logger.error('感知层聚合异常（已兜底，逐源降级）:', error);
    }
  }

  for (const sense of senses) {
    const summary = summaries.get(sense)!;
    if (!sense.enabled) continue; // 关闭源：零采集、零产出、零报错

    const item = tagged.find((candidate) => candidate.sense === sense);
    if (!item) {
      const failure = failures.find((candidate) => candidate.source === sense.name);
      summary.degraded = true;
      summary.degradeReason = reasonOfFailure(failure?.error);
      summary.detail = detailOfError(failure?.error) ?? '未取得读数（逐源降级）';
      continue;
    }

    const reading = item.reading;
    if (!isRecord(reading) || !Array.isArray(reading.signals)) {
      summary.degraded = true;
      summary.degradeReason = 'malformed_data';
      summary.detail = '采集读数形态非法（缺 signals 数组）';
      summary.malformedCount++;
      continue;
    }
    summary.collected = true;

    const before = signals.length;
    for (const raw of reading.signals) {
      try {
        signals.push(normalizeSignal(raw as RawSignal, options.now));
      } catch {
        // 单条畸形信号安全丢弃，只影响本源计数（不牵连其余信号/其余源）
        summary.malformedCount++;
      }
    }
    summary.signalCount = signals.length - before;

    const degrade = isRecord(reading.degraded) ? reading.degraded : undefined;
    if (degrade && isSenseDegradeReason(degrade.reason)) {
      summary.degraded = true;
      summary.degradeReason = degrade.reason;
      const detail = typeof degrade.detail === 'string' ? degrade.detail : undefined;
      const errorDetail = detailOfError(errorOfDegrade(degrade));
      summary.detail = detail ?? errorDetail;
    } else if (summary.malformedCount > 0) {
      summary.degraded = true;
      summary.degradeReason = 'malformed_data';
      summary.detail = `丢弃畸形信号 ${summary.malformedCount} 条`;
    }
  }

  return {
    signals,
    readings: senses.map((sense) => summaries.get(sense)!),
    failures,
    degraded: [...summaries.values()].some((summary) => summary.degraded),
  };
}

// ============================================================================
// 默认装配（5 源 + 可选第 6 路 user-behavior；接线层可覆盖各端口）
// ============================================================================

export interface DefaultSensesOptions {
  logger?: JarvisLogger;
  /** 开关判定环境（测试）；缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
  agentStatePort?: AgentStatePort;
  agentStateScope?: 'important' | 'all';
  systemHealthPort?: SystemHealthPort;
  projectEventsPort?: ProjectEventsPort;
  timeContextPort?: TimeContextPort;
  memorySignalsPort?: MemorySignalsPort;
  /** 第 6 路用户行为端口；不传则不注册该源（保持既有五源装配的向后兼容）。 */
  userBehaviorPort?: UserBehaviorPort;
}

/**
 * 默认装配（源顺序 = SENSE_NAMES 前五路 + 可选 user-behavior）。端口缺省 = 各源自行
 * 登记「接线延后」；生产接线层可就地覆盖任一端口，不动源模块。
 */
export function createDefaultSenses(options: DefaultSensesOptions = {}): Sense[] {
  const senses: Sense[] = [
    createAgentStateSense({
      logger: options.logger,
      env: options.env,
      port: options.agentStatePort,
      scope: options.agentStateScope,
    }),
    createSystemHealthSense({ logger: options.logger, env: options.env, port: options.systemHealthPort }),
    createProjectEventsSense({ logger: options.logger, env: options.env, port: options.projectEventsPort }),
    createTimeContextSense({ logger: options.logger, env: options.env, port: options.timeContextPort }),
    createMemorySignalsSense({ logger: options.logger, env: options.env, port: options.memorySignalsPort }),
  ];
  // 第 6 路：只有接线层提供端口才装配（活动账本适配器由主控注入）。
  if (options.userBehaviorPort) senses.push(createUserBehaviorSense(options.userBehaviorPort));
  return senses;
}

/** 规范源顺序的只读快照（对外暴露，便于接线层/测试断言覆盖完整）。 */
export const DEFAULT_SENSE_NAMES = [...SENSE_NAMES] as readonly SenseName[];

/** 六源名 → 类别映射（只读再导出，接线层免二次 import types）。 */
export const DEFAULT_SENSE_SOURCES = { ...SENSE_SIGNAL_SOURCES } as Readonly<Record<SenseName, SignalSource>>;

/** 六源名 → 触发形态映射（只读再导出）。 */
export const DEFAULT_SENSE_TRIGGERS = { ...SENSE_TRIGGERS } as Readonly<Record<SenseName, SenseTrigger>>;
