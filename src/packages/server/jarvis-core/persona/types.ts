/**
 * jarvis-core/persona · 类型（任务 32 人格层，06-11 P5 / 06-12 §8.1）
 *
 * 两层人格结构：
 *   - 核心身份（不可变）：名字 / 基调 / 红线「不替你做主」——见 core-identity.ts；
 *   - 关系模型（可演化）：老板画像 / 沟通偏好 / 信任度 / 协作节奏——本文件。
 *
 * 治理铁律：结论必须有证据（evidence 非空）；核心身份字段出现在提案里 = 拒收
 * （不可变）；演化须经 governance.evaluateProposal 裁决，留 diff、可回滚。
 */

// ============================================================================
// 关系模型（可演化）
// ============================================================================

/** 关系模型可演化字段（白名单；提案里出现白名单之外/核心身份字段 → 治理拒收）。 */
export const RELATIONSHIP_FIELDS = [
  'bossProfile',
  'communicationPrefs',
  'trustLevel',
  'collaborationRhythm',
] as const;
export type RelationshipField = (typeof RELATIONSHIP_FIELDS)[number];

/** 字段 → 注入渲染用中文名。 */
export const RELATIONSHIP_FIELD_LABELS: Readonly<Record<RelationshipField, string>> = {
  bossProfile: '老板画像',
  communicationPrefs: '沟通偏好',
  trustLevel: '信任度',
  collaborationRhythm: '协作节奏',
};

/** 关系模型（缺字段 = 尚未建立，不是空值）。 */
export interface RelationshipModel {
  /** 老板画像（称呼/习惯/工作方式…自由文本）。 */
  bossProfile?: string;
  /** 沟通偏好（「先说结论」「别太长」「用中文」…自由文本）。 */
  communicationPrefs?: string;
  /** 信任度（0~1）。 */
  trustLevel?: number;
  /** 协作节奏（高频快节奏 / 低频大事才找…自由文本）。 */
  collaborationRhythm?: string;
}

export type RelationshipValue = string | number | undefined;

// ============================================================================
// 演化提案与治理裁决
// ============================================================================

/** 单字段变更（from=undefined = 首次建立，不算「大改」）。 */
export interface RelationshipChange {
  /** 字段名（边界处为 string——未知字段由治理拒收，不在类型层放行）。 */
  field: string;
  from: RelationshipValue;
  to: RelationshipValue;
}

/** 演化提案（v1 由人工注入；模块不负责生成，自动提议生成登记为延后项）。 */
export interface RelationshipEvolutionProposal {
  id: string;
  proposedAt: number;
  /** 证据（成长日志条目 id / 摘要）；空 = 拒收（结论必须有证据）。 */
  evidence: readonly string[];
  changes: readonly RelationshipChange[];
}

/**
 * 治理裁决（evaluateProposal 输出）：
 *   - reject：空变更 / 无证据 / 核心身份字段 / 白名单外字段 → 拒收，不记录；
 *   - record-only：记录期（前 RECORD_PHASE_SESSIONS 次会话）→ 只记成长日志，不生效；
 *   - flagged：大改（文本重叠 < 阈值）→ 标记不应用，需人工拆分/复核后重新提案；
 *   - review：通过治理初筛 → 走 Tier2 人工审查（批准后才可应用）。
 */
export type GovernanceVerdict = 'reject' | 'record-only' | 'flagged' | 'review';

export interface GovernanceDecision {
  verdict: GovernanceVerdict;
  reasons: string[];
  /** 大改标记（verdict='flagged' 时逐字段列重叠率）。 */
  flagged?: Array<{ field: string; overlap: number }>;
}

// ============================================================================
// 演化记录（history；留 diff 可回滚）
// ============================================================================

/** 演化记录（appliedBy：tier2-approved 正常演化 / rollback 回滚记录）。 */
export interface RelationshipEvolutionRecord {
  /** 应用后的模型版本号（初始 0，每次应用/回滚 +1；回滚也占新版本，历史不重写）。 */
  version: number;
  at: number;
  proposalId: string;
  appliedBy: 'tier2-approved' | 'rollback';
  evidence: string[];
  /** 本次实际写入的逐字段 diff（回滚时 = 反向 diff）。 */
  diff: Array<{ field: string; from: RelationshipValue; to: RelationshipValue }>;
  /** 回滚目标版本（appliedBy='rollback'）。 */
  rollbackTo?: number;
  /** 应用后的完整快照（回滚重建用）。 */
  after: RelationshipModel;
}

// ============================================================================
// 观测（⑦：演化次数/diff 大小 → ⑭；治理拦截率 → ⑮；注入式回调，模块不硬绑）
// ============================================================================

export type PersonaOp = 'governance' | 'evolution-applied' | 'rollback';

export interface PersonaOpEvent {
  op: PersonaOp;
  at: number;
  proposalId?: string;
  /** governance：裁决结果（拦截率标定依据）。 */
  verdict?: GovernanceVerdict;
  reasonCount?: number;
  /** 应用/回滚后的版本号。 */
  version?: number;
  /** 回滚目标版本。 */
  rollbackTo?: number;
  /** 本次 diff 字符总量（⑦ diff 大小）。 */
  diffChars?: number;
  applied: boolean;
  reason?: string;
}

/** 观测出口；实现侧保证自身异常不影响主链路（内部 try/catch）。 */
export type PersonaObserver = (event: PersonaOpEvent) => void;
