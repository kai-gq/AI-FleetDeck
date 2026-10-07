/**
 * Boss Response Handler
 * Parses delegation, spawn, work-plan, and analysis-request blocks from boss agent responses
 */

import type { AgentClass, AgentProvider, ClaudeEffort, ClaudeModel, CodexConfig, CodexModel, DelegationDecision, GrokModel, OpencodeModel, PermissionMode, PiModel, ServerMessage, TaskCard } from '../../../shared/types.js';
import { BUILT_IN_AGENT_CLASSES } from '../../../shared/agent-types.js';
import { agentService, runtimeService, bossService, workPlanService, skillService } from '../../services/index.js';
import { getAllCustomClasses, getClassDefaultSkillIds } from '../../services/custom-class-service.js';
import { logger, getCommanderBaseUrl } from '../../utils/index.js';
import { getLastBossCommand, buildCustomAgentConfig } from './command-handler.js';
import { getTaskId, newTaskId } from '../../utils/trace-context.js';
import { logDelegation, logTaskCardStatus } from '../../services/activity-log.js';
import { formatTaskCard, normalizeTaskCard } from '../../services/task-card-service.js';
import {
  registerPendingReceipt,
  removePendingReceiptsForAgent,
  resetPendingReceiptsForTests,
} from './pending-receipt-registry.js';
// 任务15·B ⑫ 全局并发配额：接线闸门（准入/排队/出队/⑬ 撤回）+ 播报出口（只 import，不改 vcs）
import {
  DELEGATION_QUOTA_ACTION,
  cancelDelegationQuotaSlot,
  getDelegationQuotaSnapshot,
  onDelegationComplete,
  resetDelegationQuotaGateForTests,
  tryAdmitDelegation,
  type DelegationQuotaAdmitInput,
  type DelegationQuotaAdmitResult,
  type DelegationQuotaCancelResult,
  type QueuedDelegation,
} from '../../services/delegation-quota-gate.js';
import { getLastBossDispatch, logProactiveBroadcast } from '../../services/voice-companion-service.js';
import { isOnStandby, standbyRefusalMessage } from '../../services/agent-standby.js';
import { appendDecisionToAssetLibrary } from '../../services/team-memory-service.js';
import { loadDelegationHistory } from '../../data/index.js';

const log = logger.ws;

// Track recently processed delegations to prevent duplicates
const processedDelegations = new Map<string, number>();
const DELEGATION_DEDUP_WINDOW_MS = 60000; // 1 minute window

// Track active delegations: subordinateId -> { bossId, taskDescription, taskId, decisionId, taskCard }
// Used to route subordinate outputs/completion to the boss terminal
// (任务 02 扩展 taskId：委派创建点生成，回执/关闭埋点据此关联同一时间线)
// (任务 10·⑦ 扩展 decisionId/taskCard：完成入口据此把任务卡迁移到 done)
export interface ActiveDelegation {
  bossId: string;
  taskDescription: string;
  taskId?: string;
  /** 委派史记录 id（delegation-history.json 中 decision.id），任务卡状态迁移按此定位 */
  decisionId?: string;
  /** ⑦ 任务卡快照（无卡委派为 undefined —— 旧纯文本链路行为不变） */
  taskCard?: TaskCard;
}

export const activeDelegations = new Map<string, ActiveDelegation>();

/** HC-B7：重建时效（超过 24h 的未完成史条目不再复活追踪，防陈旧候选污染） */
export const ACTIVE_DELEGATION_REBUILD_TTL_MS = 24 * 60 * 60_000;
/** 启动重建只做一次（首个读者前 lazily 执行；模式同 delegation-quota-gate） */
let rebuiltActiveFromHistory = false;

/**
 * HC-B7：进程重启（tsx watch 热重启 / 崩溃恢复）清空内存 activeDelegations 后，从未完成
 * 委派史重建运行期追踪——修复「重启孤儿收养不重建委派追踪 → 在办任务完成后完成漏斗失忆」
 * （C4/CH-40：卡不迁 done、病历永停 sent、closed 行缺失、配额槽不释放）。
 * - 过滤：status ∈ {pending, sent} 且无 completion 且卡不在终态（queued 归配额重建管，
 *   done/cancelled 已终结）且 24h 内且下属 agent 仍存在；
 * - 冲突：同一下属已有 live 条目时保留 live（不覆盖）；
 * - 异常只告警不上抛（不拦断派活）；histories/force 供测试注入。
 * - 已知残余（如实登记于 19·B HC-B7）：①无卡且被撤回过的旧决策（撤回不改 status、无卡可判）
 *   会被重建，可能被完成漏斗误闭——B5 补齐产卡点后收敛；②旧版 send_boss_command 直派入口
 *   （boss-service.delegateCommand，客户端无调用方）写下的 sent 决策若 24h 内也会被重建。
 */
