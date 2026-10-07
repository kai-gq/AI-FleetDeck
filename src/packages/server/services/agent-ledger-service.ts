/**
 * Agent Ledger Service (任务22 · agent 编制台账, 06-12 §3.5 缺口4)
 *
 * 把「委派史 + agent 花名册」压成编制视角的台账：每 agent 近 N 天委派数 /
 * 完成 / 失败 / 撤回 / 连续失败 / 最后委派 / 闲置天数 / 平均耗时，并按初始
 * 阈值给出建议档（保留 / 观察中 / 归档候选）。
 *
 * 设计约束（任务书 ⑤ 与验收 ③④）：
 * - **建议非自动执行**：本模块只产建议；退役 / 归档动作需用户拍板，代码里
 *   没有任何自动退役路径。不做绩效排名（§10.1 C 档明确不做）。
 * - **纯聚合区无 IO**：computeAgentLedger / buildRosterNote / renderAgentLedgerSection
 *   不读时钟、不读文件；decisions / agents / now / 阈值全部显式传入。
 *   运行时采集单独放文件尾「接线层」（collectLiveRosterLedger）。
 * - **与 B1 档案卡同源不重造**：终态判定复用 agent-profile-service.resolveTaskOutcome
 *   （单向：ledger → profile，反向注记由 boss-service 接线，避免循环依赖）；
 *   失败率分母与 B1 completionRate 同口径（终态三分类 completed+failed+cancelled）。
 * - **无证据不出建议**：advice ≠ 'keep' 时 reasons 必非空（测试契约）。
 * - 阈值全部为**初值非实测**（任务书 ⑤2；⑮ 标定后回写 06-12 §8.2）。
 */

import * as agentService from './agent-service.js';
import { loadDelegationHistory } from '../data/index.js';
import { createLogger } from '../utils/logger.js';
import { resolveTaskOutcome, type AgentTaskOutcome } from './agent-profile-service.js';
import type { DelegationDecision } from '../../shared/types.js';

const log = createLogger('AgentLedger');

// ============================================================================
// 常量（初值非实测；任务22 ⑤2 / ⑥；⑮ 标定回写）
// ============================================================================

/** 台账统计窗口缺省值：14 天（与 B1 档案卡 DEFAULT_PROFILE_WINDOW_MS 同口径）。 */
export const DEFAULT_LEDGER_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** 「最近总失败」：窗口内连续失败 ≥3 → 观察中（观察 / 退役候选）。 */
export const CONSECUTIVE_FAILURE_THRESHOLD = 3;
/** 「最近总失败」：窗口内终态失败率 >50% → 观察中。 */
export const FAILURE_RATE_THRESHOLD = 0.5;
/** 失败率规则的最小终态样本（防 1/1=100% 单样本误报；初值非实测）。 */
export const MIN_TERMINAL_FOR_FAILURE_RATE = 2;
/** 「总闲置」：≥30 天零委派 → 归档候选（与 §8.2 记忆卡衰减同 30 天口径）。 */
export const IDLE_DAYS_THRESHOLD = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// 类型
// ============================================================================

/** 建议档：保留 / 观察中（观察·退役候选）/ 归档候选。 */
export type RosterAdvice = 'keep' | 'observe' | 'archive-candidate';

/** 花名册条目（接线方从 agentService.getAllAgents() 映射而来；纯函数不依赖 Agent 全形）。 */
export interface LedgerAgentRef {
  id: string;
  name?: string;
  /** Agent 记录的上次派活时间（与委派史最后 timestamp 取较新者作「最后委派」）。 */
  lastAssignedTaskTime?: number;
}

export interface AgentLedgerEntry {
  agentId: string;
  agentName?: string;
  /** 窗口内委派总数（含未终态）。 */
  windowDelegations: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** 终态样本数 = completed + failed + cancelled（窗口内）。 */
  terminal: number;
  /** 窗口内按时间倒序的最近连续 failed 数（cancelled/completed 打断；未终态不参与）。 */
  consecutiveFailures: number;
  /** 最后委派时间（不限窗口；委派史与 roster 时间取较新者）；无任何来源 → null。 */
  lastDelegationAt: number | null;
  /** 闲置天数 = floor((now − lastDelegationAt)/天)，钳 ≥0；无来源 → null（不出建议）。 */
  idleDays: number | null;
  /** 窗口内带 durationMs 样本的均值（毫秒，四舍五入）；无样本 → null。 */
  avgDurationMs: number | null;
  advice: RosterAdvice;
  /** 建议证据（人读短句）。keep → 空数组；非 keep 必有 ≥1 条。 */
  reasons: string[];
}

