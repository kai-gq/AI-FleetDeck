/**
 * 证据硬规则（⑮ P1 核心，Spec §4.15「建议必须 evidence-based，无证据的建议拒绝输出」）
 *
 * 强制点在 filterRecommendations()：模型输出解析后，逐条建议做
 *   1) 提取 evidence（容忍 number / 数字字符串 / {logId} / {id} 多种形态）；
 *   2) 用 LogEvidenceIndex 校验每个 logId 必须在「本次查询到的 system_log 行」中真实存在；
 *   3) 无 evidence、或所有引用都不存在 → 整条建议丢弃并记入 DroppedRecommendation；
 *   4) 通过校验的引用按真实行回填 ts/category/source/level/quote —— 模型自报的时间戳
 *      和字段一律不可信，报告里引用的必须是库里的事实。
 *
 * 该逻辑是纯函数，可脱离 LLM 单测（见 log-analysis.test.ts）。
 */

import type {
  AnalysisFinding,
  AnalysisRecommendation,
  DroppedRecommendation,
  LogEvidenceRef,
} from './types.js';
import type { SystemLogEntry } from '../data/system-log.js';

// ─── 证据索引 ───

export interface LogEvidenceIndex {
  has(logId: number): boolean;
  get(logId: number): SystemLogEntry | undefined;
  readonly size: number;
}

export function buildEvidenceIndex(rows: SystemLogEntry[]): LogEvidenceIndex {
  const map = new Map<number, SystemLogEntry>();
  for (const row of rows) {
    if (typeof row.id === 'number') map.set(row.id, row);
  }
  return {
    size: map.size,
    has: (id: number) => map.has(id),
    get: (id: number) => map.get(id),
  };
}

// ─── 引用提取（宽松入参、严格校验） ───

/** 从任意模型输出里提取候选 logId（容忍 123 / '123' / {logId: 123} / {id: '123'}）。 */
export function coerceLogId(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const candidate = obj.logId ?? obj.id ?? obj.log_id ?? obj.logID;
    return coerceLogId(candidate);
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? t : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function parseBodyObject(entry: SystemLogEntry): Record<string, unknown> | undefined {
  if (!entry.body) return undefined;
  try {
    const parsed = JSON.parse(entry.body);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** 依据真实行生成证据引用（回填事实字段 + 截断引文）。 */
export function enrichEvidence(logId: number, entry: SystemLogEntry, field?: string): LogEvidenceRef {
  const body = parseBodyObject(entry);
  const quoteSource = typeof body !== 'undefined' ? JSON.stringify(body) : entry.body;
  const quote = quoteSource && quoteSource.length > 120 ? `${quoteSource.slice(0, 117)}...` : quoteSource;
  return {
    logId,
    ts: entry.ts,
    category: entry.category,
    source: entry.source,
    level: entry.level,
    ...(field ? { field } : {}),
    ...(quote ? { quote } : {}),
  };
}

/** 单条原始引用 → 可见的合法引用；不存在则返回 undefined。 */
export function validateEvidenceRef(raw: unknown, index: LogEvidenceIndex): LogEvidenceRef | undefined {
  const logId = coerceLogId(raw);
  if (logId === undefined) return undefined;
  const entry = index.get(logId);
  if (!entry) return undefined;
  const field = raw && typeof raw === 'object' ? asString((raw as Record<string, unknown>).field) : undefined;
  return enrichEvidence(logId, entry, field);
}

/** 批量校验；返回合法引用 + 被拒数量（模型自报但库里没有的 id）。 */
export function validateEvidenceList(
  raw: unknown,
  index: LogEvidenceIndex,
): { refs: LogEvidenceRef[]; invalidCount: number; totalCount: number } {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const refs: LogEvidenceRef[] = [];
  const seen = new Set<number>();
  let invalidCount = 0;
  for (const item of list) {
    const ref = validateEvidenceRef(item, index);
    if (!ref) {
      invalidCount += 1;
      continue;
    }
    if (seen.has(ref.logId)) continue;
    seen.add(ref.logId);
    refs.push(ref);
  }
  return { refs, invalidCount, totalCount: list.length };
}

// ─── 发现段解析（异常/瓶颈/资源：证据可缺失，合法引用照常回填） ───

export function parseFindings(raw: unknown, index: LogEvidenceIndex, maxItems = 50): AnalysisFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: AnalysisFinding[] = [];
  for (const item of raw.slice(0, maxItems)) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const title = asString(obj.title ?? obj.name);
    if (!title) continue;
    const { refs } = validateEvidenceList(obj.evidence, index);
    const detail = asString(obj.detail ?? obj.description);
    out.push({
      title: title.slice(0, 300),
      ...(detail ? { detail: detail.slice(0, 2000) } : {}),
      ...(asString(obj.severity) ? { severity: asString(obj.severity) } : {}),
      evidence: refs,
    });
  }
  return out;
}

// ─── 建议段：硬规则过滤（强制点） ───

/**
 * 优化建议逐条过滤：无 evidence 或全部引用不存在 → 丢弃。
 * 返回保留项（含回填证据）与被丢弃项（含原因，供报告/单测审计）。
 */
export function filterRecommendations(
  raw: unknown,
  index: LogEvidenceIndex,
  maxItems = 30,
): { kept: AnalysisRecommendation[]; dropped: DroppedRecommendation[] } {
  const kept: AnalysisRecommendation[] = [];
  const dropped: DroppedRecommendation[] = [];
  if (!Array.isArray(raw)) return { kept, dropped };

  for (const item of raw.slice(0, maxItems)) {
    if (!item || typeof item !== 'object') {
      dropped.push({ title: '(非对象建议)', reason: 'malformed', rawEvidence: item });
      continue;
    }
    const obj = item as Record<string, unknown>;
    const title = asString(obj.title ?? obj.name);
    if (!title) {
      dropped.push({ title: '(无标题建议)', reason: 'malformed', rawEvidence: obj.evidence });
      continue;
    }
    const { refs, invalidCount, totalCount } = validateEvidenceList(obj.evidence, index);
    if (refs.length === 0) {
      dropped.push({
        title: title.slice(0, 300),
        reason: totalCount === 0 || invalidCount === 0 ? 'no-evidence' : 'all-evidence-invalid',
        rawEvidence: obj.evidence,
      });
      continue;
    }
    // action 缺失时退化为标题（仍可拍板；不因动作措辞缺失丢弃一条有证据的建议）
    const action = asString(obj.action ?? obj.recommendation ?? obj.suggestion) ?? title;
    kept.push({
      title: title.slice(0, 300),
      ...(asString(obj.detail ?? obj.description)
        ? { detail: asString(obj.detail ?? obj.description)!.slice(0, 2000) }
        : {}),
      ...(asString(obj.severity) ? { severity: asString(obj.severity) } : {}),
      action: action.slice(0, 1000),
      ...(asString(obj.target) ? { target: asString(obj.target)!.slice(0, 300) } : {}),
      ...(asString(obj.priority) ? { priority: asString(obj.priority) } : {}),
      ...(asString(obj.expectedEffect) ? { expectedEffect: asString(obj.expectedEffect)!.slice(0, 1000) } : {}),
      evidence: refs,
    });
  }
  return { kept, dropped };
}