export function ensureActiveDelegationsRebuilt(
  histories?: Map<string, DelegationDecision[]>,
  force = false
): number {
  if (rebuiltActiveFromHistory && !force) return 0;
  rebuiltActiveFromHistory = true;
  try {
    const source = histories ?? loadDelegationHistory();
    const now = Date.now();
    const preExisting = new Set(activeDelegations.keys());
    const candidates: DelegationDecision[] = [];
    for (const decisions of source.values()) {
      for (const decision of decisions) {
        if (decision.status !== 'pending' && decision.status !== 'sent') continue;
        if (decision.completion) continue;
        const card = decision.taskCard;
        if (card && (card.status === 'done' || card.status === 'cancelled' || card.status === 'queued')) continue;
        if (now - decision.timestamp > ACTIVE_DELEGATION_REBUILD_TTL_MS) continue;
        if (!agentService.getAgent(decision.selectedAgentId)) continue;
        if (preExisting.has(decision.selectedAgentId)) continue;
        candidates.push(decision);
      }
    }
    // 同一下属多条未完成决策：按时间升序应用 → 较新覆盖较旧（与 live 单槽「后派覆盖」语义一致）
    candidates.sort((a, b) => a.timestamp - b.timestamp);
    let added = 0;
    for (const decision of candidates) {
      const card = decision.taskCard;
      activeDelegations.set(decision.selectedAgentId, {
        bossId: decision.bossId,
        taskDescription: decision.userCommand,
        ...(decision.taskId ? { taskId: decision.taskId } : {}),
        decisionId: decision.id,
        ...(card ? { taskCard: card } : {}),
      });
      added++;
    }
    if (added > 0) {
      log.log(`[Delegation] rebuilt ${added} active delegation tracking(s) from history`);
    }
    return added;
  } catch (err) {
    log.warn(`[Delegation] active tracking rebuild skipped: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * Get the boss ID for an active delegation (if any)
 */
export function getBossForSubordinate(subordinateId: string): ActiveDelegation | undefined {
  ensureActiveDelegationsRebuilt();
  return activeDelegations.get(subordinateId);
}

/** 在办委派快照条目（subordinateId + 追踪内容拷贝）。 */
export interface ActiveDelegationSnapshot extends ActiveDelegation {
  subordinateId: string;
}

/**
 * 任务24：在办委派只读快照（拷贝——调用方改写不影响追踪 Map；taskCard 浅拷贝一层）。
 * 与 getBossForSubordinate 同口径先触发 HC-B7 重建，保证重启后首个读者看到完整在办列表。
 */
export function listActiveDelegations(): ActiveDelegationSnapshot[] {
  ensureActiveDelegationsRebuilt();
  return [...activeDelegations.entries()].map(([subordinateId, d]) => ({
    subordinateId,
    bossId: d.bossId,
    taskDescription: d.taskDescription,
    ...(d.taskId ? { taskId: d.taskId } : {}),
    ...(d.decisionId ? { decisionId: d.decisionId } : {}),
    ...(d.taskCard ? { taskCard: { ...d.taskCard } } : {}),
  }));
}

/**
 * Clear delegation for a subordinate (call when task completes)
 */
export function clearDelegation(subordinateId: string): void {
  activeDelegations.delete(subordinateId);
}

/** ⑧ 病历：完成入口可选透传字段（summary 由 report-task 入口提供；outputLocation 当前入口不可得）。 */
export interface CompleteDelegationOptions {
  success?: boolean;
  reason?: string;
  at?: number;
  /** ⑧ 病历产出摘要（report-task 的 req.body.summary；runtime 入口无可得来源 → 缺省） */
  summary?: string;
  /** ⑧ 病历产出位置（report-task 入口回传；任务17·A3 接通） */
  outputLocation?: string;
  /** ⑧ 病历验收打勾（report-task 入口回传；任务17·A3 接通） */
  acceptance?: Array<{ item: string; done: boolean }>;
}

/**
 * ⑦⑧ 委派完成单一漏斗：委派结束时固化病历写回 + 任务卡迁移 done（🔴⑦ 埋点随迁移落盘），再清理追踪。
 * - ⑧ 快照时序：先取 ActiveDelegation 快照（decisionId/taskId/taskDescription 所在），
 *   全部写回完成后才 delete —— 事后补录会丢任务描述（Spec §4.8 关键时序）；
 * - ⑧ 病历对所有带 decisionId 的委派生效（不止有卡者）；无追踪（第二次到达，追踪已被
 *   第一入口清理）→ 不双写不覆盖，稳定幂等（口径由测试钉住）；
 * - 无追踪/无任务卡（旧纯文本委派）退化为 clearDelegation 行为，绝不拦断回执链路；
 * - decisionId/taskId 仅服务端进程内可达（任务 02 登记限制，下属进程事件不携带）。
 */
export function completeDelegation(
  subordinateId: string,
  opts: CompleteDelegationOptions = {}
): void {
  ensureActiveDelegationsRebuilt(); // HC-B7：首个完成入口前重建（跨重启完成也能走完成漏斗）
  const delegation = activeDelegations.get(subordinateId);
  // 任务15·B：配额释放所需的 taskId 必须在清理（delete）前快照
  const quotaTaskId = delegation?.taskId;
  if (delegation) {
    const at = opts.at ?? Date.now();
    const result = opts.success === false ? 'failed' : 'completed';
    if (delegation.taskCard && delegation.decisionId) {
      bossService.updateDelegationTaskCardStatus(delegation.bossId, delegation.decisionId, 'done', {
        at,
        result,
        reason: opts.reason ?? 'turn-complete',
        subordinateId,
        taskId: delegation.taskId,
      });
    }
    // ⑧ 病历：完成事件写回（decisionId 在 delete 后不可达，必须在清理前落盘）
    if (delegation.decisionId) {
      const recorded = bossService.recordDelegationCompletion(delegation.bossId, delegation.decisionId, {
        at,
        result,
        summary: opts.summary,
        outputLocation: opts.outputLocation,
        acceptance: opts.acceptance,
        reason: opts.reason ?? 'turn-complete',
        subordinateId,
        taskId: delegation.taskId,
      });
      // 任务23 · 团队资产库：完成/失败事件驱动 append（唯一完成漏斗挂点）。
      // store 层按 decisionId 幂等拒绝重复；appendDecisionToAssetLibrary 内部 fail-open，
      // 任何资产库故障绝不拦断回执/病历链路。
      if (recorded?.completion) appendDecisionToAssetLibrary(recorded);
    }
  }
  // 任务15·B ⑫：释放配额（:103 删除前的旧挂点语义）——只动配额账本，不碰 activeDelegations，
  // 双入口幂等下只在「真正完成」（delegation 存在）那次释放；gate 内部绝不上抛。
  const dequeued = quotaTaskId ? releaseQuotaSlotSafely(quotaTaskId) : null;
  activeDelegations.delete(subordinateId);
  // 出队派发必须放在 delete 之后：被出队任务可能恰好派给同一 subordinate，
  // 若先派发再 delete，会把刚写好的运行期追踪立即清掉。
  if (dequeued) dispatchQueuedDelegation(dequeued);
}

/**
 * Test helper to clear delegation parser state.
 */
export function resetBossDelegationStateForTests(): void {
  processedDelegations.clear();
  activeDelegations.clear();
  rebuiltActiveFromHistory = false; // HC-B7：重建标志随解析器状态复位
  resetPendingReceiptsForTests(); // 任务08②：待回执登记随解析器状态一并复位
  resetDelegationQuotaGateForTests(); // 任务15·B：配额账本（含重建标志）随解析器状态复位
}

export type BroadcastFn = (message: ServerMessage) => void;
export type SendActivityFn = (agentId: string, message: string) => void;

// ============================================================================
// 任务15·B ⑫ 全局并发配额接线 helpers（Spec §4.12）
// ============================================================================

/** 任务摘要（播报/日志用；压空白 + 截断）。 */
function summarizeQuotaText(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 准入安全壳：闸门任何异常都不得拦断派活（审计已自包，这里兜底主链路）。 */
function admitDelegationSafely(input: DelegationQuotaAdmitInput): DelegationQuotaAdmitResult {
  try {
    return tryAdmitDelegation(input);
  } catch (err) {
    log.error(`[quota] gate admit failed — falling back to direct dispatch:`, err);
    return { status: 'admitted' };
  }
}

/** 完成入口安全壳：配额释放/出队异常不得影响 ⑦⑧ 完成漏斗与回执链路。 */
function releaseQuotaSlotSafely(taskId: string): QueuedDelegation | null {
  try {
    return onDelegationComplete(taskId);
  } catch (err) {
    log.error(`[quota] release failed for task ${taskId}:`, err);
    return null;
  }
}

/**
 * 派发消息构造（自原 :515-521 提取共用，行为不变）——首次派发与出队派发同构：
 * Boss 上下文 + 任务卡（⑦ 验收标准对下属可见）+ report-task 回执指引。
 */
function buildDelegatedMessage(input: {
  bossId: string;
  bossName: string;
  taskCommand: string;
  taskCard?: TaskCard;
}): string {
  const baseUrl = getCommanderBaseUrl();
  const cardBlock = input.taskCard ? `\n\n${formatTaskCard(input.taskCard)}` : '';
  // 任务17·A3 契约：completed 回执必须带非空 acceptance（逐条 {item,done}）+ 非空白 outputLocation，
  // 否则 report-task 返回 400（内联示例即新契约，下属首轮即合规；failed 回执不强制这两字段）。
  return `[DELEGATED TASK from boss "${input.bossName}" (${input.bossId})]\n\n${input.taskCommand}${cardBlock}\n\n---\nThis task was delegated by your boss agent. When you finish, report completion using:\ncurl -s -X POST ${baseUrl}/api/agents/YOUR_AGENT_ID/report-task -H "Content-Type: application/json" -d '{"summary":"Brief result summary","status":"completed","outputLocation":"path or link to the deliverable","acceptance":[{"item":"acceptance criterion from the task card","done":true}]}'\n\nA "completed" report MUST include a non-blank "outputLocation" and a non-empty "acceptance" array of {"item","done"} objects (one per acceptance criterion above, checked off) — otherwise it is rejected with HTTP 400. If the task could not be completed, report "status":"failed" (acceptance/outputLocation optional).`;
}

/** 🔴 决策观测点⑦：落卡 none → pending（准入与排队路径共用；排队路径随后 pending→queued）。 */
function logTaskCardPending(refs: {
  decisionId: string;
  bossId: string;
  subordinateId: string;
  taskCard: TaskCard;
  taskId?: string;
  at: number;
}): void {
  logTaskCardStatus({
    decisionId: refs.decisionId,
    from: 'none',
    to: 'pending',
    at: refs.at,
    bossId: refs.bossId,
    subordinateId: refs.subordinateId,
    projectId: refs.taskCard.projectId,
    sourceProject: refs.taskCard.sourceProject,
    reason: 'delegated',
    taskId: refs.taskId,
  });
}

/**
 * 任务15·B：出队派发（completeDelegation 释放配额后，由 onDelegationComplete 返回载荷触发）。
 * 与 parseBossDelegation 首次派发同构：activeDelegations.set → registerPendingReceipt
 * → sendCommand → running（.then）；失败走 ⑫ 埋点。载荷自带任务卡与 decisionId，
 * 重启重建条目也能直接恢复（taskId 缺失时新生成——旧 taskId 进程内不可达）。
 *
 * 已知缺口（登记）：出口在完成漏斗内，拿不到 WS broadcast 上下文 →
 * 不发 delegation_decision / agent_task_started 广播；播报走 logProactiveBroadcast
 * （projectId 用 taskCard 原值展示；任务14·B 别名替换只落回执前缀，未动配额播报）。
 * 绝不上抛：任何异常只记日志，不拦断完成入口。
 */
function dispatchQueuedDelegation(payload: QueuedDelegation): void {
  try {
    const taskId = payload.taskId ?? newTaskId();
    const bossName = agentService.getAgent(payload.bossId)?.name ?? payload.bossId;
    const targetAgent = agentService.getAgent(payload.selectedAgentId);
    // 出队时目标可能已待岗（排队期间被用户下线）：拒绝并归还槽位。出队时槽位已归
    // 出队者（onDelegationComplete 返回队首载荷），不归还整条 FIFO 静默断链——
    // releaseQuotaSlotSafely 的返回值是下一个队首，递归续派（同 :225/:676 模式）。
    // 本函数无 BroadcastFn，反馈走日志 + 播报通道；Boss 输出流侧由下一轮守卫兜住。
    if (isOnStandby(targetAgent)) {
      log.warn(`[quota] Dequeued task refused — ${payload.selectedAgentName} is on standby (待岗)`);
      if (payload.taskCard) {
        bossService.updateDelegationTaskCardStatus(payload.bossId, payload.decisionId, 'cancelled', {
          at: Date.now(),
          reason: 'target-on-standby',
          subordinateId: payload.selectedAgentId,
          taskId,
        });
      }
      logProactiveBroadcast({
        text: `[并发配额] 排队任务被拒绝：${payload.selectedAgentName} 已待岗（需用户恢复）——${summarizeQuotaText(payload.taskCommand)}`,
        action: DELEGATION_QUOTA_ACTION,
        taskId,
      });
      logDelegation({
        phase: 'failed',
        channel: 'boss',
        fromAgentId: payload.bossId,
        fromName: bossName,
        toAgentId: payload.selectedAgentId,
        toAgentName: payload.selectedAgentName,
        message: payload.taskCommand,
        status: 'failed',
        error: 'target on standby (待岗)',
        taskId,
      });
      const nextDequeued = releaseQuotaSlotSafely(taskId);
      if (nextDequeued) dispatchQueuedDelegation(nextDequeued);
      return;
    }

    const customAgentConfig = targetAgent
      ? buildCustomAgentConfig(payload.selectedAgentId, targetAgent.class)
      : undefined;

    activeDelegations.set(payload.selectedAgentId, {
      bossId: payload.bossId,
      taskDescription: payload.taskCommand,
      taskId,
      decisionId: payload.decisionId,
      taskCard: payload.taskCard,
    });
    // 任务08②：待回执登记延到出队（排队中未派发，不存在回执）
    registerPendingReceipt({
      targetAgentId: payload.selectedAgentId,
      bossId: payload.bossId,
      taskId,
      decisionId: payload.decisionId,
      // 任务14·B：项目归属随登记带入（回执文本【项目别名】前缀的来源）
      projectId: payload.taskCard?.projectId,
      taskSummary: payload.taskCommand,
    });

    // 任务 02 埋点：同 channel，status 标记出队派发（与首次派发行区分）
    logDelegation({
      phase: 'delegated',
      channel: 'boss',
      fromAgentId: payload.bossId,
      fromName: bossName,
      toAgentId: payload.selectedAgentId,
      toAgentName: payload.selectedAgentName,
      message: payload.taskCommand,
      delivery: 'queue',
      status: 'dequeued',
      taskId,
    });

    // ⑩ 播报出口（vcs 既有通道，只 import 不改）：排队任务开始了
    const projectLabel = payload.taskCard?.projectId ? `（项目 ${payload.taskCard.projectId}）` : '';
    logProactiveBroadcast({
      text: `[并发配额] 排队任务开始了${projectLabel}：${summarizeQuotaText(payload.taskCommand)}`,
      action: DELEGATION_QUOTA_ACTION,
      taskId,
    });

    const delegatedMessage = buildDelegatedMessage({
      bossId: payload.bossId,
      bossName,
      taskCommand: payload.taskCommand,
      taskCard: payload.taskCard,
    });
    runtimeService.sendCommand(payload.selectedAgentId, delegatedMessage, undefined, undefined, customAgentConfig)
      .then(() => {
        // 🔴 决策观测点⑦：queued → running（出队派发成功）
        if (payload.taskCard) {
          bossService.updateDelegationTaskCardStatus(payload.bossId, payload.decisionId, 'running', {
            at: Date.now(),
            reason: 'dispatched',
            subordinateId: payload.selectedAgentId,
            taskId,
          });
        }
      })
      .catch(err => {
        log.error(`Failed to dispatch dequeued task to ${payload.selectedAgentName}:`, err);
        logDelegation({
          phase: 'failed',
          channel: 'boss',
          fromAgentId: payload.bossId,
          fromName: bossName,
          toAgentId: payload.selectedAgentId,
          toAgentName: payload.selectedAgentName,
          message: payload.taskCommand,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          taskId,
        });
      });
  } catch (err) {
    log.error(`[quota] dequeued dispatch failed (completion funnel unaffected):`, err);
  }
}

// ============================================================================
// 任务16·⑬ 撤回执行面（vcs 只调本导出；配额走 gate 新增 cancel API，15·A 零改动）
// ============================================================================

/** ⑬ 撤回入参（定位顺序：subordinateId live 追踪 → decisionId/taskId 反查；均缺省时报 not-found）。 */
export interface CancelDelegationInput {
  subordinateId?: string;
  bossId?: string;
  decisionId?: string;
  taskId?: string;
  /** ⑬ 观测发起方（user=语音撤回；api/system 等）。 */
  initiator?: string;
  /** ⑬ 观测原因摘要（vcs 传用户原话截断；账本不解释语义）。 */
  reason?: string;
  at?: number;
}

export interface CancelDelegationOutcome {
  status: 'cancelled' | 'already-cancelled' | 'rejected-done' | 'not-found';
  /** 撤回发生的位置：queued=从未派发；running=已派发在跑；tracking=仅卡片残留（重启后）。 */
  cancelledFrom?: 'queued' | 'running' | 'tracking';
  bossId?: string;
  subordinateId?: string;
  subordinateName?: string;
  decisionId?: string;
  taskId?: string;
  /** 任务展示文本（话术/审计原样透传）。 */
  label?: string;
  /** 是否已向下属投递取消通知（queued 撤回未派发 → false）。 */
  notified: boolean;
  /** 通知失败摘要（投递失败且兜底失败时如实登记，不上抛）。 */
  notifyError?: string;
  /** 通知投递耗时（确认到达时刻 − 通知开始；失败路径为失败时刻，亦如实）。 */
  notifyMs?: number;
  /** 通知失败后 stopAgent 兜底是否成功。 */
  stopFallbackUsed?: boolean;
  /** 任务卡已迁移到 cancelled（无卡/已结束记录为 false）。 */
  cardMigrated: boolean;
  /** 释放槽位时被出队的队首 decisionId（已由本函数派发）。 */
  dequeuedDecisionId?: string;
}

function isBossLikeAgentRef(agent: { isBoss?: boolean; class?: string }): boolean {
  return agent.isBoss === true || agent.class === 'boss';
}

/** 委派史定位（bossId 未知时扫描全部 Boss 历史；有 decisionId 精确匹配，否则取该下属最新一条）。 */
function findDelegationDecision(refs: {
  bossId?: string;
  decisionId?: string;
  subordinateId?: string;
}): DelegationDecision | undefined {
  const bossIds = refs.bossId
    ? [refs.bossId]
    : agentService.getAllAgents().filter(isBossLikeAgentRef).map((a) => a.id);
  let newest: DelegationDecision | undefined;
  for (const bossId of bossIds) {
    let history: DelegationDecision[] = [];
    try {
      history = bossService.getDelegationHistory(bossId);
    } catch {
      continue;
    }
    for (const decision of history) {
      if (refs.decisionId) {
        if (decision.id === refs.decisionId) return decision;
      } else if (refs.subordinateId && decision.selectedAgentId === refs.subordinateId) {
        if (!newest || decision.timestamp > newest.timestamp) newest = decision;
      }
    }
  }
  return newest;
}

/** 取消通知文案（forceInterrupt 投递；要求下属停手并简单说明现状）。 */
function buildCancelNotice(input: { bossName: string; taskText: string; reason?: string }): string {
  const reasonLine = input.reason ? `\n撤回原因：${summarizeQuotaText(input.reason, 120)}` : '';
  // 任务17·A3 契约对齐：停止回执用 status="failed" 免验收/产出字段；若确已完成而报 completed，
  // 必须带 outputLocation + 非空 acceptance，否则 report-task 400 被拒（避免停手回执先 400 再重发）。
  return `[TASK CANCELLED by boss "${input.bossName}"]\n\n这个任务已被撤回，请立即停止当前工作，不要再继续执行。已经产生的阶段性产出保留现状，简单说一句进度即可。${reasonLine}\n\n若要回报停手：用 "status":"failed"（无需 acceptance/outputLocation）；若确已完成而报 "completed"，必须带 outputLocation 与非空 acceptance（逐条 {"item","done"}），否则会被 report-task 以 HTTP 400 拒绝。\n\n任务：${summarizeQuotaText(input.taskText, 120)}`;
}

/** 配额撤回安全壳：gate 异常不得拦断撤回链路（15·A/gate 内部审计已自包，这里兜底）。 */
function cancelQuotaSafely(input: Parameters<typeof cancelDelegationQuotaSlot>[0]): DelegationQuotaCancelResult {
  try {
    return cancelDelegationQuotaSlot(input);
  } catch (err) {
    log.error(`[quota] cancel failed — continuing cancel chain:`, err);
    return { status: 'not-found' };
  }
}

/**
 * 任务16·⑬ 撤回执行链（单一漏斗；vcs 解析目标后调用，本函数不猜口味）：
 * 1. 定位：activeDelegations（running）→ 配额排队快照（queued）→ 委派史卡片（tracking 残留）；
 * 2. 守卫：卡 done → rejected-done（拒撤，零副作用）；卡 cancelled → already-cancelled（幂等）；
 * 3. 配额：queued 从队列移除（不派发）；running 释放槽位并复用完成语义出队队首；
 * 4. 卡迁移 cancelled + 追踪清理 + 旧回执移除（removePendingReceiptsForAgent）；
 * 5. 通知下属：sendCommand(forceInterrupt)；失败降级 stopAgent 兜底，再失败如实登记，**绝不上抛**；
 * 6. ⑬ 审计：logDelegation phase='cancelled'（发起方/原因/目标/投递；status 记撤回结论）。
 * 返回结果供 vcs 播报；重复撤回第二次稳定走 already-cancelled（不重复通知）。
 * 边界（v1 从简，测试钉住）：撤回只作用于「已派发/在排队」的任务，不追回已产出结果；
 * 不做「停止确认回执」登记（下属停止确认依赖其下一轮输出，见任务16 报告登记项）。
 */
export async function cancelDelegation(input: CancelDelegationInput): Promise<CancelDelegationOutcome> {
  ensureActiveDelegationsRebuilt(); // HC-B7：撤回定位前重建（重启后的在办任务可撤）
  const at = input.at ?? Date.now();
  const outcome: CancelDelegationOutcome = { status: 'not-found', notified: false, cardMigrated: false };

  // ── 1) 定位 live 追踪 / 排队载荷 / 委派史 ──
  let liveSubordinateId: string | undefined;
  let live: ActiveDelegation | undefined;
  if (input.subordinateId && activeDelegations.has(input.subordinateId)) {
    liveSubordinateId = input.subordinateId;
    live = activeDelegations.get(input.subordinateId);
  } else {
    for (const [sid, entry] of activeDelegations) {
      const hit = (input.decisionId && entry.decisionId === input.decisionId)
        || (input.taskId && entry.taskId === input.taskId);
      if (hit) {
        liveSubordinateId = sid;
        live = entry;
        break;
      }
    }
  }

  const snapshot = getDelegationQuotaSnapshotForCancel();
  const queuedHit = snapshot.find((p) =>
    (input.taskId !== undefined && p.taskId === input.taskId)
    || (input.decisionId !== undefined && p.decisionId === input.decisionId)
  );

  const bossId = input.bossId ?? live?.bossId ?? queuedHit?.bossId;
  const decisionId = input.decisionId ?? live?.decisionId ?? queuedHit?.decisionId;
  const targetSubordinateId =
    liveSubordinateId ?? queuedHit?.selectedAgentId ?? input.subordinateId;
  const decision = findDelegationDecision({
    ...(bossId ? { bossId } : {}),
    ...(decisionId ? { decisionId } : {}),
    ...(!decisionId && targetSubordinateId ? { subordinateId: targetSubordinateId } : {}),
  });
  const card = decision?.taskCard;
  const label = card?.objective?.trim() || live?.taskDescription || queuedHit?.taskCommand || decision?.userCommand;
  if (bossId) outcome.bossId = bossId;
  if (decisionId) outcome.decisionId = decisionId;
  if (targetSubordinateId) {
    outcome.subordinateId = targetSubordinateId;
    const name = agentService.getAgent(targetSubordinateId)?.name;
    if (name) outcome.subordinateName = name;
  }
  const resolvedTaskId = input.taskId ?? live?.taskId ?? queuedHit?.taskId;
  if (resolvedTaskId) outcome.taskId = resolvedTaskId;
  if (label) outcome.label = label;

  // ── 2) 守卫（卡状态是权威）：done 拒撤 / cancelled 幂等 ──
  if (card?.status === 'done') {
    outcome.status = 'rejected-done';
    auditCancellation(outcome, input, at);
    return outcome;
  }
  if (card?.status === 'cancelled') {
    outcome.status = 'already-cancelled';
    auditCancellation(outcome, input, at);
    return outcome;
  }

  // ── 3) 模式选择 ──
  let mode: 'queued' | 'running' | 'tracking' | undefined;
  if (live && liveSubordinateId) mode = 'running';
  else if (queuedHit) mode = 'queued';
  else if (card && (card.status === 'pending' || card.status === 'queued' || card.status === 'running')) mode = 'tracking';
  if (!mode) {
    // 无目标可撤（无追踪/无排队/无在办卡）：明确 not-found，不猜不写
    outcome.status = 'not-found';
    auditCancellation(outcome, input, at);
    return outcome;
  }
  outcome.status = 'cancelled';
  outcome.cancelledFrom = mode;

  // ── 4) 配额账本处理（⑬ 独立通路；gate 内部绝不上抛）──
  let dequeued: QueuedDelegation | null = null;
  if (mode === 'queued' && queuedHit) {
    cancelQuotaSafely({
      quotaId: queuedHit.taskId ?? queuedHit.decisionId,
      ...(queuedHit.taskId ? { taskId: queuedHit.taskId } : {}),
      decisionId: queuedHit.decisionId,
      bossId: queuedHit.bossId,
      selectedAgentId: queuedHit.selectedAgentId,
      initiator: input.initiator,
      reason: input.reason,
      at,
    });
  } else if (mode === 'running' && live) {
    const quotaId = live.taskId ?? live.decisionId;
    if (quotaId) {
      const gateResult = cancelQuotaSafely({
        quotaId,
        ...(live.taskId ? { taskId: live.taskId } : {}),
        ...(live.decisionId ? { decisionId: live.decisionId } : {}),
        bossId: live.bossId,
        ...(liveSubordinateId ? { selectedAgentId: liveSubordinateId } : {}),
        initiator: input.initiator,
        reason: input.reason,
        at,
      });
      if (gateResult.status === 'running-released' && gateResult.dequeued) dequeued = gateResult.dequeued;
    }
  }

  // ── 5) 卡迁移 cancelled（无卡/史裁剪 → no-op，不拦断）──
  if (card && bossId && decision?.id) {
    const migrated = bossService.updateDelegationTaskCardStatus(bossId, decision.id, 'cancelled', {
      at,
      reason: input.reason ?? 'cancelled',
      subordinateId: targetSubordinateId,
      taskId: resolvedTaskId,
    });
    outcome.cardMigrated = !!migrated;
  }

  // ── 6) 追踪清理 + 旧回执移除（撤后不再匹配/播报回执）──
  if (targetSubordinateId) {
    activeDelegations.delete(targetSubordinateId);
    removePendingReceiptsForAgent(targetSubordinateId);
  }

  // ── 7) 通知下属（queued 未派发 → 不通知；失败降级 stopAgent，绝不上抛）──
  if (mode !== 'queued' && targetSubordinateId) {
    const notifyStarted = Date.now();
    const bossName = bossId ? agentService.getAgent(bossId)?.name ?? bossId : '主管';
    const targetAgent = agentService.getAgent(targetSubordinateId);
    // 待岗 (standby) 目标：进程本就已停、撤回通知必被底层守卫拒绝——直接抑制，
    // 不做无意义的投递与 stopAgent 降级（第 6 步追踪清理已完成，撤回语义完整）。
    if (isOnStandby(targetAgent)) {
      log.log(`[cancel] Cancel notice suppressed — ${targetAgent?.name ?? targetSubordinateId} is on standby (待岗)`);
    } else {
      const customAgentConfig = targetAgent
        ? buildCustomAgentConfig(targetSubordinateId, targetAgent.class)
        : undefined;
      try {
        await runtimeService.sendCommand(
          targetSubordinateId,
          buildCancelNotice({
            bossName,
            taskText: label || '(未记录任务)',
            reason: input.reason,
          }),
          undefined,
          undefined,
          customAgentConfig,
          { forceInterrupt: true }
        );
        outcome.notified = true;
      } catch (err) {
        outcome.notifyError = err instanceof Error ? err.message : String(err);
        try {
          await runtimeService.stopAgent(targetSubordinateId);
          outcome.stopFallbackUsed = true;
        } catch (fallbackErr) {
          outcome.notifyError += `; stopAgent failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`;
        }
      }
    }
    outcome.notifyMs = Date.now() - notifyStarted;
  }

  // ── 8) ⑬ 审计 + 出队派发（派发放最后；若与撤回同一 subordinate，通知已先送达）──
  auditCancellation(outcome, input, at);
  if (dequeued) {
    outcome.dequeuedDecisionId = dequeued.decisionId;
    dispatchQueuedDelegation(dequeued);
  }
  return outcome;
}

/** ⑬ 审计：撤回事件（谁发/原因/目标/通知投递）。审计是旁路，绝不上抛。 */
function auditCancellation(outcome: CancelDelegationOutcome, input: CancelDelegationInput, at: number): void {
  try {
    const status = outcome.cancelledFrom ? `cancelled-${outcome.cancelledFrom}` : outcome.status;
    logDelegation({
      phase: 'cancelled',
      channel: 'boss',
      fromAgentId: outcome.bossId,
      toAgentId: outcome.subordinateId,
      toAgentName: outcome.subordinateName,
      message: outcome.label,
      status,
      error: outcome.notifyError,
      initiator: input.initiator ?? 'unknown',
      reason: input.reason,
      notified: outcome.notified,
      notifyMs: outcome.notifyMs,
      taskId: outcome.taskId,
    });
  } catch (err) {
    log.error(`[cancel] audit failed (cancel chain unaffected):`, err);
  }
}

/** 配额排队快照（撤回定位用；缺省容错——快照异常按空队列，撤回退化为 tracking/not-found）。 */
function getDelegationQuotaSnapshotForCancel(): QueuedDelegation[] {
  try {
    return getDelegationQuotaSnapshot().queued;
  } catch (err) {
    log.error(`[quota] snapshot failed during cancel — falling back to history only:`, err);
    return [];
  }
}

type DelegationPayload = {
  selectedAgentId: string;
  selectedAgentName: string;
  taskCommand: string;
  reasoning: string;
  alternativeAgents: string[];
  confidence: 'high' | 'medium' | 'low';
  /** ⑦ 任务卡（可选增强）：格式错误降级为无卡，不阻塞派活 */
  taskCard?: TaskCard;
};

// Shared hint appended to every block parse error so the boss can self-correct.
const JSON_BLOCK_HINT =
  'Ensure the block is strictly valid JSON: no trailing commas, no unescaped quotes, no raw garbled/replacement characters, and every \\u escape followed by EXACTLY 4 hex digits.';

function describeParseError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Surface a parse failure for a fenced boss block back to the user/boss terminal
 * instead of swallowing it silently. `blockType` (e.g. "Delegation", "Spawn",
 * "Work-plan") becomes the visible "<blockType> parse error" prefix.
 */
function broadcastBlockParseError(
  broadcast: BroadcastFn,
  bossId: string,
  bossName: string,
  blockType: string,
  message: string
): void {
  broadcast({
    type: 'output',
    payload: {
      agentId: bossId,
      text: `${blockType} parse error (${bossName}): ${message}`,
      isStreaming: false,
      timestamp: Date.now(),
      isDelegation: true,
    },
  });
}

function broadcastDelegationError(
  broadcast: BroadcastFn,
  bossId: string,
  bossName: string,
  message: string
): void {
  broadcastBlockParseError(broadcast, bossId, bossName, 'Delegation', message);
}

/**
 * 待岗 (standby) 拒绝的可视反馈：**不复用** broadcastDelegationError——其前缀
 * 硬编码 "Delegation parse error"，会误导 Boss 去改 JSON。这里发明确的 refusal
 * 进 Boss 自己的输出流（isDelegation:true 同族），Boss 由此知晓「目标待岗、
 * 需用户恢复」而不是在解析层瞎猜。
 */
function broadcastDelegationRefusal(
  broadcast: BroadcastFn,
  bossId: string,
  bossName: string,
  message: string
): void {
  broadcast({
    type: 'output',
    payload: {
      agentId: bossId,
      text: `⏸ Delegation refused (${bossName}): ${message}`,
      isStreaming: false,
      timestamp: Date.now(),
      isDelegation: true,
    },
  });
}

/**
 * Re-parse a fenced block's body to recover the underlying JSON.parse error
 * message. Returns undefined when the fence is absent or the JSON is actually
 * valid (i.e. the failure was a validation issue, not a syntax error).
 */
function diagnoseFencedJsonError(resultText: string, fence: string): string | undefined {
  const match = resultText.match(new RegExp('```' + fence + '\\s*([\\s\\S]*?)```'));
  if (!match) return undefined;
  const body = match[1].trim();
  if (!body) return 'block body is empty';
  try {
    JSON.parse(body);
    return undefined;
  } catch (err) {
    return describeParseError(err);
  }
}

function extractDelegationBlocks(resultText: string): string[] {
  const blocks: string[] = [];
  const regex = /```delegation\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(resultText)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

function extractJsonSegments(text: string): string[] {
  const segments: string[] = [];
  let i = 0;

  while (i < text.length) {
    const startArray = text.indexOf('[', i);
    const startObject = text.indexOf('{', i);
    let start = -1;
    if (startArray === -1) {
      start = startObject;
    } else if (startObject === -1) {
      start = startArray;
    } else {
      start = Math.min(startArray, startObject);
    }
    if (start === -1) break;

    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let j = start; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '[' || ch === '{') {
        stack.push(ch);
        continue;
      }

      if (ch === ']' || ch === '}') {
        const open = stack[stack.length - 1];
        const validPair = (open === '[' && ch === ']') || (open === '{' && ch === '}');
        if (!validPair) {
          break;
        }
        stack.pop();
        if (stack.length === 0) {
          end = j + 1;
          break;
        }
      }
    }

    if (end === -1) break;
    segments.push(text.slice(start, end));
    i = end;
  }

  return segments;
}

function parseDelegationBlockToArray(block: string): { items: unknown[]; parseError?: string } {
  const direct = block.trim();
  if (!direct) return { items: [] };
  try {
    const parsed = JSON.parse(direct);
    return { items: Array.isArray(parsed) ? parsed : [parsed] };
  } catch (err) {
    // Keep the original syntax error so we can surface it if nothing parses.
    const parseError = describeParseError(err);
    const parsedSegments: unknown[] = [];
    for (const segment of extractJsonSegments(block)) {
      try {
        const parsed = JSON.parse(segment);
        if (Array.isArray(parsed)) {
          parsedSegments.push(...parsed);
        } else {
          parsedSegments.push(parsed);
        }
      } catch {
        // Continue trying subsequent JSON-like segments.
      }
    }
    return {
      items: parsedSegments,
      parseError: parsedSegments.length === 0 ? parseError : undefined,
    };
  }
}

function validateDelegationPayload(
  raw: unknown,
  originalCommand: string
): { payload?: DelegationPayload; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'delegation item must be an object' };
  }

  const item = raw as Record<string, unknown>;
  const selectedAgentId = typeof item.selectedAgentId === 'string' ? item.selectedAgentId.trim() : '';
  const selectedAgentName = typeof item.selectedAgentName === 'string' ? item.selectedAgentName.trim() : '';
  const explicitTask = typeof item.taskCommand === 'string' ? item.taskCommand.trim() : '';
  const fallbackTask = originalCommand.trim();
  const taskCommand = explicitTask || fallbackTask;

  if (!selectedAgentId) return { error: 'selectedAgentId is required' };
  if (!selectedAgentName) return { error: 'selectedAgentName is required' };
  if (!taskCommand) return { error: 'taskCommand is required (or last boss command must be available)' };

  const reasoning = typeof item.reasoning === 'string' ? item.reasoning : '';

  let alternativeAgents: string[] = [];
  if (item.alternativeAgents !== undefined) {
    if (!Array.isArray(item.alternativeAgents) || item.alternativeAgents.some((a) => typeof a !== 'string')) {
      return { error: 'alternativeAgents must be an array of strings' };
    }
    alternativeAgents = item.alternativeAgents;
  }

  let confidence: 'high' | 'medium' | 'low' = 'medium';
  if (item.confidence !== undefined) {
    if (item.confidence !== 'high' && item.confidence !== 'medium' && item.confidence !== 'low') {
      return { error: 'confidence must be one of high|medium|low' };
    }
    confidence = item.confidence;
  }

  // ⑦ 任务卡（可选增强）：格式错误只降级为「无卡」，不整条拒绝 —— 旧消息无卡按纯文本处理
  let taskCard: TaskCard | undefined;
  if (item.taskCard !== undefined) {
    const parsedCard = normalizeTaskCard(item.taskCard);
    if (parsedCard.card) {
      taskCard = parsedCard.card;
    } else {
      log.warn(`Ignoring malformed delegation taskCard from boss: ${parsedCard.errors.join('; ')}`);
    }
  }

  return {
    payload: {
      selectedAgentId,
      selectedAgentName,
      taskCommand,
      reasoning,
      alternativeAgents,
      confidence,
      ...(taskCard ? { taskCard } : {}),
    },
  };
}

