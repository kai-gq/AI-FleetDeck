/**
 * 语音伙伴 · 主动汇报
 *
 * 订阅 store(零改作者文件),对 agents 做「快照 diff」:
 *   - working → idle = 完成;→ error / 新 lastError = 报错;
 *   → waiting/waiting_permission = 提问;taskLabel 变化(scope=all 时)= 换任务。
 * 例外:待岗(standby)停机是用户主动下线,不算完成——快照带 standby 标记直接跳过;
 * 停止过程先广播 idle、标记后落地的那条,由本标签页的待岗手势记录兜底(standbyRequests)。
 * 事件先入队,静默窗口(默认 45s)去抖合并;flush 需要「非 busy」(聆听/转写/
 * 思考/播报中不插话,推迟到静默窗口后再试);另有定时巡查兜底(默认 30 分钟,
 * 仅在有事件时提前 flush,无事不打扰)。合并文本形如:
 *   ⟦系统事件⟧ 过去 3 分钟:① 小美 完成任务:登录页改版;② 阿强 出错:构建失败
 * 定界标记用不可口述的 ⟦⟧(任务35 协议安全化):该标记同时是服务端 hop1 的 noop 判定
 * 协议(vcs 系统提示词);旧版普通文本标记(方括号「系统事件」)老板口语/转写命中即可能被误判静默。
 * 交给组件 → POST /api/voice-companion/process { text, event:true }。
 *
 * 09·B 播报分级(四闸门 = shared/broadcast-gates 纯函数):快照 diff 事件在**进队时**
 * 构造 Signal 判定档位——SPEAK / PREPARE 进播报队列(准入时按决策增量预扣预算,仅此一次),
 * STORE 走上屏通道不口播(队列溢出丢最旧前同样先 STORE,沉默≠丢弃),SILENT 仅记幂等键;
 * **出队 flush** 只做时机放行(深夜/focus 挂起到白天,破例线以上除外),不再过预算闸、不再扣预算。
 * 决策明细留在内存统计(gatesStats),对应 ⑭ 观测点⑥(本地,不新建服务端通道)。
 *
 * 任务08② 回执订阅(派活闭环):服务端 task_receipt 经 ingestReceipt 注入**同一队列、同一闸门**
 * (预算/静默窗/幂等键统一) → 派活完成的播报档位以用户 09·B 本地设置权威判定;
 * 并对 diff 通道做**同目标覆盖抑制**——同一次完成/失败不再由快照 diff 重复出声
 * (回执文本更全:带任务摘要,故回执优先;两通道到达次序不定,先到先占、后到合并/被抑制)。
 * 回执用稳定键 `agent-{completed|failed}:{agentId}:{taskId}`(06-11 §11.1);
 * diff 通道维持逐次唯一占位键防误去重(合并回执时原位升级为稳定键)。
 *
 * diffSnapshots / formatEvents / signalForEvent 为纯函数,单测覆盖;上报器本体只做计时与订阅。
 */

import { store } from '../store';
import { wasStandbyJustRequested } from '../store/standbyRequests';
import type { AgentStatus } from '../../shared/types';
import {
  DEFAULT_GATES_CONFIG,
  applyGatesDelta,
  createGatesState,
  decideBroadcast,
  isWithinWindow,
  minutesOfDay,
  type BroadcastDecision,
  type BroadcastReason,
  type BroadcastTier,
  type EnvironmentContext,
  type GatesConfig,
  type GatesState,
  type GatesStateDelta,
  type Signal,
} from '../../shared/broadcast-gates';

/** 单个 agent 的关键字段(status + taskLabel)、错误串与待岗标记。 */
export interface AgentSnapshotEntry {
  status: AgentStatus;
  taskLabel: string;
  lastError: string;
  /**
   * 待岗(standby):用户主动停用。待岗引起的 working→idle 是「被停」而非
   * 「干完了」,不算完成事件。
   */
  standby?: boolean;
}

export type AgentSnapshot = Map<string, AgentSnapshotEntry>;

export type ProactiveEventKind = 'completed' | 'failed' | 'waiting' | 'task-changed';

export interface ProactiveEvent {
  at: number;
  kind: ProactiveEventKind;
  agentId: string;
  text: string;
  /** 任务08②：回执通道的稳定幂等键(`agent-{kind}:{agentId}:{taskId}`)；diff 通道缺省 → 逐次唯一占位。 */
  dedupeKey?: string;
}

