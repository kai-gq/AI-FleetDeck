/**
 * jarvis-core · 信号包队列（任务 26，接管 09·A 三项残余风险①–③）
 *
 * 职责：持有 GatesState 实例（判断层状态的唯一写者），把感知层原始信号归一化成
 * 09·A 契约 Signal 入队（source / kind / payload / ts / dedupeKey，对齐 06-11
 * §4.1），判断层消费出队（decideSafely + applyGatesDelta），PREPARE 攒批缓冲，
 * seenKeys 定期裁剪。归并说明（§9.2 台阶三⑪）：本队列即「意识流总线」的最小实现。
 *
 * 09·A 残余风险接管（任务 09·B 接线注意，2026-10-04 钉死；本任务在骨架层落地）：
 * ① PREPARE 准入预扣预算：consumeNext 决策时 delta 已喂回 state（预扣），
 *    flushPrepared 出队只交付、不再判定/不再 applyGatesDelta（复扣 = 预算腰斩）；
 * ② seenKeys 裁剪：maxSeenKeys（默认 500）+ seenKeyTtlMs（默认 24h）双条件，
 *    溢出自动裁、无溢出按操作数定期裁，杜绝无界增长；
 * ③ state.now 显式注入：构造时必须传入时刻，内部不读时钟；每轮由心跳 ctx.now
 *    refreshNow 更新（服务端/晨报复用不依赖进程本地时区）。
 *
 * 去重分层：判断层 seenKeys（重复落 SILENT/duplicate、不记账）+ 执行器 dedupeKey
 * （已完成不重执行）双保险；队列只做归一化，不预丢重复信号（保留 ⑥ 观测可见性）。
 *
 * 边界：跨日重置（spokenToday / instantSpeakToday / stats 窗口）含日历语义，
 * 由接线层在周期内按显式 now 判断，本骨架不含；具体信号源属任务 30。
 */

import {
  applyGatesDelta,
  createGatesState,
  type BroadcastDecision,
  type EnvironmentContext,
  type GatesState,
  type GatesStateOverrides,
  type GatesStats,
  type Signal,
  type SignalSource,
} from '../../shared/broadcast-gates.js';
import { decideSafely, jarvisLogger, type JarvisLogger } from './executors.js';

// ============================================================================
// 常量（自定初始值，非实测；待 ⑭ 观测 / ⑮ 标定）
// ============================================================================

/** seenKeys 保留上限：最近 N 条（自定 500，覆盖单日信号量绰绰有余）。 */
export const DEFAULT_MAX_SEEN_KEYS = 500;
/** seenKeys 时间窗：超过它的键在下一次裁剪时丢弃（自定 24 小时）。 */
export const DEFAULT_SEEN_KEY_TTL_MS = 24 * 60 * 60 * 1000;
/** 无溢出时的定期裁剪间隔（消费次数；自定 100）。 */
export const SEEN_TRIM_OPS_INTERVAL = 100;

// ============================================================================
// 归一化
// ============================================================================

/** 入队形态：ts / dedupeKey 可省，由队列归一化补齐。 */
export type RawSignal = Omit<Signal, 'ts' | 'dedupeKey'> & {
  /** 缺省 = 入队时刻（队列 state.now）。 */
  ts?: number;
  /** 缺省 = `${source}:${kind}:${ts}`（键值具体形态延后到任务 10，见任务 09 主脑登记）。 */
  dedupeKey?: string;
};

/** 六路信号源枚举（06-11 §4.1）。 */
export const SIGNAL_SOURCES: readonly SignalSource[] = ['agent', 'system', 'project', 'time', 'user', 'memory'];

export function isSignalSource(value: unknown): value is SignalSource {
  return typeof value === 'string' && (SIGNAL_SOURCES as readonly string[]).includes(value);
}

/**
 * 原始信号 → 09·A 契约 Signal。结构性非法（source 不在枚举 / kind 为空）抛
 * TypeError：这是编程错误，应尽早暴露，而不是静默丢信号。
 */
