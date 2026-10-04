/**
 * 任务13·⑩ 秘书 Bolba 桥（服务端封装）
 *
 * Bolba 任务板 = 业务/外部待办清单（报价、付款、会议、证书这类 agent 干不了、
 * 需要人盯的活）。本模块是语音伙伴与 Bolba 之间的唯一服务端桥：
 *   - 只读视图：今日要盯 / 按项目 / 按截止；
 *   - 写路径：创建 / 标记完成 / 重开（复用插件 close/reopen 的端点与状态语义）；
 *   - 契约动作统一入口 handleBolbaContractAction（永不抛，失败走确定性降级话术）。
 *
 * 设计约束：
 *   - 数据模型沿用 Bolba 自身（id/status/due/timeline），不投影成 agent/插件模型；
 *   - HTTP 基座复用插件导出的 bolbaRequest（URL/token/X-Actor 单处维护，不新建服务）；
 *   - 日期解析 / 分桶 / 排序 / 渲染 / 引用匹配全部为纯函数（可单测、可复现），
 *     IO 只做薄适配；now 一律显式传入，不依赖进程时钟；
 *   - 两本账边界：本模块只碰 Bolba 业务待办，绝不接触 Boss 委派通道。
 *
 * 🟡 决策观测点⑩ Bolba 同步（任务文件 ⑦，Spec §4.14）：读写事件登记 system_log
 *   （category='system' + source='bolba' + body.cat='bolba-sync'；失败按 warn 全量落盘）。
 *   source 常量暂落本模块（activity-log.ts 不在本任务所有权内），主脑可后续并入
 *   ACTIVITY_SOURCE 登记表（登记备查 2026-10-04）。
 */

import { bolbaRequest, PENDING_STATUSES } from '../plugins/builtin/bolba-tasks.js';
import { logEvent } from '../data/system-log.js';

// ─── 常量 ───

const MAX_BOLBA_TASKS = 500;
/** 最近完成任务拉取上限（reopen 专用候选源；对齐插件基座 RECENT_COMPLETED_LIMIT=8）。 */
const RECENT_DONE_LIMIT = 8;
/** 已完成状态集（对齐插件 COMPLETED_STATUSES；仅用于 done 候选列表过滤）。 */
const COMPLETED_STATUSES = new Set(['done', 'completed']);
const TITLE_MAX = 120;
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'] as const;

/** 降级话术（网络/服务不可用；与 vcs 其他分支的「确定性兜底」风格一致）。 */
export const BOLBA_DEGRADED_REPLY = 'Bolba 看板暂时连不上，过会儿再试。';

/** 「强制新建」口语短语（409 防重后的二次确认；短语启发起点，可再标定）。 */
const FORCE_CREATE_PHRASES = ['强制', '照建', '还是建', '再记一条', '再建一条', '就是要'];

/** 指令性口头语（创建任务时若模型没剥离，标题兜底剥离用）。 */
const INSTRUCTION_PREFIX_RE = /^(记一下|记下|加个?待办|加到待办|加一条|提醒我|帮我记一下|帮我记|备忘录)[，,：:\s]*/;

// ─── 类型（沿用 Bolba 模型，不吞并） ───

/** Bolba /tasks 单条任务（保留 toApiTask 字段原名；本模块只读使用）。 */
export interface BolbaApiTask {
  id: number | string;
  title: string;
  status?: string;
  proj?: string;
  due?: string;
  reg?: string;
  created_at?: string;
  notes?: string;
  description?: string;
  type?: string;
  from_person?: string;
  priority?: string;
  [key: string]: unknown;
}

/** 契约动作全集（与 vcs 的 CompanionAction 四动作同源；vcs 侧成员检查/门控共用本集合）。 */
export const BOLBA_CONTRACT_ACTIONS: ReadonlySet<string> = new Set<BolbaContractAction>([
  'query_bolba_tasks',
  'create_bolba_task',
  'complete_bolba_task',
  'reopen_bolba_task',
]);

export type BolbaContractAction =
  | 'query_bolba_tasks'
  | 'create_bolba_task'
  | 'complete_bolba_task'
  | 'reopen_bolba_task';

