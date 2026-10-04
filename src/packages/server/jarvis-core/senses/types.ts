/**
 * jarvis-core · 感知层信号 · 公共类型与开关（任务 30，06-11 §5 / §12.1 P3）
 *
 * 本轮交付 5 路信号源 = 5 个独立模块、5 个独立开关、失败互不影响（§5 工程要点）：
 *   agent-state（Agent 状态）/ system-health（系统健康）/ project-events（项目事件）
 *   / time-context（时间上下文）/ memory-signals（记忆信号）。
 * 第 6 路 user-behavior（用户行为/窗口焦点）整体延后（client 采集侵入 + 隐私 + 暂无
 * 消费场景，用户批准收敛；见报告「生产通道接线延后登记」）。
 *
 * 统一接口：`Sense.collect(now) → Promise<SenseReading>`（归一化 RawSignal 列表
 * 或安全缺省 + 降级记因）。**契约与 26 号 collectSignalsSafely 对齐：单个
 * Sense.collect 永不抛出**（端口异常/超时/畸形数据只该源降级）；聚合出口
 * `collectSensesSafely`（aggregate.ts）负责跨源隔离与 09·A Signal 归一化。
 *
 * 开关形态对齐既有先例 TC_JARVIS_MORNING_REPORT（boss-morning-report-service.ts:189）：
 * 环境变量缺省开，'0' / 'off' / 'false'（忽略大小写与空白）关；也可由配置入参
 * `enabled` 显式覆盖（测试/接线用）。
 *
 * 边界：本目录不 import client/**、不 import 任何现有服务实现；生产数据通道经
 * 可注入端口，缺省实现见各源文件的「生产通道接线延后」登记。全部为任务 30 新文件，
 * 不走 jarvis-core/index.ts barrel（按路径直导入）。
 */

import type { SignalSource } from '../../../shared/broadcast-gates.js';
import type { RawSignal } from '../signal-queue.js';

// ============================================================================
// 源名 / 类别 / 触发形态 / 开关
// ============================================================================

/** 五路源名（日志/开关/观测用；user-behavior 整体延后，不在本轮枚举内）。 */
export type SenseName =
  | 'agent-state'
  | 'system-health'
  | 'project-events'
  | 'time-context'
  | 'memory-signals';

/** 规范顺序（任务 ④ 清单顺序，去延后的 user-behavior；聚合摘要按此序输出）。 */
export const SENSE_NAMES: readonly SenseName[] = [
  'agent-state',
  'system-health',
  'project-events',
  'time-context',
  'memory-signals',
];

/** 源名 → 09·A SignalSource 类别（归一化 source 字段，一一对应）。 */
export const SENSE_SIGNAL_SOURCES: Readonly<Record<SenseName, SignalSource>> = {
  'agent-state': 'agent',
  'system-health': 'system',
  'project-events': 'project',
  'time-context': 'time',
  'memory-signals': 'memory',
};

/** 触发形态（06-11 §5）：事件型允许即时唤醒；心跳型只在对账时跑；+ 兼有。 */
export type SenseTrigger = 'event' | 'heartbeat' | 'heartbeat+event';

export const SENSE_TRIGGERS: Readonly<Record<SenseName, SenseTrigger>> = {
  'agent-state': 'event',
  'system-health': 'heartbeat+event',
  'project-events': 'event',
  'time-context': 'heartbeat',
  'memory-signals': 'heartbeat+event',
};

/** 每源一个启用环境变量（缺省开；'0'/'off'/'false' 关）。 */
export const SENSE_ENV_KEYS: Readonly<Record<SenseName, string>> = {
  'agent-state': 'TC_JARVIS_SENSE_AGENT_STATE',
  'system-health': 'TC_JARVIS_SENSE_SYSTEM_HEALTH',
  'project-events': 'TC_JARVIS_SENSE_PROJECT_EVENTS',
  'time-context': 'TC_JARVIS_SENSE_TIME_CONTEXT',
  'memory-signals': 'TC_JARVIS_SENSE_MEMORY_SIGNALS',
};

/**
 * 源开关判定（环境变量形态）。缺省 / 空白 = 开；'0' / 'off' / 'false'（忽略
 * 大小写与空白） = 关。与 isMorningReportEnabled 同口径。
 */
export function isSenseEnabled(name: SenseName, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SENSE_ENV_KEYS[name]]?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'off' || raw === 'false');
}

// ============================================================================
// 采集结果 / 降级
// ============================================================================

/**
 * 降级原因：
 * - port_not_wired：本机生产数据通道尚未接线（登记在案，非故障）；
 * - port_error：注入端口抛错；
 * - malformed_data：端口返回畸形数据（安全丢弃，保留可解析部分）；
 * - timeout：聚合层单源超时（withTimeout）。
 */
export type SenseDegradeReason = 'port_not_wired' | 'port_error' | 'malformed_data' | 'timeout';

/** 单源降级标记：安全缺省 + 记因（只该源降级，不影响其他源）。 */
export interface SenseDegrade {
  reason: SenseDegradeReason;
  /** 人类可读补因（如具体字段/通道名）。 */
  detail?: string;
  error?: unknown;
}

/** 单次采集读数：归一化原始信号（ts 已填）或安全缺省 + 可选降级标记。 */
export interface SenseReading {
  signals: RawSignal[];
  degraded?: SenseDegrade;
}

/**
 * 一路信号源。`collect` 契约：**永不抛出**——端口抛错/返回畸形数据时返回
 * 安全缺省并附 degraded 记因；超时由聚合层 withTimeout 兜底（超时后该源
 * 降级，其余源不受影响）。
 */
export interface Sense {
  readonly name: SenseName;
  readonly source: SignalSource;
  readonly trigger: SenseTrigger;
  /** 独立开关：false = 不采集不产出（collect 仍可安全调用，返回空）。 */
  readonly enabled: boolean;
  readonly collect: (now: number) => Promise<SenseReading>;
}

/** 由「配置入参 ∞ 环境变量」解析启用标志（入参优先，便于测试/接线）。 */
export function resolveSenseEnabled(name: SenseName, enabled: boolean | undefined, env?: NodeJS.ProcessEnv): boolean {
  if (typeof enabled === 'boolean') return enabled;
  return isSenseEnabled(name, env);
}
