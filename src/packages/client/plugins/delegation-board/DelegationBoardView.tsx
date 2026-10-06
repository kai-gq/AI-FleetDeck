import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { useStore } from '../../store';
import { apiUrl, authFetch } from '../../utils/storage';
import { formatTimeAgo, getLocaleTag } from '../../utils/formatting';
import {
  boardEntryKey,
  boardStatusGroup,
  filterBoardEntries,
  formatBoardDuration,
  groupEntriesByBoss,
  parseBoardResponse,
  type BoardEntry,
  type BoardEntryStatus,
  type BoardResponse,
} from './boardModel';

const BOARD_LIMIT = 100;
/** 兜底轮询：完成/评价写入不广播（vcs:930-936 已登记），只读面板接受轮询延迟。 */
const BOARD_POLL_MS = 20_000;

const STATUS_FALLBACK: Record<BoardEntryStatus, string> = {
  'in-flight': 'In flight',
  sent: 'Sent',
  pending: 'Pending',
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const FILTERS: Array<{ id: string; labelKey: string; fallback: string }> = [
  { id: 'all', labelKey: 'delegationBoard.filter.all', fallback: 'All' },
  { id: 'in-flight', labelKey: 'delegationBoard.filter.inFlight', fallback: 'In flight' },
  { id: 'completed', labelKey: 'delegationBoard.filter.completed', fallback: 'Completed' },
  { id: 'failed', labelKey: 'delegationBoard.filter.failed', fallback: 'Failed' },
];

function formatAbsoluteTime(timestamp: number | undefined, fallback: string): string {
  if (!timestamp) return fallback;
  return new Date(timestamp).toLocaleString(getLocaleTag() ?? undefined);
}

/**
 * 任务24 · 委派看板侧栏视图（只读）。
 * 验收：① 任务/状态/耗时/委派树可见；② 点开看详情（病历/验收/产出位置/评价）；
 * ③ 广播（delegation 决策）+ 20s 轮询刷新；④ 无任何写操作入口。
 */
export function DelegationBoardView() {
  const { t } = useTranslation(['terminal', 'common']);
  const store = useStore();
  // 广播驱动信号：handleDelegationDecision 每次替换 Map identity（store/delegation.ts:126）
  const histories = store.delegationHistories;
  const [data, setData] = useState<BoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [selected, setSelected] = useState<BoardEntry | null>(null);

  const statusLabel = useCallback(
    (status: BoardEntryStatus) =>
      t(`terminal:delegationBoard.status.${status}`, { defaultValue: STATUS_FALLBACK[status] ?? status }),
    [t]
  );

  const refresh = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setLoading(true);
      try {
        const response = await authFetch(apiUrl(`/api/delegations/board?limit=${BOARD_LIMIT}`));
        const body = (await response.json().catch(() => null)) as unknown;
        if (!response.ok) {
          throw new Error(
            t('terminal:delegationBoard.requestFailed', {
              defaultValue: 'Delegation board request failed ({{status}})',
              status: response.status,
            })
          );
        }
        const parsed = parseBoardResponse(body);
        if (!parsed) {
          throw new Error(
            t('terminal:delegationBoard.invalidResponse', { defaultValue: 'Delegation board returned an invalid response' })
          );
        }
        setData(parsed);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [t]
  );

  // 首次加载 + 广播驱动刷新（委派史 Map identity 变更 = 有新的委派落库）
  useEffect(() => {
    void refresh();
  }, [refresh, histories]);

  useEffect(() => {
    const id = window.setInterval(() => void refresh({ silent: true }), BOARD_POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const entries = useMemo(
    () => filterBoardEntries(data?.entries ?? [], statusFilter),
    [data, statusFilter]
  );
  const groups = useMemo(() => groupEntriesByBoss(entries), [entries]);

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
        {FILTERS.map((filter) => (
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
          {groups.map((group) => (
            <div key={group.bossId} className="delegation-board-group">
              <div className="delegation-board-group__header">
                <Icon name="user-circle" size={11} />
                <span>{group.bossName}</span>
                <em>{group.entries.length}</em>
              </div>
              {group.entries.map((entry) => (
                <button
                  key={boardEntryKey(entry)}
                  type="button"
                  className="delegation-board-row"
                  onClick={() => setSelected(entry)}
                >
                  <span className={`delegation-board-row__dot is-${boardStatusGroup(entry.what.status)}`} />
                  <span className="delegation-board-row__title">{entry.what.objective}</span>
                  {entry.what.priority && (
                    <span className="delegation-board-row__priority">{entry.what.priority}</span>
                  )}
                  <span className="delegation-board-row__agent">{entry.who.agentName}</span>
                  <span className={`delegation-board-row__status is-${boardStatusGroup(entry.what.status)}`}>
                    {statusLabel(entry.what.status)}
                  </span>
                  <span className="delegation-board-row__meta">
                    {entry.when.durationMs !== undefined && formatBoardDuration(entry.when.durationMs)}
                    {entry.when.durationMs !== undefined && ' · '}
                    {formatTimeAgo(entry.when.completedAt ?? entry.when.delegatedAt)}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 详情（面板内切换，非模态；只读） ───

interface DetailsProps {
  entry: BoardEntry;
  statusLabel: (status: BoardEntryStatus) => string;
  onBack: () => void;
}

function DelegationBoardDetails({ entry, statusLabel, onBack }: DetailsProps) {
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
