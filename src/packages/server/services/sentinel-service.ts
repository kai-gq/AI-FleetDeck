/**
 * 任务33 接线 · 活动监视器落生产（W11）
 *
 * 把 jarvis-core/sentinel（W10 纯模块，零改动）接进生产三条腿：
 * 1. **持久化**：SentinelPhaseState 落 XDG 自己的 JSON（原子写 tmp+rename，
 *    与 reflection/run-state 同型；损坏容错为初始态 + warn）；
 * 2. **每日评估**：cron 00:10（cron-service 第 7 个注册点）评「昨日」——
 *    collectDayMetricsSafely（生产 StatsPort：broadcasts 计数 + complaints）
 *    → evaluateSentinelPhase（同日幂等）→ 持久化 + ⑭ 事件
 *    （createSentinelLogObserver，source='sentinel'）；
 * 3. **指令落地 v1 = /process 事件闸口**：event=true 的输入过闸——
 *    store-only（degraded 相位）→ 抑制、返回 noop 形应答（不调 LLM、不出声）；
 *    speakAllowed 但 speechFactor<1（warning/recovering）→ 按
 *    hash(文本+指令日键) 确定性降频；normal/开关关 → 放行。
 *    **零 client 改动**；非事件（老板说话）永不过闸。
 *
 * 失败隔离（全链路口径）：闸口自身任何异常 → fail-open 放行（绝不吞播报）；
 * 每日评估 runSentinelDailyScan 永不上抛（调度层安全）。
 * 开关 TC_JARVIS_SENTINEL（缺省开）在 resolveSentinelConfig 内判。
 *
 * 边界（冻结，见 jarvis-core/sentinel/types.ts）：只按相位给相对系数/档位上限，
 * 不与 09·A 闸门内自适应叠加预算数值；服务端生产者口（晨报/bolba/配额）当前
 * speak 口=日志口——若后续接真实口播通道，接同一 clamp 助手（登记见 W11 收口）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createLogger } from '../utils/logger.js';
import { logEvent } from '../data/system-log.js';
import { defaultSentinelStatsPort } from './sentinel-stats-provider.js';
import { logDialogMessage } from './activity-log.js';
import { jarvisLogger, type JarvisLogger } from '../jarvis-core/executors.js';
import {
  buildSentinelDirective,
  collectDayMetricsSafely,
  createSentinelLogObserver,
  createSentinelPhaseState,
  directiveEvent,
  evaluateSentinelPhase,
  isSentinelPhase,
  localDayKey,
  phaseTransitionEvent,
  resolveSentinelConfig,
  startOfLocalDay,
  statsDegradedEvent,
  type ResolvedSentinelConfig,
  type SentinelConfig,
  type SentinelDegradeDirective,
  type SentinelEventSink,
  type SentinelPhaseEvaluation,
  type SentinelPhaseState,
  type SentinelStatsPort,
} from '../jarvis-core/sentinel/index.js';

const log = createLogger('Sentinel');

// ─── 持久化路径（XDG 口径；测试一律显式注入临时文件） ───

/** 活动监视器状态根目录（生产；测试须显式注入临时文件）。 */
export function defaultSentinelBaseDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'tide-commander', 'jarvis-sentinel');
}

/** 相位机状态默认文件。 */
export function defaultSentinelStatePath(): string {
  return path.join(defaultSentinelBaseDir(), 'phase-state.json');
}

// ─── 闸口 ───

export type SentinelEventGateDecision = 'pass' | 'store-only' | 'throttle';

export interface SentinelEventGateResult {
  decision: SentinelEventGateDecision;
  /** 现行指令（normal/开关关 = null；throttle/store-only 时必有，供观测记录）。 */
  directive: SentinelDegradeDirective | null;
}

