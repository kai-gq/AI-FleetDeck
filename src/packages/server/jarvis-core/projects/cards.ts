/**
 * jarvis-core · 项目感知与路由（任务 14·⑪）·项目记忆卡构建（纯函数）
 *
 * 卡从世界数据派生（每次调用现算，不落盘）：
 *   workspace(areaIds) → DrawingArea(assignedAgentIds / directories) → boss-like agent
 *   ＋ 委派史里 TaskCard.projectId/sourceProject（任务10 落卡、任务12 消费）→ 在做/最近活跃。
 *
 * Boss 判定与 vcs.isBossLikeAgent / boss-service.isBossAgent 同一行判定
 * （isBoss === true || class === 'boss'；本目录不 import services，避免反向依赖）。
 *
 * 活跃度衰减：> PROJECT_CARD_DECAY_DAYS 无活跃 → status 'idle'（常量注明初始值非实测）。
 */

import type { DelegationDecision } from '../../../shared/agent-types.js';
import { normalizeAlias } from './aliases.js';
import {
  PROJECT_CARD_DECAY_DAYS,
  RECENT_DELEGATION_WINDOW_MS,
  type ProjectAgentInput,
  type ProjectAliasEntry,
  type ProjectAreaInput,
  type ProjectCard,
  type ProjectWorkspaceInput,
} from './types.js';

/** 单卡「在做」摘要上限（防单行膨胀；1-2 行快照的输入来源）。 */
export const PROJECT_CARD_MAX_IN_PROGRESS = 3;
/** 单卡关键词上限。 */
export const PROJECT_CARD_MAX_KEYWORDS = 12;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Boss 判定：与 vcs.isBossLikeAgent 同一行（isBoss 或 class==='boss'），有单测钉行为。 */
export function isProjectBossLike(agent: { isBoss?: boolean; class?: string }): boolean {
  return agent.isBoss === true || agent.class === 'boss';
}

export interface BuildProjectCardsInput {
  workspaces: readonly ProjectWorkspaceInput[];
  areas: readonly ProjectAreaInput[];
  agents: readonly ProjectAgentInput[];
  /** 委派史（任意顺序；内部按新→旧取）。任务卡可缺失（旧记录无卡 → 不计入在做）。 */
  delegationHistory?: readonly DelegationDecision[];
  /** 别名表条目（seed 种子由 aliases.seedAliasesForWorkspaces 先行合并）。 */
  aliases?: readonly ProjectAliasEntry[];
  now: number;
}

function activityOf(agent: ProjectAgentInput | undefined): number {
  if (!agent) return 0;
  return Math.max(agent.lastWorkedAt ?? 0, agent.lastActivity ?? 0);
}

/** 主管挑一个：成员里的 boss-like 按最近活动新→旧、同刻按名字（确定序，便于测试）。 */
function pickBoss(candidates: readonly ProjectAgentInput[]): ProjectAgentInput | undefined {
  const byId = new Map<string, ProjectAgentInput>();
  for (const c of candidates) if (!byId.has(c.id)) byId.set(c.id, c);
  const sorted = [...byId.values()].sort((a, b) => {
    const diff = activityOf(b) - activityOf(a);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  });
  return sorted[0];
}

/** 中文连续串 + 英文/数字词切词（>=2 字符；长串截 12 防关键词行膨胀）。 */
function extractKeywords(texts: readonly string[]): string[] {
  const out: string[] = [];
  const push = (word: string): void => {
    const w = word.trim();
    if (w.length < 2 || out.includes(w) || out.length >= PROJECT_CARD_MAX_KEYWORDS) return;
    out.push(w);
  };
  for (const text of texts) {
    for (const run of text.match(/[一-鿿]+/g) ?? []) {
      push(run.length > 12 ? run.slice(0, 12) : run);
    }
    for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]+/g) ?? []) push(word);
  }
  return out;
}

