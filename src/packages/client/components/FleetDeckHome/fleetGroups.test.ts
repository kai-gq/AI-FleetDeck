import { describe, expect, it } from 'vitest';
import { agentStatusKey, fleetGroupOf, groupFleet } from './fleetGroups';
import type { Agent } from '../../../shared/agent-types';

const agent = (over: Partial<Agent>): Agent =>
  ({
    id: over.id ?? 'a',
    name: over.name ?? 'Agent',
    class: 'builder',
    status: 'idle',
    lastActivity: 0,
    ...over,
  }) as Agent;

describe('fleetGroups · 分组规则（SPEC：在办/待命/已办结）', () => {
  it('standby 标志优先于状态：working + standby → 待命', () => {
    expect(fleetGroupOf(agent({ status: 'working', standby: true }))).toBe('standby');
    expect(fleetGroupOf(agent({ status: 'waiting_permission', standby: true }))).toBe('standby');
  });

  it('在办 = working | waiting | waiting_permission', () => {
    expect(fleetGroupOf(agent({ status: 'working' }))).toBe('active');
    expect(fleetGroupOf(agent({ status: 'waiting' }))).toBe('active');
    expect(fleetGroupOf(agent({ status: 'waiting_permission' }))).toBe('active');
  });

  it('其余（idle/error/offline/orphaned）归已办结；standby 缺省（undefined）不误判', () => {
    for (const status of ['idle', 'error', 'offline', 'orphaned'] as const) {
      expect(fleetGroupOf(agent({ status }))).toBe('done');
    }
    expect(fleetGroupOf(agent({ status: 'working', standby: undefined }))).toBe('active');
  });

  it('groupFleet：三组顺序固定（在办→待命→已办结），空组保留', () => {
    const groups = groupFleet([]);
    expect(groups.map((g) => g.id)).toEqual(['active', 'standby', 'done']);
    expect(groups.every((g) => g.agents.length === 0)).toBe(true);
  });

  it('组内按 lastActivity 降序，缺失视为 0', () => {
    const groups = groupFleet([
      agent({ id: 'old', status: 'working', lastActivity: 100 }),
      agent({ id: 'new', status: 'working', lastActivity: 300 }),
      agent({ id: 'none', status: 'working', lastActivity: undefined as unknown as number }),
    ]);
    expect(groups[0].agents.map((a) => a.id)).toEqual(['new', 'old', 'none']);
  });

  it('agentStatusKey：七个状态全覆盖，未知回退 unknown', () => {
    expect(agentStatusKey('working')).toBe('working');
    expect(agentStatusKey('waiting')).toBe('waiting');
    expect(agentStatusKey('waiting_permission')).toBe('waitingPermission');
    expect(agentStatusKey('idle')).toBe('idle');
    expect(agentStatusKey('error')).toBe('error');
    expect(agentStatusKey('offline')).toBe('offline');
    expect(agentStatusKey('orphaned')).toBe('orphaned');
    expect(agentStatusKey('nonsense')).toBe('unknown');
  });
});
