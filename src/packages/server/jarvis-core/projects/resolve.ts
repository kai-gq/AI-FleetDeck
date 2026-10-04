/**
 * jarvis-core · 项目感知与路由（任务 14·⑪）·三层消歧（纯函数，Spec §4.11 / §5.2）
 *
 *   ① 显式信号：口称别名命中 → 模型显式 bossId → 激活工作区 → 上一问建议确认；
 *   ② 对话上下文：会话最近提及（lastProjectId）→ 最近委派史（时间窗内）；
 *   ③ 记忆卡关键词匹配：中文 2-gram / 英文词重叠，唯一最高分才命中（平票 = 歧义）。
 *
 * 三态路由（§5.3）：
 *   - 唯一命中即路由（无论哪层）；
 *   - 全仓仅 1 个 boss-like → 直派不反问（单 Boss 退化，现状零回归）；
 *   - All（未切 workspace）+ 多 Boss + 三层消不掉 → 反问一次；
 *   - 其余（已切 workspace 但消不掉 / 无可派主管 / 无项目卡）→ 回落现状首位 Boss（登记）。
 *
 * 反问只问一次由接线层的一次性消歧态保证：本模块只给「要不要问 / 问什么 / 建议是谁」。
 */

import { matchAliases } from './aliases.js';
import type {
  ProjectCard,
  ProjectResolveCandidate,
  ProjectResolveInput,
  ProjectResolveResult,
  ResolveLayer,
} from './types.js';

/** 反问句最多列几个候选项目名（问句别太长）。 */
export const PROJECT_ASK_MAX_CANDIDATES = 3;
/** 歧义候选登记上限（⑪ 观测防膨胀）。 */
export const PROJECT_MAX_AMBIGUOUS_CANDIDATES = 5;

/** 取消话术（消歧答案把已挂起的活撤回）。 */
const CANCEL_RE = /(算了|取消|不做了|不用了|不弄了|先不做|别做了|不派了)/;
/** 否定片段（「不是项目B，是项目C」→ 去掉否定片段再匹配，防误命中被否定的项目）。 */
const NEGATED_CLAUSE_RE = /(?:不是|不对|不要|不用|别)[^，,。;；!！?？]*/g;
/** 肯定确认（配合上一问的建议项目：回答「是/对/嗯」= 确认它）。 */
const AFFIRMATIVE_RE = /^(?:(?:是|对|嗯+|好|行|可以|没错|要得)(?:的|了|吧|啊)?|yes|yep|yeah|ok|okay)$/;

export function isCancelText(text: string): boolean {
  return CANCEL_RE.test(text);
}

/** 纯确认语（不含项目名时也吃）：「是」「对的」「嗯」→ true；「是项目B」→ false（交给别名层）。 */
export function isAffirmativeText(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[。.!！，,~～\s]+$/g, '');
  return AFFIRMATIVE_RE.test(normalized);
}

// ============================================================================
// ③ 关键词匹配的内部实现（2-gram / 英文词重叠）
// ============================================================================

/** 中文连续串取 2-gram；英文/数字取整词（>=2 字符，忽略大小写）。 */
function gramsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const run of text.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  }
  for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]+/g) ?? []) out.add(word);
  return out;
}

function corpusOf(card: ProjectCard): string {
  return [card.name, ...card.aliases, ...card.keywords, ...card.inProgress].join('\n');
}

interface KeywordRace {
  card?: ProjectCard;
  score: number;
  second: number;
  sample?: string;
  tied: ProjectCard[];
}