/**
 * Parse delegation block from boss response
 */
export function parseBossDelegation(
  agentId: string,
  bossName: string,
  resultText: string,
  broadcast: BroadcastFn
): void {
  log.log(`parseBossDelegation called for boss ${bossName}, resultText length=${resultText.length}`);
  const blocks = extractDelegationBlocks(resultText);
  if (blocks.length === 0) return;

  log.log(`Boss ${bossName} found ${blocks.length} delegation block(s)`);
  const originalCommand = getLastBossCommand(agentId) || '';
  const now = Date.now();

  for (const [key, timestamp] of processedDelegations) {
    if (now - timestamp > DELEGATION_DEDUP_WINDOW_MS) {
      processedDelegations.delete(key);
    }
  }

  let anyParsed = false;
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    const { items: parsedItems, parseError } = parseDelegationBlockToArray(block);

    if (parsedItems.length === 0) {
      const detail = parseError
        ? `JSON.parse failed: ${parseError}. ${JSON_BLOCK_HINT}`
        : `no valid JSON object/array found. ${JSON_BLOCK_HINT}`;
      const message = `block #${blockIndex + 1}: ${detail}`;
      log.error(`Failed to parse delegation JSON from boss ${bossName}: ${message}`);
      broadcastDelegationError(broadcast, agentId, bossName, message);
      continue;
    }

    anyParsed = true;
    log.log(`Boss ${bossName} parsed ${parsedItems.length} delegation item(s) from block #${blockIndex + 1}`);

    for (let itemIndex = 0; itemIndex < parsedItems.length; itemIndex++) {
      const rawItem = parsedItems[itemIndex];
      const validated = validateDelegationPayload(rawItem, originalCommand);

      if (!validated.payload) {
        const message = `block #${blockIndex + 1}, item #${itemIndex + 1}: ${validated.error}`;
        log.error(`Invalid delegation payload from boss ${bossName}: ${message}`);
        broadcastDelegationError(broadcast, agentId, bossName, message);
        continue;
      }

      const delegationJson = validated.payload;
      // 待岗 (standby) 守卫：放在去重/配额/落史之前——拒绝零侧效应（不进去重表、
      // 不扣配额、不进委派史、不落卡、不登记回执）。顺带把「agent id 不存在」也
      // 显式拒绝：此前它会沉进 sendCommand 的 "Agent not found" 异常。
      const delegationTarget = agentService.getAgent(delegationJson.selectedAgentId);
      if (!delegationTarget || isOnStandby(delegationTarget)) {
        const message = `block #${blockIndex + 1}, item #${itemIndex + 1}: ${!delegationTarget
          ? `agent id "${delegationJson.selectedAgentId}" does not exist`
          : standbyRefusalMessage(delegationTarget)}`;
        log.warn(`Delegation refused from boss ${bossName}: ${message}`);
        broadcastDelegationRefusal(broadcast, agentId, bossName, message);
        continue;
      }

      const dedupKey = `${agentId}:${delegationJson.selectedAgentId}:${delegationJson.taskCommand}`;
      if (processedDelegations.has(dedupKey)) {
        log.log(`Skipping duplicate delegation to ${delegationJson.selectedAgentName}: "${delegationJson.taskCommand.slice(0, 50)}..."`);
        continue;
      }

      processedDelegations.set(dedupKey, now);
      log.log(`Delegation to ${delegationJson.selectedAgentName}: "${delegationJson.taskCommand.slice(0, 80)}..."`);

      const decisionTimestamp = Date.now();
      // ⑦ 现场组卡：状态机从 pending 起（statusUpdatedAt = 落卡时间），随委派史落盘
      let taskCard: TaskCard | undefined = delegationJson.taskCard
        ? { ...delegationJson.taskCard, status: 'pending', statusUpdatedAt: decisionTimestamp }
        : undefined;
      // HC-B5：主管按提示词不再猜项目 id——卡缺 projectId 时，从 vcs 路由侧「最近一次交给
      // 该主管的派发」回填（同 14·B 别名表 id 空间；TTL 120s）。仅回填存在的卡，不凭空造卡。
      if (taskCard && !taskCard.projectId) {
        const dispatch = getLastBossDispatch();
        if (dispatch && dispatch.bossId === agentId && dispatch.projectId) {
          taskCard = { ...taskCard, projectId: dispatch.projectId };
        }
      }

      const decision: DelegationDecision = {
        id: `del-${decisionTimestamp}-${Math.random().toString(36).slice(2, 11)}`,
        timestamp: decisionTimestamp,
        bossId: agentId,
        userCommand: delegationJson.taskCommand,
        selectedAgentId: delegationJson.selectedAgentId,
        selectedAgentName: delegationJson.selectedAgentName,
        reasoning: delegationJson.reasoning,
        alternativeAgents: delegationJson.alternativeAgents,
        confidence: delegationJson.confidence,
        status: 'sent',
        ...(taskCard ? { taskCard } : {}),
      };

      // 任务 02：委派创建点生成 taskId（链路上下文已有则复用），回执/关闭埋点据此关联
      // 任务15·B：生成提前到闸门之前——配额账本按 taskId 记账（与完成入口同一把钥匙）
      const delegationTaskId = getTaskId() ?? newTaskId();
      // HC-B7：taskId 随决策落盘——重启后从委派史重建追踪仍能还原 taskId 链路
      decision.taskId = delegationTaskId;

      // ── 任务15·B ⑫ 全局并发配额准入（在落卡/落史之前判定；超预算 → queued）──
      // 本循环只处理 Boss 委派链路（秘书自留区不经 parseBossDelegation），scope='delegation' 计配。
      const admission = admitDelegationSafely({
        taskId: delegationTaskId,
        bossId: agentId,
        decisionId: decision.id,
        selectedAgentId: decision.selectedAgentId,
        selectedAgentName: decision.selectedAgentName,
        taskCommand: decision.userCommand,
        taskCard,
        scope: 'delegation',
      });

      bossService.addDelegationToHistory(agentId, decision);
      broadcast({ type: 'delegation_decision', payload: decision });

      if (admission.status === 'queued') {
        // 任务15·B ⑤1：超预算 → 任务卡先 pending 后转 queued（走既有状态日志流）；
        // 跳过运行期登记（activeDelegations/registerPendingReceipt/sendCommand/running 均延到出队）
        if (taskCard) {
          logTaskCardPending({
            decisionId: decision.id,
            bossId: agentId,
            subordinateId: decision.selectedAgentId,
            taskCard,
            taskId: delegationTaskId,
            at: decisionTimestamp,
          });
          bossService.updateDelegationTaskCardStatus(agentId, decision.id, 'queued', {
            at: Date.now(),
            reason: 'quota-exhausted',
            subordinateId: decision.selectedAgentId,
            taskId: delegationTaskId,
          });
        }

        const queuedCount = admission.decision?.queuedCount ?? 0;
        // 不假装已开工：给排队说明（不发 agent_task_started 广播）
        broadcast({
          type: 'output',
          payload: {
            agentId: decision.selectedAgentId,
            text: `⏳ **Task delegated from ${bossName} — queued (concurrency quota):**\n\n${decision.userCommand}`,
            isStreaming: false,
            timestamp: Date.now(),
            isDelegation: true,
          },
        });
        // ⑩ 播报（vcs 既有通道，只 import 不改）：有 N 个排队。
        // projectId 用 taskCard 原值展示——任务14·B 别名替换只落回执前缀，未动配额播报。
        const queueProjectLabel = taskCard?.projectId ? `（项目 ${taskCard.projectId}）` : '';
        logProactiveBroadcast({
          text: `[并发配额] 任务已排队${queueProjectLabel}：${summarizeQuotaText(decision.userCommand)}（当前 ${queuedCount} 个排队）`,
          action: DELEGATION_QUOTA_ACTION,
          taskId: delegationTaskId,
        });
        // 任务 02 埋点：派活决策写入照常（delivery='queue'，status='queued' 标记延后派发）
        logDelegation({
          phase: 'delegated',
          channel: 'boss',
          fromAgentId: agentId,
          fromName: bossName,
          toAgentId: decision.selectedAgentId,
          toAgentName: decision.selectedAgentName,
          message: decision.userCommand,
          delivery: 'queue',
          status: 'queued',
          taskId: delegationTaskId,
        });
        continue; // 运行期登记整体延到出队（dispatchQueuedDelegation）
      }

      // ── 准入路径：与 15·B 前行为一致（sendCommand 定运行期）──

      broadcast({
        type: 'output',
        payload: {
          agentId: decision.selectedAgentId,
          text: `📋 **Task delegated from ${bossName}:**\n\n${decision.userCommand}`,
          isStreaming: false,
          timestamp: Date.now(),
          isDelegation: true,
        },
      });

      log.log(`Sending command to ${decision.selectedAgentName} (${decision.selectedAgentId}): "${decision.userCommand.slice(0, 50)}..."`);

      activeDelegations.set(decision.selectedAgentId, {
        bossId: agentId,
        taskDescription: decision.userCommand,
        taskId: delegationTaskId,
        decisionId: decision.id,
        taskCard,
      });

      // 任务08②：登记待回执订阅（独立于委派追踪——回执时 activeDelegations 被清理，
      // 本登记保留到匹配/TTL 过期，供完成事件组稳定去重键 + 播报文本）
      // 任务14·B：项目归属随登记带入（回执文本【项目别名】前缀的来源）
      registerPendingReceipt({
        targetAgentId: decision.selectedAgentId,
        bossId: agentId,
        taskId: delegationTaskId,
        decisionId: decision.id,
        projectId: taskCard?.projectId,
        taskSummary: decision.userCommand,
      });

      // 任务 02 埋点：基础四类 ③ —— Boss 拆解写入（派活出站）
      logDelegation({
        phase: 'delegated',
        channel: 'boss',
        fromAgentId: agentId,
        fromName: bossName,
        toAgentId: decision.selectedAgentId,
        toAgentName: decision.selectedAgentName,
        message: decision.userCommand,
        delivery: 'queue',
        taskId: delegationTaskId,
      });

      // 🔴 决策观测点⑦：落卡 none → pending（任务卡状态机起点 + 时间）
      if (taskCard) {
        logTaskCardPending({
          decisionId: decision.id,
          bossId: agentId,
          subordinateId: decision.selectedAgentId,
          taskCard,
          taskId: delegationTaskId,
          at: decisionTimestamp,
        });
      }

      broadcast({
        type: 'agent_task_started',
        payload: {
          bossId: agentId,
          subordinateId: decision.selectedAgentId,
          subordinateName: decision.selectedAgentName,
          taskDescription: decision.userCommand,
        },
      } as any);

      const targetAgent = agentService.getAgent(decision.selectedAgentId);
      const customAgentConfig = targetAgent ? buildCustomAgentConfig(decision.selectedAgentId, targetAgent.class) : undefined;

      // Wrap the task command with boss delegation context so the subordinate knows:
      // - Who delegated the task (boss name + ID)
      // - That it should report back when done using the report-task endpoint
      // ⑦ 任务卡：随委托消息附上卡（验收标准对下属可见），旧无卡链路输出不变
      // 任务15·B：构造提为 buildDelegatedMessage（出队派发共用，行为不变）
      const delegatedMessage = buildDelegatedMessage({
        bossId: agentId,
        bossName,
        taskCommand: decision.userCommand,
        taskCard,
      });

      runtimeService.sendCommand(decision.selectedAgentId, delegatedMessage, undefined, undefined, customAgentConfig)
        .then(() => {
          // 🔴 决策观测点⑦：交付成功 → pending → running（卡状态；queued 语义见 15·B 出队路径）
          if (taskCard) {
            bossService.updateDelegationTaskCardStatus(agentId, decision.id, 'running', {
              at: Date.now(),
              reason: 'dispatched',
              subordinateId: decision.selectedAgentId,
              taskId: delegationTaskId,
            });
          }
        })
        .catch(err => {
          log.error(`Failed to auto-forward command to ${decision.selectedAgentName}:`, err);
          // 任务 02 埋点：基础四类 ③ —— Boss 派活失败行（channel 与成功行一致）
          logDelegation({
            phase: 'failed',
            channel: 'boss',
            fromAgentId: agentId,
            fromName: bossName,
            toAgentId: decision.selectedAgentId,
            toAgentName: decision.selectedAgentName,
            message: decision.userCommand,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
            taskId: delegationTaskId,
          });
        });
    }
  }

  if (!anyParsed) {
    const message = 'no valid delegation payloads were parsed';
    log.error(`Failed to parse delegation JSON from boss ${bossName}: ${message}`);
    broadcastDelegationError(broadcast, agentId, bossName, message);
  }
}

