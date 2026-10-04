/**
 * jarvis-core/reflection · INGEST 收集器（任务 28 ⑤.2）
 *
 * 经任务 27 记忆层**现成 API 只读**收集四路数据（不修改其任何文件）：
 *   当天工作记忆 + 会话摘要 + 成长日志新增 + 当前长期知识。
 *
 * 数据访问经可注入接口（ReflectionDataSource）：生产缺省实现包装
 * MemoryLifecycleStore；测试注入 fixture（createStaticReflectionDataSource）。
 *
 * 失败降级如实（06-11 §11.4「不吞循环」+ 本任务硬约束「不吞、不假」）：
 * 逐源 try/catch 隔离，失败源的数据保持缺失并登记进 bundle.errors，
 * **绝不填充伪造数据**；会话数读取失败由引擎按 skipped 处理（宁可跳过不冒险）。
 */

import { jarvisLogger, type JarvisLogger } from '../executors.js';
import type { MemoryEntry, MemoryLifecycleStore } from '../memory/types.js';
import { startOfLocalDay } from './gate.js';
import type {
  IngestSourceError,
  IngestSourceName,
  IngestedSessionSummary,
  ReflectionDataSource,
  ReflectionIngestBundle,
} from './types.js';

export interface MemoryReflectionDataSourceOptions {
  logger?: JarvisLogger;
}

/** 排序：updatedAt 降序、同刻按 id 升序（确定性，黄金对比友好）。 */
function sortByUpdatedDesc(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
}

/** 排序：createdAt 升序、同刻按 id 升序。 */
function sortByCreatedAsc(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 从条目集合推算「当天会话数」（门槛校验口径）：
 *   · 当天会话摘要（kind='session-summary'）逐条计——有 sessionId 的去重，
 *     无 sessionId 的按 1 条=1 会话计；
 *   · 当天携带 sessionId 的其余条目并入同一 id 集合（摘要未落盘时的补集）。
 * 仅用于防幻觉门槛的近似估计，不参与四操作判定。
 */
export function countSessionsFromEntries(entries: readonly MemoryEntry[], since: number): number {
  const ids = new Set<string>();
  let anonymousSummaries = 0;
  for (const entry of entries) {
    if (entry.createdAt < since) continue;
    if (entry.sessionId) ids.add(entry.sessionId);
    else if (entry.kind === 'session-summary') anonymousSummaries += 1;
  }
  return ids.size + anonymousSummaries;
}

/**
 * 生产缺省数据源：包装任务 27 MemoryLifecycleStore（只读调用 query/listMarkedForReflection）。
 * baseDir/时钟由 store 自己持有；本文件不感知磁盘布局。
 */
export function createMemoryReflectionDataSource(
  store: MemoryLifecycleStore,
  options: MemoryReflectionDataSourceOptions = {},
): ReflectionDataSource {
  const logger = options.logger ?? jarvisLogger;

  const warn = (source: IngestSourceName, message: string): IngestSourceError => {
    logger.warn(`[Reflection] INGEST 数据源读取失败（降级，不吞不假）: ${source} - ${message}`);
    return { source, message };
  };

  return {
    async countSessionsToday(at: number): Promise<number> {
      // 门槛读取失败直接抛：引擎按 skipped（session-count-unavailable）处理
      const since = startOfLocalDay(at);
      const entries = await store.query({ layer: 'working', status: 'any' });
      return countSessionsFromEntries(entries, since);
    },

    async ingest({ now, since }): Promise<ReflectionIngestBundle> {
      const errors: IngestSourceError[] = [];

      const safeRead = async (
        source: IngestSourceName,
        read: () => Promise<MemoryEntry[]>,
      ): Promise<MemoryEntry[]> => {
        try {
          return await read();
        } catch (error) {
          errors.push(warn(source, errorText(error)));
          return [];
        }
      };

      const allWorking = await safeRead('working', () =>
        store.query({ layer: 'working', status: 'any' }),
      );
      const markedEntries = await safeRead('marked', () => store.listMarkedForReflection());
      const growthLogEntries = await safeRead('growth-log', () =>
        store.query({ layer: 'growth-log', status: 'any' }),
      );
      const longTermEntries = await safeRead('long-term', () =>
        store.query({ layer: 'long-term', status: 'active' }),
      );

      // 会话摘要：kind='session-summary' 且当天创建（会话结束由 write-engine 写入）
      const todaySummaries = allWorking.filter(
        (e) => e.kind === 'session-summary' && e.createdAt >= since,
      );
      const sessions: IngestedSessionSummary[] = todaySummaries
        .map((e) => ({ sessionId: e.sessionId, summary: e.text, at: e.createdAt }))
        .sort((a, b) => (a.at - b.at) || (a.sessionId ?? '').localeCompare(b.sessionId ?? ''));

      // 当天工作记忆：当天更新过的 active 条目 + 全部待反思标记条目（去重）
      const byId = new Map<string, MemoryEntry>();
      for (const entry of allWorking) {
        if (entry.status === 'active' && entry.updatedAt >= since) byId.set(entry.id, entry);
      }
      for (const entry of markedEntries) byId.set(entry.id, entry);
      const workingEntries = sortByUpdatedDesc([...byId.values()]);

      const growthLogToday = sortByCreatedAsc(
        growthLogEntries.filter((e) => (e.createdAt >= since || e.updatedAt >= since)),
      );

      return {
        now,
        since,
        sessions,
        workingEntries,
        markedEntries: sortByUpdatedDesc(markedEntries),
        growthLogEntries: growthLogToday,
        longTermEntries: sortByUpdatedDesc(longTermEntries.filter((e) => e.status === 'active')),
        errors,
      };
    },
  };
}

// ============================================================================
// 静态数据源（测试/fixture 注入；生产不产生假数据的正当用途）
// ============================================================================

export interface StaticIngestInput {
  now: number;
  since: number;
  sessions?: IngestedSessionSummary[];
  workingEntries?: MemoryEntry[];
  markedEntries?: MemoryEntry[];
  growthLogEntries?: MemoryEntry[];
  longTermEntries?: MemoryEntry[];
  errors?: IngestSourceError[];
}

/**
 * 固定数据源：会话数与 INGEST 数据全部由调用方给定（fixture/黄金回归用；
 * 主脑 L2 沙箱也可用它预置确定性输入）。不对数据做任何加工或伪造。
 */
export function createStaticReflectionDataSource(
  sessionCount: number,
  input: StaticIngestInput,
): ReflectionDataSource {
  return {
    async countSessionsToday(): Promise<number> {
      return sessionCount;
    },
    async ingest(): Promise<ReflectionIngestBundle> {
      return {
        now: input.now,
        since: input.since,
        sessions: input.sessions ?? [],
        workingEntries: input.workingEntries ?? [],
        markedEntries: input.markedEntries ?? [],
        growthLogEntries: input.growthLogEntries ?? [],
        longTermEntries: input.longTermEntries ?? [],
        errors: input.errors ?? [],
      };
    },
  };
}