export interface AgentLedgerOptions {
  windowMs?: number;
  consecutiveFailureThreshold?: number;
  failureRateThreshold?: number;
  minTerminalForFailureRate?: number;
  idleDaysThreshold?: number;
}

// ============================================================================
// 台账计算（纯函数）
// ============================================================================

/** 本地日 YYYY-MM-DD（证据展示用；模块内自持，不依赖 server utils）。 */
function formatLocalDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 计算编制台账（纯函数，显式 now 注入）。
 *
 * 匹配口径与 B1 档案卡一致：`selectedAgentId === agent.id`；旧记录缺 id 时才退回
 * `selectedAgentName === agent.name`。窗口统计只看 `timestamp >= now − windowMs`；
 * 「最后委派 / 闲置天数」用全量历史 + roster 的 lastAssignedTaskTime。
 *
 * 建议优先级：观察中（连败 / 失败率）> 归档候选（闲置）。两者同时命中时取观察中
 * （质量信号更需人工注意）；默认窗口下二者几乎互斥（14 天内有失败 ⇒ 闲置 <30 天）。
 */
export function computeAgentLedger(
  decisions: readonly DelegationDecision[],
  agents: readonly LedgerAgentRef[],
  now: number,
  options: AgentLedgerOptions = {},
): AgentLedgerEntry[] {
  const windowMs = options.windowMs ?? DEFAULT_LEDGER_WINDOW_MS;
  const consecutiveFailureThreshold = options.consecutiveFailureThreshold ?? CONSECUTIVE_FAILURE_THRESHOLD;
  const failureRateThreshold = options.failureRateThreshold ?? FAILURE_RATE_THRESHOLD;
  const minTerminalForFailureRate = options.minTerminalForFailureRate ?? MIN_TERMINAL_FOR_FAILURE_RATE;
  const idleDaysThreshold = options.idleDaysThreshold ?? IDLE_DAYS_THRESHOLD;
  const cutoff = now - windowMs;

  return agents.map((agent) => {
    let windowDelegations = 0;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let durationSum = 0;
    let durationCount = 0;
    let lastDelegationAt: number | null =
      typeof agent.lastAssignedTaskTime === 'number' ? agent.lastAssignedTaskTime : null;
    const terminalInWindow: Array<{ at: number; outcome: AgentTaskOutcome }> = [];

    for (const d of decisions) {
      if (!d || typeof d.timestamp !== 'number') continue;
      const matches = d.selectedAgentId
        ? d.selectedAgentId === agent.id
        : Boolean(agent.name && d.selectedAgentName === agent.name);
      if (!matches) continue;

      if (lastDelegationAt === null || d.timestamp > lastDelegationAt) lastDelegationAt = d.timestamp;
      if (d.timestamp < cutoff) continue;

      windowDelegations++;
      const outcome = resolveTaskOutcome(d);
      if (outcome === 'completed') completed++;
      else if (outcome === 'failed') failed++;
      else if (outcome === 'cancelled') cancelled++;
      if (outcome) terminalInWindow.push({ at: d.timestamp, outcome });
      if (outcome && d.completion && typeof d.completion.durationMs === 'number' && d.completion.durationMs >= 0) {
        durationSum += d.completion.durationMs;
        durationCount++;
      }
    }

    const terminal = completed + failed + cancelled;
    terminalInWindow.sort((a, b) => b.at - a.at);
    let consecutiveFailures = 0;
    for (const t of terminalInWindow) {
      if (t.outcome === 'failed') consecutiveFailures++;
      else break;
    }

    const idleDays =
      lastDelegationAt === null ? null : Math.max(0, Math.floor((now - lastDelegationAt) / DAY_MS));

    const reasons: string[] = [];
    let advice: RosterAdvice = 'keep';

    if (consecutiveFailures >= consecutiveFailureThreshold) {
      advice = 'observe';
      reasons.push(`连续失败 ${consecutiveFailures} 次`);
    }
    const failureRate = terminal > 0 ? failed / terminal : null;
    if (
      failureRate !== null &&
      terminal >= minTerminalForFailureRate &&
      failureRate > failureRateThreshold
    ) {
      advice = 'observe';
      reasons.push(`失败率 ${Math.round(failureRate * 100)}%（${failed}/${terminal} 终态）`);
    }
    if (idleDays !== null && idleDays >= idleDaysThreshold) {
      if (advice === 'keep') {
        advice = 'archive-candidate';
        reasons.push(`闲置 ${idleDays} 天`);
        if (lastDelegationAt !== null) reasons.push(`最后委派 ${formatLocalDay(lastDelegationAt)}`);
      }
    }

    return {
      agentId: agent.id,
      ...(agent.name ? { agentName: agent.name } : {}),
      windowDelegations,
      completed,
      failed,
      cancelled,
      terminal,
      consecutiveFailures,
      lastDelegationAt,
      idleDays,
      avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : null,
      advice,
      reasons,
    };
  });
}

