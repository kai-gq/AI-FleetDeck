/**
 * jarvis-core/reflection · 反思 prompt 与 LLM 端口（任务 28 ⑤.5）
 *
 * prompt 构造为确定性纯函数（输入相同 → 输出逐字节相同，黄金回归友好）；
 * callReflectionLlm 为**可注入端口**（ReflectionLlmPort）：测试用确定性 mock，
 * 生产真实通道（claude haiku / 现有契约通道）接线延后——本任务只留端口，
 * 不改 vcs/backend 等任何现有文件（硬约束）。
 *
 * 缺省端口 createUnavailableReflectionLlm()：调用即抛
 * ReflectionLlmUnavailableError（引擎 → status='failed' + failReason 如实登记，
 * 绝不静默跳过或伪造提案）。
 */

import type { MemoryEntry } from '../memory/types.js';
import type {
  ReflectionIngestBundle,
  ReflectionLlmPort,
  ReflectionPrompt,
  ReflectionProposalBundle,
} from './types.js';

/** 每节最多注入的条目数（防 prompt 爆炸；截断处标注原始条数）。 */
export const DEFAULT_PROMPT_MAX_ENTRIES = 40;

/** 单条正文截断长度（字符）。 */
export const DEFAULT_PROMPT_MAX_TEXT_CHARS = 240;

export interface ReflectionPromptOptions {
  maxEntriesPerSection?: number;
  maxTextChars?: number;
}

// ============================================================================
// 端口
// ============================================================================

/** 反思 LLM 通道未接线（真实通道接线延后登记）。 */
export class ReflectionLlmUnavailableError extends Error {
  readonly code = 'reflection-llm-unavailable';
  constructor() {
    super('反思 LLM 通道未接线：真实通道接线延后（主脑在热文件窗口注入 ReflectionLlmPort）');
    this.name = 'ReflectionLlmUnavailableError';
  }
}

/** 缺省端口：生产未接线时显式失败（不静默、不伪造）。 */
export function createUnavailableReflectionLlm(): ReflectionLlmPort {
  return async () => {
    throw new ReflectionLlmUnavailableError();
  };
}

/** 固定输出端口（测试/黄金回归/L2 沙箱用）：把给定提案原样返回。 */
export function createStaticReflectionLlm(output: ReflectionProposalBundle | string): ReflectionLlmPort {
  const raw = typeof output === 'string' ? output : JSON.stringify(output);
  return async () => raw;
}

// ============================================================================
// Prompt 构造（确定性）
// ============================================================================

function sortEntries(entries: readonly MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
}

