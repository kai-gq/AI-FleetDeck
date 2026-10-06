/**
 * 任务23 · 团队共享记忆层（§9.2 台阶二①）
 *
 * 三件交付（任务书 ⑤）：
 *   1. **五要素统一视图**（视图层，零物理迁移）：委派史（任务21 结果字段）+ 病历（任务11）
 *      + 追踪态聚合为 { 谁 / 何时 / 做了什么 / 为什么 / 产出在哪 } 条目。三状态文件
 *      （voice-companion.json / delegation-history.json / tracking）物理结构不变（验收③）。
 *   2. **任务资产库**（append-only，见 team-asset-store.ts）：完成/失败事件驱动写入，
 *      条目由病历机械映射（确定性规则，非 LLM 自由写）。
 *   3. **Boss 派活先查**：新任务注入资产库命中摘要（buildAssetHitBlock，长度上限，
 *      与快照预算同风格）。注入点在 buildBossMessage（4 个生产调用点的唯一构造器）。
 *
 * 边界（任务书 ⑤5）：不吞并秘书个人记忆（任务27）/ 病历（任务11）——本模块只做
 * 「跨 agent / 跨任务」的只读聚合与资产沉淀；记忆文件的写路径仍归 27 所有。
 *
 * 本模块刻意不 import 任何 boss-* 模块（避免与 boss-response-handler 的完成钩子成环）：
 * 视图装配方（routes / 查询链路）负责把 histories / live 快照喂进纯函数。
 *
 * 回退开关：`TC_TEAM_MEMORY=0` 同时关停「资产入库」与「派活注入」（视图纯函数不受影响）。
 */

import type {
  DelegationDecision,
  DelegationUserRating,
  TaskCard,
  TaskCardPriority,
  TaskCardStatus,
} from '../../shared/types.js';
import {
  getTeamAssetStore,
  type TeamAssetEntry,
} from './team-asset-store.js';
import { createLogger } from '../utils/index.js';

const log = createLogger('TeamMemory');

// ============================================================================
// ① 五要素统一视图（纯函数装配）
// ============================================================================

/** 条目状态：任务卡状态机 ∪ 委派状态 ∪ 视图派生态（in-flight = 追踪中未落完成事件）。 */
export type TeamMemoryStatus = TaskCardStatus | 'sent' | 'in-flight' | 'completed' | 'failed';

/**
 * 团队记忆条目 = 五要素（任务书 ⑤1 逐字口径）。
 * 字段全部来自既有数据源，读取方按需渲染；不做截断（截断属于消费方预算）。
 */
export interface TeamMemoryEntry {
  decisionId: string;
  /** 派发链路 taskId（HC-B7；旧记录缺省）——任务24 看板按此关联派发行。 */
  taskId?: string;
  bossId: string;
  bossName?: string;
  /** 谁：执行者（agentId + 名字快照——agent 已删时名字仍可读）。 */
  who: { agentId: string; agentName: string };
  /** 何时：委派时刻 / 完成时刻 / 耗时（病历 durationMs）。 */
  when: { delegatedAt: number; completedAt?: number; durationMs?: number };
  /** 做了什么：任务目标 + 当前状态 + 截止日（任务17·A2）+ 优先级/项目归属（任务卡字段）。 */
  what: {
    objective: string;
    status: TeamMemoryStatus;
    due?: string;
    priority?: TaskCardPriority;
    projectId?: string;
  };
  /** 为什么：用户原话 + Boss 委派理由（+ 置信度）。 */
  why: { userCommand: string; reasoning: string; confidence?: 'high' | 'medium' | 'low' };
  /** 产出在哪：病历 outputLocation / summary（缺省 = 入口不可得，如实缺省不编造）。 */
  where: { outputLocation?: string; summary?: string };
  /** 结果面：终态结果 + 验收标准与打勾（病历 acceptance）+ 用户评价（⑧ 病历 userRating）。 */
  outcome: {
    result?: 'completed' | 'failed';
    acceptanceCriteria?: string[];
    acceptance?: Array<{ item: string; done: boolean }>;
    rating?: DelegationUserRating;
    ratedAt?: number;
  };
}