/** 队列条目:准入时已过闸门并预扣预算,出队只做时机放行。 */
interface QueuedEvent {
  event: ProactiveEvent;
  /** 准入档位:SPEAK(立即口播,已判定可开口)/ PREPARE(攒批待时机)。 */
  tier: 'SPEAK' | 'PREPARE';
  /** 准入评分(出队破例线判断用,不放回闸门重算)。 */
  score: number;
  /** 来源：diff = 快照 diff 通道；receipt = 任务08② 回执通道（合并后 diff 条目转 receipt）。 */
  source: 'diff' | 'receipt';
}

/** admitEvents 结果：进队条目 + 逐条决策（回执路径需要回读档位/理由）。 */
interface AdmitOutcome {
  queued: QueuedEvent[];
  decisions: Array<{ event: ProactiveEvent; decision: BroadcastDecision }>;
}

/** 决策观测记录(⑭ 观测点⑥:各闸门打分 → 档位 → 理由;仅本地内存)。 */
export interface BroadcastDecisionRecord {
  at: number;
  kind: ProactiveEventKind;
  agentId: string;
  tier: BroadcastTier;
  reason: BroadcastReason;
  score: number;
  disruption: number;
  budget: number;
}

/** 本会话决策统计(内存;真正分析上报通道待任务19,不新建服务端通道)。 */
export interface ProactiveGatesStats {
  /** 累计判定条数。 */
  total: number;
  /** 各档位计数。 */
  tierCounts: Record<BroadcastTier, number>;
  /** 各理由计数。 */
  reasonCounts: Partial<Record<BroadcastReason, number>>;
  /** 最近 MAX_DECISION_RECORDS 条明细(最新在后)。 */
  recent: BroadcastDecisionRecord[];
  /** 当前幂等键数量(裁剪后;残余风险②观测)。 */
  seenKeysCount: number;
  /** 今日已占主预算 / 口播子配额(预扣后)。 */
  spokenToday: number;
  instantSpeakToday: number;
}

const MAX_EVENTS = 12;
const DIFF_THROTTLE_MS = 500;
/** 忙碌时的推迟重试间隔。 */
const BUSY_RETRY_MS = 5_000;
/** 深夜/focus 挂起时的放行检查间隔(初始值非实测:5 分钟粒度,挂起期间不打扰)。 */
const QUIET_HOLD_RETRY_MS = 5 * 60_000;
/** 幂等键裁剪上限(残余风险②;初始值非实测:约最近 200 条事件,远超重复去重窗口)。 */
const MAX_SEEN_KEYS = 200;
/** 决策明细环形上限(初始值非实测:仅本地观测,够最近一次标定回看)。 */
const MAX_DECISION_RECORDS = 100;
/** 任务08②:同目标覆盖抑制窗口(初始值非实测:回执与状态 diff 同时到达,10 分钟远超正常到达间隔)。 */
const RECEIPT_COVERAGE_MS = 10 * 60_000;

