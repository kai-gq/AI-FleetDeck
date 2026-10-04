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
import { registerPendingReceipt, resetPendingReceiptsForTests } from './pending-receipt-registry.js';
// 任务15·B ⑫ 全局并发配额：接线闸门（准入/排队/出队）+ 播报出口（只 import，不改 vcs）
import {
  DELEGATION_QUOTA_ACTION,
  onDelegationComplete,
  resetDelegationQuotaGateForTests,
  tryAdmitDelegation,
  type DelegationQuotaAdmitInput,
  type DelegationQuotaAdmitResult,
  type QueuedDelegation,
} from '../../services/delegation-quota-gate.js';
import { logProactiveBroadcast } from '../../services/voice-companion-service.js';

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

/**
 * Get the boss ID for an active delegation (if any)
 */
export function getBossForSubordinate(subordinateId: string): ActiveDelegation | undefined {
  return activeDelegations.get(subordinateId);
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
  /** ⑧ 病历产出位置（当前入口不可得 → 缺省，不硬造） */
  outputLocation?: string;
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
      bossService.recordDelegationCompletion(delegation.bossId, delegation.decisionId, {
        at,
        result,
        summary: opts.summary,
        outputLocation: opts.outputLocation,
        reason: opts.reason ?? 'turn-complete',
        subordinateId,
        taskId: delegation.taskId,
      });
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
  return `[DELEGATED TASK from boss "${input.bossName}" (${input.bossId})]\n\n${input.taskCommand}${cardBlock}\n\n---\nThis task was delegated by your boss agent. When you finish, report completion using:\ncurl -s -X POST ${baseUrl}/api/agents/YOUR_AGENT_ID/report-task -H "Content-Type: application/json" -d '{"summary":"Brief result summary","status":"completed"}'`;
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
 * （projectId 用 taskCard 原值，任务 14 项目别名映射未落地）。
 * 绝不上抛：任何异常只记日志，不拦断完成入口。
 */
function dispatchQueuedDelegation(payload: QueuedDelegation): void {
  try {
    const taskId = payload.taskId ?? newTaskId();
    const bossName = agentService.getAgent(payload.bossId)?.name ?? payload.bossId;
    const targetAgent = agentService.getAgent(payload.selectedAgentId);
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
      const dedupKey = `${agentId}:${delegationJson.selectedAgentId}:${delegationJson.taskCommand}`;
      if (processedDelegations.has(dedupKey)) {
        log.log(`Skipping duplicate delegation to ${delegationJson.selectedAgentName}: "${delegationJson.taskCommand.slice(0, 50)}..."`);
        continue;
      }

      processedDelegations.set(dedupKey, now);
      log.log(`Delegation to ${delegationJson.selectedAgentName}: "${delegationJson.taskCommand.slice(0, 80)}..."`);

      const decisionTimestamp = Date.now();
      // ⑦ 现场组卡：状态机从 pending 起（statusUpdatedAt = 落卡时间），随委派史落盘
      const taskCard: TaskCard | undefined = delegationJson.taskCard
        ? { ...delegationJson.taskCard, status: 'pending', statusUpdatedAt: decisionTimestamp }
        : undefined;

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
        // projectId 用 taskCard 原值——任务 14 项目别名映射未落地，不做别名替换。
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
      registerPendingReceipt({
        targetAgentId: decision.selectedAgentId,
        bossId: agentId,
        taskId: delegationTaskId,
        decisionId: decision.id,
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