export function normalizeSignal(raw: RawSignal, now: number): Signal {
  if (!raw || !isSignalSource(raw.source)) {
    throw new TypeError(`信号 source 非法: ${String(raw?.source)}`);
  }
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
  if (!kind) throw new TypeError('信号 kind 不能为空');
  const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : now;
  const dedupeKey =
    typeof raw.dedupeKey === 'string' && raw.dedupeKey.trim() !== ''
      ? raw.dedupeKey.trim()
      : `${raw.source}:${kind}:${ts}`;
  const text = typeof raw.text === 'string' ? raw.text.trim() : raw.text;
  return { ...raw, source: raw.source, kind, ts, dedupeKey, text: text ? text : undefined };
}

// ============================================================================
// 队列
// ============================================================================

export interface ConsumedSignal {
  signal: Signal;
  decision: BroadcastDecision;
  /**
   * 准入即预扣（残余风险①）：true = SPEAK/PREPARE 已把开口额度计入 state，
   * 执行/出队（flushPrepared）时不得复扣。
   */
  budgetCharged: boolean;
  /** 判断层是否走了保守回退（配置错误，见 executors.decideSafely）。 */
  degraded: boolean;
}

export interface SignalQueueOptions {
  /** 判定时刻（epoch ms）。构造时一次取时传入，不依赖进程本地时区（残余风险③）。 */
  now: number;
  /** GatesState 初值覆盖（预算计数/统计/环境/配置）；now 以本参数为准。 */
  state?: GatesStateOverrides;
  /** @see DEFAULT_MAX_SEEN_KEYS */
  maxSeenKeys?: number;
  /** @see DEFAULT_SEEN_KEY_TTL_MS */
  seenKeyTtlMs?: number;
  logger?: JarvisLogger;
}

export class SignalQueue {
  private state: GatesState;
  private readonly queue: Signal[] = [];
  private readonly prepared: ConsumedSignal[] = [];
  /** dedupeKey → 入队处理时刻（仅裁剪用；state.seenKeys 仍是判定的唯一事实源）。 */
  private seenAt = new Map<string, number>();
  private opsSinceTrim = 0;
  private readonly maxSeenKeys: number;
  private readonly seenKeyTtlMs: number;
  private readonly logger: JarvisLogger;

  constructor(options: SignalQueueOptions) {
    this.state = createGatesState({ ...options.state, now: options.now });
    this.maxSeenKeys = options.maxSeenKeys ?? DEFAULT_MAX_SEEN_KEYS;
    this.seenKeyTtlMs = options.seenKeyTtlMs ?? DEFAULT_SEEN_KEY_TTL_MS;
    this.logger = options.logger ?? jarvisLogger;
  }

  /** 当前判定时刻（残余风险③：显式注入，非进程时钟）。 */
  get now(): number {
    return this.state.now;
  }

  /** 待消费队列长度。 */
  get size(): number {
    return this.queue.length;
  }

  /** PREPARE 攒批缓冲长度（受每日预算硬顶约束，天然有界）。 */
  get preparedCount(): number {
    return this.prepared.length;
  }

  /** 只读快照（持久化结构交给接线层决定；这里不落盘）。 */
  snapshotState(): GatesState {
    return {
      ...this.state,
      seenKeys: [...this.state.seenKeys],
      stats: { ...this.state.stats },
      env: { ...this.state.env },
      config: structuredClone(this.state.config),
    };
  }

  /**
   * 从持久化状态恢复（重启续跑）。恢复键无历史时戳，统一按 state.now 起算
   * （保守保留一个 TTL 窗口）；恢复后如需当天判定，先 refreshNow。
   */
  restoreState(state: GatesState): void {
    this.state = state;
    this.seenAt = new Map();
    for (const key of state.seenKeys) this.seenAt.set(key, state.now);
    this.opsSinceTrim = 0;
  }