/** 该工作区关联的委派（projectId 或 sourceProject 命中；新→旧）。 */
function delegationsForProject(
  history: readonly DelegationDecision[],
  projectId: string,
): DelegationDecision[] {
  return [...history]
    .filter((d) => d.taskCard != null && (d.taskCard.projectId === projectId || d.taskCard.sourceProject === projectId))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * 构建全部项目卡。输入为空/工作区无区域成员时不抛：卡照建（主管缺省、在做空）。
 * 纯函数：不读盘、不写盘。
 */
export function buildProjectCards(input: BuildProjectCardsInput): ProjectCard[] {
  const { workspaces, areas, agents, delegationHistory = [], aliases = [], now } = input;
  const byId = new Map(agents.map((a) => [a.id, a]));
  const aliasesByProject = new Map<string, string[]>();
  for (const entry of aliases) {
    const list = aliasesByProject.get(entry.projectId) ?? [];
    if (!list.includes(entry.alias)) list.push(entry.alias);
    aliasesByProject.set(entry.projectId, list);
  }

  return workspaces.map((ws) => {
    const areaSet = new Set(ws.areaIds ?? []);
    const memberIds = new Set<string>();
    const bossCandidates: ProjectAgentInput[] = [];
    let rootDirHint: string | undefined;

    for (const area of areas) {
      if (area.archived) continue;
      if (!areaSet.has(area.id)) continue;
      for (const id of area.assignedAgentIds ?? []) {
        const agent = byId.get(id);
        if (!agent) continue;
        memberIds.add(id);
        if (isProjectBossLike(agent)) bossCandidates.push(agent);
      }
      if (!rootDirHint) {
        const dir = (area.directories ?? []).find((d) => typeof d === 'string' && d.trim());
        if (dir) rootDirHint = dir.trim();
      }
    }

    // 暂存兜底：区域里只有下属、主管自己不在区域成员里时，用下属的 bossId 反查
    // （兼容两侧只填一边的数据；Spec 主链仍是 assignedAgentIds → boss-like）。
    if (bossCandidates.length === 0) {
      for (const id of memberIds) {
        const bossId = byId.get(id)?.bossId;
        const boss = bossId ? byId.get(bossId) : undefined;
        if (boss && isProjectBossLike(boss) && !memberIds.has(boss.id)) bossCandidates.push(boss);
      }
    }

    const boss = pickBoss(bossCandidates);
    const delegations = delegationsForProject(delegationHistory, ws.id);
    const inProgress: string[] = [];
    for (const d of delegations) {
      const card = d.taskCard;
      // 完成/病历已写 → 不算「在做」；objective 空 → 跳过。
      if (!card || card.status === 'done' || d.completion) continue;
      const objective = card.objective?.trim();
      if (!objective || inProgress.includes(objective)) continue;
      inProgress.push(objective);
      if (inProgress.length >= PROJECT_CARD_MAX_IN_PROGRESS) break;
    }

    const aliasList = aliasesByProject.get(ws.id) ?? [];
    // 别名展示列表：归一化后与 workspace 名重复的种子别名不再重复列出。
    const displayAliases = aliasList.filter((a) => normalizeAlias(a) !== normalizeAlias(ws.name));
    const keywords = extractKeywords([ws.name, ...aliasList, ...inProgress]);

    let lastActiveAt = ws.createdAt ?? 0;
    for (const d of delegations) lastActiveAt = Math.max(lastActiveAt, d.timestamp);
    for (const id of memberIds) lastActiveAt = Math.max(lastActiveAt, activityOf(byId.get(id)));
    if (boss) lastActiveAt = Math.max(lastActiveAt, activityOf(boss));

    const status: ProjectCard['status'] =
      now - lastActiveAt > PROJECT_CARD_DECAY_DAYS * DAY_MS ? 'idle' : 'active';

    return {
      id: ws.id,
      name: ws.name,
      aliases: [ws.name, ...displayAliases],
      ...(boss ? { bossId: boss.id, bossName: boss.name } : {}),
      areaIds: [...(ws.areaIds ?? [])],
      ...(rootDirHint ? { rootDirHint } : {}),
      inProgress,
      keywords,
      lastActiveAt,
      status,
    };
  });
}

/**
 * 委派史 → 「最近委派」项目序列（新→旧、去重、只认 {@link RECENT_DELEGATION_WINDOW_MS}
 * 窗口内；taskCard.projectId 优先，sourceProject 兜底）。消歧② 的输入。
 */
export function collectRecentProjectIds(
  history: readonly DelegationDecision[],
  now: number,
  windowMs: number = RECENT_DELEGATION_WINDOW_MS,
): string[] {
  const cutoff = now - windowMs;
  const out: string[] = [];
  for (const d of [...history].sort((a, b) => b.timestamp - a.timestamp)) {
    if (d.timestamp < cutoff) break;
    const pid = d.taskCard?.projectId ?? d.taskCard?.sourceProject;
    if (pid && !out.includes(pid)) out.push(pid);
  }
  return out;
}
