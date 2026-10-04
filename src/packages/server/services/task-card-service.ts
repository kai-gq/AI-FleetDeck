/**
 * Task Card Service（改造点⑦ 任务对象化，Spec §4.7）
 *
 * 把「派一句话」升级为「派一张任务卡」：目标 / 验收标准 / 依赖 / 优先级 +
 * projectId / sourceProject / status（pending → running → done）。
 *
 * 纯文本向后兼容（本任务硬约束）：
 * - Boss 的 delegation 块不携带 `taskCard` 时，委派链路行为与旧版完全一致；
 * - 任务卡格式错误只降级为「无卡」，不阻塞派活（卡是委托层增强字段）；
 * - 命令文本中没有 ```task-card 围栏块时，buildBossMessage 原样按纯文本注入；
 * - 任务卡状态由服务端状态机维护（解析时忽略外部传入的 status，落卡一律 pending）。
 *
 * 状态机迁移埋点（🔴 决策观测点⑦）见 activity-log.logTaskCardStatus：落 system_log
 * 的 delegation 通道（phase='task-card-status'），供 ⑧ 病历 / ⑬ 撤回消费。
 */

import type { TaskCard, TaskCardPriority, TaskCardStatus } from '../../shared/agent-types.js';

// ─── 状态机 ───

export const TASK_CARD_STATUSES: readonly TaskCardStatus[] = ['pending', 'queued', 'running', 'done', 'cancelled'];

/**
 * 已实现的五态迁移表（任务 16 补 cancelled 边）。
 * pending → done 直连用于「运行标记未及落盘、回执先到」的乱序场景。
 * queued 边（任务 15·B 全局并发配额）：pending → queued（超预算入队）、
 * queued → running（出队派发；运行标记未及落盘前不接其他边）。
 * cancelled 边（任务 16 ⑬ 撤回）：pending/queued/running → cancelled；
 * done 与 cancelled 都是终态（done 无出边 = 天然拒回退/拒撤；cancelled 无出边 = 撤回不可逆）。
 */
const TASK_CARD_TRANSITIONS: Readonly<Record<TaskCardStatus, readonly TaskCardStatus[]>> = {
  pending: ['queued', 'running', 'done', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: ['done', 'cancelled'],
  done: [],
  cancelled: [],
};

export function isTaskCardStatus(v: unknown): v is TaskCardStatus {
  return typeof v === 'string' && (TASK_CARD_STATUSES as readonly string[]).includes(v);
}

/** 状态机守卫：非法迁移（含同态重复）返回 false，调用方跳过写入并告警。 */
export function canTransitionTaskCard(from: TaskCardStatus, to: TaskCardStatus): boolean {
  return from !== to && TASK_CARD_TRANSITIONS[from].includes(to);
}

// ─── 解析 / 归一化 ───

export interface TaskCardParseResult {
  card?: TaskCard;
  errors: string[];
}

function asTrimmedString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** 字符串或字符串数组 → 去空去重数组；非法元素记一条错误（归一化整体失败时调用方降级无卡）。 */
function asStringArray(v: unknown, field: string, errors: string[]): string[] {
  if (v === undefined || v === null) return [];
  const items = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') {
      errors.push(`${field} must be a string or an array of strings`);
      continue;
    }
    const s = item.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 优先级归一化：P0-P3（大小写不敏感）+ high/medium/low 别名（Boss 口语化时兜底）。 */
const PRIORITY_ALIASES: Readonly<Record<string, TaskCardPriority>> = {
  high: 'P1',
  medium: 'P2',
  low: 'P3',
};

function normalizePriority(v: unknown, errors: string[]): TaskCardPriority | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') {
    errors.push('taskCard.priority must be a string (P0|P1|P2|P3, or high|medium|low)');
    return undefined;
  }
  const key = v.trim().toLowerCase();
  if (/^p[0-3]$/.test(key)) return key.toUpperCase() as TaskCardPriority;
  const alias = PRIORITY_ALIASES[key];
  if (alias) return alias;
  errors.push(`taskCard.priority must be one of P0|P1|P2|P3 (got "${v.trim()}")`);
  return undefined;
}

