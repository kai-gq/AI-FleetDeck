import type { Agent } from '../../../shared/agent-types';

/**
 * 指挥台总览 · 团队分组（EPIC-1）。
 * 规则（SPEC）：standby 优先 → 待命；working|waiting|waiting_permission → 在办；
 * 其余 → 已办结。组内 lastActivity 降序。纯函数，重载不依赖 DOM。
 */

export type FleetGroupId = 'active' | 'standby' | 'done';

export interface FleetGroup {
  id: FleetGroupId;
  /** i18n key 后缀（terminal:fleetHome.group.*）。 */
  labelKey: string;
  fallback: string;
  agents: Agent[];
}

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['working', 'waiting', 'waiting_permission']);

export function fleetGroupOf(agent: Pick<Agent, 'status' | 'standby'>): FleetGroupId {
  if (agent.standby === true) return 'standby';
  if (ACTIVE_STATUSES.has(agent.status)) return 'active';
  return 'done';
}

/** 展示顺序固定：在办 → 待命 → 已办结（空组也返回，由视图决定是否渲染）。 */
export function groupFleet(agents: readonly Agent[]): FleetGroup[] {
  const buckets: Record<FleetGroupId, Agent[]> = { active: [], standby: [], done: [] };
  for (const agent of agents) buckets[fleetGroupOf(agent)].push(agent);
  const byActivityDesc = (a: Agent, b: Agent) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0);
  buckets.active.sort(byActivityDesc);
  buckets.standby.sort(byActivityDesc);
  buckets.done.sort(byActivityDesc);
  return [
    { id: 'active', labelKey: 'fleetHome.group.active', fallback: '在办', agents: buckets.active },
    { id: 'standby', labelKey: 'fleetHome.group.standby', fallback: '待命', agents: buckets.standby },
    { id: 'done', labelKey: 'fleetHome.group.done', fallback: '已办结', agents: buckets.done },
  ];
}

/** AgentStatus → common:status.* 的 key（未知回退 unknown，不编造文案）。 */
const STATUS_KEYS: Record<string, string> = {
  working: 'working',
  waiting: 'waiting',
  waiting_permission: 'waitingPermission',
  idle: 'idle',
  error: 'error',
  offline: 'offline',
  orphaned: 'orphaned',
};

export function agentStatusKey(status: string): string {
  return STATUS_KEYS[status] ?? 'unknown';
}