/** 纯函数:两次快照对比,产出事件(不依赖 store / 计时器,便于单测)。 */
export function diffSnapshots(
  prev: AgentSnapshot,
  next: AgentSnapshot,
  scope: 'important' | 'all',
  now: number,
  names: Map<string, string>,
): ProactiveEvent[] {
  const events: ProactiveEvent[] = [];
  const nameOf = (id: string) => names.get(id) || id.slice(0, 8);

  for (const [id, cur] of next) {
    const before = prev.get(id);
    if (!before) continue; // 新出现的 agent:不播报(创建本身就是用户操作)
    const name = nameOf(id);
    const label = cur.taskLabel ? `(${cur.taskLabel})` : '';

    if (before.status !== cur.status) {
      if (cur.status === 'idle' && before.status === 'working') {
        // 待岗停机 = 用户主动下线,不是「任务完成」——不播报。
        if (!cur.standby) {
          events.push({ at: now, kind: 'completed', agentId: id, text: `${name} 完成任务${cur.taskLabel ? `:${cur.taskLabel}` : ''}` });
        }
        continue;
      }
      if (cur.status === 'error') {
        const err = cur.lastError ? `:${truncate(cur.lastError, 80)}` : '';
        events.push({ at: now, kind: 'failed', agentId: id, text: `${name} 出错${err}` });
        continue;
      }
      if (cur.status === 'waiting' || cur.status === 'waiting_permission') {
        const what = cur.status === 'waiting_permission' ? '等待授权' : '等待确认';
        events.push({ at: now, kind: 'waiting', agentId: id, text: `${name} ${what}${label}` });
        continue;
      }
      // 其它跃迁(→working/offline 等)不打扰
      continue;
    }

    // 状态未变:错误串更新也算报错
    if (cur.lastError && cur.lastError !== before.lastError && before.status !== 'working') {
      events.push({ at: now, kind: 'failed', agentId: id, text: `${name} 出错:${truncate(cur.lastError, 80)}` });
      continue;
    }

    if (scope === 'all' && cur.status === 'working' && cur.taskLabel && cur.taskLabel !== before.taskLabel) {
      events.push({ at: now, kind: 'task-changed', agentId: id, text: `${name} 换任务:${cur.taskLabel}` });
    }
  }
  return events;
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫'];

/** 纯函数:事件列表 → 一条可提交给大脑的合并文本(空列表返回 null)。 */
export function formatEvents(events: ProactiveEvent[], now: number): string | null {
  if (events.length === 0) return null;
  const oldest = events.reduce((min, e) => Math.min(min, e.at), events[0].at);
  const minutes = Math.max(1, Math.round((now - oldest) / 60_000));
  const body = events.map((e, i) => `${CIRCLED[i] ?? `${i + 1}.`} ${e.text}`).join(';');
  return `⟦系统事件⟧ 过去 ${minutes} 分钟:${body}`;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * 纯函数:快照事件 → 闸门信号。
 *
 * 评分分量(urgency / relevance / certainty)为初始值非实测,待 ⑭ 观测 / ⑮ 标定回写:
 *   failed       90/80/90            → 87 分,urgent,立即口播;
 *   waiting      85/80/90 + 强时效   → 85 分,可立即口播(等你授权才能继续);
 *   completed    60/70/95            → 70 分,攒批到自然开口点;
 *   task-changed 40/80/85            → 61 分,攒批(仅 scope=all 产生)。
 * dedupeKey:回执通道(任务08②)已带稳定键 `agent-{kind}:{agentId}:{taskId}`(06-11 §11.1);
 * diff 通道沿用逐次唯一占位 `agent-{kind}:{agentId}@{ts}` 防误去重丢事件,合并回执时原位升级。
 */
export function signalForEvent(event: ProactiveEvent): Signal {
  const base = {
    source: 'agent' as const,
    kind: `agent_${event.kind}`,
    ts: event.at,
    dedupeKey: event.dedupeKey ?? `agent-${event.kind}:${event.agentId}@${event.at}`,
    text: event.text,
  };
  switch (event.kind) {
    case 'failed':
      return { ...base, urgency: 90, relevance: 80, certainty: 90 };
    case 'waiting':
      return { ...base, urgency: 85, relevance: 80, certainty: 90, timeSensitive: true };
    case 'completed':
      return { ...base, urgency: 60, relevance: 70, certainty: 95 };
    case 'task-changed':
      return { ...base, urgency: 40, relevance: 80, certainty: 85 };
  }
}

// ============================================================================
// 上报器
// ============================================================================

/** agent 数据源(默认接 store;单测注入桩,避免拉起真实 store)。 */
export interface ProactiveSource {
  agents: () => Map<string, { name: string; status: AgentStatus; taskLabel?: string; lastError?: string; standby?: boolean }>;
  subscribe: (listener: () => void) => () => void;
}

function storeSource(): ProactiveSource {
  return {
    agents: () => store.getState().agents,
    subscribe: (listener) => store.subscribe(listener),
  };
}

export interface ProactiveReporterOptions {
  /** 事件合并静默窗口(ms)。 */
  quietWindowMs: number;
  /** 定时巡查间隔(ms)。 */
  intervalMs: number;
  /** 汇报范围:important = 完成/失败/等待;all = 额外包含换任务。 */
  scope: 'important' | 'all';
  /** 是否忙碌(聆听/转写/思考/播报中):忙碌时推迟 flush。 */
  isBusy: () => boolean;
  /** 提交合并文本(组件负责调大脑与播报)。 */
  onSubmit: (text: string) => void;
  /** STORE 档出口:仅上屏(不口播);缺省时只在 dev 控制台留痕。 */
  onStore?: (text: string) => void;
  /**
   * 四闸门配置(每次判定现读,设置改动即时生效,无需重建上报器)。
   * 默认 DEFAULT_GATES_CONFIG(06-11 §4 建议值非实测)。
   */
  gatesConfig?: () => GatesConfig;
  /** 当前环境快照(闸门②);客户端目前只有 speaking 可用,其余字段缺数据源。 */
  gatesEnv?: () => EnvironmentContext;
  /** 判定时刻注入(单测用);默认 Date.now。 */
  now?: () => number;
  /** 数据源(默认 store;测试注入)。 */
  source?: ProactiveSource;
}

export interface ProactiveReporterHandle {
  start: () => void;
  stop: () => void;
  /** 尝试 flush;返回提交的文本(null = 无事可报 / 忙碌或深夜挂起)。force 跳过忙碌与静默时段判定。 */
  flushNow: (opts?: { force?: boolean }) => string | null;
  pendingCount: () => number;
  /**
   * 任务08②:服务端 task_receipt 接入(派活闭环)。同一队列/闸门,回执优先、diff 同目标被覆盖抑制。
   * 返回本次判定结果(测试断言/组件观测用;SILENT 时 action='silent')。
   */
  ingestReceipt: (receipt: ProactiveReceipt) => ReceiptIngestResult;
  /** ⑭ 观测点⑥:本地决策统计(内存快照)。 */
  gatesStats: () => ProactiveGatesStats;
}

/**
 * 任务08②:回执入参(结构对齐 TaskReceiptMessage.payload 的播报必需子集,
 * 不 import 传输层类型——bus/组件负责搬运)。
 */
export interface ProactiveReceipt {
  agentId: string;
  success: boolean;
  /** 是否命中派活登记(未匹配 = 防漏报路径,text 为通用完成句)。 */
  matched: boolean;
  text: string;
  at: number;
  dedupeKey: string;
  taskId?: string;
}

/** ingestReceipt 判定结果:queued=进队列；merged=并入既有 diff 条目；stored=仅上屏；silent=丢弃。 */
export interface ReceiptIngestResult {
  action: 'queued' | 'merged' | 'stored' | 'silent';
  tier: BroadcastTier;
  reason?: BroadcastReason;
}

export function createProactiveReporter(options: ProactiveReporterOptions): ProactiveReporterHandle {
  const source = options.source ?? storeSource();
  /** 显式取时入口(残余风险③):一次取时注入 GatesState.now,不在多处隐式取时。 */
  const nowMs = () => (options.now ? options.now() : Date.now());
  let snapshot: AgentSnapshot = new Map();
  // 播报队列只放 SPEAK/PREPARE(STORE/SILENT 在准入时已分流,见 admitEvents)
  let events: QueuedEvent[] = [];
  // 任务08②:回执 → diff 同目标覆盖(agentId → 最近回执 kind/时刻;一次性消费,→working 或 stop 时清除)
  const receiptCoverage = new Map<string, { kind: 'completed' | 'failed'; at: number }>();
  let unsubscribe: (() => void) | null = null;
  // 裸定时器(node 测试环境无 window);ReturnType 兼容 DOM(number)与 Node(Timeout)
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let lastDiffAt = 0;
  // 四闸门显式状态(预算/幂等键/环境;纯函数契约见 shared/broadcast-gates)。
  // stats(忽略率/采纳率)暂无数据源(⑭ 未接入),保持 0 = 自适应不加不减;待 ⑭/⑮ 喂真值。
  let gatesState: GatesState = createGatesState({ now: nowMs(), config: currentGatesConfig() });
  let gatesDayKey = dayKeyOf(nowMs());
  // 决策观测(⑭ 观测点⑥;仅本地内存,不新建服务端通道)
  let decisionTotal = 0;
  const tierCounts: Record<BroadcastTier, number> = { SPEAK: 0, PREPARE: 0, STORE: 0, SILENT: 0 };
  const reasonCounts: Partial<Record<BroadcastReason, number>> = {};
  const decisionRecords: BroadcastDecisionRecord[] = [];

  function takeSnapshot(): AgentSnapshot {
    const map: AgentSnapshot = new Map();
    for (const [id, agent] of source.agents()) {
      map.set(id, {
        status: agent.status,
        taskLabel: agent.taskLabel ?? '',
        lastError: agent.lastError ?? '',
        standby: agent.standby === true,
      });
    }
    return map;
  }

  function names(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [id, agent] of source.agents()) map.set(id, agent.name);
    return map;
  }

  // ---- 四闸门接线(09·B)----

  function currentGatesConfig(): GatesConfig {
    return options.gatesConfig ? options.gatesConfig() : DEFAULT_GATES_CONFIG;
  }

  function currentEnv(): EnvironmentContext {
    return options.gatesEnv ? options.gatesEnv() : {};
  }

  /** 本地日期键(YYYY-M-D):跨日重置预算计数用。 */
  function dayKeyOf(now: number): string {
    const d = new Date(now);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function trimSeenKeys(keys: readonly string[]): readonly string[] {
    return keys.length <= MAX_SEEN_KEYS ? keys : keys.slice(-MAX_SEEN_KEYS);
  }

  /** 跨日重置主预算 / 口播子配额(每日配额按日自然滚动),并顺手裁剪幂等键。 */
  function refreshGatesDay(now: number): void {
    const key = dayKeyOf(now);
    if (key === gatesDayKey) return;
    gatesDayKey = key;
    gatesState = {
      ...gatesState,
      spokenToday: 0,
      instantSpeakToday: 0,
      seenKeys: trimSeenKeys(gatesState.seenKeys),
    };
  }

  /** 把决策增量喂回状态(幂等键裁剪后,残余风险②)。 */
  function advanceGates(decision: BroadcastDecision): void {
    applyDelta(decision.delta);
  }

  /** 原始增量入口(任务08②合并路径需要零增量登记稳定键,不复用整条决策)。 */
  function applyDelta(delta: GatesStateDelta): void {
    const next = applyGatesDelta(gatesState, delta);
    gatesState =
      next.seenKeys.length > MAX_SEEN_KEYS ? { ...next, seenKeys: next.seenKeys.slice(-MAX_SEEN_KEYS) } : next;
  }

  /** 决策打点:内存计数 + 环形明细 + dev 控制台(⑭ 观测点⑥)。 */
  function recordDecision(event: ProactiveEvent, decision: BroadcastDecision, now: number): void {
    decisionTotal += 1;
    tierCounts[decision.tier] += 1;
    reasonCounts[decision.reason] = (reasonCounts[decision.reason] ?? 0) + 1;
    decisionRecords.push({
      at: now,
      kind: event.kind,
      agentId: event.agentId,
      tier: decision.tier,
      reason: decision.reason,
      score: decision.score,
      disruption: decision.disruption,
      budget: decision.budget,
    });
    if (decisionRecords.length > MAX_DECISION_RECORDS) {
      decisionRecords.splice(0, decisionRecords.length - MAX_DECISION_RECORDS);
    }
    if (typeof window !== 'undefined' && import.meta.env.DEV) {
      console.debug('[播报分级]', event.kind, `${decision.tier}/${decision.reason}`, {
        score: decision.score,
        disruption: decision.disruption,
        budget: decision.budget,
      });
    }
  }

  /** STORE 档出口:上屏(不口播);未接出口时仅在浏览器 dev 留痕。 */
  function emitStore(stored: ProactiveEvent[], now: number): void {
    const text = formatEvents(stored, now);
    if (!text) return;
    if (options.onStore) {
      options.onStore(text);
      return;
    }
    if (typeof window !== 'undefined' && import.meta.env.DEV) {
      console.debug('[主动汇报] 仅上屏(STORE):', text);
    }
  }

  /**
   * 事件过四闸门并分流(进队时判定):SPEAK/PREPARE 返回给调用方进队列,
   * STORE 立刻走上屏, SILENT 只留幂等键。预算在此按决策增量预扣一次——
   * 出队 flush 不再过闸(残余风险①)。
   */
  function admitEvents(fresh: ProactiveEvent[], now: number, source: 'diff' | 'receipt'): AdmitOutcome {
    refreshGatesDay(now);
    // 显式取时一次注入(残余风险③):深夜/focus 判定只看 state.now,勿多处隐式取时
    gatesState = { ...gatesState, now, env: currentEnv(), config: currentGatesConfig() };
    const queued: QueuedEvent[] = [];
    const stored: ProactiveEvent[] = [];
    const decisions: AdmitOutcome['decisions'] = [];
    for (const event of fresh) {
      const decision = decideBroadcast(signalForEvent(event), gatesState);
      advanceGates(decision);
      recordDecision(event, decision, now);
      decisions.push({ event, decision });
      if (decision.tier === 'SPEAK' || decision.tier === 'PREPARE') {
        queued.push({ event, tier: decision.tier, score: decision.score, source });
      } else if (decision.tier === 'STORE') {
        stored.push(event);
      }
      // SILENT:不进队列也不上屏(低相关/重复),幂等键已随 delta 记入
    }
    if (stored.length > 0) emitStore(stored, now);
    return { queued, decisions };
  }

  /**
   * 任务08② diff 通道同目标覆盖判定:同 agent 同 kind 且窗口内 → 抑制并一次性消费;
   * 过期即删(窗口外自然失效,防止陈旧覆盖误伤下一次完成)。
   */
  function consumeReceiptCoverage(event: ProactiveEvent, now: number): boolean {
    const cov = receiptCoverage.get(event.agentId);
    if (!cov || cov.kind !== event.kind) return false;
    receiptCoverage.delete(event.agentId);
    return now - cov.at <= RECEIPT_COVERAGE_MS;
  }

  /**
   * 任务08② 回执接入(派活闭环):同一完成/失败经此进**同一队列、同一闸门**
   * (预算/静默窗/幂等键与 diff 通道统一,档位由用户 09·B 设置权威判定)。
   * - 队列中已有同 agent 同 kind 的 diff 条目 → **原位合并**:升级为带任务摘要的回执文本 +
   *   稳定幂等键(闸门已过,零增量登记键,不重复扣预算、不改准入档位);
   * - 否则过闸分流(与 diff 通道同口径);进队/上屏时登记**同目标覆盖**,
   *   使稍后到达的 diff 同 kind 事件被抑制——同一次完成不再双播。
   */
  function ingestReceipt(receipt: ProactiveReceipt): ReceiptIngestResult {
    const now = nowMs();
    const kind: 'completed' | 'failed' = receipt.success ? 'completed' : 'failed';

    const queuedIdx = events.findIndex(
      (q) => q.source === 'diff' && q.event.agentId === receipt.agentId && q.event.kind === kind,
    );
    if (queuedIdx >= 0) {
      // 先到的是 diff(文本较简),原位合并升级;同 kind 评分常量一致,档位/破例线沿用
      const merged: ProactiveEvent = {
        ...events[queuedIdx].event,
        text: receipt.text,
        dedupeKey: receipt.dedupeKey,
      };
      events[queuedIdx] = { ...events[queuedIdx], event: merged, source: 'receipt' };
      applyDelta({ seenKeysToAdd: [receipt.dedupeKey], dailySpokenDelta: 0, instantSpeechDelta: 0 });
      return { action: 'merged', tier: events[queuedIdx].tier };
    }

    const event: ProactiveEvent = {
      at: receipt.at,
      kind,
      agentId: receipt.agentId,
      text: receipt.text,
      dedupeKey: receipt.dedupeKey,
    };
    const { queued, decisions } = admitEvents([event], now, 'receipt');
    const decision = decisions[0]?.decision;
    if (queued.length > 0) {
      events.push(...queued);
      if (events.length > MAX_EVENTS) {
        // 与 tick 同口径:溢出丢最旧前先落 STORE 上屏(沉默≠丢弃,⑤4)
        const dropped = events.slice(0, events.length - MAX_EVENTS);
        events = events.slice(-MAX_EVENTS);
        emitStore(dropped.map((q) => q.event), now);
      }
      receiptCoverage.set(receipt.agentId, { kind, at: now });
      scheduleQuietFlush();
      return { action: 'queued', tier: queued[0].tier, reason: decision?.reason };
    }
    if (decision?.tier === 'STORE') {
      // 已上屏:稍后的 diff 同 kind 也抑制(否则同一完成会上屏两条)
      receiptCoverage.set(receipt.agentId, { kind, at: now });
      return { action: 'stored', tier: 'STORE', reason: decision.reason };
    }
    // SILENT(低相关/重复键):不进队列也不上屏;证据在服务端 delegation 埋点,已留
    return { action: 'silent', tier: decision?.tier ?? 'SILENT', reason: decision?.reason };
  }

  /**
   * 出队放行判定(残余风险①):只查时机(深夜/focus),**不再过预算闸、不再扣预算**——
   * 准入时已按决策增量预扣一次,这里重复扣会让每日预算实际腰斩。
   * 队列含 SPEAK(准入已判定可立即开口)时不拦;破例线(评分 >90)以上同样放行。
   */
  function shouldHoldForQuietHours(now: number): boolean {
    if (events.some((q) => q.tier === 'SPEAK')) return false;
    const config = currentGatesConfig();
    const minute = minutesOfDay(now);
    const quiet =
      isWithinWindow(minute, config.deepNight) ||
      config.focusWindows.some((w) => isWithinWindow(minute, w));
    if (!quiet) return false;
    const maxScore = events.reduce((max, q) => Math.max(max, q.score), 0);
    return maxScore <= config.quietBypassScore;
  }

  function scheduleQuietFlush(delay = options.quietWindowMs): void {
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      quietTimer = null;
      flushNow();
    }, delay);
  }

  function flushNow(opts: { force?: boolean } = {}): string | null {
    if (events.length === 0) return null;
    const now = nowMs();
    if (!opts.force && options.isBusy()) {
      // 忙碌:等下一轮(静默窗口后重试)
      scheduleQuietFlush(BUSY_RETRY_MS);
      return null;
    }
    if (!opts.force && shouldHoldForQuietHours(now)) {
      // 深夜/focus:攒批条目挂起到静默时段结束(检查间隔 QUIET_HOLD_RETRY_MS)
      scheduleQuietFlush(QUIET_HOLD_RETRY_MS);
      return null;
    }
    const text = formatEvents(events.map((q) => q.event), now);
    if (!text) return null;
    events = [];
    options.onSubmit(text);
    return text;
  }

  function tick(): void {
    const now = nowMs();
    if (now - lastDiffAt < DIFF_THROTTLE_MS) return; // 高频 notify 节流
    lastDiffAt = now;
    const next = takeSnapshot();
    // 任务08②:新任务开始(→working)即清覆盖——旧完成的抑制窗口不波及下一次完成
    for (const [id, cur] of next) {
      if (cur.status === 'working' && snapshot.get(id)?.status !== 'working') receiptCoverage.delete(id);
    }
    const fresh = diffSnapshots(snapshot, next, options.scope, now, names())
      .filter((e) => !consumeReceiptCoverage(e, now))
      // 待岗停机兜底:停止过程会先广播一次 idle(标记尚未落地),那一次的
      // working→idle 也可能是「用户刚点的待岗」。本标签页的手势记录能认出它。
      .filter((e) => !(e.kind === 'completed' && wasStandbyJustRequested(e.agentId, now)));
    snapshot = next;
    if (fresh.length === 0) return;
    const { queued } = admitEvents(fresh, now, 'diff');
    if (queued.length === 0) return; // 全部 STORE/SILENT:已上屏或幂等跳过,无播报队列
    events.push(...queued);
    if (events.length > MAX_EVENTS) {
      // 12 条上限丢最旧,但先落 STORE 上屏(沉默≠丢弃,⑤4)
      const dropped = events.slice(0, events.length - MAX_EVENTS);
      events = events.slice(-MAX_EVENTS);
      emitStore(dropped.map((q) => q.event), now);
    }
    scheduleQuietFlush();
  }

  function start(): void {
    if (unsubscribe) return;
    const now = nowMs();
    refreshGatesDay(now); // 跨日启动时先归零当日预算
    snapshot = takeSnapshot(); // 基线:启动前的状态不产生事件
    lastDiffAt = now;
    unsubscribe = source.subscribe(() => tick());
    intervalTimer = setInterval(() => {
      flushNow();
    }, options.intervalMs);
  }

  function stop(): void {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (quietTimer !== null) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    if (intervalTimer !== null) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    events = [];
    receiptCoverage.clear(); // 任务08②:会话结束清覆盖,避免跨会话残留抑制
  }

  return {
    start,
    stop,
    flushNow,
    pendingCount: () => events.length,
    ingestReceipt,
    gatesStats: () => ({
      total: decisionTotal,
      tierCounts: { ...tierCounts },
      reasonCounts: { ...reasonCounts },
      recent: decisionRecords.slice(),
      seenKeysCount: gatesState.seenKeys.length,
      spokenToday: gatesState.spokenToday,
      instantSpeakToday: gatesState.instantSpeakToday,
    }),
  };
}
