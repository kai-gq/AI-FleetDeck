/**
 * jarvis-core/reflection · 四操作 + Tier 划分（任务 28 ⑤.3/⑤.4）
 *
 * 纯函数：planReflection(提案, INGEST, 选项) → 计划（操作 + Tier 归属）+ 拒绝登记。
 * 计划与应用分离：本文件先算计划，Tier1 由 applyReflectionOperations 应用
 * （走任务 27 存储 API），Tier2 只进待审队列（未审不下发/不应用；首次运行强制)。
 *
 * Tier 规则（06-11 §6.3，逐条对应）：
 *   Tier1 自动应用：新增低置信知识 / PROMOTE(use_count>10) / DELETE(30 天 0 使用) /
 *                   元数据整理（仅 kind/tags 变更）；
 *   Tier2 人工审查：决定类条目 / 删除高置信条目（source=user-stated）/
 *                   新知识与旧知识矛盾 / 首次运行（覆盖全部操作）。
 * 保守起步（§13.3：连续 N 次无 Tier2 误伤才允许扩大自动应用），未列明 Tier1 的
 * 操作一律落 Tier2；DELETE 30 天 / PROMOTE use_count>10 为**建议值非实测**。
 *
 * 应用选择器：引擎只传 Tier1；人工审批只传单条已批准操作。执行器逐条 try/catch，
 * 失败如实登记（不抛、不吞）。
 */

