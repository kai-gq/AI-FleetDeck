/**
 * 语音伙伴服务 — 项目感知与路由接线层(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * 世界构建(workspaces/areas/agents/委派史 → 项目卡)+ 快照行 + 一次调用完成的三层消歧
 * + 一次性反问消费;决策逻辑全在 jarvis-core/projects/**,本模块只是服务侧数据接线与内存态。
 * 开关关 = 零调用(快照不注、路由无第 4 参、不产 ⑪ 观测)。
 */
import { logger } from '../../utils/index.js';
import * as agentService from '../agent-service.js';
import * as workspaceService from '../workspace-service.js';
import { logDelegation } from '../activity-log.js';
import { loadAreas } from '../../data/index.js';
import { logEvent } from '../../data/system-log.js';
import { emptyAliasTable, loadAliasTable, saveAliasTable, seedAliasesForWorkspaces } from '../../jarvis-core/projects/aliases.js';
import { buildProjectCards, collectRecentProjectIds } from '../../jarvis-core/projects/cards.js';
import { createProjectRoutingLogObserver } from '../../jarvis-core/projects/observability.js';
import { renderProjectSnapshotLines } from '../../jarvis-core/projects/render.js';
import { planClarificationAnswer, resolveProjectTarget, type ClarificationAnswerPlan } from '../../jarvis-core/projects/resolve.js';
import type {
  ProjectAgentInput,
  ProjectAliasEntry,
  ProjectAliasTable,
  ProjectAreaInput,
  ProjectBossRef,
  ProjectCard,
  ProjectResolveInput,
  ProjectResolveResult,
  ProjectRoutingEvent,
  ProjectWorkspaceInput,
} from '../../jarvis-core/projects/types.js';
import type { DelegationDecision } from '../../../shared/agent-types.js';
import { isBossLikeAgent } from './agents.js';
import { truncate } from './contract.js';
import { deliverToAgent } from './deliver.js';
import type { DispatchTargetAgent } from './dispatch-route.js';
import { collectDelegationHistory, type SnapshotAgent } from './snapshot.js';
import type { CompanionDelivery, VoiceCompanionState, VoiceProcessResult } from './types.js';

const log = logger.server;

// ============================================================================
// 任务14·⑪ 项目感知与路由 · 接线层
// 世界构建（workspaces/areas/agents/委派史 → 项目卡）+ 快照行 + 一次调用完成的
// 三层消歧 + 一次性反问消费；决策逻辑全在 jarvis-core/projects/**，本节只是服务侧
// 数据接线与内存态。**开关关 = 本节零调用**（快照不注、路由无第 4 参、不产 ⑪ 观测）。
// ============================================================================

/** 消歧反问挂起时效：超时丢弃挂起、按新一轮处理（初始值非实测，待 ⑭ 标定回写）。 */
export const PROJECT_CLARIFY_TTL_MS = 10 * 60_000;

interface PendingProjectClarification {
  question: string;
  /** 单候选问句时的建议项目（回答「是/对」直接确认它）。 */
  suggestionProjectId?: string;
  /** 挂起时模型给出的任务指令（回答后直接派发，不再跑 hop1）。 */
  message: string;
  delivery: CompanionDelivery;
  askedAt: number;
  taskId?: string;
  /** 挂起时的用户原话（message 为空时的兜底指令）。 */
  originalText: string;
}

interface ProjectRoutingRuntime {
  /** 会话内最近提及的项目（派发/命中携带 projectId 时更新；消歧② 输入）。 */
  lastProjectId: string | null;
  /** 本会话累计反问次数（⑪ 观测：反问多 = 记忆卡不准？）。 */
  askCount: number;
  /** 一次性消歧挂起态（在途任务等一句回答；最多反问一次）。 */
  pending: PendingProjectClarification | null;
}

export const projectRoutingRuntime: ProjectRoutingRuntime = { lastProjectId: null, askCount: 0, pending: null };

