/**
 * jarvis-core/reflection · 夜间反思引擎（任务 28 核心）
 *
 * 编排（06-11 §6.3）：
 *   门槛（当天会话数 <5 → skipped）→ INGEST → LLM 端口（可注入）
 *   → 四操作 + Tier 划分（纯函数）→ Tier1 自动应用 / Tier2 入人工队列
 *   → 反思产物（晨报草稿写 reflections 层）→ 结构化运行事件（⑭/⑮）。
 *
 * 调度边界：本文件**只导出 runNightlyReflection(deps)**；cron 02:00 注册由主脑
 * 在波次屏障统一接线（不碰 cron-service.ts / server/index.ts）。
 *
 * 降级语义（06-11 §11.4 + 本任务硬约束）：
 *   · INGEST 单源失败 → 继续跑，缺失如实登记（不吞、不假）；
 *   · 门槛读不到 → skipped（宁可跳过不冒险）；
 *   · LLM 通道未接线/解析失败 → failed，**零操作、零应用**（不静默伪造）；
 *   · 应用/入队/草稿/状态写失败 → 逐条如实记 errors，不抛出。
 */

import { randomUUID } from 'node:crypto';

import { jarvisLogger, type JarvisLogger } from '../executors.js';
import type { MemoryLifecycleStore } from '../memory/types.js';
import { checkReflectionGate, startOfLocalDay } from './gate.js';
import { createMemoryReflectionDataSource } from './ingest.js';
import {
  buildReflectionPrompt,
  createUnavailableReflectionLlm,
  parseReflectionProposals,
  ReflectionLlmUnavailableError,
  type ReflectionPromptOptions,
} from './llm.js';
import { applyReflectionOperations, countOperationKinds, planReflection } from './operations.js';
import { Tier2ReviewQueue } from './review-queue.js';
import { FileReflectionRunState } from './run-state.js';
import {
  countIngest,
  type AppliedOperationResult,
  type ReflectionDataSource,
  type ReflectionEventSink,
  type ReflectionIngestBundle,
  type ReflectionLlmPort,
  type ReflectionRunEvent,
  type ReflectionRunResult,
} from './types.js';

