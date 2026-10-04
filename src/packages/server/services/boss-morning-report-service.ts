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
import { logEvent } from '../data/system-log.js';
import { truncateOrEmpty } from '../utils/index.js';
import { logProactiveBroadcast } from './voice-companion-service.js';

// ─── 常量 ───

/** ⑨ 晨报动作标识（写进主动播报的 action 字段，便于 ⑭ 观测筛选）。 */
export const BOSS_MORNING_REPORT_ACTION = 'boss_morning_report';
/** 🟡⑨ 埋点来源标识（category='system' + source + body.cat='boss-morning-report'；不改任何枚举）。 */
export const MORNING_REPORT_LOG_SOURCE = 'boss-morning-report';
/** 目标/摘要/产出位置单字段展示上限（§7.2 播报从简；截断加省略号，不硬造内容）。 */
const GOAL_MAX = 60;
const DETAIL_MAX = 80;
/** 无项目归属的分段标签。 */
const NO_PROJECT_LABEL = '未归项目';

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

// ─── 信号构造（纯函数） ───

/**
 * 晨报信号（一天一条聚合：dedupeKey 按扫描日 → 同日重复扫描走幂等 SILENT）。
 *
 * 昨窗口径（本地日历日）：昨天 00:00 ≤ completedAt < 今天 00:00——昨天 00:00 含、
 * 今天 00:00 不含；无 completion 的旧记录（任务11 前的历史）一律按「无完成事件」排除。
 * 昨日无可报项 → null（与任务13 no-due 同构，不空发信号）。
 *
 * 多项目分段：按 taskCard?.projectId 分组（无项目归「未归项目」组），组内按完成时刻
 * 升序，文本形如「昨日要点：项目A：甲 完成「Y」（产出在 Z）；项目B：…。」——只承载
 * 晨报三句预算（06-11 §6.4：昨日要点 + 今日待办 + 主动发现）中的「昨日要点」第一句。
 *
 * 评分理由（自定，保守取值，非实测最优）：urgency 65 / relevance 85 / certainty 95
 * → 加权 77（0.5·65+0.3·85+0.2·95）< 85，刻意不走 urgent——晨报是定点自然开口点，
 * 急迫性低，不必抢占紧急高分位；用 timeSensitive 表达「晨间定点」时效，过闸门④
 * 以 'time_sensitive' 走 SPEAK，但仍受闸门②③（深夜/打扰/预算/口播子配额）约束。
 */
export function buildMorningReportSignal(records: readonly DelegationDecision[], now: Date): RawSignal | null {
  const todayStart = dayStartMillis(now);
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();

  const yesterday = records
    .filter(
      (r): r is DelegationDecision & { completion: DelegationCompletion } =>
        !!r.completion && r.completion.completedAt >= yesterdayStart && r.completion.completedAt < todayStart,
    )
    .sort((a, b) => a.completion.completedAt - b.completion.completedAt);
  if (yesterday.length === 0) return null;

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
  const text = `昨日要点：${ordered.map((s) => `${s.label}：${s.items.join('，')}`).join('；')}。`;

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
  /** 投递覆盖（测试用：观察 ConsumedSignal，不真投递）。 */
  deliver?: (consumed: ConsumedSignal) => void | Promise<void>;
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
}

/**
 * 扫一次晨报：读病历 → 组信号 → 过闸门 → 投递。任何异常都不上抛（调度层安全）。
 */
export async function runBossMorningReportScan(
  deps: BossMorningReportScanDeps = {},
): Promise<BossMorningReportScanResult> {
  const now = (deps.now ?? (() => new Date()))();
  const empty = { bosses: 0, scanned: 0, yesterday: 0, segments: 0, decisions: [], degraded: false };

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

  const records = [...histories.values()].flat();
  const signal = buildMorningReportSignal(records, now);
  if (!signal) {
    logMorningReport({ op: 'scan', ok: true, count: records.length, reason: 'no-yesterday' });
    return { ...empty, bosses: histories.size, scanned: records.length };
  }

  const payload = payloadOf(signal);
  logMorningReport({ op: 'scan', ok: true, count: records.length, yesterday: payload.count });
  logMorningReport({
    op: 'generate',
    ok: true,
    at: signal.ts,
    yesterday: payload.count,
    segments: payload.segments,
    dedupeKey: signal.dedupeKey,
  });

  const decisions: { tier: BroadcastTier; reason: BroadcastReason }[] = [];
  try {
    const queue = deps.queue ?? (morningReportQueue ??= new SignalQueue({ now: now.getTime() }));
    // 跨日重置归零预算计数（残余风险接管：日历语义由接线层判断）。
    queue.restoreState(rolloverGatesStateForNewDay(queue.snapshotState(), now));
    queue.refreshNow(now.getTime());
    queue.enqueue(signal);

    const consumed = queue.consumeAll();
    const ports = deps.ports ?? createMorningReportPorts();
    for (const entry of consumed) {
      if (deps.deliver) await deps.deliver(entry);
      else await deliverDecision(entry.signal, entry.decision, ports);
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
      error: errMessage(err),
    });
    return {
      bosses: histories.size,
      scanned: records.length,
      yesterday: payload.count ?? 0,
      segments: payload.segments ?? 0,
      decisions,
      degraded: true,
    };
  }

  return {
    bosses: histories.size,
    scanned: records.length,
    yesterday: payload.count ?? 0,
    segments: payload.segments ?? 0,
    decisions,
    degraded: false,
  };
}