export interface BolbaContractInput {
  action: BolbaContractAction;
  /** 用户原话（日期解析/项目识别以它为准）。 */
  userText: string;
  /** 契约字段（模型填写的指代/问法）。 */
  contract: { bolbaTask?: string; query?: string };
  now: Date;
}

export interface BolbaOutcome {
  response: string;
  degraded: boolean;
}

// ─── 通用小工具 ───

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function atMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const r = atMidnight(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** 周一为一周之始（中文口语「本周」口径）。 */
function mondayOf(d: Date): Date {
  const r = atMidnight(d);
  const offset = (r.getDay() + 6) % 7;
  return addDays(r, -offset);
}

function formatDate(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function cleanTitle(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX)
    .trim();
}

// ─── 日期解析 / 分桶（纯函数） ───

const WEEKDAY_INDEX: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

/** 日期短语（用于从标题里剥离）。 */
const DUE_PHRASE_RE = /(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]|(这|本|下)?\s*(?:周|星期|礼拜)\s*[一二三四五六日天]|大后天|后天|明天|明日|今天|今日/g;

/**
 * 从口语里解析截止日（→ 'YYYY-MM-DD'，本地日历；解析不到返回 null）。
 * 支持：YYYY-M-D / M月D日 / 今天/明天/后天/大后天 / (这|本|下)?周X。
 * 周口径：无前缀 = 含今天在内的下一次；本/这 = 本周（已过保守顺延一周）；下 = 下一周。
 */
export function parseSpokenDue(text: string, now: Date): string | null {
  if (!text) return null;

  const explicit = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (explicit) {
    return formatDate(new Date(Number(explicit[1]), Number(explicit[2]) - 1, Number(explicit[3])));
  }

  const monthDay = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text);
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    let year = now.getFullYear();
    // 口语不带年份：取「未来最近一次」该日期（当天含）
    if (new Date(year, month - 1, day).getTime() < atMidnight(now).getTime()) year += 1;
    return formatDate(new Date(year, month - 1, day));
  }

  if (/大后天/.test(text)) return formatDate(addDays(now, 3));
  if (/后天/.test(text)) return formatDate(addDays(now, 2));
  if (/明天|明日/.test(text)) return formatDate(addDays(now, 1));
  if (/今天|今日/.test(text)) return formatDate(addDays(now, 0));

  const weekday = /(这|本|下)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(text);
  if (weekday) {
    const target = WEEKDAY_INDEX[weekday[2]];
    if (target === undefined) return null;
    const base = weekday[1] === '下' ? addDays(mondayOf(now), 7) : mondayOf(now);
    let candidate = addDays(base, (target + 6) % 7);
    if (candidate.getTime() < atMidnight(now).getTime()) candidate = addDays(candidate, 7);
    return formatDate(candidate);
  }

  return null;
}

/** 从标题里去掉落进标题的日期词与「前/之前/以内」等截止修饰词（模型未按提示词剥离时兜底）。 */
export function stripDuePhrases(text: string): string {
  let out = text.replace(DUE_PHRASE_RE, ' ');
  out = out.replace(INSTRUCTION_PREFIX_RE, '');
  out = out.replace(/\s+(?:之前|以前|以内|前)\s*(?=[一-鿿])/g, ' ');
  out = out.replace(/^(前|之前|以前|以内)\s*/, '');
  out = out.replace(/\s*(之前|以前|以内|前)\s*$/, '');
  return out.replace(/\s+/g, ' ').trim();
}

export type BolbaDueBucket = 'overdue' | 'today' | 'tomorrow' | 'later' | 'none';

export interface BolbaDueInfo {
  bucket: BolbaDueBucket;
  /** 与 now 的日历日差（负=已过期；无法解析 → null）。 */
  days: number | null;
}

/** due 分桶（按本地日历日差，date-only；null/非法 → none）。 */
export function classifyBolbaDue(due: string | null | undefined, now: Date): BolbaDueInfo {
  if (!due) return { bucket: 'none', days: null };
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(due.trim());
  if (!m) return { bucket: 'none', days: null };
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return { bucket: 'none', days: null };
  const days = Math.round((atMidnight(d).getTime() - atMidnight(now).getTime()) / 86_400_000);
  if (days < 0) return { bucket: 'overdue', days };
  if (days === 0) return { bucket: 'today', days };
  if (days === 1) return { bucket: 'tomorrow', days };
  return { bucket: 'later', days };
}

