import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { getLocaleTag } from '../../utils/formatting';
import { DelegationTree, type DelegationTreeCallbacks } from './DelegationTree';
import { DELEGATION_STATUS_FILTERS, useDelegationBoardData } from './useDelegationBoardData';
import {
  boardStatusGroup,
  formatBoardDuration,
  type BoardEntry,
  type BoardEntryStatus,
} from './boardModel';

function formatAbsoluteTime(timestamp: number | undefined, fallback: string): string {
  if (!timestamp) return fallback;
  return new Date(timestamp).toLocaleString(getLocaleTag() ?? undefined);
}

/**
 * 任务24 · 委派看板侧栏视图（只读）。
 * 委派树：任务 → Boss → 每次委派（状态/耗时）→ 回执；
 * 交互：点主管/下属行名看对话、点回执「查看产出」跳文件、点「详情」进五要素面板。
 * 数据层（刷新三条腿 + 心跳）见 useDelegationBoardData（总览中栏同源复用）。
 */
export function DelegationBoardView() {
  const { t } = useTranslation(['terminal', 'common']);
  const [statusFilter, setStatusFilter] = useState('all');
  const [selected, setSelected] = useState<BoardEntry | null>(null);
  // 展开态 override（键 → 是否展开）：缺省按层级默认（任务/主管展开、回执收起），刷新/轮询不重置。
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
    <div className="delegation-board-view">
      <div className="delegation-board-view__toolbar">
        <div>
          <Icon name="tree" size={14} />
          <strong>{t('terminal:delegationBoard.viewTitle', { defaultValue: 'Delegation board' })}</strong>
          {data && <span className="delegation-board-view__count">{entries.length}</span>}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          title={t('common:buttons.refresh')}
        >
          <Icon name="arrow-clockwise" size={13} className={loading ? 'is-spinning' : undefined} />
        </button>
      </div>

      <div className="delegation-board-view__filters">
        {DELEGATION_STATUS_FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className={`delegation-board-chip${statusFilter === filter.id ? ' is-active' : ''}`}
            onClick={() => setStatusFilter(filter.id)}
          >
            {t(`terminal:${filter.labelKey}`, { defaultValue: filter.fallback })}
          </button>
        ))}
      </div>

      {error && (
        <div className="delegation-board-view__error">
          <Icon name="warn" size={12} />
          <span>{error}</span>
          <button type="button" onClick={() => void refresh()}>
            {t('common:buttons.retry')}
          </button>
        </div>
      )}

      {selected ? (
        <DelegationBoardDetails
          entry={selected}
          statusLabel={statusLabel}
          onBack={() => setSelected(null)}
        />
      ) : (
        <div className="delegation-board-view__list">
          {loading && !data && (
            <div className="delegation-board-view__loading">
              {t('terminal:delegationBoard.loading', { defaultValue: 'Loading delegations…' })}
            </div>
          )}
          {data && entries.length === 0 && (
            <div className="delegation-board-view__empty">
              <Icon name="tree" size={16} />
              <span>{t('terminal:delegationBoard.empty', { defaultValue: 'No delegations yet' })}</span>
            </div>
          )}
          {tasks.length > 0 && <DelegationTree tasks={tasks} cb={treeCallbacks} />}
        </div>
      )}
    </div>
  );
}

// ─── 详情（面板内切换，非模态；只读；总览中栏复用） ───

export interface DelegationBoardDetailsProps {
  entry: BoardEntry;
  statusLabel: (status: BoardEntryStatus) => string;
  onBack: () => void;
}