/** 会话轮换/重置时清空项目路由内存态（不落盘，与 session 同生命周期）。 */
export function resetProjectRoutingSession(): void {
  projectRoutingRuntime.lastProjectId = null;
  projectRoutingRuntime.askCount = 0;
  projectRoutingRuntime.pending = null;
}

/** 项目路由世界（一次构建，快照与派发消歧共用同一形态）。 */
export interface ProjectRoutingWorld {
  cards: ProjectCard[];
  aliasEntries: ProjectAliasEntry[];
  /** 服务端激活工作区（null = All，即未切）。 */
  activeWorkspaceId: string | null;
  bosses: ProjectBossRef[];
  delegationHistory: DelegationDecision[];
  now: number;
}

export interface ProjectRoutingWorldDeps {
  getWorkspaces?: () => readonly ProjectWorkspaceInput[];
  getActiveWorkspace?: () => string | null;
  loadAreasFn?: () => readonly ProjectAreaInput[];
  getAllAgents?: () => readonly ProjectAgentInput[];
  /** 已收集的委派史（传了就不再自读，防同回合重复读盘）。 */
  delegationHistory?: readonly DelegationDecision[];
  /** 别名表文件路径（测试注入临时路径；缺省 XDG 默认）。 */
  aliasesFilePath?: string;
  now?: () => number;
}

/** 别名表：读文件 → 补 workspace 名种子（有新增才落盘；读/写失败只告警不打断）。 */
function loadSeededAliasTable(
  workspaces: readonly ProjectWorkspaceInput[],
  now: number,
  filePath?: string,
): ProjectAliasTable {
  let table: ProjectAliasTable;
  try {
    table = loadAliasTable(filePath);
  } catch (err) {
    log.warn(`[VoiceCompanion] 项目别名表读取失败(按空表): ${(err as Error).message}`);
    table = emptyAliasTable(now);
  }
  const seeded = seedAliasesForWorkspaces(table, workspaces, now);
  if (seeded !== table) {
    try {
      saveAliasTable(seeded, filePath);
    } catch (err) {
      log.warn(`[VoiceCompanion] 项目别名表落盘失败(仅内存生效): ${(err as Error).message}`);
    }
  }
  return seeded;
}

/**
 * 构建项目路由世界（服务侧接线）：workspaces/areas/agents/委派史 → 项目卡 + 别名表。
 * 任一步读取失败都降级为空集，绝不打断 hop1/派发；测试可注入全部依赖（零 IO）。
 */
export function buildProjectRoutingWorld(deps: ProjectRoutingWorldDeps = {}): ProjectRoutingWorld {
  const now = (deps.now ?? (() => Date.now()))();
  let workspaces: readonly ProjectWorkspaceInput[] = [];
  try {
    workspaces = (deps.getWorkspaces ?? workspaceService.getWorkspaces)();
  } catch (err) {
    log.warn(`[VoiceCompanion] 项目路由:读工作区失败(按空处理): ${(err as Error).message}`);
  }
  let activeWorkspaceId: string | null = null;
  try {
    activeWorkspaceId = (deps.getActiveWorkspace ?? workspaceService.getActiveWorkspace)();
  } catch (err) {
    log.warn(`[VoiceCompanion] 项目路由:读激活工作区失败(按 All 处理): ${(err as Error).message}`);
  }
  let areas: readonly ProjectAreaInput[] = [];
  try {
    areas = (deps.loadAreasFn ?? loadAreas)();
  } catch (err) {
    log.warn(`[VoiceCompanion] 项目路由:读区域失败(按空处理): ${(err as Error).message}`);
  }
  let agents: readonly ProjectAgentInput[] = [];
  try {
    agents = (deps.getAllAgents ?? agentService.getAllAgents)();
  } catch (err) {
    log.warn(`[VoiceCompanion] 项目路由:读 agent 失败(按空处理): ${(err as Error).message}`);
  }
  let delegationHistory: readonly DelegationDecision[] = deps.delegationHistory ?? [];
  if (!deps.delegationHistory) {
    try {
      // collectDelegationHistory 只读 id/class/isBoss（内部逐 Boss 容错），结构型收窄安全。
      delegationHistory = collectDelegationHistory(agents as readonly SnapshotAgent[]);
    } catch (err) {
      log.warn(`[VoiceCompanion] 项目路由:读委派史失败(按空处理): ${(err as Error).message}`);
      delegationHistory = [];
    }
  }
  const aliasTable = loadSeededAliasTable(workspaces, now, deps.aliasesFilePath);
  const cards = buildProjectCards({ workspaces, areas, agents, delegationHistory, aliases: aliasTable.entries, now });
  const bosses: ProjectBossRef[] = agents
    .filter((a) => isBossLikeAgent(a))
    .map((a) => ({ id: a.id, name: a.name }));
  return { cards, aliasEntries: aliasTable.entries, activeWorkspaceId, bosses, delegationHistory: [...delegationHistory], now };
}