/** 活跃追踪输入快照（boss-response-handler.listActiveDelegations() 输出形态；本模块只读）。 */
export interface LiveDelegationInput {
  bossId: string;
  subordinateId: string;
  subordinateName?: string;
  taskDescription: string;
  decisionId?: string;
  taskId?: string;
  taskCard?: TaskCard;
}

/** 单个 Boss 的视图装配输入。 */
export interface TeamMemoryBossInput {
  bossId: string;
  bossName?: string;
  histories: readonly DelegationDecision[];
  /** 追踪态快照（在办任务——委派史里查不到完成事件的活动条目）。 */
  live?: readonly LiveDelegationInput[];
}

/** 坑清单（体检项）：失败原因 + 未打勾验收项（有则记）。 */
export function collectPitfalls(decision: DelegationDecision): string[] | undefined {
  const c = decision.completion;
  if (!c) return undefined;
  const out: string[] = [];
  if (c.result === 'failed') {
    out.push(c.reason ? `失败(${c.reason})` : '失败');
    if (c.summary) out.push(c.summary);
  }
  for (const a of c.acceptance ?? []) {
    if (!a.done) out.push(`未打勾:${a.item}`);
  }
  return out.length > 0 ? out : undefined;
}

/** 单条委派决策 → 五要素条目（纯映射；不改动入参）。 */
export function entryFromDecision(
  decision: DelegationDecision,
  metas: { bossId?: string; bossName?: string; status?: TeamMemoryStatus } = {}
): TeamMemoryEntry {
  const card = decision.taskCard;
  const completion = decision.completion;
  const status: TeamMemoryStatus =
    metas.status ?? completion?.result ?? card?.status ?? decision.status;
  return {
    decisionId: decision.id,
    ...(decision.taskId ? { taskId: decision.taskId } : {}),
    bossId: metas.bossId ?? decision.bossId,
    ...(metas.bossName ? { bossName: metas.bossName } : {}),
    who: { agentId: decision.selectedAgentId, agentName: decision.selectedAgentName },
    when: {
      delegatedAt: decision.timestamp,
      ...(completion ? { completedAt: completion.completedAt, durationMs: completion.durationMs } : {}),
    },
    what: {
      objective: card?.objective?.trim() || decision.userCommand,
      status,
      ...(card?.due ? { due: card.due } : {}),
      ...(card?.priority ? { priority: card.priority } : {}),
      ...(card?.projectId ? { projectId: card.projectId } : {}),
    },
    why: {
      userCommand: decision.userCommand,
      reasoning: decision.reasoning,
      confidence: decision.confidence,
    },
    where: {
      ...(completion?.outputLocation ? { outputLocation: completion.outputLocation } : {}),
      ...(completion?.summary ? { summary: completion.summary } : {}),
    },
    outcome: {
      ...(completion?.result ? { result: completion.result } : {}),
      ...(card?.acceptanceCriteria?.length ? { acceptanceCriteria: [...card.acceptanceCriteria] } : {}),
      ...(completion?.acceptance?.length ? { acceptance: [...completion.acceptance] } : {}),
      ...(decision.userRating ? { rating: decision.userRating } : {}),
      ...(decision.ratedAt ? { ratedAt: decision.ratedAt } : {}),
    },
  };
}

/**
 * 多 Boss 视图装配（纯函数）：委派史逐条 → 五要素；追踪中的活跃委派标 in-flight，
 * 且补上「有追踪、史里还没完成事件」的条目（转瞬即逝的中间态也不丢）。
 * 排序：时间倒序（完成时刻优先，否则委派时刻），同刻按 decisionId 稳定排序。
 */
