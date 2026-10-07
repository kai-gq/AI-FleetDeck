/**
 * Agent Profile Service (B1 人事档案卡, 任务18 / Spec §10.3 B1)
 *
 * 把「agent 的技能分配 + 它的委派史」压成一张有界档案卡，供 Boss 快照
 * （subordinate-context-service.buildBossContext 的 TEAM 段）每 agent 一行注入。
 *
 * 设计约束：
 * - **纯聚合**：无 IO、不读时钟；now 与所有数据源都显式传入（时间窗可精确测试）；
 *   取技能/取委派史的接线在 boss-service.gatherSubordinateContext（失败降级也在那）。
 * - **体积有界**：技能名只取前 K 个、逐名截断、整行硬上限（常量见下，编辑器定）。
 * - **无数据源不硬造**：
 *   - 完成率 = completed /（completed + failed + cancelled）——终态三分类都算分母
 *     （「done/(done+cancelled)」的等价可测口径；failed 是终态失败，不能不算分母），
 *     无终态样本 → null；
 *   - 耗时均值只统计带 completion.durationMs 的记录，无样本 → null；
 *   - 返工率：全仓无返工事件采集（任务17 验收自检 done:false 是未完成项，不是返工）
 *     → 恒 null（缺源登记，禁编造）。
 */

import type { DelegationDecision, Skill, AgentProfileCard } from '../../shared/types.js';

// ============================================================================
// 有界参数（编辑器定；注释即登记）
// ============================================================================

/** 档案卡摘要里列出的技能名上限（K）——一行卡只做「摘要」，全量留给技能面板。 */
export const MAX_PROFILE_SKILL_NAMES = 3;
/** 单个技能名截断长度（防长名撑爆一行）。 */
export const MAX_PROFILE_SKILL_NAME_CHARS = 24;
/** 档案卡整行硬上限（含 `- **Profile**: ` 前缀）——超出按字符截断兜底。 */
export const MAX_PROFILE_LINE_CHARS = 220;
/**
 * 历史表现时间窗缺省值：14 天。理由：委派史本身每 Boss 上限 100 条
 * （MAX_DELEGATION_HISTORY_PER_BOSS），两周窗口覆盖「近期状态」又不被远古记录稀释；
 * 纯函数可显式传 windowMs 覆盖（测试矩阵用）。
 */
export const DEFAULT_PROFILE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

// ============================================================================
// 历史表现聚合（纯函数）
// ============================================================================

/** 一条委派记录的终态分类（未终态 → null，不进分母）。 */
export type AgentTaskOutcome = 'completed' | 'failed' | 'cancelled';

/**
 * 终态判定（优先级：撤回 > 病历 > 旧 status 字段）：
 * - taskCard.status === 'cancelled'：任务16·⑬ 撤回是确定终态；
 * - completion.result：任务11·⑧ 病历（'completed' | 'failed'）；
 * - 旧记录只有 decision.status（任务11 前落盘）→ completed/failed 兜底；
 * - pending/sent 且无 completion → 未终态，返回 null。
 */
export function resolveTaskOutcome(decision: DelegationDecision): AgentTaskOutcome | null {
  if (decision.taskCard?.status === 'cancelled') return 'cancelled';
  if (decision.completion) return decision.completion.result;
  if (decision.status === 'completed') return 'completed';
  if (decision.status === 'failed') return 'failed';
  return null;
}

export interface AgentHistorySummary {
  /** 时间窗内与该 agent 匹配的委派记录总数。 */
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** 终态样本数 = completed + failed + cancelled。 */
  terminal: number;
  /** completed / terminal；无终态样本 → null。 */
  completionRate: number | null;
  /** 带 completion.durationMs 的样本均值（毫秒，四舍五入）；无样本 → null。 */
  avgDurationMs: number | null;
}

/**
 * 汇总单个 agent 的历史表现（纯函数）。
 *
 * 匹配口径：`selectedAgentId === agentId`；旧记录缺 id 时才退回
 * `selectedAgentName === agentName`（避免同名跨团队误配）。
 * 时间窗：`timestamp >= now - windowMs`（now 显式注入）。
 */
export function summarizeAgentHistory(
  decisions: readonly DelegationDecision[],
  agentId: string,
  agentName: string | undefined,
  now: number,
  windowMs: number = DEFAULT_PROFILE_WINDOW_MS,
): AgentHistorySummary {
  const cutoff = now - windowMs;
  let total = 0;
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let durationSum = 0;
  let durationCount = 0;

  for (const d of decisions) {
    if (!d || typeof d.timestamp !== 'number' || d.timestamp < cutoff) continue;
    const matches = d.selectedAgentId
      ? d.selectedAgentId === agentId
      : Boolean(agentName && d.selectedAgentName === agentName);
    if (!matches) continue;

    total++;
    const outcome = resolveTaskOutcome(d);
    if (outcome === 'completed') completed++;
    else if (outcome === 'failed') failed++;
    else if (outcome === 'cancelled') cancelled++;

    if (outcome && d.completion && typeof d.completion.durationMs === 'number' && d.completion.durationMs >= 0) {
      durationSum += d.completion.durationMs;
      durationCount++;
    }
  }

  const terminal = completed + failed + cancelled;
  return {
    total,
    completed,
    failed,
    cancelled,
    terminal,
    completionRate: terminal > 0 ? completed / terminal : null,
    avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : null,
  };
}

