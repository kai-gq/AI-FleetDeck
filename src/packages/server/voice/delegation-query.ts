/**
 * 任务07·④ 查进度走下属 —— query 链路的纯逻辑层(Spec §4.4)。
 *
 * 背景:老板问「团队那个任务到哪了」时,hop1 可能把 query 目标解析成 Boss;
 * 旧链路只取 Boss 自己的 excerpt —— 而 Boss 历史里全是调度文本(派活/拆解/收口),
 * 看不到下属的真实产出,这正是「查一下→没下文」的环3成因(Spec §2.4.1)。
 *
 * 本模块只做纯逻辑(IO 留在 voice-companion-service 编排层):
 *   1. planQueryRoute              :路由判定(Boss 树 / 单 agent / 无目标);
 *   2. pickRecentDelegations       :从委派史挑最近 N 条、按下属去重(只查最近委派,不跨历史深追溯);
 *   3. buildDelegationQueryMaterial:按「下属名 + 任务 + 产出」拼接 hop2 材料
 *      (无产出/无卡/无委派三分支在这里收敛);
 *   4. buildQueryChainLogBody      :🔴观测点④ 查询链路事件字段
 *      (请求入口 → 路由判定 → 查了哪些下属 → hop 次数 → 耗时 → 返回摘要)。
 *
 * 说明:本模块不 import voice-companion-service(避免循环依赖),Boss 判定与
 * vcs.isBossLikeAgent 保持同一行判定(有单测钉行为)。
 */

import type { DelegationCompletion, DelegationDecision, DelegationUserRating } from '../../shared/agent-types.js';

/** 只查最近委派条数上限 —— 与任务06【最近委派】注入(vcs MAX_DELEGATION_INJECT=5)同口径,不深追溯历史。 */
export const DELEGATION_QUERY_MAX = 5;

/**
 * hop2 材料总体积护栏:按单下属 excerpt 护栏(6 条 / 1500 字,§8.1)的 3 倍取整,
 * 保证多下属汇总不无界膨胀(取值保守,非实测最优,待观测标定)。
 */
export const DELEGATION_MATERIAL_BUDGET = 4_500;

/** 任务摘要截断长度 —— 与 vcs TASK_TRUNCATE(60)同口径。 */
export const DELEGATION_TASK_TRUNCATE = 60;

// ============================================================================
// 路由判定(验收 ⑥1:目标是 Boss 时触发委派树解析)
// ============================================================================

export type QueryRoute = 'boss-tree' | 'single-agent' | 'no-target';

/**
 * 查询目标路由:目标缺失 → no-target;Boss 类(isBoss 或 class==='boss',
 * 与 vcs.isBossLikeAgent 同判定)→ boss-tree;其余普通 agent → single-agent(行为不变)。
 */
export function planQueryRoute(target: { isBoss?: boolean; class?: string } | undefined): QueryRoute {
  if (!target) return 'no-target';
  return target.isBoss === true || target.class === 'boss' ? 'boss-tree' : 'single-agent';
}

// ============================================================================
// 委派树解析(只取最近委派)
// ============================================================================

/**
 * 从委派史挑出要查的下属:全局按 timestamp 倒序、同一下属只保留最近一条(更早任务已过时)、
 * 最多 limit 条(缺省 {@link DELEGATION_QUERY_MAX},与任务06 口径一致)。
 */
export function pickRecentDelegations(
  history: readonly DelegationDecision[],
  limit: number = DELEGATION_QUERY_MAX,
): DelegationDecision[] {
  const sorted = [...history].sort((a, b) => b.timestamp - a.timestamp);
  const seen = new Set<string>();
  const picked: DelegationDecision[] = [];
  for (const d of sorted) {
    if (seen.has(d.selectedAgentId)) continue;
    seen.add(d.selectedAgentId);
    picked.push(d);
    if (picked.length >= limit) break;
  }
  return picked;
}

// ============================================================================
// hop2 材料拼接(下属名 + 任务 + 产出)
// ============================================================================

/**
 * fetchAgentOutputExcerpt 的两个「无产出」占位返回(vcs 内字面量,未改动其行为);
 * 材料层据此把「没有记录」转写成「正在做 Y,暂无实质进展」的自然语句(行为定义 2)。
 */
const NO_OUTPUT_EXCERPTS: ReadonlySet<string> = new Set(['(没有可用的会话记录)', '(最近没有助手输出)']);

