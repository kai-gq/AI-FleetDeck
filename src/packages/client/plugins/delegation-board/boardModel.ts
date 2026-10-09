/**
 * 任务24 · 委派看板（客户端）数据结构与纯函数。
 *
 * 结构镜像服务端 GET /api/delegations/board 返回的 TeamMemoryEntry（五要素视图）；
 * 客户端不 import 服务端模块，接口边界按结构性校验（parseBoardResponse）防御。
 * 纯函数独立导出：分组 / 过滤 / 状态归类 / 耗时格式化 —— 单测直接覆盖。
 */

/** 看板条目状态（TaskCardStatus ∪ 委派状态 ∪ 视图派生态 in-flight）。 */
export type BoardEntryStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'done'
  | 'cancelled'
  | 'sent'
  | 'in-flight'
  | 'completed'
  | 'failed';

export interface BoardAcceptanceItem {
  item: string;
  done: boolean;
}

/** 五要素条目的客户端形态（服务端 TeamMemoryEntry 的投影子集）。 */
export interface BoardEntry {
  decisionId: string;
  taskId?: string;
  bossId: string;
  bossName?: string;
  who: { agentId: string; agentName: string };
  when: { delegatedAt: number; completedAt?: number; durationMs?: number };
  what: {
    objective: string;
    status: BoardEntryStatus;
    due?: string;
    priority?: string;
    projectId?: string;
  };
  why: { userCommand: string; reasoning: string; confidence?: string };
  where: { outputLocation?: string; summary?: string };
  outcome: {
    result?: 'completed' | 'failed';
    acceptanceCriteria?: string[];
    acceptance?: BoardAcceptanceItem[];
    rating?: 'satisfied' | 'unsatisfied';
    ratedAt?: number;
  };
}

