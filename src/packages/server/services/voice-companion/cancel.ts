/**
 * 语音伙伴服务 — 撤回/评价接线层(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * 目标解析/反问/话术全在 voice/delegation-query.ts(纯逻辑);这里只做数据接线:
 * 从 activeDelegations(handler 导出面) + 配额排队快照 + 委派史拼候选,调 handler 导出执行。
 * 不静态 import boss-response-handler(与 vcs 循环)——执行面用动态 import 取。
 */
import { logger } from '../../utils/index.js';
import * as agentService from '../agent-service.js';
import { logDelegation } from '../activity-log.js';
import { getDelegationQuotaSnapshot } from '../delegation-quota-gate.js';
import {
  buildCancelClarifyQuestion,
  buildCancelNoneResponse,
  consumeCancelClarifyAnswer,
  isActionableCancelState,
  rankCancelCandidates,
  type CancelCandidate,
  type CancelPlan,
} from '../../voice/delegation-query.js';
import type { CancelDelegationOutcome } from '../../websocket/handlers/boss-response-handler.js';
import { truncate } from './contract.js';
import { collectDelegationHistory } from './snapshot.js';
import { VoiceCompanionAbortedError, type VoiceProcessResult } from './types.js';

const log = logger.server;

// ============================================================================
// 任务16·⑬ 撤回/评价 · 接线层
// 目标解析/反问/话术全在 voice/delegation-query.ts(纯逻辑);这里只做数据接线:
// 从 activeDelegations(handler 导出面) + 配额排队快照 + 委派史拼候选,调 handler 导出执行。
// **不静态 import boss-response-handler**(与 vcs 循环) —— 执行面用动态 import 取(同
// deliverToAgent 的 index.js 惯例);类型用 import type(编译期擦除,无运行时环)。
// ============================================================================

/** 撤回反问挂起时效:超时丢弃挂起、按新一轮处理(从简实现,与任务14 同 10 分钟口径)。 */
export const CANCEL_CLARIFY_TTL_MS = 10 * 60_000;
/** 委派史兜底候选上限(仅做 done 拒撤/重启残留判定,不深追溯)。 */
export const CANCEL_HISTORY_MAX = 20;
/** B4 撤回窗口等待:轮询间隔。 */
export const CANCEL_WAIT_POLL_MS = 500;
/** B4 撤回窗口等待:默认上限(env TC_VOICE_CANCEL_WAIT_MS,0 = 关)。 */
export const CANCEL_WAIT_DEFAULT_MS = 10_000;

/**
 * B4/B5：最近一次「交给主管」的派活缓存（vcs 派发成功后写入；{@link LAST_BOSS_DISPATCH_TTL_MS} 内有效）。
 * - B4：撤回落在 dispatched→delegated 的秒级窗口（主管回合还没拆解完，无候选）时，
 *   借此识别「刚交办」并做有界等待（{@link waitFreshDispatchCandidate}）；
 * - B5：主管的委派决策漏填 taskCard.projectId 时，由此回填路由侧项目（与 14·B 别名表同 id 空间）。
 */
export interface LastBossDispatch {
  bossId: string;
  at: number;
  projectId?: string;
  taskId?: string;
}
export const LAST_BOSS_DISPATCH_TTL_MS = 120_000;
let lastBossDispatch: LastBossDispatch | null = null;

/** 记录一次对主管的派发（vcs 派发成功点调用，供 B4/B5 消费）。 */
export function recordLastBossDispatch(entry: LastBossDispatch): void {
  lastBossDispatch = entry;
}

/** 取 TTL 内最近一次对主管的派发（过期返回 null；不主动清理，下次写入覆盖）。 */
export function getLastBossDispatch(): LastBossDispatch | null {
  if (!lastBossDispatch) return null;
  if (Date.now() - lastBossDispatch.at > LAST_BOSS_DISPATCH_TTL_MS) return null;
  return lastBossDispatch;
}

/** 清空派发缓存（测试隔离）。 */
export function resetLastBossDispatchForTests(): void {
  lastBossDispatch = null;
}

export interface PendingCancelClarification {
  question: string;
  candidates: CancelCandidate[];
  askedAt: number;
  taskId?: string;
}

let pendingCancel: PendingCancelClarification | null = null;

/** 清空撤回挂起(会话轮换/重置/测试)。 */
export function resetCancelClarificationSession(): void {
  pendingCancel = null;
}

/** 读撤回反问挂起(服务主流程判定是否走一次性反问消费;无挂起 → null)。 */
export function getPendingCancelClarification(): PendingCancelClarification | null {
  return pendingCancel;
}

/** 登记撤回反问挂起(主流程 plan.kind==='ask' 时写入;一次性消费见 consumeCancelClarification)。 */
export function setPendingCancelClarification(pending: PendingCancelClarification): void {
  pendingCancel = pending;
}

