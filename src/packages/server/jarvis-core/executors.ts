/**
 * jarvis-core · 执行器骨架（任务 26，契约依据 06-11 §11.1 / §11.4）
 *
 * 本文件提供三组骨架能力（均为纯逻辑 + 可注入依赖，不含具体信号源/出口）：
 * 1. 幂等执行：触发器/执行分离 + dedupeKey 去重 + 失败指数退避（§11.1，AWS
 *    标准模式；任务 08 的重试工具落地后再提取为共用件）；
 * 2. 降级三路径（§11.4）：
 *    - 信号源失败 → collectSignalsSafely 逐源隔离，只记日志不吞循环；
 *    - claude/语音通道不可用 → deliverDecision 降级「上屏通知」；
 *    - 判断层配置错误 → decideSafely 回退「仅播报评分 >85」安全默认；
 * 3. 串行互斥：不并发两次 claude 调用（与 voice-companion-service.ts:1021 的
 *    withMutex 同型；那边是模块私有函数，这里自持一份，接线层共用同一实例）。
 *
 * 骨架边界：具体信号源属任务 30，播报出口/契约通道属 09·B 与主脑接线；
 * 本文件只定义出口接口（DeliveryPorts）与执行语义。
 */

import {
  IMMEDIATE_SCORE,
  computeRelevanceScore,
  decideBroadcast,
  evaluateDisruption,
  EMPTY_GATES_DELTA,
  type BroadcastDecision,
  type GatesConfig,
  type GatesState,
  type Signal,
} from '../../shared/broadcast-gates.js';
import { createLogger } from '../utils/logger.js';

// ============================================================================
// 日志与观测出口
// ============================================================================

