/**
 * 任务12·⑨ Boss 晨会（团队产出数据源）
 *
 * 职责：每日早晨扫一次 Boss 委派病历（任务11 落盘 delegation-history.json 的
 * DelegationDecision.completion）→ 汇总「昨日」完成项（按项目分段）为一条晨报
 * 信号（source='memory'，见 06-11 §5「记忆信号」与 §6.1「次日晨报草稿」）→
 * 过 09·A 四闸门（jarvis-core SignalQueue）→ 按决策四档投递（deliverDecision）。
 *
 * 投递通道（如实分级，不造假通道；与任务13 同款）：
 *   - SPEAK  → 复用 vcs 现有回合出口 logProactiveBroadcast（dialog out + broadcast
 *     server-sent，落 system_log；action = BOSS_MORNING_REPORT_ACTION 可筛）；
 *   - notice → 同上通道 + degraded 标记（口播出口缺失/抛错时的降级）；
 *   - PREPARE → 留在队列 prepared 缓冲（自然开口点 flush 未接，与任务13 同缺口）；
 *   - STORE → 只登记 system_log，不写 broadcast 假装已上屏（服务端无上屏消费者）。
 *
 * 任务29（晨报与 13 排序去重）：
 *   - 「今日待办」due 段扩为 union：委派卡 due ∪ Bolba 到期（复用 13 的
 *     selectDueSoonTasks/classifyBolbaDue/renderDueReport，同 horizon）；
 *   - 并入前查当日 broadcast 日志：已有 bolba_due_reminder 独播（13 先跑）→ 不并入（防双播）；
 *   - 并入且真的播出去后写覆盖账（morning-coverage-store），13 读账后跳过独播
 *     （对称防双播，与两服务触发顺序无关）；
 *   - 反射草稿/主动发现第三来源 = 阻塞登记，本任务不实现（触发条件 = 任务28 LLM 通道接通）。
 *
 * 边界与已知缺口（登记备查 2026-10-04）：
 *   - 病历只读（loadDelegationHistory），不写任何 Boss/委派数据（两本账不混）；
 *   - 队列无持久化：服务重启丢失预算计数/幂等键，同日可能重复播报一次（与客户端同口径）；
 *   - 跨日预算重置：SignalQueue 明示由接线层负责，本模块 rolloverGatesStateForNewDay 落地；
 *   - 晨报可关闭 = TC_JARVIS_MORNING_REPORT（最小形态，缺省开），正式配置 UI 后续；
 *   - 与任务13 到期提醒同为 08:00、各自独立 SignalQueue（预算不共享）——观察项待 ⑭/补册29。
 *
 * 调度入口：cron-service.startBossMorningReportJob()（每日 08:00 本地时区，懒加载本模块）。
 */

import {
  SignalQueue,
  deliverDecision,
  type ConsumedSignal,
  type DeliveryPorts,
  type RawSignal,
} from '../jarvis-core/index.js';
import type {
  BroadcastDecision,
  BroadcastReason,
  BroadcastTier,
  GatesState,
  Signal,
} from '../../shared/broadcast-gates.js';
import type { DelegationCompletion, DelegationDecision } from '../../shared/types.js';
import { loadDelegationHistory } from '../data/index.js';
import { logEvent, querySystemLog, type SystemLogEntry, type SystemLogQuery } from '../data/system-log.js';
import { truncateOrEmpty } from '../utils/index.js';
import { logProactiveBroadcast } from './voice-companion-service.js';
// 任务29：Bolba 到期并入（复用 13 的数据源与渲染，不碰 Bolba 账）
import {
  fetchPendingBolbaTasks,
  renderDueReport,
  selectDueSoonTasks,
  type BolbaApiTask,
} from './bolba-bridge-service.js';
import { BOLBA_DUE_REMINDER_ACTION } from './bolba-due-reminder-service.js';
import { getMorningCoverageStore, type MorningCoverageStore } from './morning-coverage-store.js';
// 任务19·A·⑮ P2：日报进 ⑨ 晨报聚合的只读数据源（缺文件静默跳过；只读，不写日报账）
import { readLatestDailyReport, type DailyReportDigest } from './daily-log-report-service.js';