/**
 * 撤回候选收集:
 * - live:activeDelegations(running 实时)+ 配额排队快照(queued),按 decisionId 去重;
 * - history:委派史(带卡;live 已有的剔除,取最近 CANCEL_HISTORY_MAX 条)——
 *   用于 done 拒撤/已撤过/重启后卡片残留(tracking)的定位。
 */
export async function collectCancelCandidates(): Promise<{ live: CancelCandidate[]; history: CancelCandidate[] }> {
  const agents = agentService.getAllAgents();
  const byId = new Map(agents.map((a) => [a.id, a]));
  const handler = await import('../../websocket/handlers/boss-response-handler.js');
  handler.ensureActiveDelegationsRebuilt(); // HC-B7：重启后首个候选读取前重建追踪（不重建则撤回看不到在办）

  const live: CancelCandidate[] = [];
  const seen = new Set<string>();
  for (const [subordinateId, entry] of handler.activeDelegations) {
    const card = entry.taskCard;
    live.push({
      subordinateId,
      subordinateName: byId.get(subordinateId)?.name,
      bossId: entry.bossId,
      decisionId: entry.decisionId,
      taskId: entry.taskId,
      label: card?.objective?.trim() || entry.taskDescription,
      projectId: card?.projectId,
      state: card?.status ?? 'running',
      source: 'active',
    });
    if (entry.decisionId) seen.add(entry.decisionId);
  }

  try {
    for (const payload of getDelegationQuotaSnapshot().queued) {
      if (payload.decisionId && seen.has(payload.decisionId)) continue;
      live.push({
        subordinateId: payload.selectedAgentId,
        subordinateName: byId.get(payload.selectedAgentId)?.name ?? payload.selectedAgentName,
        bossId: payload.bossId,
        decisionId: payload.decisionId,
        taskId: payload.taskId,
        label: payload.taskCard?.objective?.trim() || payload.taskCommand,
        projectId: payload.taskCard?.projectId,
        state: 'queued',
        source: 'queued',
      });
      if (payload.decisionId) seen.add(payload.decisionId);
    }
  } catch (err) {
    log.warn(`[VoiceCompanion] 配额排队快照读取失败(撤回按 live 追踪兜底): ${(err as Error).message}`);
  }

  const history: CancelCandidate[] = [];
  for (const decision of collectDelegationHistory(agents)) {
    if (!decision.taskCard || seen.has(decision.id)) continue;
    history.push({
      subordinateId: decision.selectedAgentId,
      subordinateName: byId.get(decision.selectedAgentId)?.name ?? decision.selectedAgentName,
      bossId: decision.bossId,
      decisionId: decision.id,
      label: decision.taskCard.objective?.trim() || decision.userCommand,
      projectId: decision.taskCard.projectId,
      state: decision.taskCard.status,
      source: 'history',
    });
    seen.add(decision.id);
    if (history.length >= CANCEL_HISTORY_MAX) break;
  }
  return { live, history };
}

/** B4 等待预算:env TC_VOICE_CANCEL_WAIT_MS,默认 {@link CANCEL_WAIT_DEFAULT_MS};0 = 关闭(B4 整段回退旧行为)。 */
export function cancelWaitBudgetMs(): number {
  const raw = Number(process.env.TC_VOICE_CANCEL_WAIT_MS ?? String(CANCEL_WAIT_DEFAULT_MS));
  return Number.isFinite(raw) ? Math.max(0, raw) : CANCEL_WAIT_DEFAULT_MS;
}

/**
 * B4：撤回窗口等待——「刚交给主管、委派还没落地」时轮询新候选（每 {@link CANCEL_WAIT_POLL_MS}，
 * 有界 TC_VOICE_CANCEL_WAIT_MS，默认 {@link CANCEL_WAIT_DEFAULT_MS}）。只认快照后新出现、
 * 且属于该主管(bossId)的可撤候选，并按用户原话匹配（复用 rankCancelCandidates 词面逻辑）：
 * 唯一 → match；多个 → ask；超时/环境关闭(0)/信号中断 → null（信号中断抛 abort 语义）。
 * 新候选都不匹配原话时继续等（主管这回合可能先安排了别的活）。
 */