/** 逐卡打分：共享 gram 数；最高分严格大于次高才算唯一命中。 */
function keywordRace(text: string, cards: readonly ProjectCard[]): KeywordRace {
  const textGrams = gramsOf(text);
  if (textGrams.size === 0) return { score: 0, second: 0, tied: [] };
  const scored = cards
    .map((card) => {
      const corpusGrams = gramsOf(corpusOf(card));
      let score = 0;
      let sample: string | undefined;
      for (const gram of textGrams) {
        if (!corpusGrams.has(gram)) continue;
        score += 1;
        if (!sample) sample = gram;
      }
      return { card, score, sample };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.card.name.localeCompare(b.card.name));
  if (scored.length === 0) return { score: 0, second: 0, tied: [] };
  const best = scored[0];
  return {
    card: best.card,
    score: best.score,
    second: scored[1]?.score ?? 0,
    sample: best.sample,
    tied: scored.filter((entry) => entry.score === best.score).map((entry) => entry.card),
  };
}

// ============================================================================
// 反问句 / 候选挑选
// ============================================================================

/** 反问候选：先用在层里提名过的（有主管的）项目，没有就用全部有主管的项目（按活跃度）。 */
function pickAskCards(
  candidates: readonly ProjectResolveCandidate[],
  cardById: ReadonlyMap<string, ProjectCard>,
  eligible: readonly ProjectCard[],
): ProjectCard[] {
  const fromCandidates: ProjectCard[] = [];
  for (const candidate of candidates) {
    const card = cardById.get(candidate.projectId);
    if (card?.bossId && !fromCandidates.includes(card)) fromCandidates.push(card);
  }
  const pool = fromCandidates.length > 0
    ? fromCandidates
    : [...eligible].sort((a, b) => (b.lastActiveAt - a.lastActiveAt) || a.name.localeCompare(b.name));
  return pool.slice(0, PROJECT_ASK_MAX_CANDIDATES);
}

function buildAskQuestion(cards: readonly ProjectCard[]): string {
  const names = cards.map((c) => `「${c.name}」`);
  if (names.length === 1) return `这活是交给${names[0]}的吗？不是的话，回一下项目名。`;
  return `这活要交给哪个项目？我现在有：${names.join('、')}。回一句项目名就行。`;
}

// ============================================================================
// 三层消歧主入口
// ============================================================================

export function resolveProjectTarget(input: ProjectResolveInput): ProjectResolveResult {
  const cards = input.cards;
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const candidates: ProjectResolveCandidate[] = [];

  const nominate = (card: ProjectCard, layer: ResolveLayer, source: string): void => {
    const existing = candidates.find((c) => c.projectId === card.id && c.layer === layer);
    if (existing) {
      existing.source = source;
      return;
    }
    candidates.push({ projectId: card.id, name: card.name, layer, source, hit: false });
  };
  const hit = (card: ProjectCard, layer: ResolveLayer, source: string): ProjectResolveResult => {
    const existing = candidates.find((c) => c.projectId === card.id && c.layer === layer);
    if (existing) {
      existing.hit = true;
      existing.source = source;
    } else {
      candidates.push({ projectId: card.id, name: card.name, layer, source, hit: true });
    }
    return {
      projectId: card.id,
      projectName: card.name,
      ...(card.bossId ? { bossId: card.bossId } : {}),
      layer,
      source,
      candidates,
      needAsk: false,
    };
  };

  const bosses = input.bosses ?? [];
  // 无可派主管：不路由也不反问（no_boss 由现状路由处理）。
  if (bosses.length === 0) return { candidates, needAsk: false };

  // 单 Boss 退化：全仓仅 1 个 boss-like → 直派不反问（现状零回归）。
  if (bosses.length === 1) {
    const only = bosses[0];
    const owner = cards.find((c) => c.bossId === only.id);
    if (owner) nominate(owner, 'explicit', 'single-boss');
    return {
      ...(owner ? { projectId: owner.id, projectName: owner.name } : {}),
      bossId: only.id,
      degenerate: true,
      source: 'single-boss',
      candidates,
      needAsk: false,
    };
  }

  const text = input.text ?? '';
  const cleaned = text.replace(NEGATED_CLAUSE_RE, ' ');

  // ── ① 显式信号：口称别名 → 模型显式 bossId → 激活工作区 → 建议确认 ──
  const aliasMatches = matchAliases(cleaned, input.aliases ?? []);
  for (const match of aliasMatches) {
    const card = cardById.get(match.projectId);
    if (card) nominate(card, 'explicit', `alias:${match.alias}`);
  }
  if (aliasMatches.length === 1) {
    const card = cardById.get(aliasMatches[0].projectId);
    if (card?.bossId) return hit(card, 'explicit', `alias:${aliasMatches[0].alias}`);
  }
  if (input.modelBossId) {
    const card = cards.find((c) => c.bossId === input.modelBossId);
    if (card) return hit(card, 'explicit', 'boss-id');
    // 显式 bossId 没映射到项目卡：目标仍有效（路由按 requested），只记「未映射」不再问。
  }
  if (input.activeWorkspaceId) {
    const card = cardById.get(input.activeWorkspaceId);
    if (card) {
      nominate(card, 'explicit', 'active-workspace');
      if (card.bossId) return hit(card, 'explicit', 'active-workspace');
    }
  }
  if (input.clarifySuggestion && isAffirmativeText(text)) {
    const card = cardById.get(input.clarifySuggestion);
    if (card?.bossId) return hit(card, 'explicit', 'clarify-confirm');
  }

  // ── ② 对话上下文：最近提及 → 最近委派史 ──
  if (input.lastProjectId) {
    const card = cardById.get(input.lastProjectId);
    if (card?.bossId) return hit(card, 'context', 'last-project');
  }
  for (const projectId of input.recentProjectIds ?? []) {
    const card = cardById.get(projectId);
    if (card?.bossId) return hit(card, 'context', 'recent-delegation');
  }

  // ── ③ 记忆卡关键词匹配（唯一最高分才命中；平票 = 歧义） ──
  const race = keywordRace(cleaned, cards);
  if (race.card && race.score > 0) {
    const source = `keyword:${race.sample ?? ''}`;
    if (race.score > race.second) return hit(race.card, 'keyword', source);
    for (const tied of race.tied.slice(0, PROJECT_MAX_AMBIGUOUS_CANDIDATES)) nominate(tied, 'keyword', source);
  }

  // ── 三态判定 ──
  const explicitBossSignal = Boolean(input.modelBossId);
  const eligible = cards.filter((c) => c.bossId);
  if (!input.activeWorkspaceId && !explicitBossSignal && eligible.length > 0) {
    const ask = pickAskCards(candidates, cardById, eligible);
    return {
      candidates,
      needAsk: true,
      askQuestion: buildAskQuestion(ask),
      ...(ask.length === 1 ? { suggestedProjectId: ask[0].id } : {}),
    };
  }
  // 已切 workspace 仍消不掉 / 无项目卡 → 回落现状默认（首位 Boss；由接线层登记该选择）。
  return { candidates, needAsk: false };
}

// ============================================================================
// 一次性反问的「回答」消费（纯决策；派发/播报在接线层）
// ============================================================================

export type ClarificationAnswerPlan =
  | { kind: 'resolve'; bossId: string; projectId?: string; projectName?: string; source: string; decision: ProjectResolveResult }
  | { kind: 'fallback'; decision: ProjectResolveResult }
  | { kind: 'abandon' };

/**
 * 反问后的下一轮按「回答」消费一次：
 * - 取消话术 → abandon（不派活，丢弃挂起任务）；
 * - 别名/上下文/关键词解析出项目 → resolve（派给该项目主管）；
 * - 消不掉（含否定后无替换项）→ fallback（回落现状首位 Boss，接线层登记该选择）。
 */
export function planClarificationAnswer(input: ProjectResolveInput): ClarificationAnswerPlan {
  if (isCancelText(input.text)) return { kind: 'abandon' };
  const decision = resolveProjectTarget(input);
  if (decision.bossId) {
    return {
      kind: 'resolve',
      bossId: decision.bossId,
      ...(decision.projectId ? { projectId: decision.projectId } : {}),
      ...(decision.projectName ? { projectName: decision.projectName } : {}),
      source: decision.source ?? 'clarify',
      decision,
    };
  }
  return { kind: 'fallback', decision };
}