// ─── 常量 ───

/** ⑨ 晨报动作标识（写进主动播报的 action 字段，便于 ⑭ 观测筛选）。 */
export const BOSS_MORNING_REPORT_ACTION = 'boss_morning_report';
/** 🟡⑨ 埋点来源标识（category='system' + source + body.cat='boss-morning-report'；不改任何枚举）。 */
export const MORNING_REPORT_LOG_SOURCE = 'boss-morning-report';
/** 目标/摘要/产出位置单字段展示上限（§7.2 播报从简；截断加省略号，不硬造内容）。 */
const GOAL_MAX = 60;
const DETAIL_MAX = 80;
/** 日报聚合从句的摘要上限（日报摘要自身已 ≤200，此处再收口进晨报三句预算）。 */
const DAILY_DIGEST_MAX = 160;
/** 无项目归属的分段标签。 */
const NO_PROJECT_LABEL = '未归项目';
/** 「今日待办」纳入的在办卡状态（任务17·A2）：done/cancelled 一律排除。 */
const OPEN_TASK_CARD_STATUSES: ReadonlySet<string> = new Set(['pending', 'queued', 'running']);
/** due 为 date-only 'YYYY-MM-DD'（与 TaskCard.due 契约同形）；形状不符按「无 due」跳过，不猜测。 */
const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 任务29：Bolba 到期并入视野（与 13·⑩ DUE_HORIZON_DAYS 同值 1；有意本地复制——只引 13 的动作常量 BOLBA_DUE_REMINDER_ACTION 作查重判据，不引其余）。 */
const BOLBA_DUE_HORIZON_DAYS = 1;
/** 任务29：当日 broadcast 日志查询上限（08:00 前当日播报量很小；超限宁可漏判，也不拖慢晨报）。 */
const BROADCAST_LOOKBACK_LIMIT = 500;

// ─── 时间与文本工具 ───

function formatDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

