/**
 * 任务08② 回执订阅播报 · 服务端管线
 *
 * 完成事件（runtime 'complete' / report-task 双入口）→ 匹配待回执登记 →
 * 组 Signal 过 09 判断层（shared/broadcast-gates 纯函数，服务端观测口径）→
 * 非 SILENT 时广播最小 ServerMessage `task_receipt`（客户端播报桥 → proactiveReporter 权威复判出口）。
 *
 * 职责边界：
 * - 服务端判断层用 DEFAULT_GATES_CONFIG 作**观测口径**（用户 09·B 分级设置按设计零服务端，
 *   读不到；实际播报档位由客户端 proactiveReporter 用本地设置权威判定）；
 * - 稳定幂等键 `agent-{kind}:{agentId}:{taskId}`（06-11 §11.1）——双入口复用同一键，
 *   服务端 seenKeys 去重后第二入口不再转发（M4「同一事件两通道重复播」的服务端半边）；
 *   无 taskId（未匹配完成）回退 `@ts` 唯一键：优先防漏报，宁多播不误去重；
 * - 🔴② 观测点：回执事件 → 订阅匹配 → 是否触发播报，全量落 system_log
 *   （category 'delegation'、body.phase 'receipt'，口径对齐 task-card-status 短 id/枚举）；
 * - 全链路 try/catch + logEvent 静默降级：回执链路 best-effort，绝不打断任务卡/委派主链路。
 */

import type { ServerMessage } from '../../../shared/types.js';
import {
  DEFAULT_GATES_CONFIG,
  applyGatesDelta,
  createGatesState,
  decideBroadcast,
  type BroadcastDecision,
  type BroadcastReason,
  type GatesState,
  type Signal,
} from '../../../shared/broadcast-gates.js';
import { logEvent } from '../../data/system-log.js';
import { aliasesForProject, loadAliasTable } from '../../jarvis-core/projects/aliases.js';
import { createLogger } from '../../utils/logger.js';
import { matchPendingReceipt } from './pending-receipt-registry.js';
import type { PendingBossUplink } from './boss-uplink-receipt-registry.js';

const log = createLogger('TaskReceipt');

/** 幂等键裁剪上限（与 09·B reporter 同口径）。 */
const MAX_SEEN_KEYS = 200;

export interface TaskReceiptInput {
  subordinateId: string;
  /** 可得则传（runtime-listeners 从 agentService / routes 从 agent.name）；缺省回退 id 前 8 位。 */
  agentName?: string;
  success: boolean;
  /** report-task 独有：结果摘要（当前仅透传，不进播报文本，控制语音长度）。 */
  summary?: string;
  /** 任务14·B：调用方可得的结果项目归属（兜底；匹配命中登记时优先用 receipt.projectId）。 */
  projectId?: string;
  source: 'runtime' | 'report-task';
  at?: number;
  /** 转发出口（服务端→客户端）；缺省不转发（仍过判断层 + 落埋点）。 */
  broadcast?: ((message: ServerMessage) => void) | null;
}

export interface TaskReceiptOutcome {
  /** 是否命中待回执登记（派活闭环）。 */
  matched: boolean;
  /** 是否为第二入口/重复键（未转发原因之一）。 */
  duplicate: boolean;
  tier: BroadcastDecision['tier'];
  reason: BroadcastReason;
  score: number;
  /** 是否已广播 task_receipt（tier 非 SILENT 且出口存在）。 */
  forwarded: boolean;
}

const FALLBACK_OUTCOME: TaskReceiptOutcome = {
  matched: false,
  duplicate: false,
  tier: 'SILENT',
  reason: 'low_relevance',
  score: 0,
  forwarded: false,
};

// ============================================================================
// 服务端观测用闸门状态（进程内；仅本模块使用，测试可 reset）
// ============================================================================

let gatesState: GatesState = createGatesState({ now: Date.now(), config: DEFAULT_GATES_CONFIG });
let gatesDayKey = dayKeyOf(Date.now());

