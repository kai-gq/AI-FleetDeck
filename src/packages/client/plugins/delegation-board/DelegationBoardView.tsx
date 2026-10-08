import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { store as storeActions, useStore } from '../../store';
import { apiUrl, authFetch } from '../../utils/storage';
import { formatTimeAgo, getLocaleTag } from '../../utils/formatting';
import { subscribeTaskReceipt } from '../../voice/taskReceiptBus';
import { DelegationTree, type DelegationTreeCallbacks } from './DelegationTree';
import {
  boardStatusGroup,
  buildDelegationTree,
  classifyOutputPath,
  extractOutputPath,
  filterBoardEntries,
  formatBoardDuration,
  parseBoardResponse,
  type BoardEntry,
  type BoardEntryStatus,
  type BoardResponse,
} from './boardModel';

const BOARD_LIMIT = 100;
/** 兜底轮询：完成/评价写入不广播（vcs:930-936 已登记），回执总线之外的兜底。 */
const BOARD_POLL_MS = 20_000;
/** 在办实时耗时心跳；无活跃条目时自动停表。 */
const ELAPSED_TICK_MS = 1_000;

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
 * 委派树：任务 → Boss → 每次委派（状态/耗时）→ 回执；
 * 交互：点主管/下属行名看对话、点回执「查看产出」跳文件、点「详情」进五要素面板。
 * 刷新：广播（delegation 决策）+ 回执总线即时刷 + 20s 轮询兜底 + 在办 1s 心跳；④ 无写操作入口。
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
  // 展开态 override（键 → 是否展开）：缺省按层级默认（任务/主管展开、回执收起），刷新/轮询不重置。
  const [expansion, setExpansion] = useState<Map<string, boolean>>(() => new Map());

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

  // 回执总线：完成/评价写入不广播，回执到达即静默刷新（不等 20s 轮询）
  useEffect(() => subscribeTaskReceipt(() => void refresh({ silent: true })), [refresh]);

  useEffect(() => {
    const id = window.setInterval(() => void refresh({ silent: true }), BOARD_POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const entries = useMemo(
    () => filterBoardEntries(data?.entries ?? [], statusFilter),
    [data, statusFilter]
  );

  // 在办 1s 心跳：驱动实时耗时；无活跃条目自动停表
  const hasActive = useMemo(
    () => entries.some((entry) => boardStatusGroup(entry.what.status) === 'active'),
    [entries]
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasActive) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(id);
  }, [hasActive]);

  const tasks = useMemo(
    () =>
      buildDelegationTree(entries, {
        now,
        startedAtOf: (entry) => store.agentTaskProgress.get(entry.bossId)?.get(entry.who.agentId)?.startedAt,
      }),
    [entries, now, store.agentTaskProgress]
  );

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

  // 点行名看对话（规范二连：先例 App.tsx:1068-1071；动作走 store 单例）
  const onOpenAgent = useCallback(
    (agentId: string) => {
      if (!store.agents.has(agentId)) return;
      storeActions.selectAgent(agentId);
      storeActions.setTerminalOpen(true);
    },
    [store]
  );

  const onOpenDetails = useCallback((entry: BoardEntry) => setSelected(entry), []);

  // 点回执看产出：文件 → 全局文件查看器；目录 → 文件浏览器（不可判定时 Receipt 已不给按钮）
  const onOpenOutput = useCallback(
    (entry: BoardEntry) => {
      const path = extractOutputPath(entry.where.outputLocation);
      if (!path) return;
      if (classifyOutputPath(entry.where.outputLocation) === 'file') storeActions.setFileViewerPath(path);
      else storeActions.openFileExplorer(path);
    },
    []
  );

  const agentExists = useCallback((agentId: string) => store.agents.has(agentId), [store]);

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
          {tasks.length > 0 && <DelegationTree tasks={tasks} cb={treeCallbacks} />}
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