/** 本地日历日的 00:00（epoch ms；跨 DST 由 Date 构造器自行归一，不做固定 24h 运算）。 */
function dayStartMillis(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 产出从句：有 outputLocation → 「（产出在 Z）」；缺省用 summary 摘要代替；
 * 两者皆无 → 如实省去（不硬造产出位置）。
 */
function outputClause(completion: DelegationCompletion): string {
  const location = completion.outputLocation?.trim();
  if (location) return `（产出在 ${truncateOrEmpty(location, DETAIL_MAX)}）`;
  const summary = completion.summary?.trim();
  if (summary) return `（${truncateOrEmpty(summary, DETAIL_MAX)}）`;
  return '';
}

/** 单条病历 → 「甲 完成「Y」（产出在 Z）」；failed 如实说「未完成」。 */
function renderItem(record: DelegationDecision, completion: DelegationCompletion): string {
  const actor = record.selectedAgentName?.trim() || '未署名执行者';
  const goal = record.taskCard?.objective?.trim() || record.userCommand?.trim() || '未记录内容';
  const verb = completion.result === 'failed' ? '未完成' : '完成';
  return `${actor} ${verb}「${truncateOrEmpty(goal, GOAL_MAX)}」${outputClause(completion)}`;
}

/**
 * 单张到期待办卡 → 「甲 在办「Y」（今日到期|已逾期 D）」。
 * 仅承载 due ≤ 今日的在办卡（任务17·A2）；逾期与否按 date-only 字符串比较如实标注。
 */
function renderDueItem(record: DelegationDecision, due: string, todayStr: string): string {
  const actor = record.selectedAgentName?.trim() || '未署名执行者';
  const goal = record.taskCard?.objective?.trim() || record.userCommand?.trim() || '未记录内容';
  const dueNote = due < todayStr ? `已逾期 ${due}` : '今日到期';
  return `${actor} 在办「${truncateOrEmpty(goal, GOAL_MAX)}」（${dueNote}）`;
}

// ─── 当日广播日志查询（任务29：与 13 的防双播判据） ───

/**
 * 当日本地日历日（00:00 ≤ ts < 次日 00:00）内是否已有 bolba_due_reminder 的
 * server-sent 播报（13·⑩ 先跑过）。命中 → 晨报不并入 Bolba 到期（13 已独播，防双播）。
 * body 是落库 JSON 串，需自行 parse；**查询抛错返回 true**（保守——方向选防双播）。
 * 已知残留（独立验证 Low）：抛错恰逢 13 侧当日也静默（预算 STORE / 其 fetch 失败）时，
 * 该日可能无人播 Bolba；触发前提是 EventDB 故障（此时写日志同样失败，非新增回归）。
 */
export function hasBolbaDueBroadcastToday(
  now: Date,
  query: (opts: SystemLogQuery) => readonly SystemLogEntry[] = querySystemLog,
): boolean {
  try {
    // 次日 00:00 不含（跨 DST 由 Date 构造器归一，不做固定 24h 运算）
    const nextDayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const rows = query({
      category: 'broadcast',
      since: dayStartMillis(now),
      until: nextDayStart - 1,
      limit: BROADCAST_LOOKBACK_LIMIT,
    });
    return rows.some((row) => {
      if (!row.body) return false;
      try {
        const body = JSON.parse(row.body) as { action?: unknown; phase?: unknown };
        return body.action === BOLBA_DUE_REMINDER_ACTION && body.phase === 'server-sent';
      } catch {
        return false; // body 非 JSON（纯字符串正文）→ 不是目标播报
      }
    });
  } catch {
    return true;
  }
}

// ─── 信号构造（纯函数） ───

/**
 * 任务29：Bolba 到期并入输入（IO 由扫描层准备——builder 保持纯函数，可单测）。
 * `alreadyBroadcast` = 当日已有 bolba_due_reminder 独播（见 hasBolbaDueBroadcastToday）。
 */
export interface MorningReportBolbaInput {
  /** 已拉取的 Bolba 在办任务（拉取失败 → 传空数组，等同不并入）。 */
  tasks: readonly BolbaApiTask[];
  /** true = 13 已独播 → 整体不并入（防双播，与触发顺序无关）。 */
  alreadyBroadcast: boolean;
}

/**
 * 晨报信号（一天一条聚合：dedupeKey 按扫描日 → 同日重复扫描走幂等 SILENT）。
 *
 * 昨窗口径（本地日历日）：昨天 00:00 ≤ completedAt < 今天 00:00——昨天 00:00 含、
 * 今天 00:00 不含；无 completion 的旧记录（任务11 前的历史）一律按「无完成事件」排除。
 * 昨日无可报项 → null（与任务13 no-due 同构，不空发信号）。
 *
 * 多项目分段：按 taskCard?.projectId 分组（无项目归「未归项目」组），组内按完成时刻
 * 升序，文本形如「昨日要点：项目A：甲 完成「Y」（产出在 Z）；项目B：…。」——承载
 * 晨报三句预算（06-11 §6.4：昨日要点 + 今日待办 + 主动发现）中的「昨日要点」第一句。
 *
 * 任务17·A2「今日待办」第二句：due ≤ 今日的在办卡（taskCard.status ∈ pending/queued/
 * running；done/cancelled 排除）按 projectId 沿用同款分段口径聚合成 dueClause，形如
 * 「今日待办：项目A：甲 在办「Y」（今日到期），乙 在办「Z」（已逾期 2026-10-01）。」。
 * due 为 date-only 'YYYY-MM-DD'，按本地日历日字符串比较（今日含、明日不含、逾期含）；
 * 形状不符的 due 按「无 due」跳过（不猜测、不硬造）。仅有到期卡（无昨日产出/无日报）
 * 时同样成信号——「今日待办」本身就是晨报要报的东西。
 *
 * 评分理由（自定，保守取值，非实测最优）：urgency 65 / relevance 85 / certainty 95
 * → 加权 77（0.5·65+0.3·85+0.2·95）< 85，刻意不走 urgent——晨报是定点自然开口点，
 * 急迫性低，不必抢占紧急高分位；用 timeSensitive 表达「晨间定点」时效，过闸门④
 * 以 'time_sensitive' 走 SPEAK，但仍受闸门②③（深夜/打扰/预算/口播子配额）约束。
 *
 * 任务29：`bolba` = Bolba 到期并入（13·⑩ 同源数据；due ≤ 明日，与 13 同 horizon）。
 * 13 当日已独播（alreadyBroadcast）→ 整体不并入；否则渲染成独立一句
 * 「板上待办：今天要盯 N 件：…。」接在「今日待办」之后、日报之前。并入条数与
 * bolbaTaskIds 落 payload，投递成功后由扫描层写覆盖账（13 读账跳过，对称防双播）。
 * 纯函数：拉取/查询/写账都在扫描层，本函数只做筛选、渲染与判定。
 */
export function buildMorningReportSignal(
  records: readonly DelegationDecision[],
  now: Date,
  dailyReport?: DailyReportDigest | null,
  bolba?: MorningReportBolbaInput | null,
): RawSignal | null {
  const todayStart = dayStartMillis(now);
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();

  const yesterday = records
    .filter(
      (r): r is DelegationDecision & { completion: DelegationCompletion } =>
        !!r.completion && r.completion.completedAt >= yesterdayStart && r.completion.completedAt < todayStart,
    )
    .sort((a, b) => a.completion.completedAt - b.completion.completedAt);

  // 任务19·A·⑮ P2：日报聚合从句（只读 digest；无日报/摘要为空则完全保持原文本形态）。
  const digest = dailyReport && dailyReport.summary.trim() ? dailyReport : null;
  const digestClause = digest
    ? `日志分析：${truncateOrEmpty(digest.summary.trim(), DAILY_DIGEST_MAX)}。`
    : '';

  // ─── 任务17·A2「今日待办」：due ≤ 今日的在办卡（按 projectId 同款分段） ───
  const todayStr = formatDay(now.getTime());
  const dueCards = records
    .flatMap((record) => {
      const card = record.taskCard;
      if (!card || !OPEN_TASK_CARD_STATUSES.has(card.status)) return [];
      const due = card.due?.trim();
      if (!due || !DUE_DATE_RE.test(due) || due > todayStr) return [];
      return [{ record, due }];
    })
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));

  interface DueSegment {
    label: string;
    projectId: string | null;
    items: string[];
  }
  const dueSegments = new Map<string, DueSegment>();
  for (const { record, due } of dueCards) {
    const projectId = record.taskCard?.projectId?.trim() || null;
    const key = projectId ?? '';
    let segment = dueSegments.get(key);
    if (!segment) {
      segment = { label: projectId ? `项目${projectId}` : NO_PROJECT_LABEL, projectId, items: [] };
      dueSegments.set(key, segment);
    }
    segment.items.push(renderDueItem(record, due, todayStr));
  }
  const dueOrdered = [...dueSegments.values()];
  const dueClause = dueCards.length > 0
    ? `今日待办：${dueOrdered.map((s) => `${s.label}：${s.items.join('，')}`).join('；')}。`
    : '';

  // ─── 任务29：Bolba 到期并入（「今日待办」第二来源；13 已独播则整体不并入） ───
  const bolbaDue = bolba && !bolba.alreadyBroadcast
    ? selectDueSoonTasks(bolba.tasks, now, BOLBA_DUE_HORIZON_DAYS)
    : [];
  const bolbaClause = bolbaDue.length > 0 ? `板上待办：${renderDueReport(bolbaDue, now)}` : '';

  // 昨日无产出且无日报且无到期待办（委派卡与 Bolba 都无）→ null（不空发）；任一句在即成信号。
  if (yesterday.length === 0 && !digestClause && !dueClause && !bolbaClause) return null;

  interface Segment {
    label: string;
    projectId: string | null;
    items: string[];
  }
  const segments = new Map<string, Segment>();
  for (const record of yesterday) {
    const projectId = record.taskCard?.projectId?.trim() || null;
    const key = projectId ?? '';
    let segment = segments.get(key);
    if (!segment) {
      segment = { label: projectId ? `项目${projectId}` : NO_PROJECT_LABEL, projectId, items: [] };
      segments.set(key, segment);
    }
    segment.items.push(renderItem(record, record.completion));
  }

  const ordered = [...segments.values()];
  const yesterdayClause = yesterday.length > 0
    ? `昨日要点：${ordered.map((s) => `${s.label}：${s.items.join('，')}`).join('；')}。`
    : '';
  const text = `${yesterdayClause}${dueClause}${bolbaClause}${digestClause}`;

  return {
    source: 'memory',
    kind: 'boss_morning_report',
    ts: now.getTime(),
    dedupeKey: `morning-report:${formatDay(now.getTime())}`,
    text,
    payload: {
      count: yesterday.length,
      segments: ordered.length,
      completed: yesterday.filter((r) => r.completion.result === 'completed').length,
      failed: yesterday.filter((r) => r.completion.result === 'failed').length,
      projects: ordered.map((s) => s.projectId),
      /** 任务17·A2：due ≤ 今日的在办卡数（done/cancelled 与无 due/形状不符者不计）。 */
      dueCount: dueCards.length,
      dueProjects: dueOrdered.map((s) => s.projectId),
      /** 任务29：并入播报的 Bolba 到期条数（13 已独播/无到期 → 0）。 */
      bolbaDueCount: bolbaDue.length,
      /** 任务29：并入的 Bolba 任务 id（覆盖账写入源；13 读账去重用）。 */
      bolbaTaskIds: bolbaDue.map((t) => t.id),
      ...(digest
        ? {
            dailyReport: {
              file: digest.file,
              dateLabel: digest.dateLabel,
              generatedAt: digest.generatedAt,
            },
          }
        : {}),
    },
    urgency: 65,
    relevance: 85,
    certainty: 95,
    timeSensitive: true,
  };
}