export function buildTeamMemoryEntries(
  bosses: readonly TeamMemoryBossInput[]
): TeamMemoryEntry[] {
  const entries: TeamMemoryEntry[] = [];
  const seen = new Set<string>();

  for (const boss of bosses) {
    const liveByDecision = new Map<string, LiveDelegationInput>();
    for (const l of boss.live ?? []) {
      if (l.decisionId) liveByDecision.set(l.decisionId, l);
    }
    for (const decision of boss.histories) {
      if (seen.has(decision.id)) continue;
      seen.add(decision.id);
      // 状态优先级：完成事件结果 > 追踪中(in-flight) > 卡/委派默认链（entryFromDecision 内）
      const status: TeamMemoryStatus | undefined = decision.completion
        ? decision.completion.result
        : liveByDecision.has(decision.id)
          ? 'in-flight'
          : undefined;
      entries.push(
        entryFromDecision(decision, {
          bossId: boss.bossId,
          bossName: boss.bossName,
          ...(status ? { status } : {}),
        })
      );
    }
    // 史里没有的活跃追踪（重建前/裁剪后）：补 in-flight 条目，绝不丢在办视角
    for (const l of boss.live ?? []) {
      if (l.decisionId && seen.has(l.decisionId)) continue;
      if (l.decisionId) seen.add(l.decisionId);
      const key = l.decisionId ?? `live:${l.subordinateId}`;
      entries.push({
        decisionId: key,
        ...(l.taskId ? { taskId: l.taskId } : {}),
        bossId: boss.bossId,
        ...(boss.bossName ? { bossName: boss.bossName } : {}),
        who: { agentId: l.subordinateId, agentName: l.subordinateName ?? l.subordinateId },
        when: { delegatedAt: 0 },
        what: {
          objective: l.taskCard?.objective?.trim() || l.taskDescription,
          status: 'in-flight',
          ...(l.taskCard?.due ? { due: l.taskCard.due } : {}),
          ...(l.taskCard?.priority ? { priority: l.taskCard.priority } : {}),
          ...(l.taskCard?.projectId ? { projectId: l.taskCard.projectId } : {}),
        },
        why: { userCommand: l.taskDescription, reasoning: '(追踪态：委派史无对应记录)' },
        where: {},
        outcome: {
          ...(l.taskCard?.acceptanceCriteria?.length
            ? { acceptanceCriteria: [...l.taskCard.acceptanceCriteria] }
            : {}),
        },
      });
    }
  }

  entries.sort((a, b) => {
    const ta = a.when.completedAt ?? a.when.delegatedAt;
    const tb = b.when.completedAt ?? b.when.delegatedAt;
    if (tb !== ta) return tb - ta;
    return a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0;
  });
  return entries;
}

// ============================================================================
// ② 资产条目映射 + 入库钩子（完成/失败事件驱动；确定性规则）
// ============================================================================

/** 条目内文字段截断上限（防单条资产超长；长度验收在 ⑮ 标定）。 */
export const ASSET_TEXT_MAX_CHARS = 200;