// ============================================================================
// B1 快照注记 / 报表段渲染（纯函数）
// ============================================================================

/**
 * 台账条目 → B1 快照行尾注记（短句；keep / 无证据 → null 不输出）。
 * 例：`观察中：连续失败 3 次`、`归档候选：闲置 35 天`。
 */
export function buildRosterNote(entry: AgentLedgerEntry | null | undefined): string | null {
  if (!entry || entry.advice === 'keep' || entry.reasons.length === 0) return null;
  const label = entry.advice === 'observe' ? '观察中' : '归档候选';
  return `${label}：${entry.reasons[0]}`;
}

/**
 * 台账条目 → Markdown「编制」段（⑮ 日报 / 周报共用；调用方在 entries 为空时跳过本段）。
 * 只有非保留条目逐条列出（含证据）；全员保留时只出汇总行。
 */
export function renderAgentLedgerSection(entries: readonly AgentLedgerEntry[]): string {
  const total = entries.length;
  if (total === 0) {
    return ['## 编制', '', '- 无编制数据（agent 花名册为空或不可读）'].join('\n');
  }

  const observe = entries.filter((e) => e.advice === 'observe').length;
  const archive = entries.filter((e) => e.advice === 'archive-candidate').length;
  const lines: string[] = ['## 编制', ''];
  lines.push(
    observe + archive === 0
      ? `- 汇总：共 ${total} 名（全部保留，无异常建议）`
      : `- 汇总：共 ${total} 名（保留 ${total - observe - archive} · 观察中 ${observe} · 归档候选 ${archive}）`,
  );
  for (const e of entries) {
    if (e.advice === 'keep') continue;
    const label = e.advice === 'observe' ? '观察中' : '归档候选';
    lines.push(`- ${label} · ${e.agentName || e.agentId}：${e.reasons.join('；')}`);
  }
  return lines.join('\n');
}

// ============================================================================
// 运行时采集（接线层；本区以外的全部导出均为纯函数）
// ============================================================================

/**
 * 从运行时数据面采集并计算台账（⑮ 日报 / 周报的缺省实现）：
 * 委派史 = loadDelegationHistory()（磁盘最新落盘；报表低频读取，无需内存缓存同步）；
 * 花名册 = agentService.getAllAgents() 过滤掉 boss（编制对象 = 执行者）。
 * 任何异常 → 空台账（报表段省略，绝不打断报表主流程）。
 */
export function collectLiveRosterLedger(now: number = Date.now()): AgentLedgerEntry[] {
  try {
    const decisions = Array.from(loadDelegationHistory().values()).flat();
    const agents: LedgerAgentRef[] = agentService
      .getAllAgents()
      .filter((a) => !a.isBoss)
      .map((a) => ({
        id: a.id,
        name: a.name,
        ...(typeof a.lastAssignedTaskTime === 'number' ? { lastAssignedTaskTime: a.lastAssignedTaskTime } : {}),
      }));
    return computeAgentLedger(decisions, agents, now);
  } catch (err) {
    log.warn(`编制台账采集失败（报表段省略）：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
