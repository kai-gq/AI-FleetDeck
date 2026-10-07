/**
 * jarvis-core · 感知层信号源 1/6：Agent 状态（任务 30，06-11 §5）
 *
 * 采集方式：复用现有「快照 diff」语义（只读参照 client/voice/proactiveReporter.ts:
 * diffSnapshots / signalForEvent；本模块在服务端重写纯函数，不 import client/**）：
 *   working → idle            = 完成（待岗 standby 引起的例外，见下）
 *   → error / lastError 更新  = 报错
 *   → waiting / waiting_permission = 提问（等你授权才能继续，标 timeSensitive）
 *   scope='all' 时 working 换任务也报
 * 待岗(standby)：用户主动停用，停止造成的 working→idle 不算完成（与 client 同口径）。
 * 首次采集只建立基线（启动前的状态不产生事件，与既有上报器同口径）。
 *
 * 触发：事件型（允许接线层即时唤醒）。
 *
 * 生产通道接线延后：服务端没有现成的 agent 快照源（现状源在客户端 store，
 * client/** 属本任务禁区）。端口 AgentStatePort 留待主脑接线提供；
 * 缺省端口 = 空读数 + degraded('port_not_wired')，不读任何现有文件。
 */

import type { RawSignal } from '../signal-queue.js';
import type { JarvisLogger } from '../executors.js';
import { createOnceLogger, isRecord, toNonEmptyString, truncateText } from './safe.js';
import {
  SENSE_SIGNAL_SOURCES,
  SENSE_TRIGGERS,
  resolveSenseEnabled,
  type Sense,
  type SenseDegrade,
  type SenseReading,
} from './types.js';

// ============================================================================
// 类型与端口
// ============================================================================

/** agent 快照条目（status 用宽松 string：未知状态安全忽略，不抛）。 */
export interface AgentStateEntry {
  name?: string;
  status: string;
  taskLabel?: string;
  lastError?: string;
  /** 待岗(standby)：用户主动停用。待岗引起的 working→idle 是「被停」而非「干完了」。 */
  standby?: boolean;
}

/** 快照输入：Map（同 client）或普通对象；未知形态按畸形处理。 */
export type AgentStateSnapshotInput = Map<string, AgentStateEntry> | Record<string, AgentStateEntry>;

/** 可注入端口（测试注入 mock；生产通道接线延后）。 */
export interface AgentStatePort {
  snapshot: () => AgentStateSnapshotInput | Promise<AgentStateSnapshotInput>;
}

export type AgentChangeKind = 'completed' | 'failed' | 'waiting' | 'task-changed';

export interface AgentStateChange {
  at: number;
  kind: AgentChangeKind;
  agentId: string;
  text: string;
}

