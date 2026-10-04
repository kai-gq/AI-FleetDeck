/**
 * 确定性统计（⑮ P1）：不依赖 LLM 的聚合指标。
 *
 * 作用有二：
 *   1) 作为 LLM 的输入骨架（资源段的数据基础，减少模型从几百行里肉眼求和）；
 *   2) LLM 失败/降级时，报告仍带客观数据（"查日志"不空手而归）。
 */

import type { SystemLogEntry } from '../data/system-log.js';
import type { LogStats } from './types.js';
import type { ServerLogReadResult } from './collect.js';

const MAX_SOURCE_KEYS = 12;

function bump(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

interface ParsedBody {
  cat?: string;
  sub?: string;
  durationMs?: number;
  costUsd?: number;
  costSource?: string;
  model?: string;
  tokens?: { input?: number; output?: number };
  tokensTotal?: number;
}

function safeParseBody(body?: string): ParsedBody | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? (parsed as ParsedBody) : undefined;
  } catch {
    return undefined;
  }
}

/** 聚合 system_log 行 + server.log 窗口计数为统计摘要。 */
export function buildLogStats(rows: SystemLogEntry[], serverLog: Pick<ServerLogReadResult, 'errorCount' | 'warnCount'>): LogStats {
  const byCategory: Record<string, number> = {};
  const byLevel: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const models: Record<string, number> = {};
  const resource = { turns: 0, tokensInput: 0, tokensOutput: 0, tokensTotal: 0, costUsd: 0, models };
  const durations: number[] = [];
  let errorRows = 0;
  let warnRows = 0;

  for (const row of rows) {
    bump(byCategory, String(row.category));
    bump(byLevel, String(row.level));
    bump(bySource, String(row.source ?? 'unknown'));
    if (row.level === 'error') errorRows += 1;
    if (row.level === 'warn') warnRows += 1;

    const body = safeParseBody(row.body);
    if (!body) continue;
    if (typeof body.durationMs === 'number' && Number.isFinite(body.durationMs)) {
      durations.push(body.durationMs);
    }
    if (body.cat === 'resource') {
      resource.turns += 1;
      resource.tokensInput += body.tokens?.input ?? 0;
      resource.tokensOutput += body.tokens?.output ?? 0;
      resource.tokensTotal += body.tokensTotal ?? 0;
      resource.costUsd += typeof body.costUsd === 'number' && Number.isFinite(body.costUsd) ? body.costUsd : 0;
      if (body.model) bump(models, String(body.model));
    }
  }

  // source 长尾裁剪：只留 top N（其余并入 other），避免统计对象无界
  const trim = (record: Record<string, number>): Record<string, number> => {
    const entries = Object.entries(record).sort((a, b) => b[1] - a[1]);
    if (entries.length <= MAX_SOURCE_KEYS) return Object.fromEntries(entries);
    const head = entries.slice(0, MAX_SOURCE_KEYS);
    const rest = entries.slice(MAX_SOURCE_KEYS).reduce((acc, [, n]) => acc + n, 0);
    return { ...Object.fromEntries(head), other: rest };
  };

  const sorted = durations.slice().sort((a, b) => a - b);
  return {
    total: rows.length,
    byCategory: trim(byCategory),
    byLevel: trim(byLevel),
    bySource: trim(bySource),
    errorRows,
    warnRows,
    resource: {
      ...resource,
      costUsd: Math.round(resource.costUsd * 1e6) / 1e6,
      models: trim(models),
    },
    durationMs:
      sorted.length > 0
        ? { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted[sorted.length - 1] }
        : null,
    serverLogErrors: serverLog.errorCount,
    serverLogWarns: serverLog.warnCount,
  };
}

// ============================================================================
// 任务17·A5：resource 行按 agentId / projectId 分组（成本周报数据面；buildLogStats 之外新增）
// ============================================================================