/** FNV-1a 32 位 → [0,1)；确定性（同文本+同日键恒同值，可复现、可测试）。 */
function hash01(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * 确定性保留判定（指令 speechFactor = 相对频率系数）：
 * factor ≥ 1 全放行、≤ 0 全抑制；否则 hash(日键+文本) < factor 才保留。
 * 用指令自带 day 作日键：同一次评估的指令日内决策稳定（不随调用时刻抖动）。
 */
export function shouldKeepByHash(text: string, day: string, factor: number): boolean {
  if (factor >= 1) return true;
  if (factor <= 0) return false;
  return hash01(`${day}\u0000${text}`) < factor;
}

// ─── 服务（类 + 生产单例；测试注入临时文件/替身端口） ───

export interface SentinelServiceDeps {
  /** 状态文件（缺省 defaultSentinelStatePath()；测试必须显式注入临时文件）。 */
  filePath?: string;
  /** 统计端口（缺省生产 defaultSentinelStatsPort()）。 */
  port?: SentinelStatsPort;
  /** 配置（enabled/thresholds；缺省环境开关 + 缺省阈值）。 */
  config?: SentinelConfig;
  /** ⑭ 事件出口（缺省 createSentinelLogObserver(logEvent)）。 */
  sink?: SentinelEventSink;
  logger?: JarvisLogger;
}

export class SentinelService {
  readonly filePath: string;
  private readonly port: SentinelStatsPort;
  private readonly sink: SentinelEventSink;
  private readonly logger: JarvisLogger;
  private readonly rawConfig: SentinelConfig;
  private readonly resolved: ResolvedSentinelConfig;
  private state: SentinelPhaseState | null = null;

  constructor(deps: SentinelServiceDeps = {}) {
    this.filePath = deps.filePath ?? defaultSentinelStatePath();
    this.port = deps.port ?? defaultSentinelStatsPort();
    this.rawConfig = deps.config ?? {};
    this.resolved = resolveSentinelConfig(this.rawConfig);
    this.logger = deps.logger ?? jarvisLogger;
    this.sink = deps.sink ?? createSentinelLogObserver(logEvent);
  }

  /** 加载相位机状态（缓存；损坏 → 初始态 + warn；缺失 → 初始态）。 */
  load(): SentinelPhaseState {
    if (this.state) return this.state;
    let parsed: Partial<SentinelPhaseState> | null = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<SentinelPhaseState>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.logger.warn(`[sentinel] 状态文件损坏（按初始态处理）: ${this.filePath}`, error);
      }
    }
    if (parsed && isSentinelPhase(parsed.phase) && typeof parsed.updatedAt === 'number') {
      this.state = {
        phase: parsed.phase,
        since: typeof parsed.since === 'number' ? parsed.since : parsed.updatedAt,
        sinceDay: typeof parsed.sinceDay === 'string' ? parsed.sinceDay : localDayKey(parsed.updatedAt),
        healthyStreakDays: typeof parsed.healthyStreakDays === 'number' ? parsed.healthyStreakDays : 0,
        lastEvaluatedDay: typeof parsed.lastEvaluatedDay === 'string' ? parsed.lastEvaluatedDay : null,
        lastVerdict: parsed.lastVerdict ?? null,
        updatedAt: parsed.updatedAt,
      };
    } else {
      if (parsed) this.logger.warn(`[sentinel] 状态文件形态非法（按初始态处理）: ${this.filePath}`);
      this.state = createSentinelPhaseState(Date.now());
    }
    return this.state;
  }

  /** 原子持久化（tmp+rename；写失败不阻断主链路，降级为下次重评）。 */
  private persist(state: SentinelPhaseState): void {
    this.state = state;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      this.logger.warn(`[sentinel] 状态写入失败（降级，下次评估重试）: ${this.filePath}`, error);
    }
  }

  /** 现相位存量指令（normal/开关关 = null；跳过/缺源路径不松闸——保护不中断）。 */
  getDirective(now?: number): SentinelDegradeDirective | null {
    if (!this.resolved.enabled) return null;
    const at = now ?? Date.now();
    const state = this.load();
    return buildSentinelDirective(state.phase, {
      day: localDayKey(at),
      at,
      verdict: state.lastVerdict ?? 'insufficient',
      thresholds: this.resolved.thresholds,
    });
  }

  /**
   * 事件闸口（纯判定 + 无副作用；调用方按结果决定抑制与落日志）。
   * 覆盖 event=true 的全部路径（客户端 reporter 事件 + task_receipt→reporter 同路）。
   */
  evaluateEventGate(text: string, now?: number): SentinelEventGateResult {
    if (!this.resolved.enabled) return { decision: 'pass', directive: null };
    const at = now ?? Date.now();
    const directive = this.getDirective(at);
    if (!directive) return { decision: 'pass', directive: null };
    if (!directive.speakAllowed || directive.speechFactor <= 0) {
      return { decision: 'store-only', directive };
    }
    const keep = shouldKeepByHash(text, directive.day, directive.speechFactor);
    return { decision: keep ? 'pass' : 'throttle', directive };
  }

  /**
   * 每日评估（评「昨日」；同日重复触发由相位机幂等保护）。
   * 缺源/端口失败 → 相位保持 + 存量为令 + degraded 事件；本体永不上抛由外层包。
   */
  async runDailyScan(now?: number): Promise<SentinelPhaseEvaluation> {
    const at = now ?? Date.now();
    const state = this.load();
    if (!this.resolved.enabled) {
      return { state, transition: null, directive: null, verdict: null, skippedReason: 'disabled' };
    }
    // 「昨日」= 本日 0 点前 1 毫秒所属本地日（跨 DST 也严格正确）
    const day = localDayKey(startOfLocalDay(at) - 1);

    const { metrics, degraded } = await collectDayMetricsSafely(this.port, day, { logger: this.logger });
    if (degraded) this.sink(statsDegradedEvent(degraded, at, day));

    const evaluation = evaluateSentinelPhase(state, metrics, at, this.rawConfig, this.logger);
    this.persist(evaluation.state);
    if (evaluation.transition) this.sink(phaseTransitionEvent(evaluation.transition));
    if (evaluation.directive) this.sink(directiveEvent(evaluation.directive));
    this.logger.log(
      `[sentinel] 每日评估 day=${day} phase=${evaluation.state.phase}` +
        ` verdict=${evaluation.verdict ?? '-'}${evaluation.skippedReason ? ` skip=${evaluation.skippedReason}` : ''}`,
    );
    return evaluation;
  }
}

