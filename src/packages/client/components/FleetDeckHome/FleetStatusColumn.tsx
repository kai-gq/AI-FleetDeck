import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentBadge } from '../AgentBadge';
import { Icon } from '../Icon';
import { useAgents, useAreas, store, useStore } from '../../store';
import { useWorkspaceFilter, isAgentVisibleInWorkspace } from '../WorkspaceSwitcher';
import { formatBoardDuration } from '../../plugins/delegation-board/boardModel';
import { AGENT_BADGE_TONE_VARS, agentBadgeTone } from '../../utils/agentBadge';
import { agentStatusKey, fleetGroupOf, groupFleet } from './fleetGroups';

const ELAPSED_TICK_MS = 1_000;

/**
 * 总览左栏 · 舰队状态（EPIC-1）。
 * 行 = AgentBadge + 名字(+BOSS 标) + 当前任务 + 状态灯/耗时；
 * 分组（在办/待命/已办结）与工作区过滤规则见 fleetGroups.ts + WorkspaceSwitcher。
 * 实时耗时取自 store.agentTaskProgress（在办任务的 startedAt），拿不到不编造。
 */
export function FleetStatusColumn() {
  const { t } = useTranslation(['terminal', 'common']);
  const agentsMap = useAgents();
  // areas 进依赖：agent 位置/区域变化要重算工作区可见性（同 AgentBar 的做法）
  const areas = useAreas();
  const { agentTaskProgress } = useStore();
  const [activeWorkspace] = useWorkspaceFilter();

  const agents = useMemo(
    () =>
      Array.from(agentsMap.values()).filter((agent) => {
        if (store.isAgentInArchivedArea(agent.id)) return false;
        if (!activeWorkspace) return true;
        const area = store.getAreaForAgent(agent.id);
        return isAgentVisibleInWorkspace(area?.id ?? null);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- areas 仅为触发重算
    [agentsMap, areas, activeWorkspace]
  );

  // 在办任务的 startedAt 索引：agentTaskProgress = Map<bossId, Map<agentId, progress>>
  const progressIndex = useMemo(() => {
    const index = new Map<string, number>();
    for (const inner of agentTaskProgress.values()) {
      for (const [agentId, progress] of inner) {
        if (progress.status !== 'working') continue;
        const prev = index.get(agentId);
        if (prev === undefined || progress.startedAt > prev) index.set(agentId, progress.startedAt);
      }
    }
    return index;
  }, [agentTaskProgress]);

  const hasRunning = useMemo(
    () => agents.some((agent) => fleetGroupOf(agent) === 'active' && progressIndex.has(agent.id)),
    [agents, progressIndex]
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunning) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(id);
  }, [hasRunning]);

  const groups = useMemo(() => groupFleet(agents), [agents]);
  const activeCount = groups.find((group) => group.id === 'active')?.agents.length ?? 0;

  const openAgent = useCallback((agentId: string) => {
    store.selectAgent(agentId);
    store.setTerminalOpen(true);
  }, []);

  return (
    <section className="fleetdeck-col fleetdeck-col--fleet">
      <header className="fleetdeck-col__head">
        <h2>
          <Icon name="users" size={14} />
          {t('terminal:fleetHome.fleet.title', { defaultValue: '舰队状态' })}
        </h2>
        <span className="fleetdeck-col__count">
          {t('terminal:fleetHome.fleet.count', {
            defaultValue: '{{total}} 员 · {{active}} 在办',
            total: agents.length,
            active: activeCount,
          })}
        </span>
      </header>
      <div className="fleetdeck-col__body">
        {groups
          .filter((group) => group.agents.length > 0)
          .map((group) => (
            <div key={group.id} className={`fleet-group fleet-group--${group.id}`}>
              <div className="fleet-group__head">
                <span>{t(`terminal:${group.labelKey}`, { defaultValue: group.fallback })}</span>
                <span className="fleet-group__n">{group.agents.length}</span>
              </div>
              {group.agents.map((agent) => {
                const startedAt = progressIndex.get(agent.id);
                const elapsed = startedAt !== undefined ? formatBoardDuration(now - startedAt) : '';
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className="fleet-row"
                    onClick={() => openAgent(agent.id)}
                    title={agent.currentTask || agent.name}
                  >
                    <AgentBadge agent={agent} size={28} className="fleet-row__badge" />
                    <span className="fleet-row__main">
                      <span className="fleet-row__name">
                        <span className="fleet-row__name-text">{agent.name}</span>
                        {agent.isBoss && <span className="fleet-row__boss">BOSS</span>}
                      </span>
                      <span className="fleet-row__task">{agent.currentTask || '—'}</span>
                    </span>
                    <span
                      className="fleet-row__meta"
                      style={{ '--fleet-row-tone': AGENT_BADGE_TONE_VARS[agentBadgeTone(agent.status)] } as React.CSSProperties}
                    >
                      <span className="fleet-row__dot" />
                      <span>{t(`common:status.${agentStatusKey(agent.status)}`, { defaultValue: agent.status })}</span>
                      {elapsed && <b>{elapsed}</b>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        {agents.length === 0 && (
          <div className="fleetdeck-col__empty">
            {t('terminal:fleetHome.fleet.empty', { defaultValue: '暂无 Agent' })}
          </div>
        )}
      </div>
    </section>
  );
}

export default FleetStatusColumn;
