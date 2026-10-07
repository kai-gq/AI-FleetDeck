/**
 * jarvis-core/persona · 演化治理（任务 32；06-12 §8.1「治理先行」）
 *
 * evaluateProposal 纯函数，判定顺序（先硬边界、后记录期、再大改）：
 *   1. reject：空变更 / 证据缺失（结论必须有证据）/ 核心身份字段（不可变）/
 *      白名单外字段；
 *   2. record-only：会话数 < RECORD_PHASE_SESSIONS（前 20 次只记录不生效）；
 *   3. flagged：文本重叠 < BIG_CHANGE_OVERLAP_THRESHOLD（标记不应用，需人工
 *      拆分/复核后重新提案——applyEvolution 对 flagged 一律拒绝）;
 *   4. review：通过治理初筛 → 走 Tier2 人工审查（批准后才可应用）。
 *
 * 重叠率：字符串取字符 bigram Jaccard；数值取 1-|a-b|；from 未建立 → null
 * （首次建立，不算大改）。两个阈值均为 06-12 §8.2 建议初值，非实测。
 */

import { isCoreIdentityField } from './core-identity.js';
import { RELATIONSHIP_FIELDS } from './types.js';
import type {
  GovernanceDecision,
  PersonaObserver,
  RelationshipEvolutionProposal,
  RelationshipModel,
  RelationshipValue,
} from './types.js';

/** 记录期会话数（06-12 §8.2 建议值 20；实测标定后回写该节）。 */
export const RECORD_PHASE_SESSIONS = 20;

/** 大改重叠阈值（06-12 §8.2 建议值 50%；重叠 < 阈值 = 标记不应用）。 */
export const BIG_CHANGE_OVERLAP_THRESHOLD = 0.5;

// ============================================================================
// 重叠率
// ============================================================================

function bigramsOf(text: string): Set<string> {
  const normalized = text.trim();
  const set = new Set<string>();
  if (normalized.length === 0) return set;
  if (normalized.length === 1) {
    set.add(normalized);
    return set;
  }
  for (let i = 0; i < normalized.length - 1; i++) set.add(normalized.slice(i, i + 2));
  return set;
}

/** 字符 bigram Jaccard 重叠（0~1）。两串都空 → 1；仅一边空 → 0。 */
export function computeTextOverlap(a: string, b: string): number {
  const ga = bigramsOf(a);
  const gb = bigramsOf(b);
  if (ga.size === 0 && gb.size === 0) return 1;
  if (ga.size === 0 || gb.size === 0) return 0;
  let intersection = 0;
  for (const gram of ga) if (gb.has(gram)) intersection++;
  const union = ga.size + gb.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * 单字段新旧值重叠率（0~1）；from 未建立（undefined/空串）→ null（首次建立，
 * 不算大改）。字符串 → 字符 bigram Jaccard；数值 → 1 - |a-b|（clamp 0~1）；
 * 类型改变（字符串↔数值）→ 0（视作完全重写）。
 */
export function computeValueOverlap(from: RelationshipValue, to: RelationshipValue): number | null {
  if (from === undefined || from === '') return null;
  if (typeof from === 'number' && typeof to === 'number') {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
    return Math.max(0, Math.min(1, 1 - Math.abs(from - to)));
  }
  if (typeof from === 'string' && typeof to === 'string') return computeTextOverlap(from, to);
  return 0;
}

// ============================================================================
// 裁决
// ============================================================================

export interface EvaluateProposalOptions {
  /** 当前会话计数（FileSessionCounter.count）。 */
  sessionCount: number;
}

/**
 * 演化提案治理裁决（纯函数）。current = 当前关系模型（计算重叠的权威基准；
 * 提案自带的 from 仅作缺省回退）。
 */
export function evaluateProposal(
  proposal: RelationshipEvolutionProposal,
  current: RelationshipModel,
  options: EvaluateProposalOptions,
): GovernanceDecision {
  // 1. 空变更 / 无证据 → 拒收
  if (!proposal.changes || proposal.changes.length === 0) {
    return { verdict: 'reject', reasons: ['提案没有任何字段变更'] };
  }
  if (!proposal.evidence || proposal.evidence.length === 0) {
    return { verdict: 'reject', reasons: ['结论缺少证据（evidence 为空）——结论必须有证据支撑'] };
  }

  // 2. 核心身份不可变 / 白名单外字段 → 拒收
  const boundaryReasons: string[] = [];
  for (const change of proposal.changes) {
    if (isCoreIdentityField(change.field)) {
      boundaryReasons.push(`字段「${change.field}」属核心身份（名字/基调/红线），固定不可改`);
    } else if (!(RELATIONSHIP_FIELDS as readonly string[]).includes(change.field)) {
      boundaryReasons.push(`字段「${change.field}」不在关系模型白名单（${RELATIONSHIP_FIELDS.join('/')}）内`);
    }
  }
  if (boundaryReasons.length > 0) return { verdict: 'reject', reasons: boundaryReasons };

  // 3. 记录期：前 RECORD_PHASE_SESSIONS 次会话只记录、不生效
  if (options.sessionCount < RECORD_PHASE_SESSIONS) {
    return {
      verdict: 'record-only',
      reasons: [`记录期（第 ${options.sessionCount}/${RECORD_PHASE_SESSIONS} 次会话）：只记成长日志，不生效`],
    };
  }

  // 4. 大改标记：重叠 < 阈值 → 标记不应用（人工拆分/复核后重新提案）
  const flagged: Array<{ field: string; overlap: number }> = [];
  for (const change of proposal.changes) {
    const currentValue = current[change.field as keyof RelationshipModel];
    const from = currentValue !== undefined ? currentValue : change.from;
    const overlap = computeValueOverlap(from, change.to);
    if (overlap !== null && overlap < BIG_CHANGE_OVERLAP_THRESHOLD) flagged.push({ field: change.field, overlap });
  }
  if (flagged.length > 0) {
    return {
      verdict: 'flagged',
      reasons: flagged.map(
        (f) => `字段「${f.field}」新旧重叠 ${(f.overlap * 100).toFixed(0)}%（<${BIG_CHANGE_OVERLAP_THRESHOLD * 100}% 大改阈值），标记不应用，需人工拆分/复核后重新提案`,
      ),
      flagged,
    };
  }

  // 5. 通过初筛 → Tier2 人工审查
  return { verdict: 'review', reasons: ['通过治理初筛，走 Tier2 人工审查'] };
}

// ============================================================================
// 治理观测（⑦ 治理拦截率 → ⑮）
// ============================================================================

/** 裁决 + 观测事件；裁决本身仍是纯函数，事件回调失败静默隔离。 */
export function evaluateProposalObserved(
  proposal: RelationshipEvolutionProposal,
  current: RelationshipModel,
  options: EvaluateProposalOptions & { at?: number; observer?: PersonaObserver },
): GovernanceDecision {
  const decision = evaluateProposal(proposal, current, options);
  if (options.observer) {
    try {
      options.observer({
        op: 'governance',
        at: options.at ?? Date.now(),
        proposalId: proposal.id,
        verdict: decision.verdict,
        reasonCount: decision.reasons.length,
        applied: false,
      });
    } catch {
      // 观测失败不打断裁决
    }
  }
  return decision;
}