export function DelegationBoardDetails({ entry, statusLabel, onBack }: DelegationBoardDetailsProps) {
  const { t } = useTranslation(['terminal', 'common']);
  const notRecorded = t('terminal:delegationBoard.notRecorded', { defaultValue: 'Not recorded' });

  const facts: Array<{ label: string; value: string; tone?: string }> = [
    { label: t('terminal:delegationBoard.fact.status', { defaultValue: 'Status' }), value: statusLabel(entry.what.status), tone: boardStatusGroup(entry.what.status) },
    { label: t('terminal:delegationBoard.fact.agent', { defaultValue: 'Agent' }), value: entry.who.agentName },
    { label: t('terminal:delegationBoard.fact.boss', { defaultValue: 'Boss' }), value: entry.bossName || entry.bossId },
    {
      label: t('terminal:delegationBoard.fact.duration', { defaultValue: 'Duration' }),
      value: entry.when.durationMs !== undefined ? formatBoardDuration(entry.when.durationMs) : notRecorded,
    },
    {
      label: t('terminal:delegationBoard.fact.priority', { defaultValue: 'Priority' }),
      value: entry.what.priority ?? '—',
    },
    { label: t('terminal:delegationBoard.fact.project', { defaultValue: 'Project' }), value: entry.what.projectId ?? '—' },
    { label: t('terminal:delegationBoard.fact.due', { defaultValue: 'Due' }), value: entry.what.due ?? '—' },
    {
      label: t('terminal:delegationBoard.fact.delegatedAt', { defaultValue: 'Delegated' }),
      value: entry.when.delegatedAt ? formatAbsoluteTime(entry.when.delegatedAt, notRecorded) : notRecorded,
    },
    {
      label: t('terminal:delegationBoard.fact.completedAt', { defaultValue: 'Completed' }),
      value: formatAbsoluteTime(entry.when.completedAt, notRecorded),
    },
  ];

  const acceptance = entry.outcome.acceptance;
  const criteria = entry.outcome.acceptanceCriteria;
  const ratingLabel =
    entry.outcome.rating === 'satisfied'
      ? t('terminal:delegationBoard.rating.satisfied', { defaultValue: 'Satisfied' })
      : entry.outcome.rating === 'unsatisfied'
        ? t('terminal:delegationBoard.rating.unsatisfied', { defaultValue: 'Unsatisfied' })
        : null;

  return (
    <div className="delegation-board-details">
      <div className="delegation-board-details__hero">
        <button type="button" className="delegation-board-details__back" onClick={onBack}>
          <Icon name="arrow-left" size={12} />
          {t('terminal:delegationBoard.back', { defaultValue: 'Back' })}
        </button>
        <h2>{entry.what.objective}</h2>
        <div className="delegation-board-details__tags">
          <span className={`is-${boardStatusGroup(entry.what.status)}`}>{statusLabel(entry.what.status)}</span>
          {entry.what.priority && <span>{entry.what.priority}</span>}
          {entry.what.projectId && <span>{entry.what.projectId}</span>}
          {ratingLabel && <span className={entry.outcome.rating === 'satisfied' ? 'is-success' : 'is-danger'}>{ratingLabel}</span>}
        </div>
      </div>

      <div className="delegation-board-details__facts">
        {facts.map((fact) => (
          <div key={fact.label}>
            <span>{fact.label}</span>
            <strong className={fact.tone ? `is-${fact.tone}` : undefined}>{fact.value}</strong>
          </div>
        ))}
      </div>

      <section className="delegation-board-details__section">
        <h3>
          <Icon name="question" size={12} />
          {t('terminal:delegationBoard.section.why', { defaultValue: 'Why' })}
        </h3>
        <p className="delegation-board-details__quote">{entry.why.userCommand}</p>
        <p className="delegation-board-details__reason">
          {entry.why.reasoning || notRecorded}
          {entry.why.confidence ? ` · ${entry.why.confidence}` : ''}
        </p>
      </section>

      <section className="delegation-board-details__section">
        <h3>
          <Icon name="folder" size={12} />
          {t('terminal:delegationBoard.section.where', { defaultValue: 'Output' })}
        </h3>
        {entry.where.outputLocation ? (
          <code className="delegation-board-details__path">{entry.where.outputLocation}</code>
        ) : (
          <p className="delegation-board-details__muted">{notRecorded}</p>
        )}
        {entry.where.summary && <p className="delegation-board-details__reason">{entry.where.summary}</p>}
      </section>

      <section className="delegation-board-details__section">
        <h3>
          <Icon name="check" size={12} />
          {t('terminal:delegationBoard.section.acceptance', { defaultValue: 'Acceptance' })}
        </h3>
        {acceptance && acceptance.length > 0 ? (
          <ul className="delegation-board-details__acceptance">
            {acceptance.map((item) => (
              <li key={item.item} className={item.done ? 'is-done' : 'is-open'}>
                <Icon name={item.done ? 'check' : 'close'} size={10} />
                <span>{item.item}</span>
              </li>
            ))}
          </ul>
        ) : criteria && criteria.length > 0 ? (
          <ul className="delegation-board-details__acceptance">
            {criteria.map((item) => (
              <li key={item} className="is-unknown">
                <Icon name="question" size={10} />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="delegation-board-details__muted">{notRecorded}</p>
        )}
      </section>

      <section className="delegation-board-details__section delegation-board-details__ids">
        <h3>
          <Icon name="clipboard" size={12} />
          {t('terminal:delegationBoard.section.ids', { defaultValue: 'Identifiers' })}
        </h3>
        <div>
          <span>taskId</span>
          <code>{entry.taskId ?? '—'}</code>
        </div>
        <div>
          <span>decisionId</span>
          <code>{entry.decisionId}</code>
        </div>
      </section>
    </div>
  );
}