  /** 显式注入最新时刻（每轮 wake 取一次；残余风险③）。 */
  refreshNow(now: number): void {
    this.state = { ...this.state, now };
  }

  /** 更新闸门②环境快照（接线层在每轮判定前刷新）。 */
  setEnvironment(env: EnvironmentContext): void {
    this.state = { ...this.state, env: { ...env } };
  }

  /** 更新闸门③自适应统计（忽略/采纳窗口由接线层维护）。 */
  setStats(stats: GatesStats): void {
    this.state = { ...this.state, stats: { ...stats } };
  }

  /** 归一化入队；返回归一化后的信号（便于调用方关联/dedupeKey 复用）。 */
  enqueue(raw: RawSignal): Signal {
    const signal = normalizeSignal(raw, this.state.now);
    this.queue.push(signal);
    return signal;
  }

  /**
   * 判断层消费一条：decideSafely 判定 → applyGatesDelta 把增量喂回 state
   * （含幂等 seenKeys 与预算预扣）→ PREPARE 入攒批缓冲。
   * 空队列返回 null。配置错误时走保守回退（degraded=true）。
   */
  consumeNext(): ConsumedSignal | null {
    const signal = this.queue.shift();
    if (!signal) return null;
    const guarded = decideSafely(signal, this.state, this.logger);
    const decision = guarded.decision;
    this.state = applyGatesDelta(this.state, decision.delta);
    for (const key of decision.delta.seenKeysToAdd) {
      if (!this.seenAt.has(key)) this.seenAt.set(key, this.state.now);
    }
    const consumed: ConsumedSignal = {
      signal,
      decision,
      budgetCharged: decision.delta.dailySpokenDelta > 0,
      degraded: guarded.degraded,
    };
    if (decision.tier === 'PREPARE') this.prepared.push(consumed);
    this.maybeTrimSeenKeys();
    return consumed;
  }

  /** 消费当前队列全部信号（每轮 reason 阶段的常用形态）。 */
  consumeAll(): ConsumedSignal[] {
    const out: ConsumedSignal[] = [];
    for (;;) {
      const consumed = this.consumeNext();
      if (!consumed) break;
      out.push(consumed);
    }
    return out;
  }

  /**
   * PREPARE 出队（到自然开口点时交给 act）。
   *
   * 残余风险①：这些项在 consumeNext 准入时已预扣预算（delta 已喂回 state），
   * 这里只出队，绝不再次 decideBroadcast/applyGatesDelta，也不再过预算闸
   * （复扣 = 每日 10 条预算实际只剩约 5 条）。
   */
  flushPrepared(): ConsumedSignal[] {
    return this.prepared.splice(0, this.prepared.length);
  }

  /**
   * 裁剪 seenKeys：保留最近 maxSeenKeys 条且未超 TTL；返回丢弃条数。
   * 溢出时 consumeNext 自动调用，接线层也可按周期主动调用（定期裁剪）。
   */
  trimSeenKeys(): number {
    const keys = this.state.seenKeys;
    const now = this.state.now;
    const tail = keys.length > this.maxSeenKeys ? keys.slice(keys.length - this.maxSeenKeys) : keys;
    const kept = tail.filter((key) => {
      const at = this.seenAt.get(key);
      if (at === undefined) return true; // 无时戳（外部恢复未登记）保守保留
      return now - at <= this.seenKeyTtlMs;
    });
    const keptSet = new Set(kept);
    for (const key of [...this.seenAt.keys()]) {
      if (!keptSet.has(key)) this.seenAt.delete(key);
    }
    const dropped = keys.length - kept.length;
    if (dropped > 0) {
      this.state = { ...this.state, seenKeys: kept };
    }
    return dropped;
  }

  private maybeTrimSeenKeys(): void {
    this.opsSinceTrim++;
    if (this.state.seenKeys.length > this.maxSeenKeys || this.opsSinceTrim >= SEEN_TRIM_OPS_INTERVAL) {
      this.opsSinceTrim = 0;
      this.trimSeenKeys();
    }
  }
}
