/**
 * jarvis-core · 心跳循环骨架（任务 26，06-11 §3.3 / §11.1 / §11.4）
 *
 * 四阶段（抄 Zylos/Clawdbot 的 heartbeat 模式）：
 *   wake（定时器唤醒或事件触发）→ observe（读取各路信号源当前状态）
 *   → reason（过判断层四道闸门）→ act（零动作或多动作；无动作则静默进入下一周期）。
 * 每阶段可注入回调/执行器；本文件只管「何时跑、怎么串行、失败怎么不吞循环」，
 * 不含任何具体信号源（任务 30）与播报出口（09·B/主脑接线）。
 *
 * 混合触发（06-11 §3.3）：时间心跳（默认 15 分钟，可配 5–15 分钟；初始值非实测，
 * 待 ⑭ 观测 / ⑮ 标定回写 06-12 §8.2）负责背景维护；wakeNow() 事件即时唤醒负责
 * 实时响应（绕过周期立即跑一轮）。
 *
 * 触发器/执行分离（06-11 §11.1）：定时器只登记触发意图，执行严格串行——
 * 一轮未结束前，到点的周期触发被跳过（skippedTicks++），事件唤醒被合并为紧随
 * 其后的一轮（coalescedWakes++），保证「心跳周期 > 任务执行时间时不二次触发」。
 *
 * 降级（06-11 §11.4）：单阶段异常不向外抛、不吞循环（记录后本轮降级收尾，下一
 * 周期照常）；信号源级失败隔离在 executors.collectSignalsSafely，这里只是兜底。
 */

import type { Signal } from '../../shared/broadcast-gates.js';
import { jarvisLogger, type JarvisLogger } from './executors.js';

// ============================================================================
// 周期配置（初始值非实测）
// ============================================================================

/** 默认心跳周期：15 分钟（初始值非实测；⑭→⑮ 标定后回写）。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 60_000;
/** 可配区间下界：5 分钟（初始值非实测）。 */
export const MIN_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
/** 可配区间上界：15 分钟（初始值非实测）。 */
export const MAX_HEARTBEAT_INTERVAL_MS = 15 * 60_000;

/** 把配置值归一化到 [5, 15] 分钟；非法值回落默认 15 分钟。 */
export function normalizeHeartbeatIntervalMs(intervalMs?: number): number {
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs)) return DEFAULT_HEARTBEAT_INTERVAL_MS;
  return Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.min(MAX_HEARTBEAT_INTERVAL_MS, Math.round(intervalMs)));
}

// ============================================================================
// 类型
// ============================================================================

/** 本轮唤醒路径：timer=时间心跳（背景维护）；event=事件即时唤醒（实时响应）。 */
export type HeartbeatTrigger = 'timer' | 'event';

export type HeartbeatPhaseName = 'wake' | 'observe' | 'reason' | 'act';

export interface HeartbeatCycleContext {
  trigger: HeartbeatTrigger;
  /** 自增轮号（从 1 开始，便于日志/观测串联）。 */
  cycleId: number;
  /** 本轮唤醒时刻（epoch ms，wake 时取一次，整轮共用；测试/接线可注入时钟）。 */
  now: number;
}

export interface HeartbeatPhaseError {
  phase: HeartbeatPhaseName;
  error: unknown;
}

export interface HeartbeatCycleSummary {
  cycleId: number;
  trigger: HeartbeatTrigger;
  now: number;
  durationMs: number;
  /** 本轮各阶段异常（空 = 全绿）；循环不因它们退出。 */
  errors: readonly HeartbeatPhaseError[];
  /** 是否走完 act（false = 中途降级收尾）。 */
  completed: boolean;
}

/**
 * 四阶段注入点。observe/reason/act 必填；wake 可选（如刷新环境快照、
 * 显式注入 state.now）。泛型默认按信号包形态（readonly Signal[]）。
 */
export interface HeartbeatPhases<TObserved = readonly Signal[], TReasoned = unknown> {
  wake?: (ctx: HeartbeatCycleContext) => void | Promise<void>;
  observe: (ctx: HeartbeatCycleContext) => TObserved | Promise<TObserved>;
  reason: (observed: TObserved, ctx: HeartbeatCycleContext) => TReasoned | Promise<TReasoned>;
  act: (reasoned: TReasoned, ctx: HeartbeatCycleContext) => void | Promise<void>;
}