/** 项目快照行（render.ts 压缩版）；无卡返回 []（不注快照块）。 */
export function buildProjectRoutingSnapshotLines(world: ProjectRoutingWorld): string[] {
  return renderProjectSnapshotLines({
    cards: world.cards,
    activeWorkspaceId: world.activeWorkspaceId,
    now: world.now,
  });
}

/**
 * 一次调用完成三层消歧（接线薄胶水）：把服务侧状态（会话最近提及 / 模型显式 bossId /
 * 激活工作区 / 最近委派）拼成模块输入，决策逻辑全在 resolve.ts。
 */
export function resolveProjectRoutingForTurn(input: {
  text: string;
  targetAgentId: string | null;
  agents: readonly DispatchTargetAgent[];
  world: ProjectRoutingWorld;
  lastProjectId: string | null;
  clarifySuggestion?: string;
}): ProjectResolveResult {
  const target = input.targetAgentId ? input.agents.find((a) => a.id === input.targetAgentId) : undefined;
  const resolveInput: ProjectResolveInput = {
    text: input.text,
    cards: input.world.cards,
    aliases: input.world.aliasEntries,
    activeWorkspaceId: input.world.activeWorkspaceId,
    lastProjectId: input.lastProjectId,
    recentProjectIds: collectRecentProjectIds(input.world.delegationHistory, input.world.now),
    bosses: input.world.bosses,
    ...(target && isBossLikeAgent(target) ? { modelBossId: target.id } : {}),
    ...(input.clarifySuggestion ? { clarifySuggestion: input.clarifySuggestion } : {}),
  };
  return resolveProjectTarget(resolveInput);
}

let projectRoutingObserver: ((event: ProjectRoutingEvent) => void) | undefined;

/** ⑪ 观测出口（懒建；source='project-routing'，不改 activity-log 常量表；适配器自身不抛）。 */
export function logProjectRouting(event: ProjectRoutingEvent): void {
  if (!projectRoutingObserver) {
    projectRoutingObserver = createProjectRoutingLogObserver(logEvent, { channel: 'voice' });
  }
  projectRoutingObserver(event);
}

/**
 * 一次性消歧：上一回合挂了反问 → 本回合先按「回答」消费（不跑 hop1，也不反问第二次）：
 * - 取消话术 → 丢弃挂起任务（clarify-abandoned）；
 * - 解析出项目 → 直接派给该项目主管（clarify-resolved）；
 * - 仍消不掉 → 回落现状首位 Boss 并登记该选择（clarify-fallback，⑪ 落 warn）。
 * 返回 null = 无挂起/已过期，按普通回合继续 hop1。
 */
