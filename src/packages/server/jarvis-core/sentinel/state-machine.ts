/**
 * jarvis-core · 活动监视器（任务 33）· 熔断相位机（纯函数）
 *
 * 相位：normal → warning → degraded → recovering → normal（阈值/判词见 types.ts、
 * stats.ts）。**跨天**节奏：每个本地自然日评估一次；同日重复评估幂等无操作。
 *
 * 迁移哲学（防抖三层）：
 * 1. **滞回**：忽略率 >40% 才进降级、≤30% 才算回正（0.3–0.4 带内不动，防阈值抖动）；
 * 2. **恶化立即、恢复缓慢**：进入 warning/degraded 不设门槛；离开 non-normal
 *    相位（warning→normal / recovering→normal）需**最小相位驻留**期满**且**
 *    连续回正同天数（交替抖动永远攒不够连续天数）；
 * 3. **连续回正**：degraded → recovering 需连续 N 天 healthy（缺源/非回正日
 *    清零续链），recovering → normal 再需驻留期满——保守起步（N 与驻留均为
 *    非实测初值，登记待 ⑭ 观测 / ⑮ 标定）。
 *
 * 边界（与 09·A 的分工，冻结）：本机只产**相位 + 降级指令对象**（复用 09 四档
 * 语义："减频率" / "只 STORE 不 SPEAK"）。指令只给 maxTier / speakAllowed /
 * speechFactor 相对系数，**不产绝对预算数值**；消费方（W11）不得把本指令与
 * `broadcast-gates.ts:42-47` 的闸门内自适应叠加计算（那是单次决策的另一旋钮）。
 *
 * 纯函数契约：now 由调用方显式注入；不读时钟、不写 I/O、不抛错（非法配置走
 * 缺省回退，与 09·A「配置错误 → 保守回退」同型）。
 */

import type { JarvisLogger } from '../executors.js';
import { createOnceLogger } from '../senses/safe.js';
import { localDayDiff, localDayKey, computeDayVerdict } from './stats.js';
import type {
  SentinelConfig,
  SentinelDayVerdict,
  SentinelDegradeDirective,
  SentinelDirectiveEvidence,
  SentinelMetrics,
  SentinelPhase,
  SentinelPhaseEvaluation,
  SentinelPhaseState,
  SentinelPhaseTransition,
  SentinelThresholds,
  SentinelTransitionReason,
} from './types.js';
import { resolveSentinelConfig, resolveSentinelThresholds } from './types.js';

/** 初始相位机状态（normal，自 now 起算）。 */
export function createSentinelPhaseState(now: number): SentinelPhaseState {
  return {
    phase: 'normal',
    since: now,
    sinceDay: localDayKey(now),
    healthyStreakDays: 0,
    lastEvaluatedDay: null,
    lastVerdict: null,
    updatedAt: now,
  };
}

// ============================================================================
// 降级指令（复用 09 档位语义；只给相对系数）
// ============================================================================

export interface SentinelDirectiveInput {
  /** 生效日（本地日键）。 */
  day: string;
  /** 产出时刻（epoch ms）。 */
  at: number;
  verdict: SentinelDayVerdict;
  /** 当日指标（证据快照；缺源传 null）。 */
  metrics?: SentinelMetrics | null;
  thresholds?: Partial<SentinelThresholds>;
}

/**
 * 相位 → 降级指令：
 * - normal     → null（无降级）；
 * - warning    → reduce-frequency：cap = SPEAK（可开口）+ speechFactor 0.5（非实测）；
 * - degraded   → store-only：cap = STORE（**只 STORE 不 SPEAK**）、不开口；
 * - recovering → reduce-frequency：恢复观察期仍保守（cap = SPEAK，factor 0.5）。
 * 消费方用 clampBroadcastTier(tier, directive.maxTier) 压 09 四档即可。
 */