import type { MemoryEntry, MemoryStore, MemoryUpdatePatch } from '../memory/types.js';
import {
  CONFIDENCE_TAG_PREFIX,
  DEFAULT_DELETE_UNUSED_DAYS,
  DEFAULT_PROMOTE_USE_COUNT,
  REFLECTION_OPERATION_KINDS,
  type AppliedOperationResult,
  type ApplyReflectionOptions,
  type KnowledgeConfidence,
  type PlannedOperation,
  type ReflectionIngestBundle,
  type ReflectionOperationKind,
  type ReflectionPlan,
  type ReflectionPlanOptions,
  type ReflectionProposalBundle,
  type RejectedOperation,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// 文本工具与判别器（导出供单测）
// ============================================================================

/** 归一化文本（与记忆层 file-store 去重口径一致：trim + 折叠空白 + 小写）。 */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 决定类标记词（06-11 §6.2 触发词「决定」类；Tier2 人工审查）。 */
const DECISION_MARKERS = ['决定', '定了', '敲定', '拍板', '定稿'];

/** 是否「决定」类条目（kind/tags 显式标注或正文含决定标记词）。 */
export function isDecisionText(text: string, kind?: string, tags?: readonly string[]): boolean {
  if (kind === 'decision') return true;
  if (tags?.includes('decision')) return true;
  return DECISION_MARKERS.some((m) => text.includes(m));
}

/** 矛盾信号词：新陈述含否定/覆盖语义时才可能与旧知识冲突。 */
const CONTRADICTION_MARKERS = ['不是', '不再', '改为', '改成', '换成', '取消', '不用', '别用', '停止', '废弃', '弃用'];

/** 显著 token：ASCII 词（>=2 字符）+ CJK 相邻二字组（无需分词依赖）。 */
function significantTokens(text: string): Set<string> {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_.-]*/g)) {
    if (m[0].length >= 2) tokens.add(m[0]);
  }
  for (const run of lower.replace(/[^一-鿿]+/g, ' ').split(/\s+/)) {
    for (let i = 0; i + 2 <= run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

/**
 * 新旧知识矛盾判别（确定性启发式）：新文本含矛盾信号词，且与某条 active
 * 长期知识存在 token 重叠（完全同文 = 重复而非矛盾，跳过）。
 * LLM 显式声明的 contradicts 由 planReflection 另行并入（不依赖本启发式）。
 */
export function findContradictions(newText: string, entries: readonly MemoryEntry[]): string[] {
  const normalizedNew = normalizeText(newText);
  if (!normalizedNew) return [];
  if (!CONTRADICTION_MARKERS.some((m) => normalizedNew.includes(m))) return [];
  const newTokens = significantTokens(normalizedNew);
  const hits: string[] = [];
  for (const entry of entries) {
    if (entry.status !== 'active') continue;
    const normalizedOld = normalizeText(entry.text);
    if (!normalizedOld || normalizedOld === normalizedNew) continue;
    const oldTokens = significantTokens(normalizedOld);
    let overlap = false;
    for (const token of oldTokens) {
      if (newTokens.has(token)) {
        overlap = true;
        break;
      }
    }
    if (overlap) hits.push(entry.id);
  }
  return hits;
}

/** 高置信条目 = 用户陈述（source=user-stated，06-11 §11.3 来源分层最高档）。 */
export function isHighConfidenceEntry(entry: MemoryEntry): boolean {
  return entry.source === 'user-stated';
}

/** 置信度 → 标签（记忆层无 confidence 字段，落 tags 承载）。 */
export function confidenceTag(level: KnowledgeConfidence): string {
  return `${CONFIDENCE_TAG_PREFIX}${level}`;
}

function sameTags(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((t, i) => t === right[i]);
}

// ============================================================================
// 计划（纯函数）
// ============================================================================

interface PlannerState {
  operations: PlannedOperation[];
  rejected: RejectedOperation[];
  indexes: Record<ReflectionOperationKind, number>;
}

function reject(
  state: PlannerState,
  kind: ReflectionOperationKind,
  reason: string,
  extra: { targetEntryId?: string; text?: string } = {},
): void {
  // 只登记，不推进计数器：计数器由每轮提案循环统一 +1（接受/拒绝同源），
  // 否则拒绝路径会把序号推两次 → index/opId 相对提案位置漂移。
  state.rejected.push({ kind, index: state.indexes[kind], reason, ...extra });
}

function operationId(kind: ReflectionOperationKind, index: number): string {
  return `${kind.toLowerCase()}-${index}`;
}

/** 在 INGEST 快照中查找条目（marked → working → long-term → growth-log 顺序）。 */
function findEntry(ingest: ReflectionIngestBundle, id: string): MemoryEntry | undefined {
  const pools = [ingest.markedEntries, ingest.workingEntries, ingest.longTermEntries, ingest.growthLogEntries];
  for (const pool of pools) {
    const found = pool.find((e) => e.id === id);
    if (found) return found;
  }
  return undefined;
}

/** 决定「拟议操作实际要带什么 patch」：与现存一致的部分移除；空 patch = 无需改动。 */
function buildUpdatePatch(entry: MemoryEntry, proposal: { text?: string; kind?: string; tags?: string[] }): MemoryUpdatePatch | null {
  const patch: MemoryUpdatePatch = {};
  if (proposal.text !== undefined) {
    const text = proposal.text.trim();
    if (!text) return null; // 空文本：调用方按 empty-text 拒绝
    if (text !== entry.text) patch.text = text;
  }
  if (proposal.kind !== undefined && proposal.kind !== entry.kind) patch.kind = proposal.kind;
  if (proposal.tags !== undefined && !sameTags(proposal.tags, entry.tags)) patch.tags = [...proposal.tags];
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * 计划：LLM 提案 + INGEST 快照 → 操作序列（含 Tier 归属）+ 拒绝登记。
 * 全纯函数、无 I/O、无时钟依赖（时刻由 options.now 注入）→ 黄金回归可逐字节对比。
 */
export function planReflection(
  proposals: ReflectionProposalBundle,
  ingest: ReflectionIngestBundle,
  options: ReflectionPlanOptions,
): ReflectionPlan {
  const firstRun = options.firstRun === true;
  const deleteUnusedDays = options.deleteUnusedDays ?? DEFAULT_DELETE_UNUSED_DAYS;
  const promoteUseCount = options.promoteUseCount ?? DEFAULT_PROMOTE_USE_COUNT;
  const now = options.now;
  const state: PlannerState = {
    operations: [],
    rejected: [],
    indexes: { NEW: 0, UPDATE: 0, DELETE: 0, PROMOTE: 0 },
  };

  // ── NEW ──────────────────────────────────────────────────────────────────
  for (const proposal of proposals.newEntries ?? []) {
    const index = state.indexes.NEW;
    const operation = ((): PlannedOperation | null => {
      const text = (proposal.text ?? '').trim();
      if (!text) {
        reject(state, 'NEW', 'empty-text');
        return null;
      }
      if (proposal.source === 'inferred') {
        // 记忆层硬规则：长期知识只收 user-stated / agent-confirmed
        reject(state, 'NEW', 'inferred-not-allowed-for-long-term', { text });
        return null;
      }
      const confidence = proposal.confidence ?? 'low';
      const normalized = normalizeText(text);
      if (ingest.longTermEntries.some((e) => e.status === 'active' && normalizeText(e.text) === normalized)) {
        reject(state, 'NEW', 'duplicate-existing', { text });
        return null;
      }
      const decision = isDecisionText(text, proposal.kind, proposal.tags);
      const contradictions = proposal.contradicts ? [...proposal.contradicts] : [];
      for (const id of findContradictions(text, ingest.longTermEntries)) {
        if (!contradictions.includes(id)) contradictions.push(id);
      }
      const tierInfo = firstRun
        ? { tier: 2 as const, reason: 'first-run' }
        :decision
          ? { tier: 2 as const, reason: 'decision-class' }
          : contradictions.length > 0
            ? { tier: 2 as const, reason: 'contradiction' }
            : confidence === 'low'
              ? { tier: 1 as const, reason: 'new-low-confidence' }
              : { tier: 2 as const, reason: 'new-needs-review' };
      const tags = [...new Set(['reflection', confidenceTag(confidence), ...(proposal.tags ?? [])])];
      return {
        opId: operationId('NEW', index),
        kind: 'NEW',
        tier: tierInfo.tier,
        tierReason: tierInfo.reason,
        add: {
          layer: 'long-term',
          source: proposal.source ?? 'agent-confirmed',
          kind: proposal.kind ?? 'reflection-pattern',
          text,
          confidence,
          tags,
        },
        evidenceSessionIds: proposal.evidenceSessionIds,
        note: proposal.note,
      };
    })();
    state.indexes.NEW += 1;
    if (operation) state.operations.push(operation);
  }

  // ── UPDATE ───────────────────────────────────────────────────────────────
  for (const proposal of proposals.updates ?? []) {
    const index = state.indexes.UPDATE;
    const operation = ((): PlannedOperation | null => {
      const entry = findEntry(ingest, proposal.id);
      if (!entry) {
        reject(state, 'UPDATE', 'entry-not-found', { targetEntryId: proposal.id });
        return null;
      }
      if (entry.layer === 'growth-log') {
        reject(state, 'UPDATE', 'append-only', { targetEntryId: proposal.id });
        return null;
      }
      const patch = buildUpdatePatch(entry, proposal);
      if (!patch) {
        // proposal.text 显式给空串时上面返回 null 同样是「无改动」；区分空文本拒绝
        const isExplicitEmptyText = proposal.text !== undefined && proposal.text.trim() === '';
        reject(state, 'UPDATE', isExplicitEmptyText ? 'empty-text' : 'no-change', { targetEntryId: proposal.id });
        return null;
      }
      const tierInfo = firstRun
        ? { tier: 2 as const, reason: 'first-run' }
        :isDecisionText(entry.text, entry.kind, entry.tags) || proposal.kind === 'decision'
          ? { tier: 2 as const, reason: 'decision-class' }
          : patch.text !== undefined
            ? { tier: 2 as const, reason: 'update-text-needs-review' }
            : { tier: 1 as const, reason: 'metadata-only' };
      return {
        opId: operationId('UPDATE', index),
        kind: 'UPDATE',
        tier: tierInfo.tier,
        tierReason: tierInfo.reason,
        targetEntryId: entry.id,
        patch,
        note: proposal.note,
      };
    })();
    state.indexes.UPDATE += 1;
    if (operation) state.operations.push(operation);
  }

  // ── DELETE ───────────────────────────────────────────────────────────────
  for (const proposal of proposals.deletes ?? []) {
    const index = state.indexes.DELETE;
    const operation = ((): PlannedOperation | null => {
      const entry = findEntry(ingest, proposal.id);
      if (!entry) {
        reject(state, 'DELETE', 'entry-not-found', { targetEntryId: proposal.id });
        return null;
      }
      if (entry.layer === 'growth-log') {
        reject(state, 'DELETE', 'append-only', { targetEntryId: proposal.id });
        return null;
      }
      const tierInfo = firstRun
        ? { tier: 2 as const, reason: 'first-run' }
        :isDecisionText(entry.text, entry.kind, entry.tags)
          ? { tier: 2 as const, reason: 'decision-class' }
          : isHighConfidenceEntry(entry)
            ? { tier: 2 as const, reason: 'delete-high-confidence' }
            : now - entry.updatedAt >= deleteUnusedDays * DAY_MS && entry.useCount === 0
              ? { tier: 1 as const, reason: 'delete-unused-30d' }
              : { tier: 2 as const, reason: 'delete-not-eligible' };
      return {
        opId: operationId('DELETE', index),
        kind: 'DELETE',
        tier: tierInfo.tier,
        tierReason: tierInfo.reason,
        targetEntryId: entry.id,
        note: proposal.note,
      };
    })();
    state.indexes.DELETE += 1;
    if (operation) state.operations.push(operation);
  }

  // ── PROMOTE ──────────────────────────────────────────────────────────────
  for (const proposal of proposals.promotes ?? []) {
    const index = state.indexes.PROMOTE;
    const operation = ((): PlannedOperation | null => {
      const entry = findEntry(ingest, proposal.id);
      if (!entry) {
        reject(state, 'PROMOTE', 'entry-not-found', { targetEntryId: proposal.id });
        return null;
      }
      if (entry.layer === 'growth-log') {
        reject(state, 'PROMOTE', 'append-only', { targetEntryId: proposal.id });
        return null;
      }
      if (entry.source === 'inferred') {
        reject(state, 'PROMOTE', 'inferred-not-promotable', { targetEntryId: proposal.id });
        return null;
      }
      const target = proposal.target ?? 'long-term';
      if (target !== 'long-term') {
        reject(state, 'PROMOTE', 'invalid-target', { targetEntryId: proposal.id });
        return null;
      }
      if (entry.layer === target) {
        reject(state, 'PROMOTE', 'already-in-target', { targetEntryId: proposal.id });
        return null;
      }
      const tierInfo = firstRun
        ? { tier: 2 as const, reason: 'first-run' }
        :entry.useCount > promoteUseCount
          ? { tier: 1 as const, reason: 'promote-use-count' }
          : { tier: 2 as const, reason: 'promote-below-threshold' };
      return {
        opId: operationId('PROMOTE', index),
        kind: 'PROMOTE',
        tier: tierInfo.tier,
        tierReason: tierInfo.reason,
        targetEntryId: entry.id,
        promoteTarget: target,
        note: proposal.note,
      };
    })();
    state.indexes.PROMOTE += 1;
    if (operation) state.operations.push(operation);
  }

  const tier1Count = state.operations.filter((op) => op.tier === 1).length;
  const tier2Count = state.operations.length - tier1Count;
  return {
    operations: state.operations,
    rejected: state.rejected,
    tier1Count,
    tier2Count,
    tier2Rate: state.operations.length > 0 ? tier2Count / state.operations.length : 0,
  };
}

// ============================================================================
// 应用执行器
// ============================================================================

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function applyOne(store: MemoryStore, operation: PlannedOperation): Promise<AppliedOperationResult> {
  const base = { opId: operation.opId, kind: operation.kind, tier: operation.tier };
  switch (operation.kind) {
    case 'NEW': {
      if (!operation.add) return { ...base, applied: false, reason: 'invalid-payload' };
      const entry = await store.add({
        layer: operation.add.layer,
        source: operation.add.source,
        kind: operation.add.kind,
        text: operation.add.text,
        tags: operation.add.tags,
      });
      return { ...base, applied: true, entryId: entry.id };
    }
    case 'UPDATE': {
      if (!operation.targetEntryId || !operation.patch) {
        return { ...base, applied: false, reason: 'invalid-payload' };
      }
      const entry = await store.update(operation.targetEntryId, operation.patch);
      return entry
        ? { ...base, applied: true, entryId: entry.id }
        : { ...base, applied: false, reason: 'not-found' };
    }
    case 'DELETE': {
      if (!operation.targetEntryId) return { ...base, applied: false, reason: 'invalid-payload' };
      const ok = await store.delete(operation.targetEntryId);
      return ok ? { ...base, applied: true } : { ...base, applied: false, reason: 'not-found' };
    }
    case 'PROMOTE': {
      if (!operation.targetEntryId) return { ...base, applied: false, reason: 'invalid-payload' };
      const entry = await store.promote(operation.targetEntryId, operation.promoteTarget ?? 'long-term');
      return entry
        ? { ...base, applied: true, entryId: entry.id }
        : { ...base, applied: false, reason: 'not-found' };
    }
  }
}

/**
 * 应用操作（Tier1 自动应用 / Tier2 审批后单条应用共用）。
 * 选择器：opIds 优先，其次 tiers，都缺省时执行传入的全部操作——**调用方负责
 * 只传已授权操作**（引擎只传 Tier1；审批只传批准的那一条），执行器不自行放大权限。
 * 逐条 try/catch：失败不抛，登记 error（不吞、不假）。
 */
export async function applyReflectionOperations(
  store: MemoryStore,
  operations: readonly PlannedOperation[],
  options: ApplyReflectionOptions = {},
): Promise<AppliedOperationResult[]> {
  const selected = operations.filter((op) => {
    if (options.opIds) return options.opIds.includes(op.opId);
    if (options.tiers) return options.tiers.includes(op.tier);
    return true;
  });
  const results: AppliedOperationResult[] = [];
  for (const operation of selected) {
    try {
      results.push(await applyOne(store, operation));
    } catch (error) {
      results.push({
        opId: operation.opId,
        kind: operation.kind,
        tier: operation.tier,
        applied: false,
        reason: 'error',
        error: errorText(error),
      });
    }
  }
  return results;
}

/** 操作计数（观测事件用）。 */
export function countOperationKinds(
  operations: readonly PlannedOperation[],
): Record<ReflectionOperationKind, number> {
  const counts = { NEW: 0, UPDATE: 0, DELETE: 0, PROMOTE: 0 } as Record<ReflectionOperationKind, number>;
  for (const kind of REFLECTION_OPERATION_KINDS) {
    counts[kind] = operations.filter((op) => op.kind === kind).length;
  }
  return counts;
}