export async function waitFreshDispatchCandidate(
  text: string,
  initialLive: readonly CancelCandidate[],
  initialHistory: readonly CancelCandidate[],
  dispatch: LastBossDispatch,
  signal?: AbortSignal,
): Promise<CancelPlan | null> {
  const waitMs = cancelWaitBudgetMs();
  if (waitMs <= 0) return null;
  const initialIds = new Set(
    [...initialLive, ...initialHistory]
      .map((c) => c.decisionId)
      .filter((id): id is string => !!id),
  );
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CANCEL_WAIT_POLL_MS));
    if (signal?.aborted) throw new VoiceCompanionAbortedError();
    const { live, history } = await collectCancelCandidates();
    const fresh = [...live, ...history].filter(
      (c) =>
        c.bossId === dispatch.bossId &&
        !!c.decisionId &&
        !initialIds.has(c.decisionId) &&
        isActionableCancelState(c.state),
    );
    if (fresh.length === 0) continue;
    const ranked = rankCancelCandidates(text, fresh);
    if (ranked.length === 1) return { kind: 'match', candidate: ranked[0] };
    if (ranked.length > 1) {
      return { kind: 'ask', question: buildCancelClarifyQuestion(ranked), candidates: ranked };
    }
    // ranked 为空：新候选与用户原话对不上 → 继续等（见函数注释）
  }
  return null;
}

/** 撤回结论 → 确定性播报话术(done 拒撤/重复撤回/未送达都如实说,不硬造成功)。 */
export function buildCancelOutcomeResponse(outcome: CancelDelegationOutcome, candidate?: CancelCandidate): string {
  const who = outcome.subordinateName || candidate?.subordinateName || outcome.subordinateId || candidate?.subordinateId || '下属';
  const what = truncate(outcome.label ?? candidate?.label ?? '(未记录任务)', 40);
  switch (outcome.status) {
    case 'cancelled': {
      if (outcome.cancelledFrom === 'queued') {
        // 排队目标从未派发 → 没有「通知停手」这件事，不播成「通知没送达」（如实优先）
        return `好,已撤回「${who}」的「${what}」(还没开工,已从排队中撤下)。`;
      }
      const notify = outcome.notified
        ? `已通知${who}停手。`
        : outcome.stopFallbackUsed
          ? `${who}那边的通知没送达,已先用停止操作兜底。`
          : `${who}那边的停止通知没能送达。`;
      return `好,已撤回「${who}」的「${what}」。${notify}`;
    }
    case 'already-cancelled':
      return '这个任务之前已经撤过了,不用再撤一次。';
    case 'rejected-done':
      return `「${what}」已经完成了,撤不回来。`;
    case 'not-found':
    default:
      return buildCancelNoneResponse();
  }
}

/** 执行一次撤回(解析分支与反问消费共用);handler 绝不上抛,这里再包一层兜底。 */
export async function executeCancel(
  candidate: CancelCandidate,
  input: { initiator: string; reason?: string; taskId?: string },
): Promise<{ response: string; outcome?: CancelDelegationOutcome }> {
  try {
    const handler = await import('../../websocket/handlers/boss-response-handler.js');
    const outcome = await handler.cancelDelegation({
      subordinateId: candidate.subordinateId,
      bossId: candidate.bossId,
      ...(candidate.decisionId ? { decisionId: candidate.decisionId } : {}),
      ...(candidate.taskId ? { taskId: candidate.taskId } : {}),
      initiator: input.initiator,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return { response: buildCancelOutcomeResponse(outcome, candidate), outcome };
  } catch (err) {
    log.error(`[VoiceCompanion] 撤回执行异常(降级为明确话术): ${(err as Error).message}`);
    return { response: '撤回没能完成,过会儿再喊我试一次。' };
  }
}

/**
 * 一次性反问消费(在 hop1 之前):上一回合撤回反问挂了 → 本回合先按「回答」消费一次。
 * 返回 null = 无挂起/已过期/回答指代不明(丢弃挂起,按普通回合继续,不再反问第二次)。
 */
export async function consumeCancelClarification(
  text: string,
  taskId: string,
  started: number,
): Promise<VoiceProcessResult | null> {
  const pending = pendingCancel;
  if (!pending) return null;
  const now = Date.now();
  if (now - pending.askedAt > CANCEL_CLARIFY_TTL_MS) {
    pendingCancel = null;
    logDelegation({
      phase: 'cancelled',
      channel: 'voice-companion',
      status: 'clarify-expired',
      initiator: 'user',
      reason: truncate(text, 80),
      taskId,
    });
    return null;
  }
  pendingCancel = null; // 一次性:无论解析结果如何都消费掉
  const answer = consumeCancelClarifyAnswer(text, pending.candidates);
  if (answer.kind === 'unmatched') return null;
  if (answer.kind === 'abort') {
    logDelegation({
      phase: 'cancelled',
      channel: 'voice-companion',
      status: 'clarify-abandoned',
      initiator: 'user',
      reason: truncate(text, 80),
      taskId,
    });
    return { action: 'general_response', response: '好,不撤了。', elapsedMs: Date.now() - started };
  }
  const exec = await executeCancel(answer.candidate, {
    initiator: 'user',
    reason: truncate(text, 80),
    taskId,
  });
  return {
    action: 'cancel_delegation',
    response: exec.response,
    targetAgent: { id: answer.candidate.subordinateId, name: answer.candidate.subordinateName ?? answer.candidate.subordinateId },
    elapsedMs: Date.now() - started,
  };
}
