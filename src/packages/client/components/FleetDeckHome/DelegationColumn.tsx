import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { DelegationTree, type DelegationTreeCallbacks } from '../../plugins/delegation-board/DelegationTree';
import { DelegationBoardDetails } from '../../plugins/delegation-board/DelegationBoardView';
import { DELEGATION_STATUS_FILTERS, useDelegationBoardData } from '../../plugins/delegation-board/useDelegationBoardData';
import type { BoardEntry } from '../../plugins/delegation-board/boardModel';

/**
 * 总览中栏 · 委派树（EPIC-1）。
 * 与侧栏 DelegationBoardView 同源（同一 useDelegationBoardData hook）；
 * 默认展开三层（DelegationTree 缺省：有委派数据即全展开，B-34）；
 * 详情复用 DelegationBoardDetails（非模态）。
 * 列头过滤段位（B-25 收口台账 B-16）：状态筛选模型与侧栏共用（DELEGATION_STATUS_FILTERS）；
 * 默认「进行中」（B-34 用户口径）。
 */
export function DelegationColumn() {
  const { t } = useTranslation(['terminal', 'common']);
  const [statusFilter, setStatusFilter] = useState('in-flight');
  const [selected, setSelected] = useState<BoardEntry | null>(null);
  // 展开态 override（键 → 是否展开）：刷新/轮询不重置
  const [expansion, setExpansion] = useState<Map<string, boolean>>(() => new Map());

  const { data, loading, error, refresh, entries, tasks, statusLabel, onOpenAgent, onOpenOutput, agentExists } =
    useDelegationBoardData(statusFilter);

  const isExpanded = useCallback(
    (key: string, defaultExpanded: boolean) => expansion.get(key) ?? defaultExpanded,
    [expansion]
  );
  const onToggle = useCallback((key: string, defaultExpanded: boolean) => {
    setExpansion((prev) => {
      const next = new Map(prev);
      next.set(key, !(prev.get(key) ?? defaultExpanded));
      return next;
    });
  }, []);

  const onOpenDetails = useCallback((entry: BoardEntry) => setSelected(entry), []);

  const treeCallbacks = useMemo<DelegationTreeCallbacks>(
    () => ({ statusLabel, isExpanded, onToggle, onOpenAgent, onOpenDetails, onOpenOutput, agentExists }),
    [statusLabel, isExpanded, onToggle, onOpenAgent, onOpenDetails, onOpenOutput, agentExists]
  );

  return (
    <section className="fleetdeck-col fleetdeck-col--delegation">
      <header className="fleetdeck-col__head">
        <h2>
          <Icon name="tree" size={14} />
          {t('terminal:fleetHome.delegation.title', { defaultValue: '任务树' })}
        </h2>
        {data && (
          <span className="fleetdeck-col__count">
            {t('terminal:fleetHome.delegation.count', { defaultValue: '{{count}} 任务', count: entries.length })}
          </span>
        )}
        <div className="fleetdeck-col__filters" role="group" aria-label={t('terminal:fleetHome.delegation.title', { defaultValue: '任务树' })}>
          {DELEGATION_STATUS_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              className={`fleetdeck-col__chip${statusFilter === filter.id ? ' is-active' : ''}`}
              aria-pressed={statusFilter === filter.id}
              onClick={() => setStatusFilter(filter.id)}
            >
              {t(`terminal:${filter.labelKey}`, { defaultValue: filter.fallback })}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="fleetdeck-col__refresh"
          onClick={() => void refresh()}
          disabled={loading}
          title={t('common:buttons.refresh')}
          aria-label={t('common:buttons.refresh')}
        >
          <Icon name="arrow-clockwise" size={13} className={loading ? 'is-spinning' : undefined} />
        </button>
      </header>

      {error && (
        <div className="fleetdeck-col__error">
          <Icon name="warn" size={12} />
          <span>{error}</span>
          <button type="button" onClick={() => void refresh()}>
            {t('common:buttons.retry')}
          </button>
        </div>
      )}

      <div className="fleetdeck-col__body">
        {selected ? (
          <DelegationBoardDetails entry={selected} statusLabel={statusLabel} onBack={() => setSelected(null)} />
        ) : (
          <>
            {loading && !data && (
              <div className="fleetdeck-col__loading">
                {t('terminal:delegationBoard.loading', { defaultValue: 'Loading delegations…' })}
              </div>
            )}
            {data && entries.length === 0 && (
              <div className="fleetdeck-col__empty">
                <Icon name="tree" size={16} />
                <span>{t('terminal:delegationBoard.empty', { defaultValue: 'No delegations yet' })}</span>
              </div>
            )}
            {tasks.length > 0 && <DelegationTree tasks={tasks} cb={treeCallbacks} />}
          </>
        )}
      </div>
    </section>
  );
}

export default DelegationColumn;
