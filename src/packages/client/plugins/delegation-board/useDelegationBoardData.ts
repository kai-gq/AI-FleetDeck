import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { store as storeActions, useStore } from '../../store';
import { apiUrl, authFetch } from '../../utils/storage';
import { subscribeTaskReceipt } from '../../voice/taskReceiptBus';
import {
  boardStatusGroup,
  buildDelegationTree,
  classifyOutputPath,
  extractOutputPath,
  filterBoardEntries,
  parseBoardResponse,
  type BoardEntry,
  type BoardEntryStatus,
  type BoardResponse,
  type TreeTaskNode,
} from './boardModel';

const BOARD_LIMIT = 100;
/** 兜底轮询：完成/评价写入不广播（vcs:930-936 已登记），回执总线之外的兜底。 */
const BOARD_POLL_MS = 20_000;
/** 在办实时耗时心跳；无活跃条目时自动停表。 */
const ELAPSED_TICK_MS = 1_000;

/**
 * 状态筛选模型（B-25：从 DelegationBoardView 上移，侧栏视图与总览中栏共用）。
 * id 与 filterBoardEntries 的 statusFilter 参数一致；文案在 terminal:delegationBoard.filter.*。
 */
export const DELEGATION_STATUS_FILTERS: Array<{ id: string; labelKey: string; fallback: string }> = [
  { id: 'all', labelKey: 'delegationBoard.filter.all', fallback: 'All' },
  { id: 'in-flight', labelKey: 'delegationBoard.filter.inFlight', fallback: 'In flight' },
  { id: 'completed', labelKey: 'delegationBoard.filter.completed', fallback: 'Completed' },
  { id: 'failed', labelKey: 'delegationBoard.filter.failed', fallback: 'Failed' },
];

/** 状态文案兜底；zh 文案在 terminal:delegationBoard.status.*。 */
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

export interface DelegationBoardData {
  /** 原始响应（toolbar 有无计数用 data 是否存在判定）。 */
  data: BoardResponse | null;
  loading: boolean;
  error: string | null;
  refresh: (opts?: { silent?: boolean }) => Promise<void>;
  /** 已按 statusFilter 过滤的条目（侧栏与总览中栏同源）。 */
  entries: BoardEntry[];
  /** 委派树数据（任务 → 主管 → 委派 → 回执）。 */
  tasks: TreeTaskNode[];
  /** 在办 1s 心跳的当前时刻（耗时投影用）。 */
  now: number;
  hasActive: boolean;
  statusLabel: (status: BoardEntryStatus) => string;
  /** 点行名看对话：选中 agent + 打开终端。 */
  onOpenAgent: (agentId: string) => void;
  /** 点回执看产出：文件 → 全局查看器；目录 → 文件浏览器。 */
  onOpenOutput: (entry: BoardEntry) => void;
  agentExists: (agentId: string) => boolean;
}

/**
 * 任务24 · 委派看板数据层（从 DelegationBoardView 原文搬迁，行为不变）。
 * 刷新三条腿：广播（delegation 决策）+ 回执总线即时刷 + 20s 轮询兜底，
 * 外加在办 1s 心跳驱动实时耗时。视图态（筛选/展开/选中）留在各视图组件内。
 */
export function useDelegationBoardData(statusFilter = 'all'): DelegationBoardData {
  const { t } = useTranslation(['terminal', 'common']);
  const store = useStore();
  // 广播驱动信号：handleDelegationDecision 每次替换 Map identity（store/delegation.ts:126）
  const histories = store.delegationHistories;
  const [data, setData] = useState<BoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // 点行名看对话（规范二连：先例 App.tsx:1068-1071；动作走 store 单例）
  const onOpenAgent = useCallback(
    (agentId: string) => {
      if (!store.agents.has(agentId)) return;
      storeActions.selectAgent(agentId);
      storeActions.setTerminalOpen(true);
    },
    [store]
  );

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

  return {
    data,
    loading,
    error,
    refresh,
    entries,
    tasks,
    now,
    hasActive,
    statusLabel,
    onOpenAgent,
    onOpenOutput,
    agentExists,
  };
}

export default useDelegationBoardData;