/** 可注入日志门面（与 utils/logger 的 Logger 结构兼容；测试传静默桩）。 */
export interface JarvisLogger {
  log(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** 模块默认日志（主脑接线可用 jarvisLogger，或替换为 ⑭ 观测出口）。 */
export const jarvisLogger: JarvisLogger = createLogger('JarvisCore');

/** 结构化观测事件（⑦ 心跳运行/降级事件 → ⑭ system 类；接线层转发）。 */
export interface JarvisEvent {
  /** 事件类型，如 'executor.executed' | 'delivery.degraded' | 'decision.fallback'。 */
  kind: string;
  level: 'debug' | 'warn' | 'error';
  message: string;
  /** 事件时刻（epoch ms，调用方注入）。 */
  at: number;
  detail?: Record<string, unknown>;
}

export type JarvisEventSink = (event: JarvisEvent) => void;

/** 调用观测出口并把钩子自身的异常吞掉（观测失败不能影响主链路）。 */
function emit(sink: JarvisEventSink | undefined, logger: JarvisLogger, event: JarvisEvent): void {
  if (!sink) return;
  try {
    sink(event);
  } catch (error) {
    logger.warn(`观测出口 ${event.kind} 抛错（已忽略）:`, error);
  }
}

// ============================================================================
// 串行互斥（不并发两次 claude 调用）
// ============================================================================

export interface Mutex {
  /** 串行执行：上一次（无论成败）结束后才轮到下一次。 */
  run<T>(fn: () => T | Promise<T>): Promise<T>;
}

/**
 * 串行互斥队列。语义与 voice-companion-service.ts:1021 的 withMutex 一致：
 * 前一个任务失败（reject）不阻断后续任务。
 */
export function createMutex(): Mutex {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => T | Promise<T>): Promise<T> {
      const result = tail.then(fn, fn);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

// ============================================================================
// 失败重试退避（§11.1 / §8.2 AWS 标准模式）
// ============================================================================

export interface RetryPolicy {
  /** 总尝试次数（首次执行也算 1 次）。 */
  maxAttempts: number;
  /** 首次退避基数（ms）。 */
  baseDelayMs: number;
  /** 退避倍数（指数）。 */
  factor: number;
  /** 单次退避上限（ms）。 */
  maxDelayMs: number;
}

/** 初始值非实测（待 ⑭ 观测/⑮ 标定）；任务 08 落地后提取共用。 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  factor: 2,
  maxDelayMs: 30_000,
};

/** 第 attempt 次失败后的退避时长：base · factor^(attempt-1)，封顶 maxDelayMs。 */
export function backoffDelayMs(attempt: number, policy: Pick<RetryPolicy, 'baseDelayMs' | 'factor' | 'maxDelayMs'> = DEFAULT_RETRY_POLICY): number {
  return Math.min(policy.maxDelayMs, Math.round(policy.baseDelayMs * policy.factor ** (attempt - 1)));
}

export interface RetryOptions {
  policy?: Partial<RetryPolicy>;
  /** 可注入睡眠（测试用；默认真实 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 重试前回调（观测）。 */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 指数退避重试。全部尝试失败后抛最后一次的异常（由调用方决定隔离策略）。
 */
export async function retryWithBackoff<T>(fn: (attempt: number) => T | Promise<T>, options: RetryOptions = {}): Promise<T> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= policy.maxAttempts) break;
      const delayMs = backoffDelayMs(attempt, policy);
      options.onRetry?.(attempt, error, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

// ============================================================================
// 幂等执行器（触发器/执行分离 + dedupeKey 去重 + 失败退避）
// ============================================================================

export type ExecutorStatus = 'executed' | 'duplicate' | 'in_flight' | 'failed';

export interface ExecutionRequest {
  /** 幂等键（06-11 §11.1；与判断层 seenKeys 同源）。 */
  dedupeKey: string;
  /** 事件类型（观测用）。 */
  kind?: string;
}

export interface ExecutorResult {
  status: ExecutorStatus;
  dedupeKey: string;
  kind?: string;
  /** 实际执行次数（重复/在途为 0）。 */
  attempts: number;
  durationMs: number;
  error?: unknown;
}

export interface IdempotentExecutorOptions {
  retry?: Partial<RetryPolicy>;
  /** 已完成键保留上限（自定 500；超出丢最旧，与 seenKeys 同源取舍）。 */
  maxRememberedKeys?: number;
  /** 动作是否串行（默认 true：不并发两次 claude 调用，§12.3 主链路隔离）。 */
  serial?: boolean;
  /** 可注入睡眠（测试用）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 可注入时钟（默认 Date.now；仅用于耗时统计）。 */
  now?: () => number;
  logger?: JarvisLogger;
  /** 每次 submit 的结果观测出口（⑭；含重复/在途/失败）。 */
  onResult?: (result: ExecutorResult) => void;
  /** 结构化事件出口（⑭ system 类；与 onResult 二选一或并存）。 */
  onEvent?: JarvisEventSink;
}

/** 已完成键保留上限初始值（自定非实测；⑮ 标定）。 */
export const DEFAULT_MAX_REMEMBERED_KEYS = 500;

/**
 * 幂等执行器。
 *
 * - 同 dedupeKey 只执行一次：已完成 → 'duplicate'；在途 → 'in_flight'；
 * - 动作失败 → 指数退避重试（DEFAULT_RETRY_POLICY），重试耗尽 → 'failed'
 *   并熔断（同键后续 submit 直接回 'failed'，不自动再试，防毒循环；
 *   clearFailure 可人工解禁）；
 * - submit 永不 reject：执行失败只体现在结果里（一个失败不吞循环）；
 * - serial=true（默认）时所有动作经内部互斥队列，杜绝并发 claude 调用。
 */
export class IdempotentExecutor {
  private readonly completed = new Set<string>();
  private readonly failed = new Map<string, { attempts: number; error: unknown }>();
  private readonly inFlight = new Set<string>();
  private readonly mutex = createMutex();
  private readonly retry: Partial<RetryPolicy>;
  private readonly maxRememberedKeys: number;
  private readonly serial: boolean;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly logger: JarvisLogger;
  private readonly onResult?: (result: ExecutorResult) => void;
  private readonly onEvent?: JarvisEventSink;

  constructor(options: IdempotentExecutorOptions = {}) {
    this.retry = options.retry ?? {};
    this.maxRememberedKeys = options.maxRememberedKeys ?? DEFAULT_MAX_REMEMBERED_KEYS;
    this.serial = options.serial ?? true;
    this.sleep = options.sleep;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? jarvisLogger;
    this.onResult = options.onResult;
    this.onEvent = options.onEvent;
  }

  hasCompleted(dedupeKey: string): boolean {
    return this.completed.has(dedupeKey);
  }

  hasFailed(dedupeKey: string): boolean {
    return this.failed.has(dedupeKey);
  }

  /** 解除失败熔断（人工/显式重试；默认不自动重试，防毒循环）。 */
  clearFailure(dedupeKey: string): boolean {
    return this.failed.delete(dedupeKey);
  }

  /** 清空全部记忆（测试/重启；生产重启直接新建实例）。 */
  reset(): void {
    this.completed.clear();
    this.failed.clear();
    this.inFlight.clear();
  }

  /** 触发一次执行；同键已完成/在途/熔断则直接返回对应状态，不执行动作。 */
  async submit(request: ExecutionRequest, action: () => void | Promise<void>): Promise<ExecutorResult> {
    const dedupeKey = request.dedupeKey;
    const kind = request.kind;
    const startedAt = this.now();

    const finish = (status: ExecutorStatus, attempts: number, error?: unknown): ExecutorResult => {
      const result: ExecutorResult = {
        status,
        dedupeKey,
        kind,
        attempts,
        durationMs: this.now() - startedAt,
        ...(error === undefined ? {} : { error }),
      };
      if (this.onResult) {
        try {
          this.onResult(result);
        } catch (hookError) {
          this.logger.warn('执行器结果观测出口抛错（已忽略）:', hookError);
        }
      }
      emit(this.onEvent, this.logger, {
        kind: `executor.${status}`,
        level: status === 'failed' ? 'error' : 'debug',
        message: `执行器 ${status}: ${dedupeKey}`,
        at: this.now(),
        detail: { attempts, kind },
      });
      return result;
    };

    if (this.completed.has(dedupeKey)) return finish('duplicate', 0);
    const quarantined = this.failed.get(dedupeKey);
    if (quarantined) return finish('failed', quarantined.attempts, quarantined.error);
    if (this.inFlight.has(dedupeKey)) return finish('in_flight', 0);

    this.inFlight.add(dedupeKey);
    let attempts = 0;
    try {
      const runRetry = (): Promise<void> =>
        retryWithBackoff<void>(
          async (attempt) => {
            attempts = attempt;
            await action();
          },
          {
            policy: this.retry,
            ...(this.sleep ? { sleep: this.sleep } : {}),
            onRetry: (attempt, error, delayMs) => {
              this.logger.warn(`执行失败，${delayMs}ms 后重试(第 ${attempt + 1} 次): ${dedupeKey}`, error);
            },
          },
        );
      if (this.serial) {
        await this.mutex.run(runRetry);
      } else {
        await runRetry();
      }
      this.completed.add(dedupeKey);
      this.trimCompleted();
      return finish('executed', attempts);
    } catch (error) {
      // 熔断：同键后续 submit 不再自动执行，等待 clearFailure 或换键。
      this.failed.set(dedupeKey, { attempts, error });
      this.trimFailed();
      this.logger.error(`执行最终失败（已熔断，等待人工解禁）: ${dedupeKey}`, error);
      return finish('failed', attempts, error);
    } finally {
      this.inFlight.delete(dedupeKey);
    }
  }

  private trimCompleted(): void {
    while (this.completed.size > this.maxRememberedKeys) {
      const oldest = this.completed.values().next().value;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
  }

  /** 熔断账本同样限量：丢最旧（被丢的键可能再重试一次，取舍与 completed 一致）。 */
  private trimFailed(): void {
    while (this.failed.size > this.maxRememberedKeys) {
      const oldest = this.failed.keys().next().value;
      if (oldest === undefined) break;
      this.failed.delete(oldest);
    }
  }
}

// ============================================================================
// 降级路径 1：信号源失败只记日志不吞循环
// ============================================================================

/** 单路信号源（任务 30 落地六路；此处只约定读取接口）。 */
export interface SignalSource<TRaw> {
  /** 源名（日志/开关/观测用，如 'agent-state'、'system-health'）。 */
  name: string;
  /** 读取一批原始信号（TRaw 本身不是数组；同步/异步均可）。 */
  read: () => TRaw | readonly TRaw[] | Promise<TRaw | readonly TRaw[]>;
}

export interface ObserveFailure {
  source: string;
  error: unknown;
}

export interface ObserveResult<TRaw> {
  signals: TRaw[];
  failures: ObserveFailure[];
}

/**
 * 逐源隔离地读取信号（§11.4 降级路径 1）：某源抛错只记日志并登记 failures，
 * 其余源照常读取；整体永不抛出（不吞循环）。
 */
export async function collectSignalsSafely<TRaw>(
  sources: readonly SignalSource<TRaw>[],
  options: { logger?: JarvisLogger; onSourceError?: (failure: ObserveFailure) => void } = {},
): Promise<ObserveResult<TRaw>> {
  const logger = options.logger ?? jarvisLogger;
  const signals: TRaw[] = [];
  const failures: ObserveFailure[] = [];
  for (const source of sources) {
    try {
      const out = await source.read();
      if (Array.isArray(out)) {
        signals.push(...(out as TRaw[]));
      } else if (out !== undefined && out !== null) {
        signals.push(out as TRaw);
      }
    } catch (error) {
      failures.push({ source: source.name, error });
      logger.error(`信号源 ${source.name} 读取失败（隔离，不吞循环）:`, error);
      // 钩子异常同样隔离：函数契约是「整体永不抛出」，调用方钩子抛错也不能破坏它
      try {
        options.onSourceError?.({ source: source.name, error });
      } catch (hookError) {
        logger.error('onSourceError 钩子抛错（隔离）:', hookError);
      }
    }
  }
  return { signals, failures };
}

// ============================================================================
// 降级路径 2：claude/语音通道不可用 → 降级上屏通知
// ============================================================================

export type DeliveryChannel = 'voice' | 'notice' | 'store' | 'prepare' | 'none';

/** 降级原因（§11.4 路径 2）。 */
export type DeliveryDegradeReason = 'channel_unavailable';

/**
 * 动作出口（接线层注入；本骨架不实现任何出口）：
 * - speak   = 口播（经语音契约通道，主脑接线，最后一厘米）；
 * - notice  = 上屏通知（通道不可用时的降级出口）；
 * - store   = 沉淀（写记忆/日志，STORE 档）；
 * - prepare = 准备（骨架占位，任务 31 充实）。
 */
export interface DeliveryPorts {
  speak?: (signal: Signal, decision: BroadcastDecision) => void | Promise<void>;
  notice?: (signal: Signal, decision: BroadcastDecision, reason: DeliveryDegradeReason) => void | Promise<void>;
  store?: (signal: Signal, decision: BroadcastDecision) => void | Promise<void>;
  prepare?: (signal: Signal, decision: BroadcastDecision) => void | Promise<void>;
}

export interface DeliveryResult {
  channel: DeliveryChannel;
  degraded: boolean;
  reason?: DeliveryDegradeReason;
  error?: unknown;
}

export interface DeliveryOptions {
  logger?: JarvisLogger;
  onResult?: (result: DeliveryResult, signal: Signal, decision: BroadcastDecision) => void;
}

/**
 * 按决策四档路由到出口；SPEAK 通道缺失/抛错时降级 notice（§11.4 路径 2）。
 * 本函数永不抛出：出口失败只记日志并落 degraded 标记（不阻塞语音主链路）。
 */
export async function deliverDecision(
  signal: Signal,
  decision: BroadcastDecision,
  ports: DeliveryPorts,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const logger = options.logger ?? jarvisLogger;
  let result: DeliveryResult;
  switch (decision.tier) {
    case 'SPEAK':
      result = await deliverSpeak(signal, decision, ports, logger);
      break;
    case 'PREPARE':
      result = await deliverPlaceholder(ports.prepare, signal, decision, 'prepare', logger, 'PREPARE 准备出口未接（骨架占位，任务 31 充实）');
      break;
    case 'STORE':
      result = await deliverPlaceholder(ports.store, signal, decision, 'store', logger, 'STORE 沉淀出口未接，仅记日志');
      break;
    case 'SILENT':
    default:
      result = { channel: 'none', degraded: false };
      break;
  }
  if (options.onResult) {
    try {
      options.onResult(result, signal, decision);
    } catch (error) {
      logger.warn('deliverDecision 观测出口抛错（已忽略）:', error);
    }
  }
  return result;
}

async function deliverSpeak(
  signal: Signal,
  decision: BroadcastDecision,
  ports: DeliveryPorts,
  logger: JarvisLogger,
): Promise<DeliveryResult> {
  if (ports.speak) {
    try {
      await ports.speak(signal, decision);
      return { channel: 'voice', degraded: false };
    } catch (error) {
      // §11.4：claude 通道不可用 → 降级上屏通知，不阻塞语音主链路。
      logger.warn('口播通道不可用，降级上屏通知:', error);
      return degradeToNotice(signal, decision, ports.notice, error, logger);
    }
  }
  logger.warn('口播通道未接，降级上屏通知');
  return degradeToNotice(signal, decision, ports.notice, undefined, logger);
}

async function degradeToNotice(
  signal: Signal,
  decision: BroadcastDecision,
  notice: DeliveryPorts['notice'],
  cause: unknown,
  logger: JarvisLogger,
): Promise<DeliveryResult> {
  if (!notice) {
    logger.error('上屏通知出口未接，降级仅记日志（不吞循环）', cause ?? '');
    return { channel: 'none', degraded: true, reason: 'channel_unavailable', error: cause };
  }
  try {
    await notice(signal, decision, 'channel_unavailable');
    return { channel: 'notice', degraded: true, reason: 'channel_unavailable' };
  } catch (error) {
    logger.error('上屏通知出口也失败，降级仅记日志（不吞循环）:', error);
    return { channel: 'none', degraded: true, reason: 'channel_unavailable', error };
  }
}

async function deliverPlaceholder(
  port: ((signal: Signal, decision: BroadcastDecision) => void | Promise<void>) | undefined,
  signal: Signal,
  decision: BroadcastDecision,
  channel: Extract<DeliveryChannel, 'prepare' | 'store'>,
  logger: JarvisLogger,
  missingMessage: string,
): Promise<DeliveryResult> {
  if (!port) {
    logger.warn(missingMessage);
    return { channel: 'none', degraded: false };
  }
  try {
    await port(signal, decision);
    return { channel, degraded: false };
  } catch (error) {
    logger.error(`${channel} 出口失败（仅记日志，不吞循环）:`, error);
    return { channel: 'none', degraded: true, error };
  }
}

// ============================================================================
// 降级路径 3：判断层配置错误 → 回退「仅播报评分 >85」
// ============================================================================

export interface GuardedDecision {
  decision: BroadcastDecision;
  /** 是否走了保守回退（配置校验失败或判定抛错）。 */
  degraded: boolean;
  /** 配置错误描述（仅 degraded=true 时）。 */
  configError?: string;
}

function isBadNumber(value: unknown, min: number, max: number): boolean {
  return typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max;
}

/** 判断层配置体检；返回错误描述，null = 通过。 */
export function validateGatesConfig(config: GatesConfig | undefined | null): string | null {
  if (!config || typeof config !== 'object') return 'config 缺失';
  const bad: string[] = [];
  if (isBadNumber(config.relevanceThreshold, 0, 100)) bad.push('relevanceThreshold');
  if (isBadNumber(config.disruptionThreshold, 0, 100)) bad.push('disruptionThreshold');
  if (isBadNumber(config.deepNightDisruption, 0, 100)) bad.push('deepNightDisruption');
  if (isBadNumber(config.quietBypassScore, 0, 100)) bad.push('quietBypassScore');
  if (isBadNumber(config.immediateScore, 0, 100)) bad.push('immediateScore');
  if (isBadNumber(config.baseDailyBudget, 0, 50)) bad.push('baseDailyBudget');
  if (isBadNumber(config.speechSubQuota, 0, 50)) bad.push('speechSubQuota');
  if (isBadNumber(config.ignoreRateDowngrade, 0, 1)) bad.push('ignoreRateDowngrade');
  if (isBadNumber(config.adoptRateUpgrade, 0, 1)) bad.push('adoptRateUpgrade');
  if (isBadNumber(config.budgetDownFactor, 0, 10)) bad.push('budgetDownFactor');
  if (isBadNumber(config.budgetUpFactor, 0, 10)) bad.push('budgetUpFactor');
  if (!config.deepNight || isBadNumber(config.deepNight.startMinutes, 0, 1439) || isBadNumber(config.deepNight.endMinutes, 0, 1439)) {
    bad.push('deepNight');
  }
  if (!Array.isArray(config.focusWindows)) bad.push('focusWindows');
  return bad.length > 0 ? `配置项非法: ${bad.join(', ')}` : null;
}

/** 环境打扰度读取；环境不可读（病态快照）按最大打扰报告（保守）。 */
function safeDisruption(state: GatesState | undefined): number {
  try {
    return evaluateDisruption(state?.env ?? {});
  } catch {
    return 100;
  }
}

/** 最终兜底：连保守回退都抛错时落 SILENT（仅记日志，绝不外抛）。 */
function lastResortDecision(signal: Signal): BroadcastDecision {
  let score = 0;
  try {
    score = computeRelevanceScore(signal);
  } catch {
    score = 0;
  }
  return {
    tier: 'SILENT',
    reason: 'low_relevance',
    score,
    disruption: 100,
    budget: 0,
    duplicate: false,
    delta: { seenKeysToAdd: [signal.dedupeKey], dailySpokenDelta: 0, instantSpeechDelta: 0 },
  };
}

/** 组装保守回退决策；保守回退自身抛错时再降一级（绝不外抛）。 */
function buildFallback(
  signal: Signal,
  state: GatesState | undefined,
  logger: JarvisLogger,
  configError: string,
): GuardedDecision {
  try {
    return { decision: conservativeDecide(signal, state), degraded: true, configError };
  } catch (error) {
    logger.error('保守回退自身抛错，降级为 SILENT（仅记日志）:', error);
    return { decision: lastResortDecision(signal), degraded: true, configError };
  }
}

/**
 * 安全默认（§11.4 降级路径 3）：配置不可信时只信「评分 >85 立即口播」，
 * 其余一律 STORE（不开口但不丢，M3）。
 *
 * 理由字段借用 'budget_exhausted' 表达「不开口」——09·A 的 BroadcastReason
 * 联合类型暂无 config_error 档；不改共享契约，接线层⑦上报以 degraded +
 * configError 字段区分真实原因。
 */
export function conservativeDecide(signal: Signal, state: GatesState | undefined): BroadcastDecision {
  const score = computeRelevanceScore(signal);
  const disruption = safeDisruption(state);
  const rawBudget = state?.config?.baseDailyBudget;
  const budget = typeof rawBudget === 'number' && Number.isFinite(rawBudget) ? Math.max(0, Math.min(50, Math.round(rawBudget))) : 0;
  const seenKeys = state?.seenKeys;
  if (Array.isArray(seenKeys) && seenKeys.includes(signal.dedupeKey)) {
    return { tier: 'SILENT', reason: 'duplicate', score, disruption, budget, duplicate: true, delta: EMPTY_GATES_DELTA };
  }
  const seenKeysToAdd = [signal.dedupeKey];
  if (score > IMMEDIATE_SCORE) {
    return {
      tier: 'SPEAK',
      reason: 'urgent',
      score,
      disruption,
      budget,
      duplicate: false,
      delta: { seenKeysToAdd, dailySpokenDelta: 1, instantSpeechDelta: 1 },
    };
  }
  return {
    tier: 'STORE',
    reason: 'budget_exhausted',
    score,
    disruption,
    budget,
    duplicate: false,
    delta: { seenKeysToAdd, dailySpokenDelta: 0, instantSpeechDelta: 0 },
  };
}

/**
 * 带兜底的判定入口：先体检配置、再调 09·A decideBroadcast；任一环节出错
 * 回退 conservativeDecide（§11.4 路径 3）。骨架内 SignalQueue 默认走这里。
 */
export function decideSafely(signal: Signal, state: GatesState, logger: JarvisLogger = jarvisLogger): GuardedDecision {
  const configError = validateGatesConfig(state?.config);
  if (configError) {
    logger.error(`判断层配置错误（${configError}），回退安全默认「仅播报评分 >85」`);
    return buildFallback(signal, state, logger, configError);
  }
  try {
    return { decision: decideBroadcast(signal, state), degraded: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`判断层判定抛错（${message}），回退安全默认「仅播报评分 >85」`);
    return buildFallback(signal, state, logger, message);
  }
}