export function buildSentinelDirective(
  phase: SentinelPhase,
  input: SentinelDirectiveInput,
): SentinelDegradeDirective | null {
  if (phase === 'normal') return null;
  const thresholds = resolveSentinelThresholds(input.thresholds);
  const evidence: SentinelDirectiveEvidence = {
    day: input.day,
    proactiveBroadcasts: input.metrics?.proactiveBroadcasts ?? null,
    ignoreRate: input.metrics?.ignoreRate ?? null,
    adoptRate: input.metrics?.adoptRate ?? null,
    complaints: input.metrics?.complaints ?? null,
  };
  const base = { phase, day: input.day, at: input.at, verdict: input.verdict, evidence } as const;
  switch (phase) {
    case 'warning':
      return {
        ...base,
        action: 'reduce-frequency',
        maxTier: 'SPEAK',
        speakAllowed: true,
        speechFactor: thresholds.speechFactorWhenWarning,
      };
    case 'degraded':
      return {
        ...base,
        action: 'store-only',
        maxTier: 'STORE',
        speakAllowed: false,
        speechFactor: 0,
      };
    case 'recovering':
      return {
        ...base,
        action: 'reduce-frequency',
        maxTier: 'SPEAK',
        speakAllowed: true,
        speechFactor: thresholds.speechFactorWhenRecovering,
      };
  }
}

// ============================================================================
// 相位迁移判定（纯函数）
// ============================================================================

interface TargetPhase {
  phase: SentinelPhase;
  reason: SentinelTransitionReason | null;
}

/**
 * 目标相位（未迁移时 phase = 当前相位、reason = null）。
 * 恶化立即（critical → degraded 不设驻留门槛）；恢复需 canLeave（驻留期满）
 * 且（degraded 出身时）continuousHealthy（连续 N 天回正）——两层都保守。
 */
function resolveTargetPhase(
  state: SentinelPhaseState,
  verdict: SentinelDayVerdict,
  streak: number,
  canLeave: boolean,
  thresholds: SentinelThresholds,
): TargetPhase {
  const healthyEnough = streak >= thresholds.recoverHealthyDays;
  switch (state.phase) {
    case 'normal':
      if (verdict === 'critical') return { phase: 'degraded', reason: 'ignore-rate-critical' };
      if (verdict === 'warning') return { phase: 'warning', reason: 'warning-threshold' };
      return { phase: 'normal', reason: null };
    case 'warning':
      if (verdict === 'critical') return { phase: 'degraded', reason: 'ignore-rate-critical' };
      if (verdict === 'healthy' && canLeave) return { phase: 'normal', reason: 'warning-cleared' };
      return { phase: 'warning', reason: null };
    case 'degraded':
      if (verdict === 'healthy' && healthyEnough) return { phase: 'recovering', reason: 'healthy-recovery' };
      return { phase: 'degraded', reason: null };
    case 'recovering':
      if (verdict === 'critical') return { phase: 'degraded', reason: 'ignore-rate-critical' };
      if (verdict === 'warning') return { phase: 'degraded', reason: 'recovering-relapse' };
      if (verdict === 'healthy' && canLeave && healthyEnough) {
        return { phase: 'normal', reason: 'recovering-stabilized' };
      }
      return { phase: 'recovering', reason: null };
  }
}

/**
 * 每日评估（纯函数；now/metrics 显式注入）。
 *
 * 跳过规则（按优先级）：
 * - 开关关 → `disabled`（零变化，无指令）；
 * - 评估日早于上次有判词评估（now 倒灌）→ `out-of-order`（原状态，输出存量指令）；
 * - 同日已评估 → `already-evaluated-today`（幂等原状态，输出存量指令）；
 * - 缺源/无样本 → `insufficient-metrics`（**相位保持**、续链清零，输出存量指令）。
 *
 * 跳过路径仍输出**当前相位的存量指令**：保护不中断（缺数据/同日轮询不得松闸）。
 */
