/**
 * 任务 15·A · 全局并发配额闸门(纯函数骨架,Spec §4.12 / 任务卡 ⑤;W9 接线路由:Boss 委派链路)。
 *
 * 形态(照 09·A broadcast-gates 风格):(QuotaState 显式状态 + QuotaEvent 事件 + 预算 N)
 * → (新 QuotaState + QuotaDecision 决策)。无隐藏状态、不读时钟、不起定时器、不落盘、
 * 不接线:同一 (state, event, budget) 必得同一迁移结果;调用方把返回的 state 存回
 * 即完成状态推进(W9 落地时直接嵌入 Boss 委派链路,本模块不 import 任何现有文件)。
 *
 * 语义(任务卡 ⑤1–4):
 * - 全局并发预算 N(budget,可配):同时活跃的委派链路任务上限;起步保守值见
 *   DEFAULT_CONCURRENCY_BUDGET(初始值非最优,无实测,待 ⑭ 资源观测 → ⑮ 标定回写 §8.2);
 * - 准入:活跃数 < N → admitted(占预算);否则 → queued(进 FIFO 队尾;不丢任务——
 *   任务卡还在,只是排队,Spec §4.12 边界);
 * - 出队:complete 一个 → 自动出队队首一个(FIFO);队列非空时净活跃不变;
 * - Boss 拆解:可并行数 = min(团队空闲数, 剩余预算),见 computeDispatchBudget。
 *
 * 边界(Spec §4.12):配额只约束「秘书→Boss→下属」委派链路;秘书自留区(聊天/查询/
 * ⑮ 日志分析只读)不计配额——由 QuotaScope + countsAgainstQuota 显式区分,自留区任务
 * 不进 applyQuotaEvent 的输入(调用方按谓词分流,模块内不做任何豁免判断)。
 *
 * 不丢任务不变式:任意事件序列迁移后,活跃 + 排队 = 已准入请求数 − 已完成数,且每个
 * taskId 至多出现在 activeIds/queuedIds 之一;重复请求、重复释放、未知 id 释放一律
 * noop 确定性降级、状态不动(误报完成一个仍在排队的 id 也不出队——取消是 ⑬ 的独立通路)。
 *
 * 纯计算约定:模块不做入参校验(负预算/NaN 等由接线层配置校验兜底,参照 09·B
 * validateGatesConfig 的分工);排队时长与配额审计埋点(🟡⑫)在接线层,本层只回决策与计数。
 */

// ============================================================================
// 常量(起步建议值,非实测;待 ⑭ 观测 / ⑮ 标定)
// ============================================================================

/**
 * 全局并发预算起步值 N=3(保守):同时活跃的委派链路任务上限。
 * 初始值非最优,无实测(Spec §8.2);待 ⑭ 资源观测(token 用量/排队时长/API 费用)
 * → ⑮ 分析标定后回写。
 */
export const DEFAULT_CONCURRENCY_BUDGET = 3;

// ============================================================================
// 类型
// ============================================================================

/**
 * 任务来源域(显式标志,把「计配额」与「免配额」分开):
 * - 'delegation' = 秘书→Boss→下属委派链路任务,必须过 applyQuotaEvent 闸门;
 * - 'secretary'  = 秘书自留区(聊天/查询/⑮ 日志分析只读等),不占配额——
 *   它们不进 applyQuotaEvent 的输入,调用方按 {@link countsAgainstQuota} 分流。
 */
export type QuotaScope = 'delegation' | 'secretary';

/** 配额状态(纯数据;只记 taskId,任务卡本体留在任务卡服务——「卡在 = 任务在」)。 */
export interface QuotaState {
  /** 正在占用预算的委派链路任务 id(按准入顺序排列)。 */
  readonly activeIds: readonly string[];
  /** 因预算不足排队等待的委派链路任务 id(FIFO;[0] 为队首)。 */
  readonly queuedIds: readonly string[];
}

/** 配额闸门事件(仅委派链路;自留区任务不构成本模块输入,见 QuotaScope 注释)。 */
export type QuotaEvent =
  | { kind: 'request'; taskId: string }
  | { kind: 'complete'; taskId: string };

export type QuotaAction =
  | 'admitted' // 请求 → 立即占用预算
  | 'queued' // 请求 → 超预算,进队等待
  | 'completed' // 完成 → 释放预算(队列为空,无出队)
  | 'dequeued' // 完成 → 释放并自动出队队首一个(净活跃不变)
  | 'noop'; // 无效果(重复请求/未知或重复释放),确定性降级

export type QuotaReason =
  | 'budget_available' // 活跃 < N,放行
  | 'budget_exhausted' // 活跃 = N,排队
  | 'released' // 完成释放,队列为空
  | 'auto_dequeue' // 完成触发出队队首
  | 'duplicate' // taskId 已在 activeIds/queuedIds 中
  | 'unknown_task'; // 完成的 taskId 不在活跃集(未知/重复/仍在排队)

