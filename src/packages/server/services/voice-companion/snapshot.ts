/**
 * 语音伙伴服务 — 团队快照与委派史渲染(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * 「谁在忙/谁待岗/最近委派」行渲染;Boss 行展开下属结构;供系统提示词注入。委派史只读。
 */
import { logger } from '../../utils/index.js';
import { isOnStandby } from '../agent-standby.js';
import * as bossService from '../boss-service.js';
import { formatTimeSince } from '../subordinate-context-service.js';
import { isAgentBusy, isBossLikeAgent } from './agents.js';
import { truncate } from './contract.js';
import { ERROR_TRUNCATE, MAX_DELEGATION_INJECT, MAX_SNAPSHOT_AGENTS, MAX_SNAPSHOT_SUBORDINATES, TASK_TRUNCATE } from './constants.js';
import type { DelegationDecision } from '../../../shared/agent-types.js';
import type { DrawingArea } from '../../../shared/common-types.js';

const log = logger.server;

/** 快照用的 agent 结构子集(Agent 天然满足,测试可造轻量对象)。 */
export interface SnapshotAgent {
  id: string;
  name: string;
  class?: string;
  status: string;
  isBoss?: boolean;
  /** 直属主管 id(下属侧反向指针)。 */
  bossId?: string;
  /** 直管下属 id 列表(主管侧指针);与 agent.bossId 取并集,兼容两侧只填一边的数据。 */
  subordinateIds?: readonly string[];
  taskLabel?: string;
  lastAssignedTask?: string;
  lastError?: string;
  lastWorkedAt?: number;
  lastActivity?: number;
  /** 待岗(用户手动停用,仅用户可恢复):恢复前勿派活;语音侧不计入忙/闲。 */
  standby?: boolean;
}

/**
 * Boss 卡片的「下属结构」摘要:人数 + 忙闲统计 + 逐个下属状态(带所属区域)。
 * 下属来源 = subordinateIds ∪ {bossId 指向本 Boss 的 agent};超出上限只报剩余人数。
 */
function formatSubordinateSummary(
  boss: SnapshotAgent,
  byId: ReadonlyMap<string, SnapshotAgent>,
  areasByAgent: ReadonlyMap<string, string[]>,
): string {
  const ids = new Set<string>(boss.subordinateIds ?? []);
  for (const agent of byId.values()) {
    if (agent.bossId === boss.id && agent.id !== boss.id) ids.add(agent.id);
  }
  const subs = [...ids]
    .map((id) => byId.get(id))
    .filter((s): s is SnapshotAgent => !!s && s.id !== boss.id);

  // 待岗者不算「忙/闲」(恢复前派不了活):单独计数,忙/闲分母只剩在岗者;
  // 无人待岗时输出与旧版逐字节一致(防 prompt 抖动)。
  const standbyCount = subs.filter((s) => isOnStandby(s)).length;
  const busy = subs.filter((s) => isAgentBusy(s)).length;
  const ordered = [...subs].sort((a, b) => {
    const ab = isAgentBusy(a) ? 0 : 1;
    const bb = isAgentBusy(b) ? 0 : 1;
    if (ab !== bb) return ab - bb;
    return a.name.localeCompare(b.name);
  });
  const shown = ordered.slice(0, MAX_SNAPSHOT_SUBORDINATES).map((s) => {
    const areaNames = areasByAgent.get(s.id);
    const area = areaNames?.length ? `·${areaNames.join('、')}` : '';
    const standbyMark = isOnStandby(s) ? '·待岗' : '';
    return `${s.name}(${s.status}${area}${standbyMark})`;
  });
  const rest = ordered.length - shown.length;
  if (rest > 0) shown.push(`…另${rest}人`);

  const standbyPart = standbyCount > 0 ? `/${standbyCount}待岗` : '';
  return `下属(${subs.length}): ${busy}忙/${subs.length - busy - standbyCount}闲${standbyPart}${shown.length ? ` — ${shown.join('、')}` : ''}`;
}

/**
 * 把 agent 列表压缩成 prompt 里的一行一个:按最近活动排序、截断、上限 60。
 * Boss 卡额外展开下属结构 / 忙闲 / 最近委派(改③,团队认知);委派史只读,可为空。
 * 任务14·⑪:`projectLines` 传入时在快照头部注入「项目感知」块(开关关/无卡 = 不传,
 * 输出与旧版逐字一致);项目行由 jarvis-core/projects/render 渲染。
 * 同时返回是否发生了截断(供 prompt 说明)。
 */