export interface HeartbeatHooks {
  /** 每轮结束（⑦ 心跳运行 → ⑭ system 类：周期/耗时/降级）。 */
  onCycleEnd?: (summary: HeartbeatCycleSummary) => void;
  /** 阶段异常的结构化出口（日志之外）。 */
  onPhaseError?: (info: HeartbeatPhaseError, ctx: HeartbeatCycleContext) => void;
  /** 周期触发因上一轮未结束被跳过（触发器/执行分离生效的证据）。 */
  onTickSkipped?: (info: { at: number }) => void;
  /** 事件唤醒因上一轮未结束被合并为紧随其后的一轮。 */
  onWakeCoalesced?: (info: { at: number }) => void;
}

export interface HeartbeatStats {
  /** 已执行轮数（含事件唤醒与合并轮）。 */
  cycles: number;
  /** 因上一轮未结束被跳过的周期触发数（§11.1 禁止同周期二次触发）。 */
  skippedTicks: number;
  /** 因上一轮未结束被合并的事件唤醒数。 */
  coalescedWakes: number;
  /** 累计阶段异常数（降级事件，⑦ 观测用）。 */
  errors: number;
}

export interface HeartbeatOptions<TObserved = readonly Signal[], TReasoned = unknown> {
  phases: HeartbeatPhases<TObserved, TReasoned>;
  /** 周期（ms）；默认 15 分钟，归一化到 5–15 分钟区间。 */
  intervalMs?: number;
  /** 取时钟函数（默认 Date.now；接线层可注入，保证与 state.now 同源）。 */
  now?: () => number;
  hooks?: HeartbeatHooks;
  logger?: JarvisLogger;
}

// ============================================================================
// 心跳循环
// ============================================================================

/**
 * 心跳循环。start() 后由定时器按周期触发；wakeNow() 走事件即时唤醒。
 * 两条路径共用同一执行器，严格串行、绝不重叠。
 */
export class Heartbeat<TObserved = readonly Signal[], TReasoned = unknown> {
  readonly intervalMs: number;
  private readonly phases: HeartbeatPhases<TObserved, TReasoned>;
  private readonly now: () => number;
  private readonly hooks: HeartbeatHooks;
  private readonly logger: JarvisLogger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private pendingEventWake = false;
  private idleWaiters: Array<() => void> = [];
  private readonly counters: HeartbeatStats = { cycles: 0, skippedTicks: 0, coalescedWakes: 0, errors: 0 };

  constructor(options: HeartbeatOptions<TObserved, TReasoned>) {
    this.phases = options.phases;
    this.intervalMs = normalizeHeartbeatIntervalMs(options.intervalMs);
    this.now = options.now ?? Date.now;
    this.hooks = options.hooks ?? {};
    this.logger = options.logger ?? jarvisLogger;
  }

  /** 周期触发是否已启动。 */
  get started(): boolean {
    return this.timer !== null;
  }

  /** 是否有轮次正在执行（running 或合并轮待跑）。 */
  get busy(): boolean {
    return this.running;
  }

  get stats(): Readonly<HeartbeatStats> {
    return { ...this.counters };
  }