/** 口播用相对描述：已过期 N 天 / 今天到期 / 明天到期 / N 天后到期 / 未标截止。 */
export function dueLabel(due: string | null | undefined, now: Date): string {
  const info = classifyBolbaDue(due, now);
  switch (info.bucket) {
    case 'overdue': return `已过期 ${Math.abs(info.days ?? 0)} 天`;
    case 'today': return '今天到期';
    case 'tomorrow': return '明天到期';
    case 'later': return `${info.days} 天后到期`;
    default: return '未标截止';
  }
}

/** 未来日期的口头表述（创建任务回执用）：今天/明天/M月D日。 */
export function speakableDue(due: string, now: Date): string {
  const info = classifyBolbaDue(due, now);
  if (info.bucket === 'today') return '今天';
  if (info.bucket === 'tomorrow') return '明天';
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(due.trim());
  return m ? `${Number(m[2])}月${Number(m[3])}日` : due;
}

// ─── 选单 / 分组 / 引用匹配（纯函数） ───

/** 「要盯的」= overdue + today + horizonDays 内（默认明天）。排序：最久过期在前，其次今天/明天/编号。 */
export function selectDueSoonTasks(
  tasks: readonly BolbaApiTask[],
  now: Date,
  horizonDays = 1,
): BolbaApiTask[] {
  return tasks
    .filter((t) => PENDING_STATUSES.has((t.status ?? '').toLowerCase()))
    .map((task) => ({ task, info: classifyBolbaDue(task.due, now) }))
    .filter(({ info }) =>
      info.bucket === 'overdue'
      || info.bucket === 'today'
      || info.bucket === 'tomorrow'
      || (info.bucket === 'later' && (info.days ?? Number.POSITIVE_INFINITY) <= horizonDays))
    .sort((a, b) =>
      (a.info.days ?? Number.POSITIVE_INFINITY) - (b.info.days ?? Number.POSITIVE_INFINITY)
      || String(a.task.id).localeCompare(String(b.task.id)))
    .map(({ task }) => task);
}

/** 按项目分组（组序：最早 due 在前，无 due 的最后；组内同样排序）。 */
export function groupTasksByProject(tasks: readonly BolbaApiTask[], now: Date): { project: string; tasks: BolbaApiTask[] }[] {
  const groups = new Map<string, BolbaApiTask[]>();
  for (const t of tasks) {
    const key = t.proj?.trim() || '未分项目';
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }
  const sortKey = (t: BolbaApiTask) => classifyBolbaDue(t.due, now).days ?? Number.POSITIVE_INFINITY;
  return [...groups.entries()]
    .map(([project, list]) => ({ project, tasks: [...list].sort((a, b) => sortKey(a) - sortKey(b)) }))
    .sort((a, b) => {
      const ka = a.tasks.length > 0 ? sortKey(a.tasks[0]) : Number.POSITIVE_INFINITY;
      const kb = b.tasks.length > 0 ? sortKey(b.tasks[0]) : Number.POSITIVE_INFINITY;
      return ka - kb || a.project.localeCompare(b.project);
    });
}

export type BolbaQuerySelection =
  | { mode: 'due' }
  | { mode: 'projects' }
  | { mode: 'project'; project: string };

/** 视图选择：命中已知项目名 → 项目过滤；说「按项目/各项目」→ 全项目视图；否则按截止。 */
export function pickBolbaQueryMode(text: string, projects: readonly string[]): BolbaQuerySelection {
  const lower = text.toLowerCase();
  const known = [...new Set(projects.filter((p) => p && p.trim()))].sort((a, b) => b.length - a.length);
  const hit = known.find((p) => lower.includes(p.toLowerCase()));
  if (hit) return { mode: 'project', project: hit };
  if (/所有项目|全部项目|按项目|各项目|项目(情况|进展|汇总)/.test(text)) return { mode: 'projects' };
  return { mode: 'due' };
}

