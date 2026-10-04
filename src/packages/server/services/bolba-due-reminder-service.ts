/**
 * 任务13·⑩ Bolba 到期提醒（主动播报链路）
 *
 * 职责：每日扫描 Bolba 在办任务 → 聚合成一条「待办到期」信号（source='memory'，
 * 见 06-11 §5 记忆信号与任务30 信号源清单）→ 过 09·A 四闸门（jarvis-core
 * SignalQueue）→ 按决策四档投递（deliverDecision）。
 *
 * 投递通道（如实分级，不造假通道）：
 *   - SPEAK  → 复用 vcs 现有回合出口 logProactiveBroadcast（dialog out + broadcast
 *     server-sent，落 system_log；与普通回合同形态，action 可筛）；
 *   - notice → 同上通道 + degraded 标记（口播出口缺失/抛错时的降级）；
 *   - PREPARE → 留在队列 prepared 缓冲（自然开口点 flush 未接，登记缺口）；
 *   - STORE → 只登记 system_log，不写 broadcast 假装已上屏（服务端无上屏消费者）。
 *
 * 边界与已知缺口（登记备查 2026-10-04）：
 *   - 不碰 Boss 委派账本（两本账不混）；
 *   - 队列无持久化：服务重启丢失预算计数/幂等键，同日可能重复播报一次（与客户端同口径）；
 *   - 跨日预算重置：SignalQueue 明示由接线层负责，本模块 rolloverGatesStateForNewDay 落地；
 *   - PREPARE 攒批项目前无 flush 点（自然开口点在客户端回合，不在本任务所有权内）。
 *
 * 调度入口：cron-service.startBolbaDueReminderJob()（每日 08:00 本地时区，懒加载本模块）。
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
import {
  classifyBolbaDue,
  fetchPendingBolbaTasks,
  logBolbaSync,
  renderDueReport,
  selectDueSoonTasks,
  type BolbaApiTask,
} from './bolba-bridge-service.js';
import { logProactiveBroadcast } from './voice-companion-service.js';

// ─── 常量 ───

/** ⑩ 到期提醒动作标识（写进主动播报的 action 字段，便于 ⑭ 观测筛选）。 */
export const BOLBA_DUE_REMINDER_ACTION = 'bolba_due_reminder';
/** 「要盯」视野：今天 + 明天（overdue 恒含）。 */
export const DUE_HORIZON_DAYS = 1;

// ─── 信号构造（纯函数） ───

function formatDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

function dueCountOf(input: { payload?: unknown }): number | undefined {
  const payload = input.payload as { count?: unknown } | undefined;
  return typeof payload?.count === 'number' ? payload.count : undefined;
}

/**
 * 到期信号（一天一条聚合：dedupeKey 按扫描日 → 同日重复扫描走幂等 SILENT）。
 * 评分：有 overdue/today → urgency 85 / relevance 80 / certainty 95（加权 86 > 85 = urgent）
 * 且 timeSensitive；仅明天 → urgency 70（加权 78，落 PREPARE 攒批）。
 */
export function buildDueReminderSignal(tasks: readonly BolbaApiTask[], now: Date): RawSignal | null {
  const due = selectDueSoonTasks(tasks, now, DUE_HORIZON_DAYS);
  if (due.length === 0) return null;

  const buckets = due.map((t) => classifyBolbaDue(t.due, now).bucket);
  const immediate = buckets.some((b) => b === 'overdue' || b === 'today');
  return {
    source: 'memory',
    kind: 'bolba_task_due',
    ts: now.getTime(),
    dedupeKey: `bolba-due-scan:${formatDay(now.getTime())}`,
    text: renderDueReport(tasks, now),
    payload: { count: due.length, taskIds: due.map((t) => t.id), buckets },
    urgency: immediate ? 85 : 70,
    relevance: 80,
    certainty: 95,
    ...(immediate ? { timeSensitive: true } : {}),
  };
}

// ─── 跨日重置（SignalQueue 明示的接线层职责） ───