  /** 启动周期触发（幂等）。不把进程钉住：定时器 unref，接线层另有常驻引用。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.onTick(), this.intervalMs);
    this.timer.unref?.();
    this.logger.log(`心跳循环启动：周期 ${Math.round(this.intervalMs / 60_000)} 分钟（初始值非实测）`);
  }

  /** 停止周期触发（幂等）；已在执行的一轮不受影响。 */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.logger.log('心跳循环停止');
  }

  /**
   * 事件即时唤醒：绕过周期立即跑一轮。
   * @returns true = 本轮已开跑；false = 上一轮未结束，已合并为紧随其后的一轮
   *          （不丢事件；合并轮 trigger 仍为 'event'）。
   */
  wakeNow(): boolean {
    if (this.running) {
      this.pendingEventWake = true;
      this.counters.coalescedWakes++;
      this.logger.debug('事件唤醒时上一轮未结束，已合并为紧随其后的一轮');
      this.callHook('onWakeCoalesced', () => this.hooks.onWakeCoalesced?.({ at: this.now() }));
      return false;
    }
    this.logger.debug('事件即时唤醒：立即跑一轮');
    void this.runLoop('event');
    return true;
  }

  /** 等待回到空闲（当前轮与合并轮都结束）；测试与优雅停机用。 */
  whenIdle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  // --------------------------------------------------------------------------
  // 触发器层（只登记意图，不做执行）
  // --------------------------------------------------------------------------

  private onTick(): void {
    if (this.running) {
      // 触发器/执行分离（§11.1）：上一轮未收尾，本周期不再触发。
      this.counters.skippedTicks++;
      this.callHook('onTickSkipped', () => this.hooks.onTickSkipped?.({ at: this.now() }));
      return;
    }
    void this.runLoop('timer');
  }

  // --------------------------------------------------------------------------
  // 执行层（严格串行；合并轮紧随其后）
  // --------------------------------------------------------------------------

  private async runLoop(trigger: HeartbeatTrigger): Promise<void> {
    this.running = true;
    try {
      let nextTrigger: HeartbeatTrigger = trigger;
      for (;;) {
        await this.executeCycle(nextTrigger);
        if (!this.pendingEventWake) break;
        this.pendingEventWake = false;
        nextTrigger = 'event';
      }
    } catch (error) {
      // 兜底：执行器自身异常也不能吞掉循环（正常路径各阶段已隔离）。
      this.counters.errors++;
      this.logger.error('心跳轮执行异常（循环继续）:', error);
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private async executeCycle(trigger: HeartbeatTrigger): Promise<HeartbeatCycleSummary> {
    const cycleId = ++this.counters.cycles;
    const now = this.now();
    const ctx: HeartbeatCycleContext = { trigger, cycleId, now };
    const errors: HeartbeatPhaseError[] = [];
    let completed = false;

    // wake 可选；失败不阻断（如环境快照刷新失败仍应继续读信号）。
    if (this.phases.wake) {
      await this.runPhase('wake', () => this.phases.wake!(ctx), errors, ctx);
    }

    let observed!: TObserved;
    const observedOk = await this.runPhase(
      'observe',
      async () => {
        observed = await this.phases.observe(ctx);
      },
      errors,
      ctx,
    );
    if (observedOk) {
      let reasoned!: TReasoned;
      const reasonedOk = await this.runPhase(
        'reason',
        async () => {
          reasoned = await this.phases.reason(observed, ctx);
        },
        errors,
        ctx,
      );
      if (reasonedOk) {
        completed = await this.runPhase('act', () => this.phases.act(reasoned, ctx), errors, ctx);
      }
    }

    const summary: HeartbeatCycleSummary = {
      cycleId,
      trigger,
      now,
      durationMs: this.now() - now,
      errors,
      completed,
    };
    this.logger.debug(
      `心跳轮 ${cycleId} 结束 trigger=${trigger} completed=${completed} errors=${errors.length} 耗时=${summary.durationMs}ms`,
    );
    this.callHook('onCycleEnd', () => this.hooks.onCycleEnd?.(summary));
    return summary;
  }

  private async runPhase(
    name: HeartbeatPhaseName,
    fn: () => void | Promise<void>,
    errors: HeartbeatPhaseError[],
    ctx: HeartbeatCycleContext,
  ): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (error) {
      this.counters.errors++;
      errors.push({ phase: name, error });
      this.logger.error(`心跳阶段 ${name} 异常（轮 ${ctx.cycleId}，已降级收尾、循环继续）:`, error);
      this.callHook('onPhaseError', () => this.hooks.onPhaseError?.({ phase: name, error }, ctx));
      return false;
    }
  }

  /** 观测钩子自身抛错不能影响循环/链路。 */
  private callHook(name: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.logger.warn(`心跳钩子 ${name} 抛错（已忽略）:`, error);
    }
  }
}