/** 该 excerpt 是否有实质产出(占位串/空白 = 无)。 */
export function hasSubstantiveOutput(excerpt: string): boolean {
  const text = excerpt.trim();
  return text.length > 0 && !NO_OUTPUT_EXCERPTS.has(text);
}

/** 「正在干活」状态集合 —— 与 vcs.ACTIVE_AGENT_STATUSES 同集合(此处独立列出以避免循环 import)。 */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['working', 'waiting', 'waiting_permission']);

/** 产出位置(路径/链接)展示上限 —— 位置字段只需可定位,过长即截(固定口径,便于测试钉)。 */
export const DELEGATION_OUTPUT_LOCATION_MAX = 200;

/** 单个下属的查询条目:由编排层(vcs)取好 excerpt / agent 快照后传入,本模块只负责拼装。 */
export interface SubordinateQueryEntry {
  agentId: string;
  agentName: string;
  /** 当前状态;agent 已不在快照(被删/未加载)时缺省。 */
  status?: string;
  /**
   * ⑦ 任务卡目标(任务10);旧委派记录无此字段,读取方按「无卡」处理 → undefined。
   * 有卡时作为「XX 正在做 Y」的 Y;无卡回退 userCommand(行为定义 2)。
   */
  taskCardObjective?: string;
  /** 委派原始指令。 */
  userCommand: string;
  /** 该下属最近 assistant 产出(fetchAgentOutputExcerpt 结果;无产出为其占位串)。 */
  excerpt: string;
  /**
   * ⑧ 病历完成事件(任务11):有 completion 的委派走「执行者/耗时/产出」完成行,
   * 无 completion(旧记录/未完成)的记录走原三分支不变。
   */
  completion?: DelegationCompletion;
  /** ⑧ 病历用户评价(满意/不满意):仅回写后存在。 */
  userRating?: DelegationUserRating;
}

/** Spec §4.4 行为定义 3:无委派记录时如实返回「未找到对应委派」(确定性话术,不跑 hop2 防编造)。 */
export function buildNoDelegationResponse(bossName: string): string {
  return `未找到对应委派——「${bossName}」名下还没有任何委派记录。`;
}

/** 单行摘要用文本:压空白 + 截断(与 vcs TASK_TRUNCATE 一致的口径)。 */
function truncateTask(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > DELEGATION_TASK_TRUNCATE ? `${t.slice(0, DELEGATION_TASK_TRUNCATE)}…` : t;
}

/** 保留换行/分隔线的按字截断(材料里的 excerpt 不做空白压缩,保住 fetchAgentOutputExcerpt 的 '\n---\n' 分段)。 */
function clampText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 任务展示文本:任务卡目标优先,无卡回退委派原话(行为定义 2 的 Y)。 */
function taskTextOf(entry: SubordinateQueryEntry): string {
  return truncateTask(entry.taskCardObjective?.trim() || entry.userCommand || '(未记录任务)');
}

/** ⑧ 耗时展示口径(任务11):<1 分钟用秒,其余保留 1 位小数分钟(固定口径,便于测试钉)。 */
export function formatDelegationDuration(durationMs: number): string {
  const safe = Math.max(0, durationMs);
  if (safe < 60_000) return `${Math.round(safe / 1000)} 秒`;
  return `${Math.round(safe / 6_000) / 10} 分钟`;
}

/**
 * ⑧ 病历完成行(任务11):执行者(【名】)+ 任务 + 完成态/耗时 + 产出 + 产出位置 + 评价。
 * 产出优先用 completion.summary(report-task 产出摘要);无摘要回退该下属最近产出(保住可读)。
 */
function buildCompletedSection(
  entry: SubordinateQueryEntry,
  name: string,
  task: string,
  excerptShare: number
): string {
  const completion = entry.completion!;
  const duration = formatDelegationDuration(completion.durationMs);
  const parts = [
    completion.result === 'failed'
      ? `【${name}】任务「${task}」执行失败（耗时 ${duration}）`
      : `【${name}】任务「${task}」已完成（耗时 ${duration}）`,
  ];
  const summary = completion.summary?.trim();
  if (summary) {
    parts.push(`产出: ${clampText(summary, excerptShare)}`);
  } else if (hasSubstantiveOutput(entry.excerpt)) {
    // 病历无摘要(runtime 入口先到时)→ 回退下属最近产出,不因缺摘要丢「产出在哪」
    parts.push(`产出:\n${clampText(entry.excerpt, excerptShare)}`);
  }
  const location = completion.outputLocation?.trim();
  if (location) parts.push(`产出位置: ${clampText(location, DELEGATION_OUTPUT_LOCATION_MAX)}`);
  if (entry.userRating) parts.push(`评价: ${entry.userRating === 'satisfied' ? '满意' : '不满意'}`);
  return parts.join('｜');
}

