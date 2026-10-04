/**
 * jarvis-core · 项目感知与路由（任务 14·⑪，Spec §4.11 P1）·公共类型与开关
 *
 * P1 边界：快照注入 + 项目记忆卡 + 三层消歧 + 路由 + 开关 + ⑪ 观测。
 * 不做 P2（语音建项目/跨项目转交）、不改记忆层（27 MemoryEntry 无 projectId）、
 * 不做回执前缀（14·B）。workspace 语义升格为「项目」，不另建实体。
 *
 * 数据事实：TaskCard.projectId/sourceProject（任务10 落卡、任务12 晨报消费）是
 * 既有事实标准——本模块只消费，不改落卡链。项目 ↔ Boss 链 = workspace.areaIds
 * → DrawingArea.assignedAgentIds → boss-like agent（暂存兜底见 cards.ts）。
 *
 * 开关形态对齐既有先例 TC_JARVIS_MORNING_REPORT（boss-morning-report-service.ts:189）
 * 与 senses/types.ts：环境变量缺省开，'0' / 'off' / 'false'（忽略大小写与空白）关；
 * 也可由配置入参 enabled 显式覆盖（测试/接线用）。**关 = 零行为变化**：不注快照块、
 * 路由回落现状首位 Boss、不产 ⑪ 观测。
 *
 * 隔离：本目录不 import services/**（vcs 只按路径 import 本目录），测试一律显式注入数据。
 */

// ============================================================================
// 开关
// ============================================================================

/** ⑪ 项目感知与路由总开关（缺省开；'0'/'off'/'false' 关）。 */
export const PROJECT_ROUTING_ENV_KEY = 'TC_JARVIS_PROJECT_ROUTING';

/**
 * 开关判定（环境变量形态）。缺省 / 空白 = 开；'0' / 'off' / 'false'（忽略
 * 大小写与空白）= 关。与 isMorningReportEnabled / isSenseEnabled 同口径。
 */
export function isProjectRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PROJECT_ROUTING_ENV_KEY]?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'off' || raw === 'false');
}

/** 由「配置入参 ∞ 环境变量」解析启用标志（入参优先，便于测试/接线）。 */
export function resolveProjectRoutingEnabled(enabled: boolean | undefined, env?: NodeJS.ProcessEnv): boolean {
  if (typeof enabled === 'boolean') return enabled;
  return isProjectRoutingEnabled(env);
}

// ============================================================================
// 常量（初始值非实测，待 ⑭ 观测 / ⑮ 标定回写）
// ============================================================================

/**
 * 活跃度衰减天数（Spec §5.1-5）：N 天无委派/回执 → 标「闲置」，消歧优先级降级。
 * **初始值非实测**（认知科学依据：遗忘曲线 30 天稳定、间隔重复 1-3-7-14-30；
 * 非本系统实测），待 ⑭ 委派/回执日志标定后回写（Spec §8.2）。
 */
export const PROJECT_CARD_DECAY_DAYS = 30;

/**
 * 「最近委派史」进入消歧②的时间窗（毫秒）。**初始值非实测**：只认当天/近期的
 * 委派上下文，防几周前的旧委派把 All 状态下的每句「让团队做 X」都劫持走；
 * 待 ⑭ 日志标定。
 */
export const RECENT_DELEGATION_WINDOW_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// 世界数据输入（结构型：vcs 的 Agent / Workspace / DrawingArea 直接满足）
// ============================================================================

export interface ProjectWorkspaceInput {
  id: string;
  name: string;
  areaIds: readonly string[];
  createdAt?: number;
}

export interface ProjectAreaInput {
  id: string;
  name?: string;
  assignedAgentIds?: readonly string[];
  directories?: readonly string[];
  archived?: boolean;
}

export interface ProjectAgentInput {
  id: string;
  name: string;
  isBoss?: boolean;
  class?: string;
  status?: string;
  /** 直属主管 id（下属侧反向指针；暂存兜底用）。 */
  bossId?: string;
  lastWorkedAt?: number;
  lastActivity?: number;
}

/** 全仓 boss-like agent 清单（单 Boss 退化判定用）。 */
export interface ProjectBossRef {
  id: string;
  name: string;
}

// ============================================================================
// 项目记忆卡（⑪ 数据源；从 world + 委派史派生）
// ============================================================================

export interface ProjectCard {
  /** 项目 id = workspace id（workspace 语义升格为「项目」，不另建实体）。 */
  id: string;
  name: string;
  /** 口称别名（含 workspace 名种子 + 别名表条目；消歧① 吃这张表）。 */
  aliases: string[];
  /** 项目主管（workspace.areaIds → areas.assignedAgentIds → boss-like）；无则缺省。 */
  bossId?: string;
  bossName?: string;
  areaIds: string[];
  /** 目录提示（区域 directories 首个非空；P1 只提示，绝不改 agent.cwd）。 */
  rootDirHint?: string;
  /** 在做任务摘要（委派史 taskCard.projectId/sourceProject 命中且未完成，新→旧）。 */
  inProgress: string[];
  /** 卡关键词（名字/别名/在做摘要切词；消歧③）。 */
  keywords: string[];
  /** 最近活跃（项目创建、最近委派、成员/主管最近活动取最大；epoch ms，0 = 无记录）。 */
  lastActiveAt: number;
  /** active/idle：超过 {@link PROJECT_CARD_DECAY_DAYS} 无活跃 → idle。 */
  status: 'active' | 'idle';
}