function trimText(value: string | undefined, max = ASSET_TEXT_MAX_CHARS): string {
  const clean = (value ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * 委派决策 → 资产条目（纯函数）。
 * 仅在**完成/失败事件已固化**（completion 存在）时返回条目——「只在完成/失败事件时写」（任务书 ⑤4）。
 * 无 completion（sent/pending/in-flight）→ null：不写资产。
 */
export function decisionToAssetEntry(
  decision: DelegationDecision,
  opts: { now?: number } = {}
): TeamAssetEntry | null {
  const completion = decision.completion;
  if (!completion) return null;
  const card = decision.taskCard;
  const pitfalls = collectPitfalls(decision);
  return {
    decisionId: decision.id,
    bossId: decision.bossId,
    agentId: decision.selectedAgentId,
    agentName: decision.selectedAgentName,
    objective: trimText(card?.objective?.trim() || decision.userCommand),
    userCommand: trimText(decision.userCommand),
    reasoning: trimText(decision.reasoning),
    ...(card?.acceptanceCriteria?.length ? { acceptanceCriteria: [...card.acceptanceCriteria] } : {}),
    ...(pitfalls ? { pitfalls } : {}),
    ...(completion.outputLocation ? { outputLocation: trimText(completion.outputLocation) } : {}),
    ...(completion.summary ? { summary: trimText(completion.summary) } : {}),
    durationMs: completion.durationMs,
    outcome: completion.result,
    completedAt: completion.completedAt,
    recordedAt: opts.now ?? Date.now(),
  };
}

/** 总开关：TC_TEAM_MEMORY=0 同时关停入库与注入（故障排查/体验对比用）。 */
export function isTeamMemoryEnabled(): boolean {
  return process.env.TC_TEAM_MEMORY !== '0';
}

/**
 * 完成漏斗钩子（fail-open）：完成/失败事件 → 追加资产条目。
 * - 幂等：同 decisionId 二次到达由 store 层拒绝（duplicate 属正常路径，不告警）；
 * - 任何异常（磁盘等）绝不上抛——完成链路（回执/病历）永远优先。
 */
export function appendDecisionToAssetLibrary(decision: DelegationDecision): boolean {
  if (!isTeamMemoryEnabled()) return false;
  try {
    const entry = decisionToAssetEntry(decision);
    if (!entry) return false;
    const result = getTeamAssetStore().append(entry);
    if (result.appended) {
      log.log(
        `[TeamMemory] 资产入库 decision=${entry.decisionId} agent=${entry.agentName} outcome=${entry.outcome} 耗时=${entry.durationMs}ms`
      );
      return true;
    }
    if (result.reason !== 'duplicate') {
      log.warn(`[TeamMemory] 资产入库被拒 reason=${result.reason} decision=${entry.decisionId}`);
    }
    return false;
  } catch (err) {
    log.warn(`[TeamMemory] 资产入库异常(忽略): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ============================================================================
// ③ Boss 派活先查：资产库命中摘要（长度上限，勿超快照预算风格）
// ============================================================================

/** 命中摘要总长上限（回写⑧：初始值非实测 → ⑭ → ⑮ 标定；与快照预算同量级）。 */
export const ASSET_HIT_BLOCK_MAX_CHARS = 600;
/** 单行上限。 */
export const ASSET_HIT_LINE_MAX_CHARS = 96;
/** 最多命中条数。 */
export const ASSET_HIT_MAX_ITEMS = 3;

export interface AssetHit {
  entry: TeamAssetEntry;
  score: number;
  matchedTokens: string[];
}

/**
 * 中文/英文混合分词（命中匹配用；确定性、无依赖）：
 * - CJK 连续串 → 滑窗 2/3/4 字子串（"帮我看看登录页" → 登录/登录页…；三字窗覆盖"登录页"
 *   这类词，不依赖词典）；
 * - ASCII 词 ≥2 字符（小写归一）；
 * - 常用对话套话（"帮我/看看/一下"…）过滤——这些词命中任何条目都无信息量。
 */
const HIT_STOPWORDS = new Set([
  '帮我', '我一', '一下', '看看', '这个', '那个', '一个', '什么', '怎么', '可以',
  '我们', '你们', '他们', '现在', '已经', '然后', '就是', '还是', '但是', '因为',
  '所以', '如果', '麻烦', '辛苦', '帮忙', '需要', '的话',
]);

export function tokenizeForHits(text: string): string[] {
  const tokens = new Set<string>();
  for (const m of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []) {
    tokens.add(m);
  }
  for (const run of text.match(/[一-鿿]{2,}/g) ?? []) {
    for (let size = 2; size <= 4; size++) {
      for (let i = 0; i + size <= run.length; i++) {
        const win = run.slice(i, i + size);
        if (!HIT_STOPWORDS.has(win)) tokens.add(win);
      }
    }
  }
  return [...tokens].slice(0, 60);
}

function isCjkToken(token: string): boolean {
  return /^[一-鿿]+$/.test(token);
}

/**
 * 资产命中检索（纯函数）：按词面重合打分——
 *   - 长 CJK 词（>2 字，如整串"登录页"）计 2 分；二字组/英文词计 1 分；
 *   - 命中面 = 任务侧字段（目标/原话/摘要/验收/执行者），不含 reasoning（理由长且杂，易泛化误命中）；
 *   - 排序：分数降序 → 完成时间降序 → decisionId 升序（同分稳定，测试可钉）。
 */
export function findAssetHits(
  assets: readonly TeamAssetEntry[],
  text: string,
  opts: { maxHits?: number; minScore?: number } = {}
): AssetHit[] {
  const maxHits = opts.maxHits ?? ASSET_HIT_MAX_ITEMS;
  const minScore = opts.minScore ?? 1;
  const tokens = tokenizeForHits(text);
  if (tokens.length === 0) return [];

  const scored: AssetHit[] = [];
  for (const entry of assets) {
    const haystack = [
      entry.objective,
      entry.userCommand,
      entry.summary ?? '',
      entry.outputLocation ?? '',
      entry.agentName,
      ...(entry.acceptanceCriteria ?? []),
      ...(entry.pitfalls ?? []),
    ]
      .join('\n')
      .toLowerCase();
    const matchedTokens = tokens.filter((t) => haystack.includes(t));
    const score = matchedTokens.reduce((sum, t) => sum + (isCjkToken(t) && t.length > 2 ? 2 : 1), 0);
    if (score >= minScore) scored.push({ entry, score, matchedTokens });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.entry.completedAt !== a.entry.completedAt) return b.entry.completedAt - a.entry.completedAt;
    return a.entry.decisionId < b.entry.decisionId ? -1 : a.entry.decisionId > b.entry.decisionId ? 1 : 0;
  });
  return scored.slice(0, maxHits);
}

/** 耗时人性化（确定性）。 */
export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return '不足1秒';
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  return `${(minutes / 60).toFixed(1)}小时`;
}

/**
 * 命中摘要渲染（纯函数）：null = 无命中（调用方保持输出与旧版逐字节一致）。
 * 每行：〈目标〉・执行者・日期・结果・耗时・产出；行/总长双上限，超限截断丢弃整行。
 */
export function renderAssetHitBlock(
  hits: readonly AssetHit[],
  opts: { maxChars?: number; lineMaxChars?: number } = {}
): string | null {
  if (hits.length === 0) return null;
  const maxChars = opts.maxChars ?? ASSET_HIT_BLOCK_MAX_CHARS;
  const lineMaxChars = opts.lineMaxChars ?? ASSET_HIT_LINE_MAX_CHARS;
  const header = '【团队资产命中】以下历史任务与本次相关(供拆解参考,不必强制沿用):';
  const lines: string[] = [header];
  let total = header.length;
  for (const hit of hits) {
    const e = hit.entry;
    const date = new Date(e.completedAt).toISOString().slice(0, 10);
    const outcomeTag = e.outcome === 'failed' ? '未成' : '完成';
    const where = e.outputLocation
      ? `产出:${e.outputLocation}`
      : e.summary
        ? `摘要:${e.summary}`
        : '产出位置未记录';
    let line = `- 〈${trimText(e.objective, 30)}〉 ${e.agentName} ${date} ${outcomeTag}・耗时${formatDuration(e.durationMs)}・${where}`;
    if (line.length > lineMaxChars) line = `${line.slice(0, lineMaxChars - 1)}…`;
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.length > 1 ? lines.join('\n') : null;
}

/**
 * 生产便捷出口：读资产库 + 命中 + 渲染（fail-open：任何异常返回 null，绝不拦断消息构造）。
 */
export function buildAssetHitBlock(text: string): string | null {
  if (!isTeamMemoryEnabled()) return null;
  try {
    const hits = findAssetHits(getTeamAssetStore().list(), text);
    return renderAssetHitBlock(hits);
  } catch (err) {
    log.warn(`[TeamMemory] 命中摘要构造失败(忽略): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