function truncate(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

function limit<T>(items: readonly T[], max: number): { items: T[]; truncatedFrom?: number } {
  if (items.length <= max) return { items: [...items] };
  return { items: items.slice(0, max), truncatedFrom: items.length };
}

function formatEntry(entry: MemoryEntry, maxTextChars: number): string {
  const flags = [entry.layer, entry.source, entry.kind].join('/');
  const status = entry.status === 'pending-reflection' ? ', pending-reflection' : '';
  return `- [${entry.id}] (${flags}, use=${entry.useCount}${status}, updated=${new Date(entry.updatedAt).toISOString()}) ${truncate(entry.text, maxTextChars)}`;
}

function section(title: string, lines: string[], truncatedFrom?: number): string {
  const head = truncatedFrom !== undefined ? `${title}（截断，共 ${truncatedFrom} 条）` : title;
  return [`## ${head}`, ...(lines.length > 0 ? lines : ['（无）'])].join('\n');
}

const SYSTEM_PROMPT = [
  '你是 Tide Commander 的夜间反思引擎（06-11 §6.3 Reflexion + Dream 模式）。',
  '输入是秘书记忆层当天的 INGEST 数据；你的任务是产出长期知识的四操作提案。',
  '',
  '硬性要求：',
  '1. 只输出一个严格 JSON 对象：不要 markdown 代码块、不要解释文字。',
  '2. 不编造输入中不存在的事实；每条 NEW 尽量给出 evidenceSessionIds（来源会话证据）。',
  '3. NEW 仅在跨会话重复出现时提出；与旧知识矛盾时必须填 contradicts（旧知识 id 列表）。',
  '4. 决定类条目、删除高置信条目、新旧矛盾一律照实标注；不确定的用 confidence="low"。',
  '5. 无法判断时宁可少提案：空提案完全允许。',
  '',
  'JSON 结构（数组均可省略）：',
  '{',
  '  "newEntries": [{ "text": "知识点", "confidence": "low|medium|high", "kind": "可选", "tags": ["可选"], "evidenceSessionIds": ["会话 id"], "contradicts": ["旧知识 id"], "note": "可选" }],',
  '  "updates": [{ "id": "旧知识 id", "text": "可选（新事实）", "kind": "可选", "tags": ["可选"], "note": "可选" }],',
  '  "deletes": [{ "id": "旧知识 id", "note": "可选" }],',
  '  "promotes": [{ "id": "条目 id", "target": "long-term", "note": "可选" }],',
  '  "morningDraft": "≤3 句的次日晨报草稿（可省略）"',
  '}',
].join('\n');

/** 构造反思 prompt（确定性：排序 + 截断固定，无时钟/随机依赖）。 */
export function buildReflectionPrompt(
  ingest: ReflectionIngestBundle,
  options: ReflectionPromptOptions = {},
): ReflectionPrompt {
  const maxEntries = options.maxEntriesPerSection ?? DEFAULT_PROMPT_MAX_ENTRIES;
  const maxTextChars = options.maxTextChars ?? DEFAULT_PROMPT_MAX_TEXT_CHARS;

  const sessions = [...ingest.sessions].sort(
    (a, b) => (a.at - b.at) || (a.sessionId ?? '').localeCompare(b.sessionId ?? ''),
  );
  const sessionLines = limit(
    sessions.map((s) => `- [${s.sessionId ?? 'anonymous'}] ${new Date(s.at).toISOString()}: ${truncate(s.summary, maxTextChars)}`),
    maxEntries,
  );

  const working = limit(sortEntries(ingest.workingEntries), maxEntries);
  const marked = limit(sortEntries(ingest.markedEntries), maxEntries);
  const growth = limit(sortEntries(ingest.growthLogEntries), maxEntries);
  const longTerm = limit(sortEntries(ingest.longTermEntries), maxEntries);

  const parts = [
    `# INGEST（窗口 ${new Date(ingest.since).toISOString()} → ${new Date(ingest.now).toISOString()}）`,
    section(`会话摘要（${sessions.length} 条）`, sessionLines.items, sessionLines.truncatedFrom),
    section(`工作记忆（${ingest.workingEntries.length} 条）`, working.items.map((e) => formatEntry(e, maxTextChars)), working.truncatedFrom),
    section(`待反思标记（${ingest.markedEntries.length} 条）`, marked.items.map((e) => formatEntry(e, maxTextChars)), marked.truncatedFrom),
    section(`成长日志新增（${ingest.growthLogEntries.length} 条）`, growth.items.map((e) => formatEntry(e, maxTextChars)), growth.truncatedFrom),
    section(`长期知识（${ingest.longTermEntries.length} 条）`, longTerm.items.map((e) => formatEntry(e, maxTextChars)), longTerm.truncatedFrom),
    '# 输出',
    '严格 JSON（见系统提示的结构），不要多余文字。',
  ];
  return { system: SYSTEM_PROMPT, user: parts.join('\n\n') };
}

// ============================================================================
// 解析（严格；坏结构 → 抛错由引擎按 failed 处理，不做半截应用）
// ============================================================================

export class ReflectionProposalParseError extends Error {
  readonly code = 'reflection-proposal-parse-error';
  constructor(readonly reason: string) {
    super(`反思提案解析失败：${reason}`);
    this.name = 'ReflectionProposalParseError';
  }
}

function extractJsonObject(raw: string): string {
  const text = (raw ?? '').trim();
  if (!text) throw new ReflectionProposalParseError('空响应');
  // 允许 ```json fences（LLM 常见输出），提取第一个 fenced 块
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ReflectionProposalParseError('未找到 JSON 对象');
  return candidate.slice(start, end + 1);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReflectionProposalParseError(`${field} 不是对象`);
  }
  return value as Record<string, unknown>;
}