export interface BolbaTaskMatch {
  kind: 'found' | 'ambiguous' | 'none';
  task?: BolbaApiTask;
  candidates?: BolbaApiTask[];
}

/**
 * 把「完成 X / 重开 X」的 X 解析成板上任务：
 * 纯数字（可带 #）→ id 精确；否则标题忽略大小写精确 → 包含（双向）；多命中 = 歧义（候选最多 3）。
 */
export function matchBolbaTaskReference(reference: string, tasks: readonly BolbaApiTask[]): BolbaTaskMatch {
  const ref = reference.trim();
  if (!ref) return { kind: 'none' };

  const pure = /^#?\s*(\d+)$/.exec(ref);
  if (pure) {
    const byId = tasks.find((t) => String(t.id) === pure[1]);
    return byId ? { kind: 'found', task: byId } : { kind: 'none' };
  }

  const lower = ref.toLowerCase();
  const exact = tasks.filter((t) => t.title.toLowerCase() === lower);
  if (exact.length === 1) return { kind: 'found', task: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact.slice(0, 3) };

  const contained = tasks.filter((t) => {
    const title = t.title.toLowerCase();
    return title.includes(lower) || lower.includes(title);
  });
  if (contained.length === 1) return { kind: 'found', task: contained[0] };
  if (contained.length > 1) return { kind: 'ambiguous', candidates: contained.slice(0, 3) };
  return { kind: 'none' };
}

/** 词面相似候选（409 防重时提示用户板上已有哪条；启发式、非关键路径）。 */
export function rankSimilarTasks(title: string, tasks: readonly BolbaApiTask[], limit = 3): BolbaApiTask[] {
  const tokens = (title.toLowerCase().match(/[a-z0-9]{2,}|[一-鿿]{2,}/g) ?? []).slice(0, 8);
  if (tokens.length === 0) return [];
  return tasks
    .map((task) => {
      const hay = `${task.title} ${task.proj ?? ''}`.toLowerCase();
      const score = tokens.reduce((acc, tok) => acc + (hay.includes(tok) ? 1 : 0), 0);
      return { task, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.task);
}

/** 用户是否明确要求「强建」（409 防重后的二次确认短语）。 */
export function wantsForceCreate(userText: string): boolean {
  return FORCE_CREATE_PHRASES.some((p) => userText.includes(p));
}

// ─── 渲染（口播文本，无 markdown） ───

function pendingOf(tasks: readonly BolbaApiTask[]): BolbaApiTask[] {
  return tasks.filter((t) => PENDING_STATUSES.has((t.status ?? '').toLowerCase()));
}

function earliestOf(tasks: readonly BolbaApiTask[], now: Date): BolbaApiTask | null {
  if (tasks.length === 0) return null;
  return [...tasks].sort((a, b) =>
    (classifyBolbaDue(a.due, now).days ?? Number.POSITIVE_INFINITY)
    - (classifyBolbaDue(b.due, now).days ?? Number.POSITIVE_INFINITY))[0];
}

/** 今日要盯视图：overdue/today/tomorrow 列表；无到期但有在办 → 提示最急一件。 */
export function renderDueReport(tasks: readonly BolbaApiTask[], now: Date, cap = 6): string {
  const pending = pendingOf(tasks);
  if (pending.length === 0) return '板上没有在办的活。';

  const due = selectDueSoonTasks(pending, now);
  if (due.length === 0) {
    const next = earliestOf(pending, now);
    const detail = next && next.due ? `，最急的是『${next.title}』（${dueLabel(next.due, now)}）` : '（都没标截止）';
    return `这两天没有到期的；板上还有 ${pending.length} 件在办${detail}。要看就说一声。`;
  }

  const lines = due.slice(0, cap).map((t, i) =>
    `${CIRCLED[i] ?? `${i + 1}.`}『${t.title}』${dueLabel(t.due, now)}${t.proj ? `（${t.proj}）` : ''}`);
  const tail = due.length > cap ? `还有 ${due.length - cap} 件，要看就说一声。` : '';
  return `今天要盯 ${due.length} 件：${lines.join('；')}。${tail}`;
}

/** 按项目视图：项目分组 + 每组最急一件。 */
export function renderProjectReport(tasks: readonly BolbaApiTask[], now: Date, cap = 6): string {
  const pending = pendingOf(tasks);
  if (pending.length === 0) return '板上没有在办的活。';

  const groups = groupTasksByProject(pending, now);
  const lines = groups.slice(0, cap).map((g, i) => {
    const earliest = earliestOf(g.tasks, now);
    const urgent = earliest && earliest.due ? `，最急：『${earliest.title}』${dueLabel(earliest.due, now)}` : '';
    return `${CIRCLED[i] ?? `${i + 1}.`}${g.project} ${g.tasks.length} 件在办${urgent}`;
  });
  const tail = groups.length > cap ? `；还有 ${groups.length - cap} 个项目` : '';
  return `按项目：${lines.join('；')}${tail}。`;
}

// ─── IO 薄适配（复用插件 bolbaRequest） ───

function toBolbaTask(value: unknown): BolbaApiTask | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const id = rec.id;
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  const title = typeof rec.title === 'string' && rec.title.trim()
    ? rec.title.trim()
    : typeof rec.head === 'string' && rec.head.trim()
      ? rec.head.trim()
      : '';
  if (!title) return null;
  return {
    ...rec,
    id,
    title,
    status: typeof rec.status === 'string' ? rec.status : undefined,
    proj: typeof rec.proj === 'string' ? rec.proj : typeof rec.project === 'string' ? rec.project : undefined,
    due: typeof rec.due === 'string' ? rec.due : undefined,
    reg: typeof rec.reg === 'string' ? rec.reg : undefined,
    created_at: typeof rec.created_at === 'string' ? rec.created_at : undefined,
    notes: typeof rec.notes === 'string' ? rec.notes : undefined,
    description: typeof rec.description === 'string' ? rec.description : undefined,
    type: typeof rec.type === 'string' ? rec.type : undefined,
    from_person: typeof rec.from_person === 'string' ? rec.from_person : undefined,
    priority: typeof rec.priority === 'string' ? rec.priority : undefined,
  };
}

function taskArray(payload: unknown): BolbaApiTask[] {
  const list = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).tasks
    : undefined;
  if (!Array.isArray(list)) throw new Error('Bolba Tasks returned an invalid task-list response');
  return list.map(toBolbaTask).filter((t): t is BolbaApiTask => t !== null);
}