// ─── 跨日重置（SignalQueue 明示的接线层职责） ───

/**
 * 日历日翻转时归零当日预算计数与自适应统计；同一天原样返回。
 * seenKeys 保留（dedupeKey 的 TTL 裁剪由队列自行负责），env/config 保留。
 * 与任务13 rolloverGatesStateForNewDay 同构（有意本地复制：本模块只需这一个纯函数，
 * 避免为 8 行逻辑引入 bolba-bridge 整条依赖链；13 侧实现保持不动）。
 */
export function rolloverGatesStateForNewDay(state: GatesState, now: Date): GatesState {
  if (formatDay(state.now) === formatDay(now.getTime())) return state;
  return {
    ...state,
    now: now.getTime(),
    spokenToday: 0,
    instantSpeakToday: 0,
    stats: { broadcasts: 0, ignored: 0, adopted: 0 },
  };
}

// ─── 开关（06-11 §6.4「晨报永远可关闭」；最小形态，正式配置 UI 后续） ───

/**
 * 晨报开关：TC_JARVIS_MORNING_REPORT，缺省开；'0' / 'off' / 'false'（忽略大小写与空白）关。
 * 在扫描入口读取（测试用 vi.stubEnv 注入；不改 server/index.ts、不做设置 UI）。
 */
