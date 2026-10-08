import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { DelegationTree, type DelegationTreeCallbacks } from '../../plugins/delegation-board/DelegationTree';
import { DelegationBoardDetails } from '../../plugins/delegation-board/DelegationBoardView';
import { useDelegationBoardData } from '../../plugins/delegation-board/useDelegationBoardData';
import type { BoardEntry } from '../../plugins/delegation-board/boardModel';

/**
 * 总览中栏 · 委派树（EPIC-1）。
 * 与侧栏 DelegationBoardView 同源（同一 useDelegationBoardData hook）；
 * 默认展开任务与主管层（DelegationTree 缺省：任务/主管展开、委派/回执收起）；
 * 详情复用 DelegationBoardDetails（非模态）。
 */
export function DelegationColumn() {
  const { t } = useTranslation(['terminal', 'common']);
  const [selected, setSelected] = useState<BoardEntry | null>(null);
  // 展开态 override（键 → 是否展开）：刷新/轮询不重置
  const [expansion, setExpansion] = useState<Map<string, boolean>>(() => new Map());

  const { data, loading, error, refresh, entries, tasks, statusLabel, onOpenAgent, onOpenOutput, agentExists } =
    useDelegationBoardData('all');

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
          {t('terminal:fleetHome.delegation.title', { defaultValue: '委派树' })}
        </h2>
        {data && (
          <span className="fleetdeck-col__count">
            {t('terminal:fleetHome.delegation.count', { defaultValue: '{{count}} 任务', count: entries.length })}
          </span>
        )}
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