/** 截止日归一化（任务17·A2）：只收 date-only 'YYYY-MM-DD'（与 Bolba 同形），非法同上记错误。 */
function normalizeDue(v: unknown, errors: string[]): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') {
    errors.push('taskCard.due must be a date-only string (YYYY-MM-DD)');
    return undefined;
  }
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    errors.push(`taskCard.due must be a date-only string YYYY-MM-DD (got "${s}")`);
    return undefined;
  }
  return s;
}

/**
 * 归一化/校验原始 taskCard 对象（Boss delegation 块中携带）。
 * 失败返回 errors（调用方降级为无卡，不阻塞派活）；成功返回卡，status 一律 pending。
 */
export function normalizeTaskCard(raw: unknown): TaskCardParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: ['taskCard must be an object'] };
  }

  const item = raw as Record<string, unknown>;
  const errors: string[] = [];

  const objective = asTrimmedString(item.objective);
  if (!objective) errors.push('taskCard.objective is required');

  const acceptanceCriteria = asStringArray(item.acceptanceCriteria, 'taskCard.acceptanceCriteria', errors);
  const dependencies = asStringArray(item.dependencies, 'taskCard.dependencies', errors);
  const priority = normalizePriority(item.priority, errors);
  const due = normalizeDue(item.due, errors);

  if (errors.length > 0 || !objective) return { errors };

  return {
    errors: [],
    card: {
      objective,
      acceptanceCriteria,
      dependencies,
      priority,
      projectId: asTrimmedString(item.projectId),
      sourceProject: asTrimmedString(item.sourceProject),
      status: 'pending',
      due,
    },
  };
}

/**
 * 从自由文本中抽取 ```task-card 围栏块（JSON 体）。无块 / 非法 JSON / 校验失败
 * 一律返回 undefined —— 调用方按纯文本处理（向后兼容）。
 */
const TASK_CARD_FENCE = /```task-card\s*\n([\s\S]*?)\n```/;

export function parseTaskCardFromText(text: string): TaskCard | undefined {
  const match = TASK_CARD_FENCE.exec(text);
  if (!match) return undefined;
  try {
    const { card } = normalizeTaskCard(JSON.parse(match[1].trim()));
    return card;
  } catch {
    return undefined;
  }
}

// ─── 渲染 ───

/** 渲染为可读任务卡块（注入下属的委托消息；不含 status —— 状态由服务端维护）。 */
export function formatTaskCard(card: TaskCard): string {
  const lines = ['[TASK CARD]', `Objective: ${card.objective}`, 'Acceptance criteria:'];
  if (card.acceptanceCriteria.length > 0) {
    for (const c of card.acceptanceCriteria) lines.push(`- ${c}`);
  } else {
    lines.push('- (none provided)');
  }
  lines.push('Dependencies:');
  if (card.dependencies.length > 0) {
    for (const d of card.dependencies) lines.push(`- ${d}`);
  } else {
    lines.push('- (none)');
  }
  if (card.priority) lines.push(`Priority: ${card.priority}`);
  if (card.due) lines.push(`Due: ${card.due}`);
  if (card.projectId) {
    lines.push(`Project: ${card.projectId}${card.sourceProject ? ` (source: ${card.sourceProject})` : ''}`);
  } else if (card.sourceProject) {
    lines.push(`Source project: ${card.sourceProject}`);
  }
  lines.push('[/TASK CARD]');
  return lines.join('\n');
}

/**
 * Boss 注入版：在可读卡后附 delegation 块 JSON 字段提示，让 Boss 把卡原样带下去。
 * 这是委托消息（用户消息）的增强，不改 Boss 纯调度员 prompt 本身（⑤ 边界）。
 */
export function formatTaskCardForBoss(card: TaskCard): string {
  const schema: Record<string, unknown> = {
    objective: card.objective,
    acceptanceCriteria: card.acceptanceCriteria,
    dependencies: card.dependencies,
  };
  if (card.priority) schema.priority = card.priority;
  if (card.due) schema.due = card.due;
  if (card.projectId) schema.projectId = card.projectId;
  if (card.sourceProject) schema.sourceProject = card.sourceProject;

  return `${formatTaskCard(card)}\nWhen you delegate this task, carry the card through in the delegation block item as:\n"taskCard": ${JSON.stringify(schema)}`;
}