export function isMorningReportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TC_JARVIS_MORNING_REPORT?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'off' || raw === 'false');
}

// ─── 队列单例（无持久化；重启即新的一天起点） ───

let morningReportQueue: SignalQueue | null = null;

/** 测试专用：丢弃进程内队列单例。 */
export function resetBossMorningReportStateForTests(): void {
  morningReportQueue = null;
}

// ─── 🟡⑨ 埋点（category='system' + source/body.cat 本模块自有；不改任何枚举/不改别人文件） ───

interface MorningReportLogFields {
  op: 'scan' | 'generate' | 'deliver';
  ok: boolean;
  /** 生成/投递时刻（信号 ts；生成观测用）。 */
  at?: number;
  /** 病历展平记录总数（scan）。 */
  count?: number;
  /** 昨日命中条数（scan / deliver）。 */
  yesterday?: number;
  /** 项目分段数（generate / deliver）。 */
  segments?: number;
  dedupeKey?: string;
  tier?: BroadcastTier;
  reason?: BroadcastReason | 'disabled' | 'no-yesterday';
  /** 任务19·A·⑮ P2：本条晨报是否聚合了日报（generate）。 */
  dailyReport?: boolean;
  /** 任务29：并入播报的 Bolba 到期条数（generate；已独播跳过/无到期 → 0）。 */
  bolbaDue?: number;
  error?: string;
}

