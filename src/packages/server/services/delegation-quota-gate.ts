/**
 * 任务15·B · 全局并发配额闸门接线（Spec §4.12；15·A 纯函数 `delegation-quota` 的单例外壳）
 *
 * 职责：把 15·A 的 (QuotaState + QuotaEvent + budget) → (新状态 + 决策) 纯迁移接成
 * 进程内单例，并补齐「排队不丢任务」（⑤3 硬边缘）所需的载荷账本：
 *   - `tryAdmitDelegation`：委派链路任务准入——活跃 < N → admitted；否则入 FIFO 队列
 *     并留存完整派发载荷（taskId/bossId/decisionId/selectedAgentId/selectedAgentName/
 *     taskCommand/taskCard），
 *     出队时直接用该载荷补做运行期登记（activeDelegations/registerPendingReceipt/
 *     sendCommand → running，见 boss-response-handler.ts dispatchQueuedDelegation）；
 *   - `onDelegationComplete`：完成 → 释放预算；队首存在则自动出队并**返回其载荷**
 *     供调用方派发（播报「排队任务开始了」由调用方做）；
 *   - 🟡⑫ 审计：排队/出队时 `logEvent`（category='delegation' + 既有 source 'boss'，
 *     不新增 ACTIVITY_SOURCE；字段含 taskId/bossId/queueMs/phase），**永不上抛**；
 *   - 启动重建（best-effort，见下）。
 *
 * 边界：
 *   - 只接 **Boss 委派链路**。秘书自留区（聊天/查询/只读）按 15·A QuotaScope 分流——
 *     scope='secretary' 直接放行、不进状态（调用方也可干脆不调用本模块）；
 *   - 开关 `TC_JARVIS_DELEGATION_QUOTA`（缺省开；'0'/'off'/'false' 关）；预算
 *     `TC_JARVIS_QUOTA_BUDGET`（缺省 3；负/NaN/非法兜底 3 + 警告一次；0 = 全部排队，
 *     15·A 保守语义，若想关闭请用开关）；
 *   - 单例状态无持久化：重启后账本清空，靠 `rebuildDelegationQuotaQueueFromHistory`
 *     从委派史 best-effort 回填 **queued** 载荷（按 queuedAt 升序）。边界如实登记：
 *     ① 重启前处于 pending/running 的在跑任务 **不回填 active**（旧 taskId 进程内不可达，
 *     完成事件也不再到达）——活跃计数从空开始，宁可短暂偏松也不永久占住预算；
 *     ② 重建条目以 decisionId 作配额 id（taskId 不可达），出队派发时再生成新 taskId；
 *     ③ 重建条目要等下一次「进程内任务完成」才出队（无自动开工，避免服务未就绪时派活）；
 *     ④ 委派史 100 条/ Boss 上限（任务 10 既有约束）之前的排队条目可能已被裁剪，不保证。
 */

import type { DelegationDecision, TaskCard } from '../../shared/types.js';
import { logEvent } from '../data/system-log.js';
import { loadDelegationHistory } from '../data/index.js';
import { logger } from '../utils/index.js';
import {
  DEFAULT_CONCURRENCY_BUDGET,
  applyQuotaEvent,
  countsAgainstQuota,
  createQuotaState,
  type QuotaDecision,
  type QuotaScope,
  type QuotaState,
} from './delegation-quota.js';

// logger.boss 在测试的 utils mock 下可能缺失 → 与 boss-service 同款防御（`|| console`）
const log = logger.boss || console;

// ============================================================================
// 常量 / 配置
// ============================================================================

/** 开关：缺省开；'0' / 'off' / 'false'（忽略大小写与空白）关。 */
export const DELEGATION_QUOTA_ENABLED_ENV = 'TC_JARVIS_DELEGATION_QUOTA';
/** 全局并发预算 N：缺省 3（15·A DEFAULT_CONCURRENCY_BUDGET，初始值非最优待 ⑭⑮ 标定）。 */
export const DELEGATION_QUOTA_BUDGET_ENV = 'TC_JARVIS_QUOTA_BUDGET';

