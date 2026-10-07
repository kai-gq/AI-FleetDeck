/**
 * jarvis-core/persona · 门面（任务 32 接线入口）
 *
 * 秘书服务（voice-companion-service）只从本文件取三件事：
 *   - isPersonaEnabled()：开关（TC_JARVIS_PERSONA，缺省开）；
 *   - buildPersonaInjection()：核心身份块（常驻）+ 关系模型块（按需，空则缺省）；
 *   - recordPersonaSession()：会话计数（幂等；sessionId null 不计数）。
 * 另导出 recordProposalEvidence()：提案/裁决写成长日志（append-only 留痕）。
 *
 * 全部永不抛：人格层故障绝不打断语音主链路（调用方仍有 try/catch 双保险）。
 */

import { jarvisLogger } from '../executors.js';
import type { MemoryEntry, MemoryStore } from '../memory/index.js';
import { buildCoreIdentityBlock } from './core-identity.js';
import { FileSessionCounter } from './session-counter.js';
import { FileRelationshipStore } from './relationship-store.js';
import { RELATIONSHIP_FIELD_LABELS } from './types.js';
import type {
  GovernanceDecision,
  RelationshipEvolutionProposal,
  RelationshipField,
  RelationshipModel,
  RelationshipValue,
} from './types.js';

// ─── 门面再导出（接线侧单入口） ───

export * from './types.js';
export {
  CORE_IDENTITY,
  CORE_IDENTITY_NAME,
  CORE_IDENTITY_TONE,
  CORE_IDENTITY_RED_LINES,
  isCoreIdentityField,
  buildCoreIdentityBlock,
} from './core-identity.js';
export {
  RECORD_PHASE_SESSIONS,
  BIG_CHANGE_OVERLAP_THRESHOLD,
  computeTextOverlap,
  computeValueOverlap,
  evaluateProposal,
  evaluateProposalObserved,
} from './governance.js';
export type { EvaluateProposalOptions } from './governance.js';
export { FileSessionCounter } from './session-counter.js';
export type { PersonaSessionState, FileSessionCounterOptions } from './session-counter.js';
export { FileRelationshipStore } from './relationship-store.js';
export type { ApplyEvolutionResult, FileRelationshipStoreOptions } from './relationship-store.js';
export { defaultPersonaBaseDir, defaultRelationshipPath, defaultSessionCounterPath } from './paths.js';

// ─── 开关（缺省开；与 ⑨ 晨报 / ⑮ 日报同款最小形态） ───

export function isPersonaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TC_JARVIS_PERSONA?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'off' || raw === 'false');
}

// ─── 注入构建 ───

export interface PersonaInjection {
  /** 核心身份块（不可变；always-on）。 */
  coreBlock: string;
  /** 关系模型块（尚未建立任何字段 → 缺省 = 不注块）。 */
  relationshipBlock?: string;
}

/** 关系模型 → 注入块（多行；空模型 → undefined）。 */
export function renderRelationshipBlock(model: RelationshipModel): string | undefined {
  const lines: string[] = [];
  for (const field of Object.keys(RELATIONSHIP_FIELD_LABELS) as RelationshipField[]) {
    const value = model[field];
    if (value === undefined || value === '') continue;
    lines.push(`- ${RELATIONSHIP_FIELD_LABELS[field]}：${value}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

export interface BuildPersonaInjectionOptions {
  /** 关系模型存储（测试注入临时文件；缺省进程级单例）。 */
  store?: FileRelationshipStore;
}

/** 组装秘书人格注入（核心身份 always-on + 关系模型按需）。读失败降级为只注核心身份。 */
export function buildPersonaInjection(options: BuildPersonaInjectionOptions = {}): PersonaInjection {
  const coreBlock = buildCoreIdentityBlock();
  let relationshipBlock: string | undefined;
  try {
    const store = options.store ?? defaultRelationshipStore();
    relationshipBlock = renderRelationshipBlock(store.getModel().model);
  } catch (error) {
    jarvisLogger.warn('[Persona] 关系模型读取失败（本次只注核心身份）', error);
  }
  return relationshipBlock ? { coreBlock, relationshipBlock } : { coreBlock };
}

// ─── 会话计数 ───

export interface RecordPersonaSessionOptions {
  counter?: FileSessionCounter;
  at?: number;
}

/**
 * 记录一次会话（幂等：同 id 不重复计）。sessionId null（claude 尚未返回）→ null，
 * 不计数也不落盘；计数失败降级返回 null，永不上抛。
 */
export function recordPersonaSession(
  sessionId: string | null,
  options: RecordPersonaSessionOptions = {},
): { sessionCount: number; counted: boolean } | null {
  if (!sessionId) return null;
  try {
    const counter = options.counter ?? defaultSessionCounter();
    return counter.recordSession(sessionId, options.at);
  } catch (error) {
    jarvisLogger.warn('[Persona] 会话计数失败（忽略本回合）', error);
    return null;
  }
}

// ─── 成长日志留痕（记录期与常态都写：留痕不依赖是否生效） ───

function formatValue(value: RelationshipValue): string {
  return value === undefined ? '（未建立）' : String(value);
}

/**
 * 把提案与治理裁决写成长日志（growth-log，append-only）。
 * 记忆层缺省/写失败 → 返回 null（降级，不上抛）——留痕失败不改治理结论。
 */
export async function recordProposalEvidence(
  memory: Pick<MemoryStore, 'add'> | null | undefined,
  proposal: RelationshipEvolutionProposal,
  decision: GovernanceDecision,
  opts: { at?: number; sessionId?: string } = {},
): Promise<MemoryEntry | null> {
  if (!memory) return null;
  try {
    const changesText = proposal.changes
      .map((c) => `${c.field}: ${formatValue(c.from)} → ${formatValue(c.to)}`)
      .join('；');
    return await memory.add({
      layer: 'growth-log',
      source: 'agent-confirmed',
      text: `[人格演化·${decision.verdict}] 提案 ${proposal.id}：${changesText}（证据 ${proposal.evidence.length} 条；${decision.reasons[0] ?? ''}）`,
      kind: 'persona-evolution',
      tags: ['persona-evolution', decision.verdict],
      sessionId: opts.sessionId,
      at: opts.at,
    });
  } catch (error) {
    jarvisLogger.warn('[Persona] 成长日志留痕失败（降级，不影响治理结论）', error);
    return null;
  }
}

// ─── 进程级单例（生产路径；测试一律显式注入） ───

let relationshipStoreSingleton: FileRelationshipStore | null = null;
let sessionCounterSingleton: FileSessionCounter | null = null;

function defaultRelationshipStore(): FileRelationshipStore {
  return (relationshipStoreSingleton ??= new FileRelationshipStore());
}

function defaultSessionCounter(): FileSessionCounter {
  return (sessionCounterSingleton ??= new FileSessionCounter());
}
