/**
 * jarvis-core · 感知层信号源 3/6：项目事件（任务 30，06-11 §5）
 *
 * 采集项：git 提交/分支、测试失败、构建错误、文件变化（watch）。
 * 触发：事件型（允许接线层即时唤醒——事件到达即 wakeNow，不等心跳）。
 *
 * 端口 ProjectEventsPort.poll() 注入一批事件（git CLI / 测试构建输出 / fs.watch
 * 均为生产候选，接线延后）；本模块做归一化 + 评分 + 稳定去重键：
 *   test_failed   85/80/90 → 86 分立即口播；
 *   build_failed  90/80/90 → 87 分；
 *   branch_changed 50/75/90 → 68 分攒批；
 *   git_commit    40/70/90 → 61 分攒批；
 *   file_changed  30/60/80 → 50 分（多落 SILENT/STORE，防刷屏）。
 * 评分分量初始值非实测（待 ⑭ 观测 / ⑮ 标定）。
 *
 * 去重：事件自带 dedupeKey 优先（如 commit hash）；缺省用
 * `project-{kind}:{projectId|default}@{at}` 逐次占位（at 缺省 = 采集时刻）。
 * 端口缺省 = 空读数 + degraded('port_not_wired')。
 */

import type { RawSignal } from '../signal-queue.js';
import type { JarvisLogger } from '../executors.js';
import { createOnceLogger, isRecord, toFiniteNumber, toNonEmptyString } from './safe.js';
import {
  SENSE_SIGNAL_SOURCES,
  SENSE_TRIGGERS,
  resolveSenseEnabled,
  type Sense,
  type SenseDegrade,
  type SenseReading,
} from './types.js';

// ============================================================================
// 端口数据类型
// ============================================================================

export type ProjectEventKind = 'git_commit' | 'branch_changed' | 'test_failed' | 'build_failed' | 'file_changed';

/** 端口投递的一条项目事件（kind 必填；其余可选）。 */
export interface ProjectEventInput {
  kind: ProjectEventKind;
  /** 事件发生时刻（epoch ms）；缺省 = 采集时刻。 */
  at?: number;
  projectId?: string;
  text?: string;
  payload?: unknown;
  /** 稳定幂等键（建议：commit hash / 测试轮 id / 文件路径+变更签名）。 */
  dedupeKey?: string;
}

/** 可注入端口（测试注入 mock；生产通道接线延后）。 */
export interface ProjectEventsPort {
  poll: () => readonly ProjectEventInput[] | Promise<readonly ProjectEventInput[]>;
}

// ============================================================================
// 评分表（初始值非实测，待 ⑭ 观测 / ⑮ 标定）
// ============================================================================

export const PROJECT_EVENT_KINDS: readonly ProjectEventKind[] = [
  'git_commit',
  'branch_changed',
  'test_failed',
  'build_failed',
  'file_changed',
];

export const PROJECT_EVENT_SCORES: Readonly<Record<ProjectEventKind, { urgency: number; relevance: number; certainty: number }>> = {
  git_commit: { urgency: 40, relevance: 70, certainty: 90 },
  branch_changed: { urgency: 50, relevance: 75, certainty: 90 },
  test_failed: { urgency: 85, relevance: 80, certainty: 90 },
  build_failed: { urgency: 90, relevance: 80, certainty: 90 },
  file_changed: { urgency: 30, relevance: 60, certainty: 80 },
};

export function isProjectEventKind(value: unknown): value is ProjectEventKind {
  return typeof value === 'string' && (PROJECT_EVENT_KINDS as readonly string[]).includes(value);
}

// ============================================================================
// 归一化
// ============================================================================

interface NormalizedEvents {
  events: ProjectEventInput[];
  malformedCount: number;
}

function normalizeProjectEvents(raw: unknown): NormalizedEvents {
  if (!Array.isArray(raw)) throw new TypeError('项目事件读数形态非法（需数组）');
  const events: ProjectEventInput[] = [];
  let malformedCount = 0;
  for (const item of raw) {
    if (!isRecord(item) || !isProjectEventKind(item.kind)) {
      malformedCount++;
      continue;
    }
    events.push({
      kind: item.kind,
      at: toFiniteNumber(item.at),
      projectId: toNonEmptyString(item.projectId),
      text: toNonEmptyString(item.text),
      payload: item.payload,
      dedupeKey: toNonEmptyString(item.dedupeKey),
    });
  }
  return { events, malformedCount };
}

/** 事件 → 09·A 原始信号（评分见 PROJECT_EVENT_SCORES）。 */
export function signalForProjectEvent(event: ProjectEventInput, now: number): RawSignal {
  const at = event.at ?? now;
  const scores = PROJECT_EVENT_SCORES[event.kind];
  const project = event.projectId ?? 'default';
  return {
    source: SENSE_SIGNAL_SOURCES['project-events'],
    kind: `project_${event.kind}`,
    ts: now,
    dedupeKey: event.dedupeKey ?? `project-${event.kind}:${project}@${at}`,
    ...(event.text ? { text: event.text } : {}),
    ...(event.projectId ? { projectId: event.projectId } : {}),
    ...(event.payload !== undefined ? { payload: event.payload } : {}),
    urgency: scores.urgency,
    relevance: scores.relevance,
    certainty: scores.certainty,
  };
}

// ============================================================================
// 信号源工厂
// ============================================================================

export interface ProjectEventsSenseOptions {
  /** 独立开关；缺省读 TC_JARVIS_SENSE_PROJECT_EVENTS（缺省开）。 */
  enabled?: boolean;
  /** 事件端口；缺省 = 未接线（安全缺省 + 记因）。 */
  port?: ProjectEventsPort;
  logger?: JarvisLogger;
  /** 开关判定用环境（测试）；缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
}

/** 创建项目事件信号源（无状态：每次 poll 独立归一化）。 */
export function createProjectEventsSense(options: ProjectEventsSenseOptions = {}): Sense {
  const enabled = resolveSenseEnabled('project-events', options.enabled, options.env);
  const logOnce = createOnceLogger(options.logger);

  const collect = async (now: number): Promise<SenseReading> => {
    if (!enabled) return { signals: [] };
    if (!options.port) {
      logOnce('warn', 'port_not_wired', '项目事件源未接线：跳过采集（登记为生产通道接线延后）');
      return {
        signals: [],
        degraded: { reason: 'port_not_wired', detail: '项目事件端口未接（git/测试/构建/watch 通道待接线）' },
      };
    }

    let raw: unknown;
    try {
      raw = await options.port.poll();
    } catch (error) {
      logOnce('error', 'port_error', '项目事件源读取失败（隔离，不吞循环）:', error);
      return { signals: [], degraded: { reason: 'port_error', error } };
    }

    let normalized: NormalizedEvents;
    try {
      normalized = normalizeProjectEvents(raw);
    } catch (error) {
      logOnce('error', 'malformed', '项目事件读数形态非法（隔离）:', error);
      return { signals: [], degraded: { reason: 'malformed_data', detail: '事件读数形态非法', error } };
    }

    const degraded: SenseDegrade | undefined =
      normalized.malformedCount > 0
        ? { reason: 'malformed_data', detail: `丢弃畸形项目事件 ${normalized.malformedCount} 条` }
        : undefined;
    return { signals: normalized.events.map((event) => signalForProjectEvent(event, now)), ...(degraded ? { degraded } : {}) };
  };

  return {
    name: 'project-events',
    source: SENSE_SIGNAL_SOURCES['project-events'],
    trigger: SENSE_TRIGGERS['project-events'],
    enabled,
    collect,
  };
}