export interface QuotaDecision {
  action: QuotaAction;
  reason: QuotaReason;
  /** 本事件对应的任务 id(noop 事件也回传,便于观测)。 */
  taskId: string;
  /** action='dequeued' 时被自动放行的队首任务 id;其余为 null。 */
  dequeuedId: string | null;
  /** 迁移后的活跃数(⑫ 配额审计观测点可直接取用)。 */
  activeCount: number;
  /** 迁移后的排队数。 */
  queuedCount: number;
}

/** 迁移结果:新状态 + 决策。调用方存回 state 即可,无需 delta 回放。 */
export interface QuotaTransition {
  state: QuotaState;
  decision: QuotaDecision;
}

// ============================================================================
// 边界判定 / 状态构造
// ============================================================================

/** 该来源域是否占配额:'delegation' 占,'secretary' 免(Spec §4.12 边界)。 */
export function countsAgainstQuota(scope: QuotaScope): boolean {
  return scope === 'delegation';
}

/** 构造配额状态(数组拷贝,防止调用方后续改动污染状态;不做合法性校验)。 */
export function createQuotaState(init: Partial<QuotaState> = {}): QuotaState {
  return {
    activeIds: [...(init.activeIds ?? [])],
    queuedIds: [...(init.queuedIds ?? [])],
  };
}

// ============================================================================
// 迁移主体
// ============================================================================

function transition(
  state: QuotaState,
  action: QuotaAction,
  reason: QuotaReason,
  taskId: string,
  dequeuedId: string | null,
): QuotaTransition {
  return {
    state,
    decision: {
      action,
      reason,
      taskId,
      dequeuedId,
      activeCount: state.activeIds.length,
      queuedCount: state.queuedIds.length,
    },
  };
}

/**
 * 纯迁移主入口:(状态, 事件, 预算) → (新状态, 决策)。
 *
 * 准入判定 `活跃数 < budget`(严格小于):budget ≤ 0 时一律排队(保守降级,不静默放行
 * 也不丢任务);完成一个且队列非空时按 FIFO 自动出队队首一个,返回 decision.dequeuedId
 * 供接线层播报「项目 X 的排队任务开始了」。输入状态绝不被修改(未变数组按引用复用)。
 */
export function applyQuotaEvent(
  state: QuotaState,
  event: QuotaEvent,
  budget: number = DEFAULT_CONCURRENCY_BUDGET,
): QuotaTransition {
  if (event.kind === 'request') {
    const { taskId } = event;
    // 幂等:同一 taskId 已在活跃或排队中 → 不重复占位(重复请求确定性降级)。
    if (state.activeIds.includes(taskId) || state.queuedIds.includes(taskId)) {
      return transition(state, 'noop', 'duplicate', taskId, null);
    }
    if (state.activeIds.length < budget) {
      return transition(
        { activeIds: [...state.activeIds, taskId], queuedIds: state.queuedIds },
        'admitted',
        'budget_available',
        taskId,
        null,
      );
    }
    return transition(
      { activeIds: state.activeIds, queuedIds: [...state.queuedIds, taskId] },
      'queued',
      'budget_exhausted',
      taskId,
      null,
    );
  }

  // complete:只认活跃集中的 taskId。
  const idx = state.activeIds.indexOf(event.taskId);
  if (idx === -1) {
    // 未知 id / 重复释放 / 误报完成一个仍在排队的 id:noop,状态不动(任务不丢;
    // 取消排队任务走 ⑬ 的独立通路,不在配额闸门内处理)。
    return transition(state, 'noop', 'unknown_task', event.taskId, null);
  }
  const remainingActive = [...state.activeIds];
  remainingActive.splice(idx, 1);

  if (state.queuedIds.length === 0) {
    return transition(
      { activeIds: remainingActive, queuedIds: state.queuedIds },
      'completed',
      'released',
      event.taskId,
      null,
    );
  }
  const [dequeuedId, ...restQueue] = state.queuedIds;
  return transition(
    { activeIds: [...remainingActive, dequeuedId], queuedIds: restQueue },
    'dequeued',
    'auto_dequeue',
    event.taskId,
    dequeuedId,
  );
}

// ============================================================================
// Boss 拆解并行数(任务卡 ⑤2:min(团队空闲数, 剩余预算))
// ============================================================================

/** 剩余预算 = max(0, budget − 活跃数)(配置缩水导致活跃 > N 时钳到 0)。 */
export function remainingBudget(
  state: QuotaState,
  budget: number = DEFAULT_CONCURRENCY_BUDGET,
): number {
  return Math.max(0, budget - state.activeIds.length);
}

/**
 * Boss 拆解可并行数 = min(团队空闲数, 剩余预算);两路各自钳到 ≥0
 * (空闲数传负属调用方笔误,按 0 处理——不放大也不放行)。
 */
export function computeDispatchBudget(
  state: QuotaState,
  idleTeamSize: number,
  budget: number = DEFAULT_CONCURRENCY_BUDGET,
): number {
  return Math.max(0, Math.min(idleTeamSize, remainingBudget(state, budget)));
}