// ─── 生产单例与模块级入口（cron / 路由用） ───

let singleton: SentinelService | null = null;

/** 生产单例（懒加载；构造无 I/O 副作用）。 */
export function getSentinelService(): SentinelService {
  if (!singleton) singleton = new SentinelService();
  return singleton;
}

/** 测试重置单例（不进生产调用路径）。 */
export function __resetSentinelServiceForTest(): void {
  singleton = null;
}

/** cron 入口：每日评估（永不上抛——调度层安全）。 */
export async function runSentinelDailyScan(now?: number): Promise<void> {
  try {
    await getSentinelService().runDailyScan(now);
  } catch (err) {
    log.warn('活动监视器每日评估失败（隔离，不上抛）:', err);
  }
}

/** 路由入口：事件闸口（fail-open——闸口自身缺陷绝不吞播报）。 */
export function evaluateVoiceEventGate(text: string, now?: number): SentinelEventGateResult {
  try {
    return getSentinelService().evaluateEventGate(text, now);
  } catch {
    return { decision: 'pass', directive: null };
  }
}

/** 现相位存量指令（观测/其他消费方只读；异常 → null 保守不阻断）。 */
export function getCurrentSentinelDirective(now?: number): SentinelDegradeDirective | null {
  try {
    return getSentinelService().getDirective(now);
  } catch {
    return null;
  }
}

/**
 * 被闸口抑制的事件落日志（degraded 标记；**不写 broadcast**——
 * 没有发声就没有播报行，省得污染 sentinel 自己的播报分母）。
 * 失败隔离：观测失败不影响闸口主链路。
 */
export function logSuppressedVoiceEvent(text: string, result: SentinelEventGateResult): void {
  if (result.decision === 'pass') return;
  try {
    logDialogMessage({
      direction: 'in',
      text,
      isEvent: true,
      action: `sentinel-${result.decision}`, // sentinel-store-only / sentinel-throttle（⑭ 可筛；与 decision 状态名一致）
      degraded: true,
    });
  } catch {
    // 观测出口失败静默（与 activity-log 失败隔离同型）
  }
}
