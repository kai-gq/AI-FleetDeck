/**
 * jarvis-core · 感知层信号源 6/6：记忆信号（任务 30，06-11 §5）
 *
 * 采集项：待办到期 / 承诺未兑现 / 知识缺口（由记忆层暴露）。触发：心跳 + 事件。
 * 端口 MemorySignalsPort.read() 注入候选（生产候选：任务 13 Bolba 到期扫描已
 * 在役——不重复接管；任务 27 memory stack 的承诺/知识缺口暴露待接线）。
 *
 * 三类映射与评分（初始值非实测，待 ⑭ 观测 / ⑮ 标定）：
 *   due            → memory_task_due        85/80/95 + timeSensitive（对齐任务 13 口径，
 *                    86 分 = 立即口播）
 *   promise_unkept → memory_promise_unkept  70/75/85（78 分攒批）
 *   knowledge_gap  → memory_knowledge_gap   40/65/60（55 分沉默）
 *
 * 去重：端口自带 dedupeKey 优先（如任务 13 的按日扫描键）；缺省
 * `memory-{kind}:{itemId|all}@{本地日}` —— 同日同类同条幂等，防心跳重复产信号。
 * 端口缺省 = 空读数 + degraded('port_not_wired')。
 */

import type { RawSignal } from '../signal-queue.js';
import type { JarvisLogger } from '../executors.js';
import { createOnceLogger, isRecord, localDayKey, toFiniteNumber, toNonEmptyString } from './safe.js';
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

export type MemorySignalKind = 'due' | 'promise_unkept' | 'knowledge_gap';

export const MEMORY_SIGNAL_KINDS: readonly MemorySignalKind[] = ['due', 'promise_unkept', 'knowledge_gap'];

/** 端口投递的一条记忆信号候选。 */
export interface MemorySignalInput {
  kind: MemorySignalKind;
  /** 条目稳定标识（任务 id / 承诺 id / 知识条目 id）；缺省 = 该类的聚合项。 */
  itemId?: string;
  text?: string;
  /** 事件发生时刻（epoch ms）；仅用于缺省键同刻去重，不覆盖采集 ts。 */
  at?: number;
  /** 稳定幂等键（建议由记忆层提供）；缺省按日分桶。 */
  dedupeKey?: string;
  payload?: unknown;
}

/** 可注入端口（测试注入 mock；生产通道接线延后）。 */
export interface MemorySignalsPort {
  read: () => readonly MemorySignalInput[] | Promise<readonly MemorySignalInput[]>;
}

// ============================================================================
// 映射表
// ============================================================================

interface MemorySignalSpec {
  kind: string;
  urgency: number;
  relevance: number;
  certainty: number;
  timeSensitive: boolean;
  label: string;
}

export const MEMORY_SIGNAL_SPECS: Readonly<Record<MemorySignalKind, MemorySignalSpec>> = {
  due: { kind: 'memory_task_due', urgency: 85, relevance: 80, certainty: 95, timeSensitive: true, label: '待办到期' },
  promise_unkept: { kind: 'memory_promise_unkept', urgency: 70, relevance: 75, certainty: 85, timeSensitive: false, label: '承诺未兑现' },
  knowledge_gap: { kind: 'memory_knowledge_gap', urgency: 40, relevance: 65, certainty: 60, timeSensitive: false, label: '知识缺口' },
};

export function isMemorySignalKind(value: unknown): value is MemorySignalKind {
  return typeof value === 'string' && (MEMORY_SIGNAL_KINDS as readonly string[]).includes(value);
}

// ============================================================================
// 归一化与信号构造
// ============================================================================

interface NormalizedMemorySignals {
  items: MemorySignalInput[];
  malformedCount: number;
}

function normalizeMemorySignals(raw: unknown): NormalizedMemorySignals {
  if (!Array.isArray(raw)) throw new TypeError('记忆信号读数形态非法（需数组）');
  const items: MemorySignalInput[] = [];
  let malformedCount = 0;
  for (const item of raw) {
    if (!isRecord(item) || !isMemorySignalKind(item.kind)) {
      malformedCount++;
      continue;
    }
    items.push({
      kind: item.kind,
      itemId: toNonEmptyString(item.itemId),
      text: toNonEmptyString(item.text),
      at: toFiniteNumber(item.at),
      dedupeKey: toNonEmptyString(item.dedupeKey),
      payload: item.payload,
    });
  }
  return { items, malformedCount };
}

/** 候选 → 09·A 原始信号（评分见 MEMORY_SIGNAL_SPECS）。 */
export function signalForMemorySignal(input: MemorySignalInput, now: number): RawSignal {
  const spec = MEMORY_SIGNAL_SPECS[input.kind];
  const item = input.itemId ?? 'all';
  return {
    source: SENSE_SIGNAL_SOURCES['memory-signals'],
    kind: spec.kind,
    ts: now,
    dedupeKey: input.dedupeKey ?? `memory-${input.kind}:${item}@${localDayKey(now)}`,
    text: input.text ?? `${spec.label}:${item}`,
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    urgency: spec.urgency,
    relevance: spec.relevance,
    certainty: spec.certainty,
    ...(spec.timeSensitive ? { timeSensitive: true } : {}),
  };
}

// ============================================================================
// 信号源工厂
// ============================================================================

export interface MemorySignalsSenseOptions {
  /** 独立开关；缺省读 TC_JARVIS_SENSE_MEMORY_SIGNALS（缺省开）。 */
  enabled?: boolean;
  /** 数据端口；缺省 = 未接线（安全缺省 + 记因）。 */
  port?: MemorySignalsPort;
  logger?: JarvisLogger;
  /** 开关判定用环境（测试）；缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
}

/** 创建记忆信号源（无状态：每次 read 独立归一化）。 */
export function createMemorySignalsSense(options: MemorySignalsSenseOptions = {}): Sense {
  const enabled = resolveSenseEnabled('memory-signals', options.enabled, options.env);
  const logOnce = createOnceLogger(options.logger);

  const collect = async (now: number): Promise<SenseReading> => {
    if (!enabled) return { signals: [] };
    if (!options.port) {
      logOnce('warn', 'port_not_wired', '记忆信号源未接线：跳过采集（登记为生产通道接线延后）');
      return {
        signals: [],
        degraded: { reason: 'port_not_wired', detail: '记忆信号端口未接（到期已在任务 13 在役；承诺/知识缺口待任务 27 暴露）' },
      };
    }

    let raw: unknown;
    try {
      raw = await options.port.read();
    } catch (error) {
      logOnce('error', 'port_error', '记忆信号源读取失败（隔离，不吞循环）:', error);
      return { signals: [], degraded: { reason: 'port_error', error } };
    }

    let normalized: NormalizedMemorySignals;
    try {
      normalized = normalizeMemorySignals(raw);
    } catch (error) {
      logOnce('error', 'malformed', '记忆信号读数形态非法（隔离）:', error);
      return { signals: [], degraded: { reason: 'malformed_data', detail: '记忆信号读数形态非法', error } };
    }

    const degraded: SenseDegrade | undefined =
      normalized.malformedCount > 0
        ? { reason: 'malformed_data', detail: `丢弃畸形记忆信号 ${normalized.malformedCount} 条` }
        : undefined;
    return { signals: normalized.items.map((item) => signalForMemorySignal(item, now)), ...(degraded ? { degraded } : {}) };
  };

  return {
    name: 'memory-signals',
    source: SENSE_SIGNAL_SOURCES['memory-signals'],
    trigger: SENSE_TRIGGERS['memory-signals'],
    enabled,
    collect,
  };
}