export interface ReflectionDeps {
  /** 任务 27 记忆层存储（只读导入；Tier1 应用/晨报草稿经其 API 写）。 */
  store: MemoryLifecycleStore;
  /** INGEST 数据源；缺省 = 包 store 的只读实现（createMemoryReflectionDataSource）。 */
  dataSource?: ReflectionDataSource;
  /** LLM 端口；缺省 = 不可用端口（真实通道接线延后登记）。 */
  llm?: ReflectionLlmPort;
  /** Tier2 待审队列；缺省 = 默认路径 JSON 持久化队列（测试注入临时文件）。 */
  reviewQueue?: Tier2ReviewQueue;
  /** 运行状态（首次运行判定）；缺省 = 默认路径 JSON。 */
  runState?: FileReflectionRunState;
  /** 结构化运行事件出口（⑭ 适配见 createReflectionLogObserver）。 */
  observer?: ReflectionEventSink;
  logger?: JarvisLogger;
  /** 时钟（epoch ms）；缺省 Date.now（测试显式注入）。 */
  now?: () => number;
  /** 门槛下限；缺省 5（Dream 硬规则，保留不标定；仅供测试/L2 显式注入）。 */
  minSessions?: number;
  /** DELETE 判定天数；缺省 30（建议值非实测）。 */
  deleteUnusedDays?: number;
  /** PROMOTE use_count 下限（严格大于）；缺省 10（建议值非实测）。 */
  promoteUseCount?: number;
  /** 显式覆盖首次运行判定（测试）；缺省查 runState。 */
  firstRun?: boolean;
  promptOptions?: ReflectionPromptOptions;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 观测出口自身异常不影响主链路（与 jarvis-core executors.emit 同型）。 */
function emit(sink: ReflectionEventSink | undefined, logger: JarvisLogger, event: ReflectionRunEvent): void {
  if (!sink) return;
  try {
    sink(event);
  } catch (error) {
    logger.warn(`[Reflection] 观测出口 ${event.kind} 抛错（已忽略）`, error);
  }
}

/**
 * 跑一次夜间反思。返回终态结果（completed / skipped / failed），不抛异常。
 * 幂等/重入由主脑调度侧控制（本函数不持锁；每次运行生成独立 runId）。
 */
export async function runNightlyReflection(deps: ReflectionDeps): Promise<ReflectionRunResult> {
  const logger = deps.logger ?? jarvisLogger;
  const now = deps.now?.() ?? Date.now();
  const runId = randomUUID();
  const runState = deps.runState ?? new FileReflectionRunState({ logger });
  const queue = deps.reviewQueue ?? new Tier2ReviewQueue({ logger });
  const dataSource = deps.dataSource ?? createMemoryReflectionDataSource(deps.store, { logger });
  const firstRun = deps.firstRun ?? runState.isFirstRun();
  const errors: string[] = [];

  const finish = (result: ReflectionRunResult): ReflectionRunResult => {
    try {
      runState.record({
        status: result.status,
        at: now,
        tier2Rate: result.status === 'completed' ? result.tier2Rate : undefined,
      });
    } catch (error) {
      logger.warn('[Reflection] 运行状态写入异常（已忽略）', error);
    }
    return result;
  };

  // ── ① 门槛校验（防幻觉硬规则） ──────────────────────────────────────────
  let sessionCount: number;
  try {
    sessionCount = await dataSource.countSessionsToday(now);
  } catch (error) {
    const message = `session-count 读取失败: ${errorText(error)}`;
    errors.push(message);
    logger.warn(`[Reflection] ${message}（跳过本次反思，宁可跳过不冒险）`);
    const result: ReflectionRunResult = {
      runId, status: 'skipped', at: now, sessionCount: 0, firstRun,
      skippedReason: 'session-count-unavailable',
      operations: [], rejected: [], applied: [], pendingReviewIds: [],
      tier2Intercepted: 0, tier2Rate: 0, errors,
    };
    emit(deps.observer, logger, {
      kind: 'reflection.run.skipped', level: 'warn', at: now, runId,
      sessionCount: 0, firstRun, skippedReason: 'session-count-unavailable',
      tier1Applied: 0, tier2Intercepted: 0, tier2Rate: 0, errors,
    });
    return finish(result);
  }

  const gate = checkReflectionGate(sessionCount, { minSessions: deps.minSessions });
  if (!gate.passed) {
    logger.log(`[Reflection] 跳过：当天会话数 ${gate.sessionCount} < ${gate.minSessions}（防幻觉硬规则）`);
    const result: ReflectionRunResult = {
      runId, status: 'skipped', at: now, sessionCount: gate.sessionCount, firstRun,
      skippedReason: 'insufficient-sessions',
      operations: [], rejected: [], applied: [], pendingReviewIds: [],
      tier2Intercepted: 0, tier2Rate: 0, errors,
    };
    emit(deps.observer, logger, {
      kind: 'reflection.run.skipped', level: 'info', at: now, runId,
      sessionCount: gate.sessionCount, firstRun, skippedReason: 'insufficient-sessions',
      tier1Applied: 0, tier2Intercepted: 0, tier2Rate: 0,
    });
    return finish(result);
  }

  // ── ② INGEST（逐源降级，缺失如实登记） ────────────────────────────────
  let ingest: ReflectionIngestBundle;
  try {
    ingest = await dataSource.ingest({ now, since: startOfLocalDay(now) });
  } catch (error) {
    const message = `INGEST 失败: ${errorText(error)}`;
    errors.push(message);
    logger.warn(`[Reflection] ${message}`);
    const result: ReflectionRunResult = {
      runId, status: 'failed', at: now, sessionCount: gate.sessionCount, firstRun,
      failReason: 'ingest-failed',
      operations: [], rejected: [], applied: [], pendingReviewIds: [],
      tier2Intercepted: 0, tier2Rate: 0, errors,
    };
    emit(deps.observer, logger, {
      kind: 'reflection.run.failed', level: 'warn', at: now, runId,
      sessionCount: gate.sessionCount, firstRun, failReason: 'ingest-failed',
      tier1Applied: 0, tier2Intercepted: 0, tier2Rate: 0, errors,
    });
    return finish(result);
  }
  const ingestCounts = countIngest(ingest);
  for (const sourceError of ingest.errors) {
    errors.push(`${sourceError.source}: ${sourceError.message}`);
  }

  // ── ③ LLM 端口（缺省未接线 → failed，零操作） ──────────────────────────
  const llm = deps.llm ?? createUnavailableReflectionLlm();
  const prompt = buildReflectionPrompt(ingest, deps.promptOptions);
  let raw: string;
  try {
    raw = await llm(prompt);
  } catch (error) {
    const failReason = error instanceof ReflectionLlmUnavailableError
      ? 'llm-port-unavailable' as const
      : 'llm-call-failed' as const;
    const message = `LLM ${failReason}: ${errorText(error)}`;
    errors.push(message);
    logger.warn(`[Reflection] ${message}（本次零操作、零应用）`);
    const result: ReflectionRunResult = {
      runId, status: 'failed', at: now, sessionCount: gate.sessionCount, firstRun,
      failReason, ingest: ingestCounts,
      operations: [], rejected: [], applied: [], pendingReviewIds: [],
      tier2Intercepted: 0, tier2Rate: 0, errors,
    };
    emit(deps.observer, logger, {
      kind: 'reflection.run.failed', level: 'warn', at: now, runId,
      sessionCount: gate.sessionCount, firstRun, failReason, ingest: ingestCounts,
      tier1Applied: 0, tier2Intercepted: 0, tier2Rate: 0, errors,
    });
    return finish(result);
  }

  // ── ④ 解析 + 计划（四操作 + Tier 划分，纯函数） ────────────────────────
  let proposals;
  try {
    proposals = parseReflectionProposals(raw);
  } catch (error) {
    const message = `提案解析失败: ${errorText(error)}`;
    errors.push(message);
    logger.warn(`[Reflection] ${message}（本次零操作、零应用）`);
    const result: ReflectionRunResult = {
      runId, status: 'failed', at: now, sessionCount: gate.sessionCount, firstRun,
      failReason: 'proposal-parse-failed', ingest: ingestCounts,
      operations: [], rejected: [], applied: [], pendingReviewIds: [],
      tier2Intercepted: 0, tier2Rate: 0, errors,
    };
    emit(deps.observer, logger, {
      kind: 'reflection.run.failed', level: 'warn', at: now, runId,
      sessionCount: gate.sessionCount, firstRun, failReason: 'proposal-parse-failed',
      ingest: ingestCounts, tier1Applied: 0, tier2Intercepted: 0, tier2Rate: 0, errors,
    });
    return finish(result);
  }

  const plan = planReflection(proposals, ingest, {
    now,
    firstRun,
    deleteUnusedDays: deps.deleteUnusedDays,
    promoteUseCount: deps.promoteUseCount,
  });

  // ── ⑤a Tier1 自动应用（Tier2 一律不在此列） ─────────────────────────────
  let applied: AppliedOperationResult[] = [];
  try {
    applied = await applyReflectionOperations(deps.store, plan.operations, { tiers: [1] });
  } catch (error) {
    errors.push(`Tier1 应用异常: ${errorText(error)}`);
  }
  for (const failure of applied.filter((r) => !r.applied)) {
    errors.push(`应用失败 ${failure.opId}: ${failure.error ?? failure.reason ?? 'unknown'}`);
  }

  // ── ⑤b Tier2 入人工队列（未审不下发/不应用） ────────────────────────────
  let pendingReviewIds: string[] = [];
  const tier2Operations = plan.operations.filter((op) => op.tier === 2);
  try {
    pendingReviewIds = queue.enqueue(runId, tier2Operations).map((item) => item.id);
  } catch (error) {
    errors.push(`Tier2 入队失败: ${errorText(error)}`);
  }

  // ── ⑤c 反思产物：次日晨报草稿 → reflections 层（供任务 29） ─────────────
  let morningDraftEntryId: string | undefined;
  const draft = proposals.morningDraft?.trim();
  if (draft) {
    try {
      const entry = await deps.store.add({
        layer: 'reflections',
        source: 'agent-confirmed',
        kind: 'morning-report-draft',
        text: draft,
        tags: ['morning-report-draft'],
        at: now,
      });
      morningDraftEntryId = entry.id;
    } catch (error) {
      errors.push(`晨报草稿写入失败: ${errorText(error)}`);
    }
  }

  // ── ⑥ 结果 + 结构化事件（⑭/⑮） ────────────────────────────────────────
  const operationCounts = countOperationKinds(plan.operations);
  const tier1Applied = applied.filter((r) => r.applied).length;
  const result: ReflectionRunResult = {
    runId,
    status: 'completed',
    at: now,
    sessionCount: gate.sessionCount,
    firstRun,
    ingest: ingestCounts,
    operations: plan.operations,
    rejected: plan.rejected,
    applied,
    pendingReviewIds,
    tier2Intercepted: plan.tier2Count,
    tier2Rate: plan.tier2Rate,
    morningDraftEntryId,
    errors,
  };
  emit(deps.observer, logger, {
    kind: 'reflection.run.completed',
    level: errors.length > 0 ? 'warn' : 'info',
    at: now,
    runId,
    sessionCount: gate.sessionCount,
    firstRun,
    ingest: ingestCounts,
    operationCounts,
    rejectedCount: plan.rejected.length,
    tier1Applied,
    tier2Intercepted: plan.tier2Count,
    tier2Rate: plan.tier2Rate,
    morningDraftWritten: morningDraftEntryId !== undefined,
    errors: errors.length > 0 ? errors : undefined,
  });
  logger.log(
    `[Reflection] 反思完成：会话 ${gate.sessionCount} · 操作 ${plan.operations.length}（Tier1 ${plan.tier1Count}/Tier2 ${plan.tier2Count}）· ` +
      `应用 ${tier1Applied} · 待审 ${pendingReviewIds.length} · 拦截率 ${plan.tier2Rate.toFixed(4)}` +
      (errors.length > 0 ? ` · 降级 ${errors.length} 条` : ''),
  );
  return finish(result);
}