/** 单个下属分段:已完成(有 ⑧ 病历)→ 执行者/耗时/产出;否则原三分支(有产出/working/如实无产出)。 */
function buildSubordinateSection(entry: SubordinateQueryEntry, excerptShare: number): string {
  const name = entry.agentName || entry.agentId;
  const task = taskTextOf(entry);
  // ⑧ 病历优先:完成/失败的委派回答「谁干的/花多久/产出在哪」(Spec §4.8 验收)
  if (entry.completion) return buildCompletedSection(entry, name, task, excerptShare);
  if (hasSubstantiveOutput(entry.excerpt)) {
    return `【${name}】任务「${task}」\n产出:\n${clampText(entry.excerpt, excerptShare)}`;
  }
  if (entry.status && ACTIVE_STATUSES.has(entry.status)) {
    // 行为定义 2:XX 正在做 Y,暂无实质进展(Y = 任务卡目标;无卡 = 委派原话)。
    return `【${name}】正在做「${task}」,暂无实质进展`;
  }
  return `【${name}】状态 ${entry.status ?? '未知'},任务「${task}」暂无实质产出记录`;
}

/**
 * 组装 hop2 材料:按「下属名 + 任务 + 产出」分段(新→旧),总长受 {@link DELEGATION_MATERIAL_BUDGET}
 * 约束 —— 先按条目数均分 excerpt 份额,超预算再整体截尾。
 * entries 为空(无委派记录)时返回确定性话术;编排层在该分支直接采用、不跑 hop2,此处为防御性兜底。
 */
export function buildDelegationQueryMaterial(input: {
  bossName: string;
  entries: readonly SubordinateQueryEntry[];
}): string {
  const { bossName, entries } = input;
  if (entries.length === 0) return buildNoDelegationResponse(bossName);

  const header = `以下为主管「${bossName}」名下最近委派的下属产出(新→旧,共 ${entries.length} 条;每条为该下属最近的助手输出):`;
  const share = Math.max(1, Math.floor(DELEGATION_MATERIAL_BUDGET / entries.length));
  const sections = entries.map((entry) => buildSubordinateSection(entry, share));
  const material = [header, ...sections].join('\n\n');
  return material.length > DELEGATION_MATERIAL_BUDGET
    ? `${material.slice(0, DELEGATION_MATERIAL_BUDGET - 1)}…`
    : material;
}

// ============================================================================
// 🔴 决策观测点④ 查询链路事件字段(Spec §4.14)
// ============================================================================

export interface QueryChainLogInput {
  /** request=请求入口+路由判定;completed=拿到返回;failed=hop2 降级兜底 */
  phase: 'request' | 'completed' | 'failed';
  /** 老板的原始问法(截断,复现「查一下→没下文」的入口证据) */
  request: string;
  route: QueryRoute;
  targetAgentId?: string;
  targetName?: string;
  /** Boss 树下实际查了下哪些下属(agentId,查询顺序) */
  subordinateIds?: string[];
  /** 本链路实际发生的 claude 调用跳数:2=hop1+hop2;1=确定性路径(无委派/目标缺失) */
  hops?: number;
  durationMs?: number;
  /** 返回摘要(截断) */
  responsePreview?: string;
  degraded?: boolean;
  error?: string;
}

/**
 * 查询链路事件 body(纯函数,便于单测钉字段形态)。
 * 落盘形态:category='system' + source='voice-companion' + body.cat='query-chain'
 * —— 加法式接入,不改表结构、不挤占 dialog/broadcast/delegation 时间线。
 */
export function buildQueryChainLogBody(input: QueryChainLogInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    cat: 'query-chain',
    phase: input.phase,
    request: input.request,
    route: input.route,
  };
  if (input.targetAgentId) body.targetAgentId = input.targetAgentId;
  if (input.targetName) body.targetName = input.targetName;
  if (input.subordinateIds) {
    body.subordinateIds = [...input.subordinateIds];
    body.subordinateCount = input.subordinateIds.length;
  }
  if (input.hops !== undefined) body.hops = input.hops;
  if (input.durationMs !== undefined) body.durationMs = input.durationMs;
  if (input.responsePreview !== undefined) body.responsePreview = input.responsePreview;
  if (input.degraded) body.degraded = true;
  if (input.error) body.error = input.error;
  return body;
}