/**
 * Parse spawn block from boss response
 */
export async function parseBossSpawn(
  bossId: string,
  bossName: string,
  resultText: string,
  broadcast: BroadcastFn,
  sendActivity: SendActivityFn
): Promise<void> {
  log.log(` Boss ${bossName} checking for spawn block: ${resultText.includes('```spawn')}`);

  const spawnMatch = resultText.match(/```spawn\s*\n([\s\S]*?)\n```/);
  if (!spawnMatch) return;

  log.log(` Boss ${bossName} spawn match found!`);
  try {
    const parsed = JSON.parse(spawnMatch[1].trim());
    const spawns = Array.isArray(parsed) ? parsed : [parsed];

    log.log(` Parsed ${spawns.length} spawn request(s) from boss ${bossName}`);

    const boss = agentService.getAgent(bossId);
    const bossCwd = boss?.cwd || process.cwd();
    const builtInClassIds = Object.keys(BUILT_IN_AGENT_CLASSES).filter(c => c !== 'boss');
    const customClassIds = getAllCustomClasses().map(c => c.id);
    const validClasses = [...builtInClassIds, ...customClassIds];

    for (const spawnRequest of spawns) {
      const {
        name,
        class: agentClass,
        cwd,
        model,
        codexModel,
        opencodeModel,
        grokModel,
        piModel,
        effort,
        initialSkillIds,
        provider,
        customInstructions,
        codexConfig,
        permissionMode,
      } = spawnRequest;

      if (!name || !agentClass) {
        log.error(` Spawn request missing required fields (name, class):`, spawnRequest);
        continue;
      }

      if (!validClasses.includes(agentClass)) {
        log.error(` Invalid agent class "${agentClass}". Must be one of: ${validClasses.join(', ')}`);
        continue;
      }

      let safeProvider: AgentProvider | undefined;
      if (provider !== undefined) {
        if (provider === 'claude' || provider === 'codex' || provider === 'opencode' || provider === 'grok' || provider === 'pi') {
          safeProvider = provider;
        } else {
          log.warn(` Spawn: invalid provider "${provider}" — falling back to default. Allowed: claude, codex, opencode, grok, pi.`);
        }
      }

      let safeEffort: ClaudeEffort | undefined;
      if (effort !== undefined) {
        if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xHigh' || effort === 'max') {
          safeEffort = effort;
        } else {
          log.warn(` Spawn: invalid effort "${effort}" — ignoring. Allowed: low, medium, high, xHigh, max.`);
        }
      }

      let safeSkillIds: string[] | undefined;
      if (initialSkillIds !== undefined) {
        if (Array.isArray(initialSkillIds) && initialSkillIds.every(s => typeof s === 'string')) {
          safeSkillIds = initialSkillIds;
        } else {
          log.warn(` Spawn: initialSkillIds must be an array of strings — ignoring.`);
        }
      }

      const agentCwd = cwd || bossCwd;
      log.log(` Boss ${bossName} spawning new ${agentClass} agent: "${name}" in ${agentCwd}`);

      try {
        const newAgent = await agentService.createAgent(
          name,
          agentClass as AgentClass,
          agentCwd,
          undefined, // position
          undefined, // sessionId
          undefined, // useChrome
          (permissionMode as PermissionMode | undefined) ?? 'bypass',
          safeSkillIds,
          undefined, // isBoss
          model as ClaudeModel | undefined,
          codexModel as CodexModel | undefined,
          typeof customInstructions === 'string' ? customInstructions : undefined,
          safeProvider,
          codexConfig as CodexConfig | undefined,
          safeEffort,
          opencodeModel as OpencodeModel | undefined,
          grokModel as GrokModel | undefined,
          piModel as PiModel | undefined
        );

        // Assign initial skills (mirrors agent-handler behavior). Combine
        // explicitly requested skills with the class's default skills.
        const requestedSkills = safeSkillIds ?? [];
        const classDefaultSkills = getClassDefaultSkillIds(newAgent.class);
        const allSkillIds = [...new Set([...requestedSkills, ...classDefaultSkills])];
        for (const skillId of allSkillIds) {
          try {
            skillService.assignSkillToAgent(skillId, newAgent.id);
          } catch (skillErr) {
            log.warn(` Failed to assign skill "${skillId}" to ${newAgent.name}: ${skillErr}`);
          }
        }

        const currentSubordinates = bossService.getSubordinates(bossId).map(a => a.id);
        const newSubordinates = [...currentSubordinates, newAgent.id];
        bossService.assignSubordinates(bossId, newSubordinates);

        log.log(` Successfully spawned agent ${newAgent.name} (${newAgent.id}) for boss ${bossName}`);

        broadcast({
          type: 'boss_spawned_agent',
          payload: {
            agent: newAgent,
            bossId,
            bossPosition: boss?.position || { x: 0, y: 0, z: 0 },
          },
        });

        sendActivity(newAgent.id, `${newAgent.name} deployed by ${bossName}`);
        broadcast({
          type: 'boss_subordinates_updated',
          payload: { bossId, subordinateIds: newSubordinates },
        });
      } catch (err) {
        log.error(` Failed to spawn agent "${name}" for boss ${bossName}:`, err);
      }
    }
  } catch (err) {
    const message = `JSON.parse failed: ${describeParseError(err)}. ${JSON_BLOCK_HINT}`;
    log.error(` Failed to parse spawn JSON from boss ${bossName}: ${message}`);
    broadcastBlockParseError(broadcast, bossId, bossName, 'Spawn', message);
  }
}