// ============================================================================
// 档案卡组装 / 渲染（纯函数）
// ============================================================================

export interface AgentProfileInput {
  agentId: string;
  agentName?: string;
  /** 该 agent 当前生效的技能（调用方经 skillService.getSkillsForAgent 取，失败已降级为空）。 */
  skills: readonly Skill[];
  /** 候选委派记录（调用方给全量；本函数自行按 agent + 时间窗过滤）。 */
  decisions: readonly DelegationDecision[];
  /** 显式注入的当前时刻（毫秒）。 */
  now: number;
  windowMs?: number;
  maxSkillNames?: number;
  /** 任务22 编制注记（boss-service 经 agent-ledger-service.buildRosterNote 产生）；缺省不输出。 */
  rosterNote?: string | null;
}

/** 码点序比较（跨机器确定；不依赖 locale/ICU）。 */
function compareByCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 名称截断（纯字符截断，避免依赖 server utils 让本模块保持零内部依赖）。 */
function truncateName(name: string, maxChars: number): string {
  return name.length > maxChars ? name.slice(0, maxChars - 1) + '…' : name;
}

/**
 * 组装一张 agent 档案卡（纯函数，显式 now 注入）。
 * 技能名去重、按码点序稳定排序后取前 K；历史表现为时间窗内聚合。
 */
export function buildAgentProfileCard(input: AgentProfileInput): AgentProfileCard {
  const maxSkillNames = input.maxSkillNames ?? MAX_PROFILE_SKILL_NAMES;

  const names: string[] = [];
  for (const skill of input.skills) {
    const raw = typeof skill?.name === 'string' ? skill.name.trim() : '';
    if (!raw) continue;
    const name = truncateName(raw, MAX_PROFILE_SKILL_NAME_CHARS);
    if (!names.includes(name)) names.push(name);
  }
  names.sort(compareByCodePoints);

  const skillNames = names.slice(0, Math.max(0, maxSkillNames));
  const history = summarizeAgentHistory(
    input.decisions,
    input.agentId,
    input.agentName,
    input.now,
    input.windowMs,
  );

  return {
    skillCount: names.length,
    skillNames,
    hiddenSkillCount: names.length - skillNames.length,
    totalDelegations: history.total,
    completedCount: history.completed,
    failedCount: history.failed,
    cancelledCount: history.cancelled,
    terminalCount: history.terminal,
    completionRate: history.completionRate,
    avgDurationMs: history.avgDurationMs,
    reworkRate: null, // 无数据源（缺源登记，禁编造）
    ...(input.rosterNote ? { rosterNote: input.rosterNote } : {}),
  };
}

/** 耗时可读化：<1s → ms；<60s → s；<1h → m；其余 → h（一位小数）。 */
export function formatProfileDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * 渲染档案卡为 Boss 快照里的一行（纯函数、体积有界）：
 *   `- **Profile**: Skills(3/7): a, b, c +4 | Done 10/12 (83%) | Avg 4.2m`
 * 无样本一律 n/a（不写 0 冒充）；整行超出 MAX_PROFILE_LINE_CHARS 时字符截断兜底。
 * 任务22 起：编制注记（rosterNote，如「观察中：连续失败 3 次」）追加在行尾。
 */
export function renderAgentProfileLine(card: AgentProfileCard): string {
  const skills = card.skillCount > 0
    ? `Skills(${card.skillNames.length}/${card.skillCount}): ${card.skillNames.join(', ')}${card.hiddenSkillCount > 0 ? ` +${card.hiddenSkillCount}` : ''}`
    : 'Skills(0)';

  const done = card.completionRate !== null
    ? `Done ${card.completedCount}/${card.terminalCount} (${Math.round(card.completionRate * 100)}%)`
    : 'Done n/a (no completed work yet)';

  const avg = card.avgDurationMs !== null
    ? `Avg ${formatProfileDuration(card.avgDurationMs)}`
    : 'Avg n/a';

  const note = card.rosterNote ? ` | ${card.rosterNote}` : '';
  const line = `- **Profile**: ${skills} | ${done} | ${avg}${note}`;
  return line.length > MAX_PROFILE_LINE_CHARS
    ? line.slice(0, MAX_PROFILE_LINE_CHARS - 1) + '…'
    : line;
}