/** 🟡⑫ 审计 phase：入队 / 出队（⑭ 观测点筛选与 19·A 验收按此查询）。 */
export const DELEGATION_QUOTA_PHASE_QUEUED = 'quota-queued';
export const DELEGATION_QUOTA_PHASE_DEQUEUED = 'quota-dequeued';
/** 播报 action（logProactiveBroadcast 的 action 字段，供 ⑭ system_log 筛选）。 */
export const DELEGATION_QUOTA_ACTION = 'delegation_quota';

/** 🟡⑫ 审计 source：既有字符串 'boss'（同 logTaskCardStatus），不新增常量、不改 activity-log.ts。 */
const QUOTA_LOG_SOURCE = 'boss';

/**
 * 开关判定（每次调用读 env，测试可注入；形态对齐 TC_JARVIS_MORNING_REPORT 先例）。
 * 未设/空串 → 开；未知值 → 开（只有显式关闭值才关）。
 */
export function isDelegationQuotaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DELEGATION_QUOTA_ENABLED_ENV]?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'off' || raw === 'false');
}

/** 非法预算只警告一次（每个非法原始值各一次），避免每个委派都刷屏。 */
const warnedBudgetValues = new Set<string>();

/**
 * 预算解析：空/未设 → 3；有限非负数 → 原值（含 0：15·A 下全部排队，保守降级）；
 * 负/NaN/Infinity/非数字 → 兜底 3 + 警告一次。
 */
export function resolveDelegationQuotaBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DELEGATION_QUOTA_BUDGET_ENV]?.trim();
  if (!raw) return DEFAULT_CONCURRENCY_BUDGET;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    if (!warnedBudgetValues.has(raw)) {
      warnedBudgetValues.add(raw);
      log.warn?.(
        `[DelegationQuota] invalid ${DELEGATION_QUOTA_BUDGET_ENV}="${raw}" — falling back to ${DEFAULT_CONCURRENCY_BUDGET}`
      );
    }
    return DEFAULT_CONCURRENCY_BUDGET;
  }
  return parsed;
}

// ============================================================================
// 载荷账本 / 单例状态
// ============================================================================

/** 排队任务完整派发载荷（「排队不丢任务」的实体；出队时据此补做运行期登记）。 */
export interface QueuedDelegation {
  /**
   * 服务端进程内 taskId（任务 02 登记限制）。启动重建条目不可达旧 taskId → undefined,
   * 出队派发时由调用方新生成；live 入队条目必有。
   */
  taskId?: string;
  bossId: string;
  decisionId: string;
  /** 出队派发所需的下属标识（brief 载荷清单 + 派发最小集）。 */
  selectedAgentId: string;
  selectedAgentName: string;
  taskCommand: string;
  taskCard?: TaskCard;
  /** 入队时刻（🟡⑫ 排队时长基准）；重建条目取 taskCard.statusUpdatedAt ?? decision.timestamp。 */
  queuedAt: number;
}

/** 准入入参：载荷字段 + 来源域（缺省委派链路）。 */
export interface DelegationQuotaAdmitInput extends Omit<QueuedDelegation, 'queuedAt'> {
  scope?: QuotaScope;
}

export interface DelegationQuotaAdmitResult {
  status: 'admitted' | 'queued';
  /** 免配（自留区）/关闭开关时无决策（未进 15·A 迁移）；其余透传 15·A 决策。 */
  decision?: QuotaDecision;
}

/** 配额状态（15·A 纯数据）。 */
let quotaState: QuotaState = createQuotaState();
/** FIFO 载荷账本：key = 配额 id（live 条目 = taskId；重建条目 = decisionId，两者前缀不冲突）。 */
let queuedPayloads = new Map<string, QueuedDelegation>();
/** 启动重建只做一次（首个准入前 lazily 执行）。 */
let rebuiltFromHistory = false;