export function evaluateSentinelPhase(
  state: SentinelPhaseState,
  metrics: SentinelMetrics | null,
  now: number,
  config: SentinelConfig = {},
  logger?: JarvisLogger,
): SentinelPhaseEvaluation {
  const resolved = resolveSentinelConfig(config);
  if (!resolved.enabled) {
    return { state, transition: null, directive: null, verdict: null, skippedReason: 'disabled' };
  }

  const day = metrics?.day ?? localDayKey(now);
  const standingDirective = (verdict: SentinelDayVerdict | null): SentinelDegradeDirective | null =>
    buildSentinelDirective(state.phase, {
      day,
      at: now,
      verdict: verdict ?? state.lastVerdict ?? 'insufficient',
      metrics,
      thresholds: resolved.thresholds,
    });

  // 乱序守卫仅对「已有评估」的状态生效（lastEvaluatedDay 非空）：从未评估过的状态
  // （如服务首启，updatedAt 由真实时钟播种）没有「上次评估」可被倒灌，首评一律放行——
  // 否则注入历史 now 的首次扫描会被误判乱序（2026-10-06 实锤：测试 NOW 固定 10-05，
  // 服务 load() 播种 10-06，五个首评用例全部翻红）。
  if (state.lastEvaluatedDay && localDayDiff(state.updatedAt, now) < 0) {
    createOnceLogger(logger)(
      'warn',
      'out-of-order',
      `[sentinel] 评估日倒序（now=${now} < updatedAt=${state.updatedAt}）：跳过，原相不动`,
    );
    return {
      state,
      transition: null,
      directive: standingDirective(null),
      verdict: null,
      skippedReason: 'out-of-order',
    };
  }

  if (state.lastEvaluatedDay === day) {
    return {
      state,
      transition: null,
      directive: standingDirective(null),
      verdict: state.lastVerdict,
      skippedReason: 'already-evaluated-today',
    };
  }

  if (!metrics) {
    // 端口未接线/失败：不判。相位保持、续链清零（连续口径：缺数据日不算回正）。
    const next: SentinelPhaseState = { ...state, healthyStreakDays: 0, lastVerdict: 'insufficient' };
    return {
      state: next,
      transition: null,
      directive: standingDirective('insufficient'),
      verdict: 'insufficient',
      skippedReason: 'insufficient-metrics',
    };
  }

  const verdict = computeDayVerdict(metrics, resolved.thresholds);
  if (verdict === 'insufficient') {
    const next: SentinelPhaseState = { ...state, healthyStreakDays: 0, lastVerdict: 'insufficient' };
    return {
      state: next,
      transition: null,
      directive: standingDirective('insufficient'),
      verdict,
      skippedReason: 'insufficient-metrics',
    };
  }

  const streak = verdict === 'healthy' ? state.healthyStreakDays + 1 : 0;
  // 恢复性迁移的双重门槛（防抖）：① 本相位已驻留 ≥ dwell 天；
  // ② 连续回正 ≥ dwell 天（打断「好一天坏一天」的交替抖动，交替永不满第二个条件）。
  const canLeave =
    localDayDiff(state.since, now) >= resolved.thresholds.minPhaseDwellDays &&
    streak >= resolved.thresholds.minPhaseDwellDays;
  const target = resolveTargetPhase(state, verdict, streak, canLeave, resolved.thresholds);

  const next: SentinelPhaseState =
    target.phase === state.phase
      ? { ...state, healthyStreakDays: streak, lastEvaluatedDay: day, lastVerdict: verdict, updatedAt: now }
      : {
          phase: target.phase,
          since: now,
          sinceDay: day,
          // 进入 degraded = 新熔断事件：续链清零（旧 episode 的回正天数不继承）。
          healthyStreakDays: target.phase === 'degraded' ? 0 : streak,
          lastEvaluatedDay: day,
          lastVerdict: verdict,
          updatedAt: now,
        };

  const transition: SentinelPhaseTransition | null =
    target.phase === state.phase
      ? null
      : {
          from: state.phase,
          to: target.phase,
          day,
          at: now,
          verdict,
          reason: target.reason ?? 'warning-threshold',
        };

  return {
    state: next,
    transition,
    directive: buildSentinelDirective(next.phase, {
      day,
      at: now,
      verdict,
      metrics,
      thresholds: resolved.thresholds,
    }),
    verdict,
  };
}