/** 拉取在办任务（与插件同口径：/tasks 全量 → PENDING_STATUSES 过滤 → 截断）。 */
export async function fetchPendingBolbaTasks(): Promise<BolbaApiTask[]> {
  const payload = await bolbaRequest('/tasks');
  return taskArray(payload)
    .filter((t) => PENDING_STATUSES.has((t.status ?? '').toLowerCase()))
    .slice(0, MAX_BOLBA_TASKS);
}

/**
 * 拉取最近完成任务（reopen 专用候选源——「完成 X」后再「重开 X」是 reopen 主场景，
 * 只匹配在办会让撤销误完成永远找不到）。端点/过滤口径对齐插件基座 fetchPendingTasks：
 * /tasks?status=done&limit=N → COMPLETED_STATUSES 过滤 → 截断。
 */
export async function fetchRecentDoneBolbaTasks(): Promise<BolbaApiTask[]> {
  const payload = await bolbaRequest(`/tasks?status=done&limit=${RECENT_DONE_LIMIT}`);
  return taskArray(payload)
    .filter((t) => COMPLETED_STATUSES.has((t.status ?? '').toLowerCase()))
    .slice(0, RECENT_DONE_LIMIT);
}

export interface BolbaQueryOutcome extends BolbaOutcome {
  mode?: BolbaQuerySelection['mode'];
}