/** 测试专用：丢弃进程内状态（与 resetBossDelegationStateForTests 一并调用）。 */
export function resetDelegationQuotaGateForTests(): void {
  quotaState = createQuotaState();
  queuedPayloads = new Map();
  rebuiltFromHistory = false;
  warnedBudgetValues.clear();
}

/** 只读快照（测试断言 / 后续 ⑭ 观测；数组与载荷均为拷贝，防外部污染）。 */
export function getDelegationQuotaSnapshot(): {
  enabled: boolean;
  budget: number;
  activeIds: readonly string[];
  queuedIds: readonly string[];
  queued: QueuedDelegation[];
} {
  return {
    enabled: isDelegationQuotaEnabled(),
    budget: resolveDelegationQuotaBudget(),
    activeIds: [...quotaState.activeIds],
    queuedIds: [...quotaState.queuedIds],
    queued: quotaState.queuedIds
      .map((id) => queuedPayloads.get(id))
      .filter((p): p is QueuedDelegation => !!p)
      .map((p) => ({ ...p })),
  };
}

// ============================================================================
// 启动重建（best-effort；边界见文件头）
// ============================================================================

/**
 * 从未完成委派史回填排队载荷：只取 `taskCard.status === 'queued'` 的记录，
 * 按 queuedAt（statusUpdatedAt ?? decision.timestamp）升序并入现有队尾。
 * - 不重建 active（边界 ①）；已有同 id（重放/重复调用）跳过；
 * - histories 参数供测试注入；缺省读委派史存储（data/index 的 loadDelegationHistory）。
 * - 返回本次新增的排队条数。
 */
export function rebuildDelegationQuotaQueueFromHistory(
  histories?: Map<string, DelegationDecision[]>
): number {
  const source = histories ?? loadDelegationHistory();
  const candidates: { id: string; payload: QueuedDelegation }[] = [];

  for (const decisions of source.values()) {
    for (const decision of decisions) {
      const card = decision.taskCard;
      // done = 已结束（含失败终态，15·A/任务10 语义）；pending/running 不回填（边界 ①）
      if (!card || card.status !== 'queued') continue;
      candidates.push({
        id: decision.id, // 旧 taskId 进程内不可达（任务 02 登记限制）→ 以 decisionId 作配额 id
        payload: {
          bossId: decision.bossId,
          decisionId: decision.id,
          selectedAgentId: decision.selectedAgentId,
          selectedAgentName: decision.selectedAgentName,
          taskCommand: decision.userCommand,
          taskCard: card,
          queuedAt: card.statusUpdatedAt ?? decision.timestamp,
        },
      });
    }
  }

  candidates.sort((a, b) => a.payload.queuedAt - b.payload.queuedAt);

  const known = new Set<string>([...quotaState.activeIds, ...quotaState.queuedIds]);
  const added: string[] = [];
  for (const candidate of candidates) {
    if (known.has(candidate.id) || queuedPayloads.has(candidate.id)) continue;
    queuedPayloads.set(candidate.id, candidate.payload);
    added.push(candidate.id);
  }
  if (added.length > 0) {
    quotaState = createQuotaState({
      activeIds: quotaState.activeIds,
      queuedIds: [...quotaState.queuedIds, ...added],
    });
    log.log?.(`[DelegationQuota] rebuilt ${added.length} queued delegation(s) from history`);
  }
  return added.length;
}