function dayKeyOf(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 跨日重置预算计数（本模块只关心幂等键，预算计数仅为观测一致性）。 */
function refreshGatesDay(now: number): void {
  const key = dayKeyOf(now);
  if (key === gatesDayKey) return;
  gatesDayKey = key;
  gatesState = { ...gatesState, spokenToday: 0, instantSpeakToday: 0 };
}

function advanceGates(decision: BroadcastDecision): void {
  const next = applyGatesDelta(gatesState, decision.delta);
  gatesState =
    next.seenKeys.length > MAX_SEEN_KEYS ? { ...next, seenKeys: next.seenKeys.slice(-MAX_SEEN_KEYS) } : next;
}

/**
 * 任务14·B：projectId → 口称别名（取 14·A 别名表 aliasesForProject 首条；表内为归一化口称名）。
 * 无 projectId / 未知项目 / 表缺失或损坏（14·A 已按空表容错）→ undefined：**未知则不加前缀，如实**。
 * 不缓存、每次现读（别名改动即时生效；回执频率低，同步读小文件可忽略）。
 */
function resolveProjectAlias(projectId: string | undefined): string | undefined {
  if (!projectId) return undefined;
  try {
    return aliasesForProject(loadAliasTable(), projectId)[0];
  } catch (err) {
    log.warn('[任务14·B] 项目别名查询失败（回执不加前缀）:', err);
    return undefined;
  }
}

// ============================================================================
// 主流程
// ============================================================================

/**
 * 完成事件统一入口（双入口调用点：runtime-listeners 'complete' / routes/agents report-task）。
 * 永不抛出；返回本次判定结果供调用方/测试断言。
 */
export function notifyTaskCompletion(input: TaskReceiptInput): TaskReceiptOutcome {
  try {
    const at = input.at ?? Date.now();
    const match = matchPendingReceipt(input.subordinateId, at);
    const receipt = match?.receipt;
    const duplicate = match?.duplicate === true;

    const name = input.agentName || input.subordinateId.slice(0, 8);
    const verb = input.success ? '完成任务' : '任务失败';
    // 任务14·B：回执文本前缀【项目别名】（登记快照 receipt.projectId 优先，调用方透传兜底）；
    // 别名不可得 → 不加前缀、不占位、不写「未知」。
    const projectAlias = resolveProjectAlias(receipt?.projectId ?? input.projectId);
    const projectPrefix = projectAlias ? `【${projectAlias}】` : '';
    const text = receipt?.taskSummary
      ? `${projectPrefix}${name} ${verb}:${receipt.taskSummary}`
      : `${projectPrefix}${name} ${verb}`;
    const dedupeKey = receipt?.taskId
      ? `agent-${input.success ? 'completed' : 'failed'}:${input.subordinateId}:${receipt.taskId}`
      : `agent-${input.success ? 'completed' : 'failed'}:${input.subordinateId}@${at}`;

    // 评分子项与 09·B reporter 的完成/失败常量逐字一致（观测口径统一）
    const signal: Signal = {
      source: 'agent',
      kind: input.success ? 'agent_completed' : 'agent_failed',
      ts: at,
      dedupeKey,
      text,
      ...(input.success
        ? { urgency: 60, relevance: 70, certainty: 95 }
        : { urgency: 90, relevance: 80, certainty: 90 }),
    };

    refreshGatesDay(at);
    gatesState = { ...gatesState, now: at, config: DEFAULT_GATES_CONFIG, env: {} };
    const decision = decideBroadcast(signal, gatesState);
    advanceGates(decision);

    const forwarded = decision.tier !== 'SILENT' && typeof input.broadcast === 'function';
    if (forwarded && input.broadcast) {
      input.broadcast({
        type: 'task_receipt',
        payload: {
          agentId: input.subordinateId,
          agentName: input.agentName,
          success: input.success,
          matched: !!receipt,
          taskId: receipt?.taskId,
          decisionId: receipt?.decisionId,
          taskSummary: receipt?.taskSummary,
          text,
          at,
          source: input.source,
          dedupeKey,
          observed: { tier: decision.tier, reason: decision.reason, score: decision.score },
        },
      } as ServerMessage);
    }

    // 🔴② 观测点：回执事件 → 订阅匹配 → 是否触发播报（delegation 类全量不采样）
    logEvent('delegation', {
      ts: at,
      source: 'boss',
      agentId: input.subordinateId,
      taskId: receipt?.taskId,
      body: {
        cat: 'delegation',
        phase: 'receipt',
        matched: !!receipt,
        duplicate: duplicate || decision.duplicate,
        success: input.success,
        entry: input.source,
        tier: decision.tier,
        reason: decision.reason,
        score: decision.score,
        forwarded,
        dedupeKey,
      },
    });

    return {
      matched: !!receipt,
      duplicate: duplicate || decision.duplicate,
      tier: decision.tier,
      reason: decision.reason,
      score: decision.score,
      forwarded,
    };
  } catch (err) {
    log.warn('[任务08②] 回执播报管线异常（已忽略，主链路不受影响）:', err);
    return { ...FALLBACK_OUTCOME };
  }
}

// ============================================================================
// 任务40：秘书↔主管上行回执（「已回复」/「已办结」——复用同一判断层/广播/埋点模式）
// ============================================================================

/** T1 回合末句摘录显示长度（初值非实测最优，待 L3 标定）。 */
export const MAX_TURN_TAIL_LENGTH = 40;

/** 尾摘清洗：空白压缩 + 取结尾 ≤40 字（截断时前缀 … 表明由来），空文本舍弃。 */
function truncateTurnTail(text: string | undefined): string | undefined {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > MAX_TURN_TAIL_LENGTH ? `…${clean.slice(-MAX_TURN_TAIL_LENGTH)}` : clean;
}

export interface BossUplinkReceiptInput {
  bossId: string;
  /** 可得则传（runtime-listeners 从 agentService）；缺省回退 id 前 8 位。 */
  agentName?: string;
  /** 触发时消费的登记快照（consumeBossUplinkReceipt 返回值）。 */
  entry: PendingBossUplink;
  /** T1 主管回合闭包（「已回复」）/ T2 链路收口（「已办结」）——动词按触发点区分。 */
  trigger: 'turn-close' | 'subordinate-complete';
  /** T1 回合末句素材（此处清洗 + 截尾；T2 忽略）。 */
  turnTextTail?: string;
  at?: number;
  /** 转发出口（服务端→客户端）；缺省不转发（仍过判断层 + 落埋点）。 */
  broadcast?: ((message: ServerMessage) => void) | null;
}

/**
 * 上行回执统一入口（触发点：runtime-listeners T1 回合闭包 / T2 链路收口）。
 * 永不抛出；返回本次判定结果供调用方/测试断言。与 notifyTaskCompletion 同判断层/同闸门状态。
 */
export function notifyBossUplinkCompletion(input: BossUplinkReceiptInput): TaskReceiptOutcome {
  try {
    const at = input.at ?? Date.now();
    const name = input.agentName || input.bossId.slice(0, 8);
    // 任务14·B：前缀【项目别名】（登记快照 entry.projectId；别名不可得 → 不加前缀、不占位）
    const projectAlias = resolveProjectAlias(input.entry.projectId);
    const projectPrefix = projectAlias ? `【${projectAlias}】` : '';
    const tail = input.trigger === 'turn-close' ? truncateTurnTail(input.turnTextTail) : undefined;
    const verb = input.trigger === 'turn-close' ? '已回复' : '已办结';
    const text = `${projectPrefix}${name} ${verb}:${input.entry.taskSummary}${tail ? `——${tail}` : ''}`;
    // 稳定幂等键：一次派活一条（秘书侧 taskId；无 taskId 回退 @ts 唯一键）
    const dedupeKey = `boss-uplink:${input.bossId}:${input.entry.taskId ?? `@${at}`}`;

    // 评分子项与成功完成同常量（观测口径统一；不新增 kind —— 复用既有评分与客户端 kind 映射）
    const signal: Signal = {
      source: 'agent',
      kind: 'agent_completed',
      ts: at,
      dedupeKey,
      text,
      urgency: 60,
      relevance: 70,
      certainty: 95,
    };

    refreshGatesDay(at);
    gatesState = { ...gatesState, now: at, config: DEFAULT_GATES_CONFIG, env: {} };
    const decision = decideBroadcast(signal, gatesState);
    advanceGates(decision);

    const forwarded = decision.tier !== 'SILENT' && typeof input.broadcast === 'function';
    if (forwarded && input.broadcast) {
      input.broadcast({
        type: 'task_receipt',
        payload: {
          agentId: input.bossId,
          agentName: input.agentName,
          success: true,
          matched: true,
          taskId: input.entry.taskId,
          taskSummary: input.entry.taskSummary,
          text,
          at,
          source: 'runtime',
          dedupeKey,
          observed: { tier: decision.tier, reason: decision.reason, score: decision.score },
        },
      } as ServerMessage);
    }

    // 🔴② 观测点：上行回执（与下属层同 phase 'receipt'，body 以 uplink:'boss' + trigger 区分子类）
    logEvent('delegation', {
      ts: at,
      source: 'boss',
      agentId: input.bossId,
      taskId: input.entry.taskId,
      body: {
        cat: 'delegation',
        phase: 'receipt',
        matched: true,
        duplicate: decision.duplicate,
        success: true,
        entry: 'runtime',
        uplink: 'boss',
        trigger: input.trigger,
        tier: decision.tier,
        reason: decision.reason,
        score: decision.score,
        forwarded,
        dedupeKey,
      },
    });

    return {
      matched: true,
      duplicate: decision.duplicate,
      tier: decision.tier,
      reason: decision.reason,
      score: decision.score,
      forwarded,
    };
  } catch (err) {
    log.warn('[任务40] 上行回执播报管线异常（已忽略，主链路不受影响）:', err);
    return { ...FALLBACK_OUTCOME };
  }
}

/** 测试专用：清空服务端观测闸门状态（幂等键/预算/跨日键）。 */
export function resetTaskReceiptNotifierForTests(now = Date.now()): void {
  gatesState = createGatesState({ now, config: DEFAULT_GATES_CONFIG });
  gatesDayKey = dayKeyOf(now);
}