/** 晨会生成与投递事件登记（append-only；logEvent 自身静默降级，绝不影响主链路）。 */
function logMorningReport(fields: MorningReportLogFields): void {
  logEvent('system', {
    source: MORNING_REPORT_LOG_SOURCE,
    level: fields.ok ? undefined : 'warn',
    body: {
      cat: 'boss-morning-report',
      op: fields.op,
      ok: fields.ok,
      at: fields.at,
      count: fields.count,
      yesterday: fields.yesterday,
      segments: fields.segments,
      dedupeKey: fields.dedupeKey,
      tier: fields.tier,
      reason: fields.reason,
      dailyReport: fields.dailyReport,
      bolbaDue: fields.bolbaDue,
      error: fields.error,
    },
  });
}

// ─── 投递端口（复用 vcs 通道；STORE 不假装上屏） ───

function payloadOf(signal: { payload?: unknown }): { count?: number; segments?: number } {
  return (signal.payload ?? {}) as { count?: number; segments?: number };
}

/** 四档投递端口：SPEAK/notice 走 logProactiveBroadcast；PREPARE/STORE 只登记 system_log。 */
export function createMorningReportPorts(): DeliveryPorts {
  const logOutcome = (decision: BroadcastDecision, signal: Signal, ok: boolean, error?: string): void => {
    const payload = payloadOf(signal);
    logMorningReport({
      op: 'deliver',
      ok,
      at: signal.ts,
      yesterday: payload.count,
      segments: payload.segments,
      dedupeKey: signal.dedupeKey,
      tier: decision.tier,
      reason: decision.reason,
      ...(error ? { error } : {}),
    });
  };

  return {
    speak: (signal, decision) => {
      logProactiveBroadcast({ text: signal.text ?? '', action: BOSS_MORNING_REPORT_ACTION });
      logOutcome(decision, signal, true);
    },
    notice: (signal, decision, reason) => {
      // 口播出口缺失/抛错的降级路径：仍走现有通道，但如实打降级标记。
      logProactiveBroadcast({ text: signal.text ?? '', action: BOSS_MORNING_REPORT_ACTION, degraded: true });
      logOutcome(decision, signal, false, `degraded:${reason}`);
    },
    prepare: (signal, decision) => {
      // 攒批留在 queue.prepared（flush 点未接，见文件头缺口登记）；此处仅登记。
      logOutcome(decision, signal, true);
    },
    store: (signal, decision) => {
      // STORE 档：服务端无上屏消费者，只登记 system_log，不广播。
      logOutcome(decision, signal, true);
    },
  };
}

// ─── 扫描主流程 ───

export interface BossMorningReportScanDeps {
  /** 病历读取（测试注入；缺省 loadDelegationHistory 直接读盘）。 */
  loadHistory?: () => Map<string, DelegationDecision[]>;
  /** 时刻注入（测试用；缺省进程时钟——调度层触发时用真实时间）。 */
  now?: () => Date;
  /** 队列注入（测试用；缺省进程内单例）。 */
  queue?: SignalQueue;
  /** 端口覆盖（测试用）。 */
  ports?: DeliveryPorts;
  /** 投递覆盖（测试用：观察 ConsumedSignal，不真投递；不写覆盖账）。 */
  deliver?: (consumed: ConsumedSignal) => void | Promise<void>;
  /** 日报摘要读取覆盖（测试用）；缺省 readLatestDailyReport（缺文件返回 null）。 */
  readDailyReport?: () => DailyReportDigest | null;
  /** 任务29：Bolba 在办任务拉取覆盖（测试用）；缺省 fetchPendingBolbaTasks；抛错静默跳过不并入。 */
  fetchBolbaTasks?: () => Promise<readonly BolbaApiTask[]>;
  /** 任务29：当日是否已有 bolba_due_reminder 独播（测试用）；缺省 hasBolbaDueBroadcastToday。 */
  hasBolbaBroadcastToday?: (now: Date) => boolean;
  /** 任务29：覆盖账（测试注入临时文件）；缺省进程单例（XDG 数据目录）。 */
  coverageStore?: MorningCoverageStore;
}