function optionalArray(value: unknown, field: string): unknown[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ReflectionProposalParseError(`${field} 不是数组`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ReflectionProposalParseError(`${field} 不是字符串`);
  return value;
}

function stringArray(value: unknown, field: string): string[] | undefined {
  const arr = optionalArray(value, field);
  if (!arr) return undefined;
  return arr.map((item, i) => {
    if (typeof item !== 'string') throw new ReflectionProposalParseError(`${field}[${i}] 不是字符串`);
    return item;
  });
}

const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high']);
const SOURCE_VALUES = new Set(['user-stated', 'agent-confirmed', 'inferred']);

type NewProposalItem = NonNullable<ReflectionProposalBundle['newEntries']>[number];
type PromoteProposalItem = NonNullable<ReflectionProposalBundle['promotes']>[number];

function parseNew(item: unknown, i: number): NewProposalItem {
  const record = asRecord(item, `newEntries[${i}]`);
  if (typeof record.text !== 'string' || !record.text.trim()) {
    throw new ReflectionProposalParseError(`newEntries[${i}].text 缺失/为空`);
  }
  const confidence = optionalString(record.confidence, `newEntries[${i}].confidence`);
  if (confidence !== undefined && !CONFIDENCE_VALUES.has(confidence)) {
    throw new ReflectionProposalParseError(`newEntries[${i}].confidence 非法: ${confidence}`);
  }
  const source = optionalString(record.source, `newEntries[${i}].source`);
  if (source !== undefined && !SOURCE_VALUES.has(source)) {
    throw new ReflectionProposalParseError(`newEntries[${i}].source 非法: ${source}`);
  }
  return {
    text: record.text,
    confidence: confidence as NewProposalItem['confidence'],
    kind: optionalString(record.kind, `newEntries[${i}].kind`),
    tags: stringArray(record.tags, `newEntries[${i}].tags`),
    source: source as NewProposalItem['source'],
    evidenceSessionIds: stringArray(record.evidenceSessionIds, `newEntries[${i}].evidenceSessionIds`),
    contradicts: stringArray(record.contradicts, `newEntries[${i}].contradicts`),
    note: optionalString(record.note, `newEntries[${i}].note`),
  };
}

/** 严格解析 LLM 输出为提案包（容忍 ```json fence 与多余的键，不容忍坏结构）。 */
export function parseReflectionProposals(raw: string): ReflectionProposalBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch (error) {
    if (error instanceof ReflectionProposalParseError) throw error;
    throw new ReflectionProposalParseError(error instanceof Error ? error.message : String(error));
  }
  const root = asRecord(parsed, '根');

  const result: ReflectionProposalBundle = {};
  const newEntries = optionalArray(root.newEntries, 'newEntries');
  if (newEntries) result.newEntries = newEntries.map((item, i) => parseNew(item, i)) as ReflectionProposalBundle['newEntries'];

  const updates = optionalArray(root.updates, 'updates');
  if (updates) {
    result.updates = updates.map((item, i) => {
      const record = asRecord(item, `updates[${i}]`);
      if (typeof record.id !== 'string' || !record.id.trim()) {
        throw new ReflectionProposalParseError(`updates[${i}].id 缺失/为空`);
      }
      return {
        id: record.id,
        text: optionalString(record.text, `updates[${i}].text`),
        kind: optionalString(record.kind, `updates[${i}].kind`),
        tags: stringArray(record.tags, `updates[${i}].tags`),
        note: optionalString(record.note, `updates[${i}].note`),
      };
    });
  }

  const deletes = optionalArray(root.deletes, 'deletes');
  if (deletes) {
    result.deletes = deletes.map((item, i) => {
      const record = asRecord(item, `deletes[${i}]`);
      if (typeof record.id !== 'string' || !record.id.trim()) {
        throw new ReflectionProposalParseError(`deletes[${i}].id 缺失/为空`);
      }
      return { id: record.id, note: optionalString(record.note, `deletes[${i}].note`) };
    });
  }

  const promotes = optionalArray(root.promotes, 'promotes');
  if (promotes) {
    result.promotes = promotes.map((item, i) => {
      const record = asRecord(item, `promotes[${i}]`);
      if (typeof record.id !== 'string' || !record.id.trim()) {
        throw new ReflectionProposalParseError(`promotes[${i}].id 缺失/为空`);
      }
      return {
        id: record.id,
        // 语义合法性（仅允许 long-term）由 planReflection 判定并登记拒绝
        target: optionalString(record.target, `promotes[${i}].target`) as PromoteProposalItem['target'],
        note: optionalString(record.note, `promotes[${i}].note`),
      };
    });
  }

  const morningDraft = optionalString(root.morningDraft, 'morningDraft');
  if (morningDraft !== undefined) result.morningDraft = morningDraft;
  return result;
}