/**
 * Parse work-plan block from boss response
 */
export function parseBossWorkPlan(
  bossId: string,
  bossName: string,
  resultText: string,
  broadcast: BroadcastFn
): void {
  const hasWorkPlanFence = resultText.includes('```work-plan');
  log.log(` Boss ${bossName} checking for work-plan block: ${hasWorkPlanFence}`);

  const workPlanDraft = workPlanService.parseWorkPlanBlock(resultText);
  if (!workPlanDraft) {
    // A fence was present but parsing/validation failed — surface it instead of
    // dropping the work plan silently.
    if (hasWorkPlanFence) {
      const parseError = diagnoseFencedJsonError(resultText, 'work-plan');
      const message = parseError
        ? `JSON.parse failed: ${parseError}. ${JSON_BLOCK_HINT}`
        : 'work-plan JSON parsed but is missing required fields (expected "name" and a "phases" array).';
      log.error(` Failed to parse work-plan from boss ${bossName}: ${message}`);
      broadcastBlockParseError(broadcast, bossId, bossName, 'Work-plan', message);
    }
    return;
  }

  log.log(` Boss ${bossName} work-plan match found! Creating plan: "${workPlanDraft.name}"`);

  try {
    const workPlan = workPlanService.createWorkPlan(bossId, workPlanDraft);

    // Broadcast the created work plan
    broadcast({
      type: 'work_plan_created',
      payload: workPlan,
    });

    log.log(` Created work plan "${workPlan.name}" with ${workPlan.totalTasks} tasks (${workPlan.parallelizableTasks.length} parallelizable)`);
  } catch (err) {
    log.error(` Failed to create work plan from boss ${bossName}:`, err);
  }
}