export interface BoardResponse {
  generatedAt: number;
  total: number;
  limit: number;
  offset: number;
  entries: BoardEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBoardEntry(value: unknown): value is BoardEntry {
  if (!isRecord(value)) return false;
  const who = value.who;
  const what = value.what;
  return (
    typeof value.decisionId === 'string' &&
    typeof value.bossId === 'string' &&
    isRecord(who) &&
    typeof who.agentName === 'string' &&
    isRecord(what) &&
    typeof what.objective === 'string' &&
    typeof what.status === 'string'
  );
}

/**
 * 服务端响应校验（宽松：结构非法 → null；单条非法 → 跳过该条）。
 * 看板是只读观测面，宁可少显示一条也不让整页崩掉。
 */
export function parseBoardResponse(body: unknown): BoardResponse | null {
  if (!isRecord(body) || !Array.isArray(body.entries)) return null;
  return {
    generatedAt: typeof body.generatedAt === 'number' ? body.generatedAt : 0,
    total: typeof body.total === 'number' ? body.total : body.entries.length,
    limit: typeof body.limit === 'number' ? body.limit : body.entries.length,
    offset: typeof body.offset === 'number' ? body.offset : 0,
    entries: body.entries.filter(isBoardEntry),
  };
}

/** 行样式归类（行样式/筛选用）：活跃 / 成功 / 失败 / 取消。 */
export type BoardStatusGroup = 'active' | 'success' | 'danger' | 'muted';

/** 状态归类：活跃 / 成功 / 失败 / 取消。 */
export function boardStatusGroup(status: BoardEntryStatus): BoardStatusGroup {
  switch (status) {
    case 'in-flight':
    case 'sent':
    case 'pending':
    case 'queued':
    case 'running':
      return 'active';
    case 'completed':
    case 'done':
      return 'success';
    case 'failed':
      return 'danger';
    case 'cancelled':
      return 'muted';
  }
}

/**
 * 段位过滤（B-25 段位共用；B-34 起按状态组）。
 * 'all' = 不过滤；「进行中/已完成/失败」段位按状态组全量匹配——进行中 = active 全组
 * （sent/in-flight/pending/queued/running）、已完成含 done；其余未知 id 仍按状态精确匹配。
 * 注意：服务端 ?status= 仍是精确匹配（客户端只走本地过滤，不传该参数）。
 */
const STATUS_FILTER_GROUPS: Record<string, BoardStatusGroup> = {
  'in-flight': 'active',
  completed: 'success',
  failed: 'danger',
};

export function filterBoardEntries(entries: readonly BoardEntry[], status: string): BoardEntry[] {
  if (!status || status === 'all') return [...entries];
  const group = STATUS_FILTER_GROUPS[status];
  if (group) return entries.filter((e) => boardStatusGroup(e.what.status) === group);
  return entries.filter((e) => e.what.status === status);
}

/** 耗时紧凑格式（语言中立：38s / 3m / 2.1h / 2.0d）。 */
export function formatBoardDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '';
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

/** 条目稳定键（列表 key / 详情定位；与视图 decisionId 同源）。 */
export function boardEntryKey(entry: BoardEntry): string {
  return entry.decisionId;
}

// ─── 委派树（任务 → Boss → 每次委派 → 回执） ───
// 任务层无独立实体：以 taskId 归组（同任务重派/换人自动聚合），无 taskId 回退 objective，
// 再不齐单条自成任务。树节点 React key 一律 decisionId（taskId 进程内生成、跨重启不稳定）。

export interface TreeDelegationNode {
  kind: 'delegation';
  /** = decisionId（稳定键） */
  key: string;
  entry: BoardEntry;
  statusGroup: BoardStatusGroup;
  /** 在办实时耗时（ms）；非活跃或无可信起点 → null（显示「进行中」，不编造时间）。 */
  liveElapsedMs: number | null;
}

export interface TreeBossNode {
  kind: 'boss';
  /** 展开态全局键 = `${任务键}#${bossId}` */
  key: string;
  bossId: string;
  bossName: string;
  statusGroup: BoardStatusGroup;
  delegations: TreeDelegationNode[];
}

export interface TreeTaskNode {
  kind: 'task';
  /** 归组键（task:/obj:/del: 前缀） */
  key: string;
  label: string;
  taskId?: string;
  statusGroup: BoardStatusGroup;
  latestAt: number;
  delegationCount: number;
  bosses: TreeBossNode[];
}

export interface BuildDelegationTreeOptions {
  now: number;
  /** 在办起点投影（store.agentTaskProgress）；拿不到时回退委派时刻。 */
  startedAtOf?: (entry: BoardEntry) => number | undefined;
}

/** 任务归组键：taskId 优先（重派聚合）；无则 objective；再退单条 decisionId。 */
export function taskGroupKey(entry: BoardEntry): string {
  const taskId = entry.taskId?.trim();
  if (taskId) return `task:${taskId}`;
  const objective = entry.what.objective?.trim();
  if (objective) return `obj:${objective}`;
  return `del:${entry.decisionId}`;
}

/** 聚合态（任务行/Boss 行圆点）：有活跃 → active；否则有失败 → danger；全取消 → muted；其余 success。 */
export function aggregateStatusGroup(statuses: readonly BoardEntryStatus[]): BoardStatusGroup {
  const groups = statuses.map(boardStatusGroup);
  if (groups.includes('active')) return 'active';
  if (groups.includes('danger')) return 'danger';
  if (groups.length > 0 && groups.every((group) => group === 'muted')) return 'muted';
  return 'success';
}

/**
 * 在办实时耗时：仅活跃态计时；起点 = agentTaskProgress.startedAt，回退委派时刻；
 * delegatedAt=0（服务端在办合成条目）且无起点 → null。
 */
export function liveElapsedMs(
  status: BoardEntryStatus,
  delegatedAt: number,
  startedAt: number | undefined,
  now: number
): number | null {
  if (boardStatusGroup(status) !== 'active') return null;
  const start = startedAt && startedAt > 0 ? startedAt : delegatedAt;
  if (!(start > 0)) return null;
  return Math.max(0, now - start);
}

/** 组装三层树：任务（latestAt 倒序）→ Boss（首次出现序）→ 委派（保持输入序）。 */
export function buildDelegationTree(
  entries: readonly BoardEntry[],
  opts: BuildDelegationTreeOptions
): TreeTaskNode[] {
  interface BossDraft {
    bossId: string;
    bossName: string;
    delegations: TreeDelegationNode[];
  }
  interface TaskDraft {
    key: string;
    label: string;
    taskId?: string;
    latestAt: number;
    bosses: BossDraft[];
  }
  const tasks = new Map<string, TaskDraft>();
  for (const entry of entries) {
    const key = taskGroupKey(entry);
    let task = tasks.get(key);
    if (!task) {
      task = {
        key,
        label: entry.what.objective?.trim() || entry.why.userCommand?.trim() || entry.decisionId,
        taskId: entry.taskId?.trim() || undefined,
        latestAt: 0,
        bosses: [],
      };
      tasks.set(key, task);
    }
    let boss = task.bosses.find((candidate) => candidate.bossId === entry.bossId);
    if (!boss) {
      boss = { bossId: entry.bossId, bossName: entry.bossName?.trim() || entry.bossId, delegations: [] };
      task.bosses.push(boss);
    }
    boss.delegations.push({
      kind: 'delegation',
      key: boardEntryKey(entry),
      entry,
      statusGroup: boardStatusGroup(entry.what.status),
      liveElapsedMs: liveElapsedMs(entry.what.status, entry.when.delegatedAt, opts.startedAtOf?.(entry), opts.now),
    });
    task.latestAt = Math.max(task.latestAt, entry.when.completedAt ?? entry.when.delegatedAt ?? 0);
  }
  const result: TreeTaskNode[] = [];
  for (const task of tasks.values()) {
    const all = task.bosses.flatMap((boss) => boss.delegations);
    result.push({
      kind: 'task',
      key: task.key,
      label: task.label,
      taskId: task.taskId,
      statusGroup: aggregateStatusGroup(all.map((node) => node.entry.what.status)),
      latestAt: task.latestAt,
      delegationCount: all.length,
      bosses: task.bosses.map((boss) => ({
        kind: 'boss',
        key: `${task.key}#${boss.bossId}`,
        bossId: boss.bossId,
        bossName: boss.bossName,
        statusGroup: aggregateStatusGroup(boss.delegations.map((node) => node.entry.what.status)),
        delegations: boss.delegations,
      })),
    });
  }
  // 任务排序（B-34 用户口径）：纯按最新活动倒序——最新的委派排最上面
  // （取代 B-32「在办置顶」；「在办有哪些」由默认「进行中」段位承担）
  result.sort((a, b) => b.latestAt - a.latestAt);
  return result;
}

/**
 * 产出位置是否为可用路径（取首个空白分隔片段；整串含空白或是自然语言描述 → null）。
 * 真实数据里大量产出是「无文件交付(只读任务)…」这类人话——只当文本展示，不猜路径。
 * 紧贴的括号注解（如 `E:/tmp/uia-out.txt(UIA 完整控件文本)`，路径与注解间无空格）取片段后剥离；
 * 「(1).json」这类括号属于文件名本体（注解尾段仍以扩展名收尾）时保留。
 */
export function extractOutputPath(raw: string | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  const isPathLike = (candidate: string) => /[\\/]/.test(candidate) && !/\s/.test(candidate);
  const cutGluedNote = (fragment: string): string => {
    const at = fragment.search(/[(（]/);
    if (at <= 0) return fragment;
    const head = fragment.slice(0, at);
    const tail = fragment.slice(at).split(/[\\/]/).pop() ?? '';
    if (/\.[A-Za-z0-9]{1,8}$/.test(tail)) return fragment; // 括号属文件名本体
    return head;
  };
  const first = cutGluedNote(text.split(/\s+/)[0]);
  if (isPathLike(first)) return first;
  return isPathLike(text) ? text : null;
}

/** 产出位置分类：文件（按扩展名）/ 目录 / 不可判定（自然语言等，只当文本展示）。 */
export function classifyOutputPath(raw: string | undefined): 'file' | 'dir' | 'unknown' {
  const path = extractOutputPath(raw);
  if (!path) return 'unknown';
  const last = path.split(/[\\/]/).filter(Boolean).pop() ?? '';
  if (/^[A-Za-z]:$/.test(last)) return 'dir'; // 盘根 E:
  return /\.[A-Za-z0-9]{1,8}$/.test(last) ? 'file' : 'dir';
}