/**
 * 日历日翻转时归零当日预算计数与自适应统计；同一天原样返回。
 * seenKeys 保留（dedupeKey 的 TTL 裁剪由队列自行负责），env/config 保留。
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

// ─── 队列单例（无持久化；重启即新的一天起点） ───

let reminderQueue: SignalQueue | null = null;

/** 测试专用：丢弃进程内队列单例。 */
export function resetBolbaDueReminderStateForTests(): void {
  reminderQueue = null;
}

// ─── 投递端口（复用 vcs 通道；STORE 不假装上屏） ───

/** 四档投递端口：SPEAK/notice 走 logProactiveBroadcast；PREPARE/STORE 只登记 system_log。 */
export function createBolbaReminderPorts(): DeliveryPorts {
  const logOutcome = (decision: BroadcastDecision, signal: Signal, ok: boolean, error?: string): void => {
    logBolbaSync({
      op: 'due-reminder',
      ok,
      tier: decision.tier,
      reason: decision.reason,
      count: dueCountOf(signal),
      ...(error ? { error } : {}),
    });
  };

  return {
    speak: (signal, decision) => {
      logProactiveBroadcast({ text: signal.text ?? '', action: BOLBA_DUE_REMINDER_ACTION });
      logOutcome(decision, signal, true);
    },
    notice: (signal, decision, reason) => {
      // 口播出口缺失/抛错的降级路径：仍走现有通道，但如实打降级标记。
      logProactiveBroadcast({ text: signal.text ?? '', action: BOLBA_DUE_REMINDER_ACTION, degraded: true });
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

export interface BolbaDueScanDeps {
  /** 任务拉取（测试注入；缺省真实拉取）。 */
  fetchTasks?: () => Promise<BolbaApiTask[]>;
  /** 时刻注入（测试用；缺省进程时钟——调度层触发时用真实时间）。 */
  now?: () => Date;
  /** 队列注入（测试用；缺省进程内单例）。 */
  queue?: SignalQueue;
  /** 端口覆盖（测试用）。 */
  ports?: DeliveryPorts;
  /** 投递覆盖（测试用：观察 ConsumedSignal，不真投递）。 */
  deliver?: (consumed: ConsumedSignal) => void | Promise<void>;
}

export interface BolbaDueScanResult {
  scanned: number;
  due: number;
  decisions: { tier: BroadcastTier; reason: BroadcastReason }[];
  degraded: boolean;
}

/**
 * 拉一次扫描：拉取 → 组信号 → 过闸门 → 投递。任何异常都不上抛（调度层安全）。
 */
export async function runBolbaDueReminderScan(deps: BolbaDueScanDeps = {}): Promise<BolbaDueScanResult> {
  const now = (deps.now ?? (() => new Date()))();
  const fetchTasks = deps.fetchTasks ?? fetchPendingBolbaTasks;

  let tasks: BolbaApiTask[];
  try {
    tasks = await fetchTasks();
  } catch (err) {
    logBolbaSync({ op: 'scan', ok: false, error: err instanceof Error ? err.message : String(err) });
    return { scanned: 0, due: 0, decisions: [], degraded: true };
  }

  const signal = buildDueReminderSignal(tasks, now);
  logBolbaSync({ op: 'scan', ok: true, count: tasks.length, ...(signal ? {} : { reason: 'no-due' }) });
  if (!signal) return { scanned: tasks.length, due: 0, decisions: [], degraded: false };

  const queue = deps.queue ?? (reminderQueue ??= new SignalQueue({ now: now.getTime() }));
  // 跨日重置归零预算计数（残余风险接管：日历语义由接线层判断）。
  queue.restoreState(rolloverGatesStateForNewDay(queue.snapshotState(), now));
  queue.refreshNow(now.getTime());
  queue.enqueue(signal);

  const consumed = queue.consumeAll();
  const ports = deps.ports ?? createBolbaReminderPorts();
  for (const entry of consumed) {
    if (deps.deliver) await deps.deliver(entry);
    else await deliverDecision(entry.signal, entry.decision, ports);
  }

  return {
    scanned: tasks.length,
    due: dueCountOf(signal) ?? 0,
    decisions: consumed.map((c) => ({ tier: c.decision.tier, reason: c.decision.reason })),
    degraded: false,
  };
}