/**
 * Parse analysis-request block from boss response
 */
export function parseBossAnalysisRequest(
  bossId: string,
  bossName: string,
  resultText: string,
  broadcast: BroadcastFn,
  sendActivity: SendActivityFn
): void {
  log.log(` Boss ${bossName} checking for analysis-request block: ${resultText.includes('```analysis-request')}`);

  const analysisDrafts = workPlanService.parseAnalysisRequestBlock(resultText);
  if (analysisDrafts.length === 0) return;

  log.log(` Boss ${bossName} analysis-request match found! ${analysisDrafts.length} request(s)`);

  for (const draft of analysisDrafts) {
    try {
      // Create the analysis request
      const request = workPlanService.createAnalysisRequest(bossId, draft);

      // Broadcast the created request
      broadcast({
        type: 'analysis_request_created',
        payload: request,
      });

      // Start the analysis by sending the query to the target agent
      workPlanService.startAnalysisRequest(request.id);

      // Get agent name for activity message
      const targetAgent = agentService.getAgent(draft.targetAgent);
      const agentName = targetAgent?.name || draft.targetAgent;

      // Send activity notification
      sendActivity(draft.targetAgent, `Analysis requested by ${bossName}`);

      // Send the analysis query as a command to the scout
      const focusContext = draft.focus && draft.focus.length > 0
        ? `\n\nFocus areas: ${draft.focus.join(', ')}`
        : '';

      const analysisCommand = `[ANALYSIS REQUEST from ${bossName}]\n\n${draft.query}${focusContext}\n\nPlease provide a detailed analysis and report back your findings.`;

      // Build custom config for the target agent
      const customAgentConfig = targetAgent ? buildCustomAgentConfig(draft.targetAgent, targetAgent.class) : undefined;

      runtimeService.sendCommand(draft.targetAgent, analysisCommand, undefined, undefined, customAgentConfig)
        .catch(err => {
          log.error(` Failed to send analysis request to ${agentName}:`, err);
        });

      log.log(` Started analysis request to ${agentName}: "${draft.query.slice(0, 60)}..."`);
    } catch (err) {
      log.error(` Failed to create analysis request from boss ${bossName}:`, err);
    }
  }
}

/**
 * Parse all boss response blocks (delegation, spawn, work-plan, analysis-request)
 * Call this from the output handler when a boss agent completes a response
 */
export async function parseAllBossBlocks(
  bossId: string,
  bossName: string,
  resultText: string,
  broadcast: BroadcastFn,
  sendActivity: SendActivityFn
): Promise<void> {
  // Parse in order: analysis-request, work-plan, delegation, spawn
  // This order allows the boss to first request analysis, then create plans, then delegate
  parseBossAnalysisRequest(bossId, bossName, resultText, broadcast, sendActivity);
  parseBossWorkPlan(bossId, bossName, resultText, broadcast);
  parseBossDelegation(bossId, bossName, resultText, broadcast);
  await parseBossSpawn(bossId, bossName, resultText, broadcast, sendActivity);
}
