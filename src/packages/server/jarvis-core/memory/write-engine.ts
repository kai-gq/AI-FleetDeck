/**
 * jarvis-core · 记忆写入引擎（任务 27，06-11 §6.2 / §11.3）
 *
 * 「先写后回应」的服务端侧：调用方在回应用户之前 await 本引擎的 capture*，
 * 落盘完成后才继续（契约回路接入点在 voice-companion-service，由主脑在热文件
 * 窗口接线——本文件只提供可被接线尾调用的纯逻辑，不改热文件）。
 *
 * 触发词扫描（⑤.3）：**服务端确定性规则**，不靠 LLM 自由发挥。五类信号
 * （纠正「不是X」/ 专名 / 偏好 / 决定 / 数值）由 TRIGGER_RULES 明表定义，
 * 命中/不误报由矩阵单测钉死（write-engine.test.ts）。
 *
 * 来源分层（§11.3）：user-stated / agent-confirmed / inferred。推断只写工作
 * 记忆（store 层强制拒收 inferred 进长期知识/成长日志）；promote 到长期知识
 * 时 store 同样拒收 inferred（InferredMemoryRejectedError）。
 *
 * 降级：写失败不阻断主链路（06-11 §11.4）——capture* 不抛异常，错误进
 * CaptureResult.errors 并走观测出口（reason='error'，⑭ 侧按 warn 落盘）。
 */

import { jarvisLogger, type JarvisLogger } from '../executors.js';
import {
  scanTriggers,
  type TriggerHit,
} from './trigger-rules.js';
import {
  type MemoryEntry,
  type MemoryLifecycleStore,
  type MemoryObserver,
  type MemoryOpEvent,
  type SweepOptions,
  type SweepResult,
} from './types.js';

// ============================================================================
// 类型
// ============================================================================

export interface MemoryCaptureOptions {
  sessionId?: string;
  /** 显式时刻（epoch ms）；缺省取引擎时钟。 */
  at?: number;
}

export interface CaptureResult {
  /** 实际落盘（或去重命中）的条目；无触发词时为空。 */
  entries: MemoryEntry[];
  /** 扫描命中的触发词信号（去重后，按位置排序）。 */
  hits: TriggerHit[];
  /** 无法映射而跳过的操作数（如 vcs memoryOps 的 remove——id 空间不同）。 */
  skipped: number;
  /** 写失败摘要（降级：不阻断回应，仅观测）。 */
  errors: string[];
}

/** vcs memoryOps 的结构型镜像（不 import 热文件，接线尾可直接传 contract.memoryOps）。 */
export interface VoiceMemoryOpLike {
  op: 'add' | 'remove' | 'setSummary';
  text?: string;
  id?: string;
  summary?: string;
}

export interface SessionSummaryInput {
  sessionId?: string;
  summary: string;
  at?: number;
}

export interface MemoryWriteEngineOptions {
  store: MemoryLifecycleStore;
  observer?: MemoryObserver;
  logger?: JarvisLogger;
  /** 时钟（epoch ms）；缺省 Date.now。 */
  now?: () => number;
  /** 单次 capture 最多落盘的触发词命中（去重后）；缺省 10。 */
  maxHitsPerCapture?: number;
}

export const DEFAULT_MAX_HITS_PER_CAPTURE = 10;

// ============================================================================
// 写入引擎
// ============================================================================

export class MemoryWriteEngine {
  private readonly store: MemoryLifecycleStore;
  private readonly observer: MemoryObserver | undefined;
  private readonly logger: JarvisLogger;
  private readonly now: () => number;
  private readonly maxHitsPerCapture: number;

  constructor(options: MemoryWriteEngineOptions) {
    this.store = options.store;
    this.observer = options.observer;
    this.logger = options.logger ?? jarvisLogger;
    this.now = options.now ?? Date.now;
    this.maxHitsPerCapture = options.maxHitsPerCapture ?? DEFAULT_MAX_HITS_PER_CAPTURE;
  }

  /**
   * 用户陈述捕获（先写后回应主入口）：扫描一轮用户话语，命中则把整句作为
   * 一条 user-stated 工作记忆落盘。命中多类信号时合并为一条（tags 记全部
   * kinds；主 kind 取规则优先级）——夜间反思（任务 28）可再拆分/提炼。
   * 重复陈述由 store.add 去重（刷新 updatedAt）。
   */
  async captureUserTurn(text: string, opts: MemoryCaptureOptions = {}): Promise<CaptureResult> {
    return this.capture(text, 'user-stated', opts);
  }

  /** 代理确认（§11.3 第二种可信来源）：模型明确写回/确认的事实，同样过触发词扫描。 */
  async captureAgentConfirmed(text: string, opts: MemoryCaptureOptions = {}): Promise<CaptureResult> {
    return this.capture(text, 'agent-confirmed', opts);
  }

  /**
   * 推断候选（§11.3：预测/准备只存候选、标注推测）：只写工作记忆，
   * 不做触发词扫描；夜间反思消费后决定去留。
   */
  async captureInferred(text: string, opts: MemoryCaptureOptions = {}): Promise<MemoryEntry | null> {
    const content = (text ?? '').trim();
    if (!content) return null;
    const at = opts.at ?? this.now();
    try {
      const entry = await this.store.add({
        layer: 'working',
        source: 'inferred',
        kind: 'inferred',
        text: content,
        tags: ['candidate'],
        sessionId: opts.sessionId,
        at,
      });
      this.emit({
        op: 'capture',
        applied: true,
        at,
        layer: 'working',
        source: 'inferred',
        entryId: entry.id,
        sessionId: opts.sessionId,
        detail: { kind: 'inferred-candidate' },
      });
      return entry;
    } catch (error) {
      this.reportCaptureError(error, at, 'working', 'inferred', opts.sessionId);
      return null;
    }
  }