/** 单个分组（一个 agent / 一个项目）的资源合计。 */
export interface ResourceGroupTotals {
  /** 分组键（agentId / projectId）；行内无标注落 null（渲染层按「未标注」显示）。 */
  key: string | null;
  /** resource 行数。 */
  turns: number;
  tokensInput: number;
  tokensOutput: number;
  tokensTotal: number;
  /** 可用费用合计（USD）；组内无任何数值费用 → null（如实标注 unavailable，不假造 0）。 */
  costUsd: number | null;
  /** 贡献了数值费用的行数。 */
  costRows: number;
  /** resource 行中 costUsd 不可用的行数（如实剥离，不按 0 计入合计）。 */
  costUnavailableRows: number;
  /** costSource 分布（provider / estimated / unavailable / unknown 等）。 */
  costSources: Record<string, number>;
  /** 模型使用次数。 */
  models: Record<string, number>;
}

export interface ResourceUsageBreakdown {
  /** 窗口内 resource 行总数（含无 agent/project 标注者）。 */
  rows: number;
  /** 按 agentId 分组（tokensTotal 降序，同值按 key 字典序；无标注者恒排末位）。 */
  byAgent: ResourceGroupTotals[];
  /** 按 projectId 分组（同上）。 */
  byProject: ResourceGroupTotals[];
}

function nonEmptyKey(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function newGroup(key: string | null): ResourceGroupTotals {
  return {
    key,
    turns: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensTotal: 0,
    costUsd: null,
    costRows: 0,
    costUnavailableRows: 0,
    costSources: {},
    models: {},
  };
}

function accumulateResourceGroup(
  groups: Map<string, ResourceGroupTotals>,
  key: string | null,
  body: ParsedBody,
): void {
  const mapKey = key ?? '';
  let group = groups.get(mapKey);
  if (!group) {
    group = newGroup(key);
    groups.set(mapKey, group);
  }
  group.turns += 1;
  group.tokensInput += body.tokens?.input ?? 0;
  group.tokensOutput += body.tokens?.output ?? 0;
  group.tokensTotal += body.tokensTotal ?? 0;

  const cost = typeof body.costUsd === 'number' && Number.isFinite(body.costUsd) ? body.costUsd : undefined;
  if (cost === undefined) {
    // 如实剥离：costUsd 不可用的行不按 0 计入合计，单独计数供渲染层标注。
    group.costUnavailableRows += 1;
  } else {
    group.costUsd = (group.costUsd ?? 0) + cost;
    group.costRows += 1;
  }
  const costSource = typeof body.costSource === 'string' && body.costSource ? body.costSource : 'unknown';
  bump(group.costSources, costSource);
  if (body.model) bump(group.models, String(body.model));
}

function finalizeResourceGroups(groups: Map<string, ResourceGroupTotals>): ResourceGroupTotals[] {
  return [...groups.values()]
    .map((group) => ({
      ...group,
      costUsd: group.costUsd === null ? null : Math.round(group.costUsd * 1e6) / 1e6,
    }))
    .sort((a, b) => {
      // 未标注（null）恒排末位（与 tokensTotal 无关），其余按 tokensTotal 降序、同值按 key 字典序。
      if (a.key === null && b.key !== null) return 1;
      if (b.key === null && a.key !== null) return -1;
      if (b.tokensTotal !== a.tokensTotal) return b.tokensTotal - a.tokensTotal;
      if (a.key === null || b.key === null) return 0;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
}

/**
 * 按 agentId / projectId 分组聚合 resource 行（任务17·A5 成本周报数据面）。
 * 纯函数：调用方喂 querySystemLog({source:'resource', since, until}) 结果，零新采集；
 * 只认 body.cat==='resource'，非 resource / 坏 body 一律跳过（不猜测）。
 */
export function aggregateResourceUsage(rows: readonly SystemLogEntry[]): ResourceUsageBreakdown {
  const byAgent = new Map<string, ResourceGroupTotals>();
  const byProject = new Map<string, ResourceGroupTotals>();
  let resourceRows = 0;

  for (const row of rows) {
    const body = safeParseBody(row.body);
    if (!body || body.cat !== 'resource') continue;
    resourceRows += 1;
    accumulateResourceGroup(byAgent, nonEmptyKey(row.agentId), body);
    accumulateResourceGroup(byProject, nonEmptyKey(row.projectId), body);
  }

  return {
    rows: resourceRows,
    byAgent: finalizeResourceGroups(byAgent),
    byProject: finalizeResourceGroups(byProject),
  };
}