/** 只读视图（今日/按项目/按截止）；失败 → 确定性降级话术（不抛）。 */
export async function queryBolbaTasksView(input: {
  userText: string;
  now: Date;
  /** 测试注入用；省略则真实拉取。 */
  tasks?: readonly BolbaApiTask[];
}): Promise<BolbaQueryOutcome> {
  let tasks: readonly BolbaApiTask[];
  if (input.tasks) {
    tasks = input.tasks;
  } else {
    try {
      tasks = await fetchPendingBolbaTasks();
    } catch (err) {
      logBolbaSync({ op: 'query', ok: false, error: errMessage(err) });
      return { response: BOLBA_DEGRADED_REPLY, degraded: true };
    }
  }

  const selection = pickBolbaQueryMode(
    input.userText,
    tasks.map((t) => t.proj ?? '').filter((p) => p.length > 0),
  );
  const response = selection.mode === 'project'
    ? renderProjectReport(tasks.filter((t) => (t.proj ?? '') === selection.project), input.now)
    : selection.mode === 'projects'
      ? renderProjectReport(tasks, input.now)
      : renderDueReport(tasks, input.now);
  logBolbaSync({ op: 'query', ok: true, mode: selection.mode, count: tasks.length });
  return { response, degraded: false, mode: selection.mode };
}