export interface BossMorningReportScanResult {
  /** 扫过的 boss 数（病历 Map 的 key 数）。 */
  bosses: number;
  /** 展平的病历记录总数。 */
  scanned: number;
  /** 落入「昨日」窗口并写进晨报的条数。 */
  yesterday: number;
  /** 项目分段数。 */
  segments: number;
  decisions: { tier: BroadcastTier; reason: BroadcastReason }[];
  /** 是否走兜底降级（读盘/投递异常）；开关关闭不算降级。 */
  degraded: boolean;
  /** 命中 TC_JARVIS_MORNING_REPORT 关闭开关 → 未扫描未投递。 */
  disabled?: boolean;
  /** 任务19·A·⑮ P2：本次晨报信号是否聚合了每日日志分析日报。 */
  dailyReportIncluded: boolean;
  /** 任务29：并入播报的 Bolba 到期条数（0 = 无到期/13 已独播跳过/拉取失败）。 */
  bolbaDue: number;
  /** 任务29：本次是否写入覆盖账（并入且真的播出才写）。 */
  coverageRecorded: boolean;
}

/**
 * 扫一次晨报：读病历 → 组信号 → 过闸门 → 投递。任何异常都不上抛（调度层安全）。
 */
export async function runBossMorningReportScan(
  deps: BossMorningReportScanDeps = {},
): Promise<BossMorningReportScanResult> {
  const now = (deps.now ?? (() => new Date()))();
  const empty = {
    bosses: 0,
    scanned: 0,
    yesterday: 0,
    segments: 0,
    decisions: [],
    degraded: false,
    dailyReportIncluded: false,
    bolbaDue: 0,
    coverageRecorded: false,
  };

  // 关闭开关在扫描入口读：关 = 不读盘、不投递（06-11 §6.4）。
  if (!isMorningReportEnabled()) {
    logMorningReport({ op: 'scan', ok: true, reason: 'disabled' });
    return { ...empty, disabled: true };
  }

  const loadHistory = deps.loadHistory ?? loadDelegationHistory;
  let histories: Map<string, DelegationDecision[]>;
  try {
    histories = loadHistory();
  } catch (err) {
    logMorningReport({ op: 'scan', ok: false, error: errMessage(err) });
    return { ...empty, degraded: true };
  }

  // 任务19·A·⑮ P2：日报聚合只读源 —— 读最新一期日报摘要（缺文件/读取异常静默跳过，
  // 绝不因日报缺失打断晨报；日报账与委派账两本账不混）。
  let dailyReport: DailyReportDigest | null = null;
  try {
    dailyReport = (deps.readDailyReport ?? readLatestDailyReport)();
  } catch {
    dailyReport = null;
  }

  // 任务29：Bolba 到期并入 —— 只在真有到期任务时才查当日广播日志（先查后并，
  // 避免无谓读账）；拉取/查询异常一律静默跳过（绝不打断晨报）。
  let bolbaInput: MorningReportBolbaInput | null = null;
  try {
    const bolbaTasks = await (deps.fetchBolbaTasks ?? fetchPendingBolbaTasks)();
    if (selectDueSoonTasks(bolbaTasks, now, BOLBA_DUE_HORIZON_DAYS).length > 0) {
      const alreadyBroadcast = (deps.hasBolbaBroadcastToday ?? hasBolbaDueBroadcastToday)(now);
      bolbaInput = { tasks: bolbaTasks, alreadyBroadcast };
    }
  } catch {
    bolbaInput = null;
  }

  const records = [...histories.values()].flat();
  const signal = buildMorningReportSignal(records, now, dailyReport, bolbaInput);
  if (!signal) {
    logMorningReport({ op: 'scan', ok: true, count: records.length, reason: 'no-yesterday' });
    return { ...empty, bosses: histories.size, scanned: records.length };
  }

  const payload = payloadOf(signal);
  const dailyReportIncluded = !!((signal.payload ?? {}) as { dailyReport?: unknown }).dailyReport;
  const bolbaTaskIds = ((signal.payload ?? {}) as { bolbaTaskIds?: (string | number)[] }).bolbaTaskIds ?? [];
  logMorningReport({ op: 'scan', ok: true, count: records.length, yesterday: payload.count });
  logMorningReport({
    op: 'generate',
    ok: true,
    at: signal.ts,
    yesterday: payload.count,
    segments: payload.segments,
    dedupeKey: signal.dedupeKey,
    dailyReport: dailyReportIncluded,
    bolbaDue: bolbaTaskIds.length,
  });

  const decisions: { tier: BroadcastTier; reason: BroadcastReason }[] = [];
  let spoken = false;
  try {
    const queue = deps.queue ?? (morningReportQueue ??= new SignalQueue({ now: now.getTime() }));
    // 跨日重置归零预算计数（残余风险接管：日历语义由接线层判断）。
    queue.restoreState(rolloverGatesStateForNewDay(queue.snapshotState(), now));
    queue.refreshNow(now.getTime());
    queue.enqueue(signal);

    const consumed = queue.consumeAll();
    const ports = deps.ports ?? createMorningReportPorts();
    for (const entry of consumed) {
      if (deps.deliver) {
        // 测试/高级覆盖：注释约定「不真投递」——不据此判定已播出（不写覆盖账）。
        await deps.deliver(entry);
      } else {
        const result = await deliverDecision(entry.signal, entry.decision, ports);
        // voice = speak 出口成功；notice = speak 不可用的降级上屏——两者都真的发出了播报。
        if (result.channel === 'voice' || result.channel === 'notice') spoken = true;
      }
      decisions.push({ tier: entry.decision.tier, reason: entry.decision.reason });
    }
  } catch (err) {
    // 交付段异常：记 warn 埋点并降级返回（调度层安全），已完成的决策如实带回。
    logMorningReport({
      op: 'deliver',
      ok: false,
      at: signal.ts,
      yesterday: payload.count,
      segments: payload.segments,
      dedupeKey: signal.dedupeKey,
      bolbaDue: bolbaTaskIds.length,
      error: errMessage(err),
    });
    return {
      bosses: histories.size,
      scanned: records.length,
      yesterday: payload.count ?? 0,
      segments: payload.segments ?? 0,
      decisions,
      degraded: true,
      dailyReportIncluded,
      bolbaDue: bolbaTaskIds.length,
      coverageRecorded: false,
    };
  }

  // 任务29：并入的 Bolba 到期确实随晨报播出去之后，才写覆盖账（13 读账后跳过独播）。
  // 只认真正上屏/口播的通道——PREPARE/STORE 没有发出声音，不得记账（否则 13 会因
  // 「已覆盖」静默，用户什么都听不到）；写失败由覆盖账自身降级（13 照常独播）。
  // 并发口径（任务29 独立验证锁定，勿破坏）：自 :558 查当日广播日志至本处写账，
  // 全程同步代码 + 已决 Promise（speak 端口为同步 logProactiveBroadcast）——同一
  // 宏任务内原子；勿在此段插入 I/O/定时器 await（会重开与 13 侧的真竞态）。
  let coverageRecorded = false;
  if (spoken && bolbaTaskIds.length > 0) {
    (deps.coverageStore ?? getMorningCoverageStore()).recordCoverage({
      day: formatDay(now.getTime()),
      bolbaTaskIds,
    });
    coverageRecorded = true;
  }

  return {
    bosses: histories.size,
    scanned: records.length,
    yesterday: payload.count ?? 0,
    segments: payload.segments ?? 0,
    decisions,
    degraded: false,
    dailyReportIncluded,
    bolbaDue: bolbaTaskIds.length,
    coverageRecorded,
  };
}