export async function consumeProjectClarification(
  text: string,
  state: VoiceCompanionState,
  taskId: string,
  started: number,
): Promise<VoiceProcessResult | null> {
  const pending = projectRoutingRuntime.pending;
  if (!pending) return null;
  const now = Date.now();
  const sessionId = state.sessionId ?? undefined;
  if (now - pending.askedAt > PROJECT_CLARIFY_TTL_MS) {
    projectRoutingRuntime.pending = null;
    logProjectRouting({
      kind: 'clarify-expired',
      at: now,
      sessionId,
      taskId,
      askCount: projectRoutingRuntime.askCount,
      text: truncate(text, 80),
    });
    return null;
  }
  projectRoutingRuntime.pending = null;

  let plan: ClarificationAnswerPlan;
  try {
    const world = buildProjectRoutingWorld({ now: () => now });
    plan = planClarificationAnswer({
      text,
      cards: world.cards,
      aliases: world.aliasEntries,
      activeWorkspaceId: world.activeWorkspaceId,
      lastProjectId: projectRoutingRuntime.lastProjectId,
      recentProjectIds: collectRecentProjectIds(world.delegationHistory, now),
      bosses: world.bosses,
      ...(pending.suggestionProjectId ? { clarifySuggestion: pending.suggestionProjectId } : {}),
    });
  } catch (err) {
    log.warn(`[VoiceCompanion] 消歧回答解析失败(回落首位 Boss): ${(err as Error).message}`);
    plan = { kind: 'fallback', decision: { candidates: [], needAsk: false } };
  }

  if (plan.kind === 'abandon') {
    logProjectRouting({
      kind: 'clarify-abandoned',
      at: now,
      sessionId,
      taskId,
      askCount: projectRoutingRuntime.askCount,
      text: truncate(text, 80),
    });
    return { action: 'general_response', response: '好，这活先不派了。', elapsedMs: Date.now() - started };
  }

  const agents = agentService.getAllAgents();
  const fallbackBoss = agents.find((a) => isBossLikeAgent(a));
  const bossId = plan.kind === 'resolve' ? plan.bossId : fallbackBoss?.id;
  const target = bossId ? agents.find((a) => a.id === bossId && isBossLikeAgent(a)) : undefined;
  const kind = plan.kind === 'resolve' ? 'clarify-resolved' : 'clarify-fallback';
  if (!target) {
    logProjectRouting({
      kind,
      at: now,
      sessionId,
      taskId,
      askCount: projectRoutingRuntime.askCount,
      text: truncate(text, 80),
      decision: plan.decision,
      fallbackToFirstBoss: true,
    });
    return { action: 'general_response', response: '团队里还没有主管(Boss)，这事我暂时派不出去。', elapsedMs: Date.now() - started };
  }

  const message = pending.message.trim() ? pending.message : pending.originalText;
  let interrupted: boolean;
  try {
    interrupted = await deliverToAgent(target, message, pending.delivery);
  } catch (err) {
    logDelegation({
      phase: 'failed',
      channel: 'voice-companion',
      toAgentId: target.id,
      toAgentName: target.name,
      message,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      routedBy: 'project-clarify',
      taskId,
      sessionId,
    });
    throw err;
  }
  logProjectRouting({
    kind,
    at: now,
    sessionId,
    taskId,
    askCount: projectRoutingRuntime.askCount,
    text: truncate(text, 80),
    decision: plan.decision,
    finalBossId: target.id,
    fallbackToFirstBoss: kind === 'clarify-fallback',
    ...(kind === 'clarify-fallback' ? { level: 'warn' as const } : {}),
  });
  if (plan.kind === 'resolve' && plan.projectId) projectRoutingRuntime.lastProjectId = plan.projectId;
  logDelegation({
    phase: 'dispatched',
    channel: 'voice-companion',
    toAgentId: target.id,
    toAgentName: target.name,
    message,
    delivery: pending.delivery,
    interrupted,
    status: kind,
    routedBy: 'project-clarify',
    taskId,
    sessionId,
  });
  const projectLabel = plan.kind === 'resolve' && plan.projectName ? `「${plan.projectName}」的` : '';
  const response = kind === 'clarify-resolved'
    ? `好，这活交给${projectLabel}主管「${target.name}」安排。`
    : `行，这活我先交给主管「${target.name}」安排。`;
  log.log(`[VoiceCompanion] 消歧${kind === 'clarify-resolved' ? '命中' : '回落'} → ${target.name}: ${message}`);
  return {
    action: 'delegate_to_boss',
    response,
    targetAgent: { id: target.id, name: target.name },
    messageSent: message,
    delivery: pending.delivery,
    interrupted,
    elapsedMs: Date.now() - started,
  };
}