export function buildAgentSnapshotLines(
  agents: readonly SnapshotAgent[],
  areas: readonly DrawingArea[],
  delegationHistory: readonly DelegationDecision[] = [],
  projectLines?: readonly string[],
): { lines: string[]; total: number; truncated: boolean } {
  const areasByAgent = new Map<string, string[]>();
  for (const area of areas) {
    if (area.archived) continue;
    for (const id of area.assignedAgentIds ?? []) {
      const list = areasByAgent.get(id) ?? [];
      list.push(area.name);
      areasByAgent.set(id, list);
    }
  }

  const byId = new Map(agents.map((a) => [a.id, a]));
  // 每个 Boss 只取最近一条委派(输入可能跨 Boss 交错,先按时间倒序再取首个)。
  const recentByBoss = new Map<string, DelegationDecision>();
  for (const d of [...delegationHistory].sort((a, b) => b.timestamp - a.timestamp)) {
    if (!recentByBoss.has(d.bossId)) recentByBoss.set(d.bossId, d);
  }

  const sorted = [...agents].sort((a, b) => {
    const at = a.lastWorkedAt ?? a.lastActivity ?? 0;
    const bt = b.lastWorkedAt ?? b.lastActivity ?? 0;
    if (bt !== at) return bt - at;
    return a.name.localeCompare(b.name);
  });

  const selected = sorted.slice(0, MAX_SNAPSHOT_AGENTS);
  const lines = selected.map((a) => {
    const parts = [`- ${a.name} | id: ${a.id} | ${a.class ?? 'unknown'} | ${a.status}`];
    const isBoss = isBossLikeAgent(a);
    if (isBoss) parts.push('[BOSS]');
    // 待岗标注(仅待岗时追加):秘书据此不派活、如实报「待岗」,非待岗行零变化。
    if (isOnStandby(a)) parts.push('[待岗:用户已停用,勿派活,需用户恢复]');
    const agentAreas = areasByAgent.get(a.id);
    if (agentAreas?.length) parts.push(`[区域: ${agentAreas.join('、')}]`);
    if (isBoss) {
      parts.push(`| ${formatSubordinateSummary(a, byId, areasByAgent)}`);
      const recent = recentByBoss.get(a.id);
      if (recent) {
        parts.push(`| 最近委派: "${truncate(recent.userCommand, TASK_TRUNCATE)}" → ${recent.selectedAgentName} (${recent.status})`);
      }
    }
    const task = a.taskLabel || a.lastAssignedTask;
    if (task) parts.push(`| 任务: ${truncate(task, TASK_TRUNCATE)}`);
    if (a.lastError) parts.push(`| 最近错误: ${truncate(a.lastError, ERROR_TRUNCATE)}`);
    return parts.join(' ');
  });

  // 任务14·⑪ 项目快照块（当前项目 + 各项目在做/主管/最近活跃；空 = 零变化）。
  const projectBlock = projectLines && projectLines.length > 0
    ? ['【项目感知】(当前/各项目在做与最近活跃;派活归属先看这里)', ...projectLines, '']
    : [];
  return { lines: [...projectBlock, ...lines], total: sorted.length, truncated: sorted.length > selected.length };
}

/**
 * 委派史摘要(改③,镜像 subordinate-context-service.ts:135-137 的
 * `getDelegationHistory().slice(0,5)` 范式):按时间倒序取最近 MAX_DELEGATION_INJECT
 * 条,格式 Boss → 下属: 任务 [状态];空历史返回 []。
 */
export function buildDelegationSummaryLines(
  history: readonly DelegationDecision[],
  bossNames?: ReadonlyMap<string, string>,
): string[] {
  return [...history]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_DELEGATION_INJECT)
    .map((d) => {
      const boss = bossNames?.get(d.bossId) ?? d.bossId;
      return `- [${formatTimeSince(d.timestamp)}前] ${boss} → ${d.selectedAgentName}: "${truncate(d.userCommand, TASK_TRUNCATE)}" [状态: ${d.status}]`;
    });
}

/**
 * 汇总所有 Boss 的委派史(只读)。
 * 决策观测点③「委派史变更」通道预留(随任务 08 回执链路一起启用,本任务不实现):
 * 现有接缝是 boss-service.subscribe('delegation_decision'),但它只在
 * analyzeAndDelegate 路径 emit;回执链路真正写盘走 addDelegationToHistory
 * (boss-response-handler),写入侧不 emit —— 任务 08 需在写入侧补事件或改订阅,
 * 这里保持每次读实时 map、不做缓存。
 * 文件缺失/读取失败 → 返回空数组,不打断 hop1。
 */
export function collectDelegationHistory(agents: readonly SnapshotAgent[]): DelegationDecision[] {
  const merged: DelegationDecision[] = [];
  for (const agent of agents) {
    if (!isBossLikeAgent(agent)) continue;
    try {
      merged.push(...bossService.getDelegationHistory(agent.id));
    } catch (err) {
      log.warn(`[VoiceCompanion] 读取委派史失败(boss ${agent.id}),按空处理: ${(err as Error).message}`);
    }
  }
  // 各 Boss 内部已是新→旧;跨 Boss 合并后按时间倒序,保证「最近 5 条」是全局最近。
  return merged.sort((a, b) => b.timestamp - a.timestamp);
}
