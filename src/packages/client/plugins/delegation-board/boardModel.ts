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

export interface BoardBossGroup {
  bossId: string;
  bossName: string;
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

/** 状态归类（行样式/筛选用）：活跃 / 成功 / 失败 / 取消。 */
export function boardStatusGroup(status: BoardEntryStatus): 'active' | 'success' | 'danger' | 'muted' {
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

/** 通过服务端 status 过滤（'all' = 不过滤）。 */
export function filterBoardEntries(entries: readonly BoardEntry[], status: string): BoardEntry[] {
  if (!status || status === 'all') return [...entries];
  return entries.filter((e) => e.what.status === status);
}

/** 按 Boss 分组（保持输入顺序——条目已是时间倒序；Boss 顺序 = 首次出现顺序）。 */
export function groupEntriesByBoss(entries: readonly BoardEntry[]): BoardBossGroup[] {
  const groups = new Map<string, BoardBossGroup>();
  for (const entry of entries) {
    const existing = groups.get(entry.bossId);
    if (existing) {
      existing.entries.push(entry);
    } else {
      groups.set(entry.bossId, {
        bossId: entry.bossId,
        bossName: entry.bossName || entry.bossId,
        entries: [entry],
      });
    }
  }
  return [...groups.values()];
}

/** 耗时紧凑格式（语言中立：38s / 3m / 2.1h）。 */
export function formatBoardDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '';
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

/** 条目稳定键（列表 key / 详情定位；与视图 decisionId 同源）。 */
export function boardEntryKey(entry: BoardEntry): string {
  return entry.decisionId;
}