export interface AgentStateSenseOptions {
  /** 独立开关；缺省读 TC_JARVIS_SENSE_AGENT_STATE（缺省开）。 */
  enabled?: boolean;
  /** 数据端口；缺省 = 未接线（安全缺省 + 记因）。 */
  port?: AgentStatePort;
  /** 汇报范围：important（完成/失败/等待）| all（额外含换任务）；缺省 important。 */
  scope?: 'important' | 'all';
  logger?: JarvisLogger;
  /** 开关判定用环境（测试）；缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
}

// ============================================================================
// 归一化（畸形数据安全丢弃）
// ============================================================================

interface NormalizedSnapshot {
  entries: Map<string, AgentStateEntry>;
  malformedCount: number;
}

/** 快照归一化：整体非 Map/对象 → 抛 TypeError；单条目畸形 → 计数丢弃。 */
function normalizeAgentSnapshot(raw: unknown): NormalizedSnapshot {
  let pairs: Array<[unknown, unknown]>;
  if (raw instanceof Map) {
    pairs = [...raw.entries()];
  } else if (isRecord(raw)) {
    pairs = Object.entries(raw);
  } else {
    throw new TypeError('agent 快照形态非法（需 Map 或普通对象）');
  }

  const entries = new Map<string, AgentStateEntry>();
  let malformedCount = 0;
  for (const [id, entry] of pairs) {
    const agentId = toNonEmptyString(id);
    if (!agentId || !isRecord(entry)) {
      malformedCount++;
      continue;
    }
    const status = toNonEmptyString(entry.status);
    if (!status) {
      malformedCount++;
      continue;
    }
    entries.set(agentId, {
      status,
      name: toNonEmptyString(entry.name),
      taskLabel: toNonEmptyString(entry.taskLabel),
      lastError: toNonEmptyString(entry.lastError),
      standby: entry.standby === true, // 只认显式 true：缺字段/脏值都按未待岗
    });
  }
  return { entries, malformedCount };
}

// ============================================================================
// 快照 diff（纯函数，语义对齐 client proactiveReporter.diffSnapshots）
// ============================================================================

/**
 * 两次快照对比产出事件（纯函数）。规则与 client diffSnapshots 一致：新出现的
 * agent 不报（创建本身就是用户操作）；未匹配的跃迁（→working/offline 等）不打扰。
 */
export function diffAgentSnapshots(
  prev: ReadonlyMap<string, AgentStateEntry>,
  next: ReadonlyMap<string, AgentStateEntry>,
  scope: 'important' | 'all',
  now: number,
): AgentStateChange[] {
  const events: AgentStateChange[] = [];
  const nameOf = (id: string, entry: AgentStateEntry) => entry.name || id.slice(0, 8);

  // 排序遍历：输出稳定（便于测试与去重键关联），与 client 的插入序差异不影响语义。
  for (const id of [...next.keys()].sort()) {
    const cur = next.get(id)!;
    const before = prev.get(id);
    if (!before) continue; // 新出现的 agent：只登记基线，不播报
    const name = nameOf(id, cur);
    const label = cur.taskLabel ? `(${cur.taskLabel})` : '';

    if (before.status !== cur.status) {
      if (cur.status === 'idle' && before.status === 'working') {
        // 待岗停机 = 用户主动下线，不是「任务完成」——不报（与 client 同口径）。
        if (!cur.standby) {
          events.push({ at: now, kind: 'completed', agentId: id, text: `${name} 完成任务${cur.taskLabel ? `:${cur.taskLabel}` : ''}` });
        }
        continue;
      }
      if (cur.status === 'error') {
        const err = cur.lastError ? `:${truncateText(cur.lastError, 80)}` : '';
        events.push({ at: now, kind: 'failed', agentId: id, text: `${name} 出错${err}` });
        continue;
      }
      if (cur.status === 'waiting' || cur.status === 'waiting_permission') {
        const what = cur.status === 'waiting_permission' ? '等待授权' : '等待确认';
        events.push({ at: now, kind: 'waiting', agentId: id, text: `${name} ${what}${label}` });
        continue;
      }
      continue; // 其它跃迁（→working/offline 等）不打扰
    }

    // 状态未变：错误串更新也算报错（与 client 同口径）
    if (cur.lastError && cur.lastError !== before.lastError && before.status !== 'working') {
      events.push({ at: now, kind: 'failed', agentId: id, text: `${name} 出错:${truncateText(cur.lastError, 80)}` });
      continue;
    }

    // scope=all：working 中换任务也报
    if (scope === 'all' && cur.status === 'working' && cur.taskLabel && cur.taskLabel !== before.taskLabel) {
      events.push({ at: now, kind: 'task-changed', agentId: id, text: `${name} 换任务:${cur.taskLabel}` });
    }
  }
  return events;
}

/**
 * 事件 → 09·A 原始信号。评分分量与 client signalForEvent 同值（初始值非实测，
 * 待 ⑭ 观测 / ⑮ 标定）：
 *   failed 90/80/90 → 87 分立即口播；waiting 85/80/90 且 timeSensitive；
 *   completed 60/70/95 → 70 分攒批；task-changed 40/80/85 → 61 分攒批。
 * dedupeKey 沿用 diff 通道逐次唯一占位 `agent-{kind}:{agentId}@{ts}`，防误去重丢事件。
 */
export function signalForAgentChange(change: AgentStateChange): RawSignal {
  const base: RawSignal = {
    source: SENSE_SIGNAL_SOURCES['agent-state'],
    kind: `agent_${change.kind}`,
    ts: change.at,
    dedupeKey: `agent-${change.kind}:${change.agentId}@${change.at}`,
    text: change.text,
  };
  switch (change.kind) {
    case 'failed':
      return { ...base, urgency: 90, relevance: 80, certainty: 90 };
    case 'waiting':
      return { ...base, urgency: 85, relevance: 80, certainty: 90, timeSensitive: true };
    case 'completed':
      return { ...base, urgency: 60, relevance: 70, certainty: 95 };
    case 'task-changed':
      return { ...base, urgency: 40, relevance: 80, certainty: 85 };
  }
}

// ============================================================================
// 信号源工厂
// ============================================================================

/** 创建 Agent 状态信号源（有状态：内部保留上一次快照作 diff 基线）。 */
export function createAgentStateSense(options: AgentStateSenseOptions = {}): Sense {
  const enabled = resolveSenseEnabled('agent-state', options.enabled, options.env);
  const scope = options.scope ?? 'important';
  const logOnce = createOnceLogger(options.logger);
  let previous: Map<string, AgentStateEntry> | null = null;

  const collect = async (now: number): Promise<SenseReading> => {
    if (!enabled) return { signals: [] };
    if (!options.port) {
      const degraded: SenseDegrade = { reason: 'port_not_wired', detail: 'agent 快照端口未接（现状源在 client store，属本轮禁区）' };
      logOnce('warn', 'port_not_wired', 'Agent 状态源未接线：跳过采集（登记为生产通道接线延后）');
      return { signals: [], degraded };
    }

    let raw: unknown;
    try {
      raw = await options.port.snapshot();
    } catch (error) {
      return { signals: [], degraded: { reason: 'port_error', error } };
    }

    let normalized: NormalizedSnapshot;
    try {
      normalized = normalizeAgentSnapshot(raw);
    } catch (error) {
      return { signals: [], degraded: { reason: 'malformed_data', detail: 'agent 快照形态非法', error } };
    }

    const degraded: SenseDegrade | undefined =
      normalized.malformedCount > 0
        ? { reason: 'malformed_data', detail: `丢弃畸形 agent 条目 ${normalized.malformedCount} 条` }
        : undefined;

    const first = previous === null;
    const prev = previous ?? new Map<string, AgentStateEntry>();
    previous = normalized.entries;
    if (first) return { signals: [], ...(degraded ? { degraded } : {}) }; // 首次只建基线

    const changes = diffAgentSnapshots(prev, normalized.entries, scope, now);
    return { signals: changes.map(signalForAgentChange), ...(degraded ? { degraded } : {}) };
  };

  return {
    name: 'agent-state',
    source: SENSE_SIGNAL_SOURCES['agent-state'],
    trigger: SENSE_TRIGGERS['agent-state'],
    enabled,
    collect,
  };
}