/** 首个准入前 best-effort 重建；读盘/解析异常只告警不上抛（不拦断派活）。 */
function ensureRebuiltFromHistory(): void {
  if (rebuiltFromHistory) return;
  rebuiltFromHistory = true;
  try {
    rebuildDelegationQuotaQueueFromHistory();
  } catch (err) {
    log.warn?.(
      `[DelegationQuota] history rebuild skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ============================================================================
// 🟡⑫ 审计（排队 / 出队；绝不上抛，再包一层 try/catch 兜底）
// ============================================================================

function auditQuota(
  phase: typeof DELEGATION_QUOTA_PHASE_QUEUED | typeof DELEGATION_QUOTA_PHASE_DEQUEUED,
  payload: QueuedDelegation,
  queueMs: number,
  decision: QuotaDecision
): void {
  try {
    logEvent('delegation', {
      source: QUOTA_LOG_SOURCE,
      taskId: payload.taskId,
      agentId: payload.selectedAgentId,
      projectId: payload.taskCard?.projectId,
      body: {
        cat: 'delegation',
        phase, // 'quota-queued' | 'quota-dequeued'
        taskId: payload.taskId ?? null,
        bossId: payload.bossId,
        decisionId: payload.decisionId,
        projectId: payload.taskCard?.projectId ?? null,
        queueMs,
        activeCount: decision.activeCount,
        queuedCount: decision.queuedCount,
        reason: decision.reason,
      },
    });
  } catch {
    // 🟡⑫ 审计是旁路：任何异常都不得影响配额决策与派活主链路
  }
}

// ============================================================================
// 准入 / 出队
// ============================================================================

/**
 * 准入一个委派链路任务：
 * - scope 免配 / 开关关闭 → admitted（不进状态，保持 15·B 前的旧行为）；
 * - 活跃 < N → admitted（占预算）；否则 → queued（入 FIFO 队尾 + 账本留存载荷 + ⑫ 审计）；
 * - 重复 taskId（同一链路 id 复用等）→ 15·A 确定性 noop，按 admitted 放行（不重复占预算、
 *   不排队——避免产生无人能释放的队列条目；旧直派行为兜底）。
 * 绝不上抛：调用方通常再包一层兜底。
 */
export function tryAdmitDelegation(input: DelegationQuotaAdmitInput): DelegationQuotaAdmitResult {
  const scope: QuotaScope = input.scope ?? 'delegation';
  if (!countsAgainstQuota(scope)) return { status: 'admitted' }; // 自留区免配（Spec §4.12 边界）
  if (!isDelegationQuotaEnabled()) return { status: 'admitted' }; // 开关关闭 → 直派

  ensureRebuiltFromHistory();
  const budget = resolveDelegationQuotaBudget();
  const quotaId = input.taskId ?? input.decisionId;

  const { state, decision } = applyQuotaEvent(quotaState, { kind: 'request', taskId: quotaId }, budget);
  quotaState = state;

  if (decision.action === 'queued') {
    const payload: QueuedDelegation = {
      taskId: input.taskId,
      bossId: input.bossId,
      decisionId: input.decisionId,
      selectedAgentId: input.selectedAgentId,
      selectedAgentName: input.selectedAgentName,
      taskCommand: input.taskCommand,
      taskCard: input.taskCard,
      queuedAt: Date.now(),
    };
    queuedPayloads.set(quotaId, payload);
    auditQuota(DELEGATION_QUOTA_PHASE_QUEUED, payload, 0, decision);
    return { status: 'queued', decision };
  }

  // admitted / duplicate（确定性 noop）→ 均按直派放行
  return { status: 'admitted', decision };
}

/**
 * 一个委派任务完成（语义同 15·A complete 事件）：释放预算；若队首被自动放行，
 * 返回其载荷供调用方派发（activeDelegations/registerPendingReceipt/sendCommand + 播报），
 * 无出队/未知 id/重复释放 → null（确定性幂等，双入口安全）。
 */
export function onDelegationComplete(taskId: string): QueuedDelegation | null {
  if (!isDelegationQuotaEnabled()) return null;
  const budget = resolveDelegationQuotaBudget();
  const { state, decision } = applyQuotaEvent(quotaState, { kind: 'complete', taskId }, budget);
  quotaState = state;

  if (decision.action !== 'dequeued' || !decision.dequeuedId) return null;

  const payload = queuedPayloads.get(decision.dequeuedId) ?? null;
  queuedPayloads.delete(decision.dequeuedId);
  // 账本缺失（理论不可达）→ 槽位已释放但不派发；确定性降级，不抛
  if (payload) {
    auditQuota(DELEGATION_QUOTA_PHASE_DEQUEUED, payload, Date.now() - payload.queuedAt, decision);
  }
  return payload;
}