  /**
   * 会话结束/轮换 → 摘要写工作记忆（⑤.4）。source=agent-confirmed：
   * 摘要由服务端/模型基于真实会话产出，可由夜间反思提炼进长期知识。
   * 空摘要返回 null（不写空条目）。
   */
  async summarizeSession(input: SessionSummaryInput): Promise<MemoryEntry | null> {
    const summary = (input.summary ?? '').trim();
    if (!summary) return null;
    const at = input.at ?? this.now();
    try {
      const entry = await this.store.add({
        layer: 'working',
        source: 'agent-confirmed',
        kind: 'session-summary',
        text: summary,
        tags: ['session-summary'],
        sessionId: input.sessionId,
        at,
      });
      this.emit({
        op: 'capture',
        applied: true,
        at,
        layer: 'working',
        source: 'agent-confirmed',
        entryId: entry.id,
        sessionId: input.sessionId,
        detail: { kind: 'session-summary' },
      });
      return entry;
    } catch (error) {
      this.reportCaptureError(error, at, 'working', 'agent-confirmed', input.sessionId);
      return null;
    }
  }

  /**
   * 桥接 vcs 既有 memoryOps（共存方案，接线尾可调）：
   *   add(\{text\}) → 工作记忆 agent-confirmed 条目；
   *   setSummary   → 会话摘要（同 summarizeSession）；
   *   remove(id)   → 跳过（vcs 的 note id 与 vault 条目 id 不同空间，不强行映射）。
   * 既有 CompanionMemory（voice-companion.json）保持原样独立运转，互不改写。
   */
  async bridgeVoiceMemoryOps(ops: readonly VoiceMemoryOpLike[], opts: MemoryCaptureOptions = {}): Promise<CaptureResult> {
    const result: CaptureResult = { entries: [], hits: [], skipped: 0, errors: [] };
    for (const op of ops) {
      const at = opts.at ?? this.now();
      if (op.op === 'add') {
        const text = (op.text ?? '').trim();
        if (!text) {
          result.skipped += 1;
          continue;
        }
        try {
          result.entries.push(
            await this.store.add({
              layer: 'working',
              source: 'agent-confirmed',
              kind: 'agent-note',
              text,
              tags: ['agent-note'],
              sessionId: opts.sessionId,
              at,
            }),
          );
        } catch (error) {
          const message = this.errorText(error);
          result.errors.push(message);
          this.reportCaptureError(error, at, 'working', 'agent-confirmed', opts.sessionId);
        }
      } else if (op.op === 'setSummary') {
        const entry = await this.summarizeSession({ sessionId: opts.sessionId, summary: op.summary ?? '', at });
        if (entry) result.entries.push(entry);
        else result.skipped += 1;
      } else {
        result.skipped += 1; // remove：跨 id 空间，登记为未映射
      }
    }
    return result;
  }

  /** 过期/超容量裁剪（委托 store；返回 droppedCount 供 ⑭ 观测，接线尾/任务 28 调用）。 */
  async sweep(opts: SweepOptions = {}): Promise<SweepResult> {
    return this.store.sweep(opts);
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  private async capture(
    text: string,
    source: 'user-stated' | 'agent-confirmed',
    opts: MemoryCaptureOptions,
  ): Promise<CaptureResult> {
    const content = (text ?? '').trim();
    const hits = content ? scanTriggers(content, { maxHits: this.maxHitsPerCapture }) : [];
    if (hits.length === 0) {
      return { entries: [], hits: [], skipped: 0, errors: [] };
    }
    const at = opts.at ?? this.now();
    const kinds = [...new Set(hits.map((h) => h.kind))];
    const errors: string[] = [];
    const entries: MemoryEntry[] = [];
    try {
      const entry = await this.store.add({
        layer: 'working',
        source,
        kind: hits[0].kind,
        text: content,
        tags: kinds,
        sessionId: opts.sessionId,
        at,
      });
      entries.push(entry);
    } catch (error) {
      errors.push(this.errorText(error));
      this.reportCaptureError(error, at, 'working', source, opts.sessionId);
      return { entries, hits, skipped: 0, errors };
    }
    this.emit({
      op: 'capture',
      applied: true,
      at,
      layer: 'working',
      source,
      entryId: entries[0].id,
      sessionId: opts.sessionId,
      detail: { kinds, hits: hits.map((h) => ({ kind: h.kind, text: h.text })) },
      totals: await this.safeStats(),
    });
    return { entries, hits, skipped: 0, errors };
  }

  private async safeStats(): Promise<MemoryOpEvent['totals']> {
    try {
      return await this.store.stats();
    } catch {
      return undefined;
    }
  }

  private reportCaptureError(
    error: unknown,
    at: number,
    layer: MemoryEntry['layer'],
    source: MemoryEntry['source'],
    sessionId?: string,
  ): void {
    const message = this.errorText(error);
    this.logger.warn(`[MemoryWriteEngine] 记忆写入失败（降级，不阻断回应）: ${message}`);
    this.emit({
      op: 'capture',
      applied: false,
      reason: 'error',
      at,
      layer,
      source,
      sessionId,
      detail: { error: message },
    });
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private emit(event: MemoryOpEvent): void {
    if (!this.observer) return;
    try {
      this.observer(event);
    } catch (error) {
      this.logger.warn(`[MemoryWriteEngine] 观测出口 ${event.op} 抛错（已忽略）`, error);
    }
  }
}
