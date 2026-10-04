/**
 * Trace Context —— 整链贯穿 ID（⑭ 日志地基①，Spec §4.14 行为定义 2）
 *
 * 目的：一次「你说话 → 消歧 → 派活 → 执行 → 回执 → 播报」的链路共享 taskId/sessionId，
 * 使 system_log 可按 taskId 串出完整时间线。taskId 在意图判定为任务类时生成一次，
 * 链路内后续环节一律复用（禁止各环节各生成各的）。
 *
 * 用法：
 *   runWithTrace({ sessionId }, () => {
 *     const taskId = ensureTaskId();   // 判定为任务类时调用；非任务类链路可不调
 *     logEvent('dialog', { body: '...' });      // 自动带上 taskId/sessionId
 *     ...
 *   });
 *
 * 注意：AsyncLocalStorage 只覆盖同一 Node 进程内的异步链。跨进程时（秘书 → tmux 里的 Boss →
 * 下属，或回执从文件监听回来）taskId 必须随消息显式传递，收到方用 runWithTrace({ taskId })
 * 恢复链路，才能让「反问 → 派活 → 回执 → 播报」共享同一个 taskId。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import * as crypto from 'node:crypto';

export interface TraceContext {
  /** 链路 ID（非任务类链路可用；system_log schema 未落此列，仅作进程内关联与后续扩展） */
  traceId?: string;
  /** 任务 ID：意图判定为任务类时由 ensureTaskId() 生成，派活/回执/播报全程共享 */
  taskId?: string;
  sessionId?: string;
  projectId?: string;
  agentId?: string;
  /** 来源标识：logEvent 未显式给 source 时的默认值 */
  source?: string;
}

const TRACE_KEYS = ['traceId', 'taskId', 'sessionId', 'projectId', 'agentId', 'source'] as const;

const als = new AsyncLocalStorage<TraceContext>();

function randomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

/** 生成一个新的链路 ID（前缀 trace-，用于日志/排查时人眼可辨） */
export function newTraceId(): string {
  return `trace-${Date.now().toString(36)}-${randomSuffix()}`;
}

/** 生成一个新的任务 ID（前缀 task-；会随派活消息传递给 Boss/下属） */
export function newTaskId(): string {
  return `task-${Date.now().toString(36)}-${randomSuffix()}`;
}

/** 把 patch 中显式给定的字段合并进 target；undefined 不覆盖已有值。 */
function mergeDefined(target: TraceContext, patch: TraceContext): TraceContext {
  for (const key of TRACE_KEYS) {
    const value = patch[key];
    if (value !== undefined) target[key] = value;
  }
  return target;
}

/**
 * 在链路上下文中执行 fn。子上下文继承父上下文（可嵌套），显式字段覆盖父值。
 * 链路起点（WS 消息处理、语音回合、定时任务等）应包一层，后续环节自动共享 ID。
 */
export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
  const parent = als.getStore();
  const merged: TraceContext = mergeDefined({ ...parent }, ctx);
  return als.run(merged, fn);
}

/** 当前链路上下文的快照；不在链路内时返回 undefined。 */
export function getTraceContext(): Readonly<TraceContext> | undefined {
  const store = als.getStore();
  return store ? { ...store } : undefined;
}

/** 合并更新当前链路上下文（如链路中途拿到 sessionId/projectId）；不在链路内时无操作。 */
export function updateTraceContext(patch: TraceContext): void {
  const store = als.getStore();
  if (!store) return;
  mergeDefined(store, patch);
}

/**
 * 取当前链路的 taskId；没有则生成一次并写回上下文，后续环节复用同一个。
 * 不在链路上下文内时退化为返回一个新 ID（调用方应先 runWithTrace 才能获得贯穿保证）。
 */
export function ensureTaskId(): string {
  const store = als.getStore();
  if (!store) return newTaskId();
  if (!store.taskId) store.taskId = newTaskId();
  return store.taskId;
}

/** 当前链路的 taskId（未生成过则 undefined）。 */
export function getTaskId(): string | undefined {
  return als.getStore()?.taskId;
}