/** 语音创建任务（POST /tasks；409 防重不强建，二次确认后 ?force=true 重试）。 */
export async function createBolbaTaskFromVoice(input: {
  userText: string;
  contract?: { bolbaTask?: string; query?: string };
  now: Date;
}): Promise<BolbaOutcome> {
  const rawTitle = cleanTitle(input.contract?.bolbaTask ?? '') || cleanTitle(input.userText);
  const title = cleanTitle(stripDuePhrases(rawTitle)) || rawTitle;
  const due = parseSpokenDue(input.userText, input.now) ?? parseSpokenDue(rawTitle, input.now);
  const body: Record<string, unknown> = { title, ...(due ? { due } : {}) };
  const force = wantsForceCreate(input.userText);

  try {
    const payload = await bolbaRequest(force ? '/tasks?force=true' : '/tasks', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const rec = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
    const created = toBolbaTask(rec.task ?? payload);
    const idText = created ? `，编号 ${created.id}` : '';
    const dueText = due ? `，截止 ${speakableDue(due, input.now)}` : '';
    logBolbaSync({ op: 'create', ok: true, title, count: 1 });
    return { response: `记下了：『${title}』${dueText}${idText}。`, degraded: false };
  } catch (err) {
    const msg = errMessage(err);
    if (!force && msg.includes('(409)')) {
      // 防重保护：不强建；提示板上已有哪条（词面相似），用户确认真要新开才 force。
      let similar: BolbaApiTask[] = [];
      try {
        similar = rankSimilarTasks(title, await fetchPendingBolbaTasks());
      } catch {
        similar = [];
      }
      logBolbaSync({ op: 'create', ok: false, title, error: '409 duplicate' });
      const list = similar.length > 0
        ? `板上已有很像的：${similar.map((t) => `『${t.title}』`).join('、')}。`
        : '板上可能已有重复任务。';
      return { response: `${list}我先没有重复建；确实要新开一条就说「强制记一条」。`, degraded: false };
    }
    logBolbaSync({ op: 'create', ok: false, title, error: msg });
    return { response: BOLBA_DEGRADED_REPLY, degraded: true };
  }
}

async function actOnBolbaTask(
  op: 'complete' | 'reopen',
  reference: string,
): Promise<BolbaOutcome> {
  let tasks: BolbaApiTask[];
  try {
    if (op === 'reopen') {
      // reopen 候选 = 在办 ∪ 最近完成（撤销误完成是主场景；只匹配在办会让
      // 「完成 X」后再「重开 X」永远回「没找到」）。
      // 两路与插件 fetchPendingTasks 同口径一并成功/失败：坏一路即降级，
      // 不谎报「没找到」（在办与完成候选同现时由 match 的歧义守卫兜住）。
      const [pending, done] = await Promise.all([fetchPendingBolbaTasks(), fetchRecentDoneBolbaTasks()]);
      tasks = [...pending, ...done];
    } else {
      // complete 仍只看在办：不把已完成条目当候选（防回退误改已完成的活）。
      tasks = await fetchPendingBolbaTasks();
    }
  } catch (err) {
    logBolbaSync({ op, ok: false, error: errMessage(err) });
    return { response: BOLBA_DEGRADED_REPLY, degraded: true };
  }

  const ref = reference.trim();
  const match = matchBolbaTaskReference(ref, tasks);
  if (match.kind === 'none') {
    logBolbaSync({ op, ok: false, error: 'not-found' });
    return { response: `板上没找到「${ref || '这个'}」，你再说细一点？`, degraded: false };
  }
  if (match.kind === 'ambiguous') {
    logBolbaSync({ op, ok: false, error: 'ambiguous' });
    const list = (match.candidates ?? []).map((t) => `『${t.title}』`).join('、');
    return { response: `「${ref}」对应好几条：${list}。你说是哪条？`, degraded: false };
  }

  const task = match.task as BolbaApiTask;
  try {
    const id = encodeURIComponent(String(task.id));
    if (op === 'complete') {
      // 与插件 close 同端点/同状态语义（status:'done'）
      await bolbaRequest(`/tasks/${id}/close`, { method: 'POST', body: JSON.stringify({ status: 'done' }) });
    } else {
      await bolbaRequest(`/tasks/${id}/reopen`, { method: 'POST' });
    }
    logBolbaSync({ op, ok: true, taskId: task.id, title: task.title });
    return {
      response: op === 'complete' ? `好，『${task.title}』标记完成了。` : `好，『${task.title}』重开了。`,
      degraded: false,
    };
  } catch (err) {
    logBolbaSync({ op, ok: false, taskId: task.id, title: task.title, error: errMessage(err) });
    return { response: BOLBA_DEGRADED_REPLY, degraded: true };
  }
}

/** 标记完成（POST /tasks/:id/close {status:'done'}）。 */
export async function completeBolbaTaskFromVoice(input: { reference: string; now: Date }): Promise<BolbaOutcome> {
  return actOnBolbaTask('complete', input.reference);
}

/** 重开（POST /tasks/:id/reopen；候选含最近完成列表）。 */
export async function reopenBolbaTaskFromVoice(input: { reference: string; now: Date }): Promise<BolbaOutcome> {
  return actOnBolbaTask('reopen', input.reference);
}

/** 契约动作统一入口：四动作分发；任何异常都不上抛（兜底确定性降级话术）。 */
export async function handleBolbaContractAction(input: BolbaContractInput): Promise<BolbaOutcome> {
  try {
    const reference = (input.contract.bolbaTask || input.contract.query || input.userText).trim();
    switch (input.action) {
      case 'query_bolba_tasks':
        return await queryBolbaTasksView({
          userText: `${input.contract.query ?? ''} ${input.userText}`.trim(),
          now: input.now,
        });
      case 'create_bolba_task':
        return await createBolbaTaskFromVoice({ userText: input.userText, contract: input.contract, now: input.now });
      case 'complete_bolba_task':
        return await completeBolbaTaskFromVoice({ reference, now: input.now });
      case 'reopen_bolba_task':
        return await reopenBolbaTaskFromVoice({ reference, now: input.now });
      default:
        return { response: BOLBA_DEGRADED_REPLY, degraded: true };
    }
  } catch (err) {
    logBolbaSync({ op: 'query', ok: false, error: errMessage(err) });
    return { response: BOLBA_DEGRADED_REPLY, degraded: true };
  }
}

// ─── 🟡⑩ system_log 埋点（口径：category='system' + source='bolba' + body.cat='bolba-sync'） ───

export const BOLBA_SYNC_SOURCE = 'bolba';

export type BolbaSyncOp = 'query' | 'create' | 'complete' | 'reopen' | 'scan' | 'due-reminder';

export interface BolbaSyncFields {
  op: BolbaSyncOp;
  ok: boolean;
  mode?: string;
  taskId?: string | number;
  title?: string;
  count?: number;
  tier?: string;
  reason?: string;
  error?: string;
}

/** Bolba 读写事件登记（append-only；logEvent 自身静默降级，绝不影响主链路）。 */
export function logBolbaSync(fields: BolbaSyncFields): void {
  logEvent('system', {
    source: BOLBA_SYNC_SOURCE,
    level: fields.ok ? undefined : 'warn',
    body: {
      cat: 'bolba-sync',
      op: fields.op,
      ok: fields.ok,
      mode: fields.mode,
      taskId: fields.taskId,
      title: fields.title ? fields.title.slice(0, 80) : undefined,
      count: fields.count,
      tier: fields.tier,
      reason: fields.reason,
      error: fields.error,
    },
  });
}
