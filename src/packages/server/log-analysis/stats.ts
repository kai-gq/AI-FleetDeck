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