// ============================================================================
// 别名表（workspace ⇄ Bolba 项目 ⇄ 口称名；文件存储见 aliases.ts）
// ============================================================================

export interface ProjectAliasEntry {
  /** 归一化后的口称名（normalizeAlias；匹配时忽略大小写与空白）。 */
  alias: string;
  projectId: string;
  createdAt: number;
  /** seed = workspace 名自动种子；file = 别名表文件里手改/后续写入。 */
  source: 'seed' | 'file';
}

export interface ProjectAliasTable {
  version: 1;
  entries: ProjectAliasEntry[];
  updatedAt: number;
}

// ============================================================================
// 三层消歧（resolve.ts 纯函数）
// ============================================================================

/** 消歧层：① 显式信号 / ② 对话上下文 / ③ 卡关键词匹配。 */
export type ResolveLayer = 'explicit' | 'context' | 'keyword';

/** 单条候选记录（⑪ 观测：三层各自候选/命中）。 */
export interface ProjectResolveCandidate {
  projectId: string;
  name: string;
  layer: ResolveLayer;
  /** 提名来源，如 'alias:项目B' / 'boss-id' / 'active-workspace' / 'last-project' / 'recent-delegation' / 'keyword:报价'。 */
  source: string;
  /** 是否最终命中（同一层唯一命中才为 true）。 */
  hit: boolean;
}

export interface ProjectResolveInput {
  /** 用户原话（或消歧答案）。 */
  text: string;
  cards: readonly ProjectCard[];
  aliases: readonly ProjectAliasEntry[];
  /** 服务端激活工作区（null/缺省 = All，即未切）。 */
  activeWorkspaceId?: string | null;
  /** 会话内最近提及项目（内存态，由接线层维护）。 */
  lastProjectId?: string | null;
  /** 委派史里的 projectId（新→旧、已按 {@link RECENT_DELEGATION_WINDOW_MS} 过滤）。 */
  recentProjectIds?: readonly string[];
  /** 全仓 boss-like agent（单 Boss 退化判定；0 个 = 无可派主管）。 */
  bosses: readonly ProjectBossRef[];
  /** 模型显式 bossId（契约 targetAgentId 且为 boss-like 时；显式信号，不再反问）。 */
  modelBossId?: string | null;
  /** 上一回合反问的建议项目（单候选问句）；回答「是/对」直接确认它。 */
  clarifySuggestion?: string | null;
}

/** 三层消歧结果（返回 {bossId?, layer, candidates, needAsk} + 反问/来源明细）。 */
export interface ProjectResolveResult {
  projectId?: string;
  projectName?: string;
  bossId?: string;
  /** 命中层；未命中时缺省。 */
  layer?: ResolveLayer;
  /** 命中来源明细（观测用）。 */
  source?: string;
  candidates: ProjectResolveCandidate[];
  /** 三态路由：是否需要反问（All + 多 Boss + 消不掉）。 */
  needAsk: boolean;
  /** 反问句（needAsk=true 时给出）。 */
  askQuestion?: string;
  /** 单候选问句的建议项目（「是它吗」；开放问句缺省）。 */
  suggestedProjectId?: string;
  /** 单 Boss 退化：全仓仅 1 个 boss-like → 直派不反问。 */
  degenerate?: boolean;
}

// ============================================================================
// ⑪ 观测事件（observability.ts 适配为 logEvent('system', source='project-routing')）
// ============================================================================

export type ProjectRoutingEventKind =
  | 'route'
  | 'need-ask'
  | 'clarify-resolved'
  | 'clarify-fallback'
  | 'clarify-abandoned'
  | 'clarify-expired';

export interface ProjectRoutingEvent {
  kind: ProjectRoutingEventKind;
  at: number;
  sessionId?: string;
  taskId?: string;
  /** 用户原话/回答（接线层截断后传入）。 */
  text?: string;
  /** 三层解析结果（命中/候选/反问）；缺省=无解析。 */
  decision?: ProjectResolveResult;
  /** 最终派发目标 Boss（登记该选择，如回落首位 Boss）。 */
  finalBossId?: string;
  /** 是否回落现状默认（首位 Boss 兜底）。 */
  fallbackToFirstBoss?: boolean;
  /** 反问句（need-ask）。 */
  question?: string;
  /** 本会话累计反问次数（⑮ 分析：反问多 = 卡不准？）。 */
  askCount?: number;
  level?: 'info' | 'warn';
}
