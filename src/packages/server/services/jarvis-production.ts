/**
 * W13 · jarvis-core 生产接线：port_not_wired → 实端口（任务 26/30/31 前置）
 *
 * 本文件是「最后一厘米」：把 jarvis-core 骨架（心跳/队列/幂等执行器/四档投递）
 * 与感知层 6 源接到 Tide Commander 的真实服务上，并把 PREPARE 攒批出口注册进
 * 统一开口点 flush 表（jarvis-core/prepare-flush）。
 *
 * 实端口（每路的数据源与口径，2026-10-06 接线时逐路核实）：
 *   - agent-state    ← agent-service.getAllAgents()：status 直用，currentTask→taskLabel，
 *                      lastError 透传（sense 内部做快照 diff，首采只建基线）；
 *   - system-health  ← fs.statfs（工作盘 + C: 剩余百分比）+ system-log 近 1h 错误计数；
 *                      单盘/日志库失败逐段跳过，不误报；backgroundTasks/services 两段 v1
 *                      弃用（AgentBackgroundTask 无失败态字段，映射即造假）；
 *   - project-events ← git CLI（log 最近 20 条 + 当前分支）：适配器持 baseline/seen
 *                      （sense 无状态），首次 poll 只建基线；提交幂等键 = git-commit:{hash}；
 *   - time-context   ← 用户活动账 lastSpeechAt（W13 用户活动管线）；
 *   - memory-signals ← 每读新建 FileMemoryStore（构造即索引缓存，复用第二实例会陈旧）；
 *                      working 层活跃条目 tag 'promise'→promise_unkept、'knowledge-gap'
 *                      →knowledge_gap；v1 不产 due（任务 13 在役，防双播）；
 *   - user-behavior  ← 用户活动账快照（lastActivityAt/lastSpeechAt；同源分工见该 sense 头注）。
 *
 * 投递口径（与任务 13/29 既有通道同规，不造假通道）：
 *   - SPEAK  → logProactiveBroadcast(action=`jarvis_{kind}`)，经 IdempotentExecutor 幂等包装；
 *   - notice → 同通道 + degraded 标记（口播出口缺失/抛错的降级路径）；
 *   - PREPARE→ 留在队列 prepared 缓冲，注册到 prepare-flush（开口点交付）：
 *       · jarvis-core 主脑队列：逐条播报 action=`jarvis_batched_{kind}`（flush 与即时口播可筛分）；
 *       · bolba-due / boss-morning：复用各自服务的 speak 端口（保持各自日志账口径）；
 *   - STORE  → 仅日志（服务端无上屏消费者，不假装上屏）。
 *
 * 触发：心跳四阶段——wake（跨日预算 rollover + 刷新 now/环境快照）→ observe（六源齐采
 * 入队）→ reason（consumeAll）→ act（四档投递；用户活跃窗口内兜底 flush；活动账落盘）。
 * 开关：TC_JARVIS_CORE=0 关（缺省开）。启动即 wakeNow 一轮建基线（首轮不产信号）。
 * 安全：init 失败不上抛（整体降级，业务主链路不受影响）；shutdown 幂等。
 */

import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import * as path from 'node:path';

import {
  Heartbeat,
  IdempotentExecutor,
  SignalQueue,
  deliverDecision,
  jarvisLogger,
  type ConsumedSignal,
  type DeliveryPorts,
} from '../jarvis-core/index.js';
import { collectSensesSafely, createDefaultSenses, type SenseCollection } from '../jarvis-core/senses/aggregate.js';
import type { AgentStateEntry, AgentStatePort } from '../jarvis-core/senses/agent-state.js';
import type { DiskProbe, LogErrorProbe, SystemHealthPort } from '../jarvis-core/senses/system-health.js';
import type { ProjectEventInput, ProjectEventsPort } from '../jarvis-core/senses/project-events.js';
import type { MemorySignalInput, MemorySignalKind, MemorySignalsPort } from '../jarvis-core/senses/memory-signals.js';
import type { TimeContextPort } from '../jarvis-core/senses/time-context.js';
import type { UserBehaviorPort } from '../jarvis-core/senses/user-behavior.js';
import {
  flushPreparedAtOpeningPoint,
  registerPreparedQueue,
  unregisterPreparedQueue,
} from '../jarvis-core/prepare-flush.js';
import { FileMemoryStore, defaultMemoryBaseDir, type MemoryEntry } from '../jarvis-core/memory/index.js';
import type { Agent } from '../../shared/agent-types.js';
import { getAllAgents } from './agent-service.js';
import { countSystemLog } from '../data/system-log.js';
import { getUserActivitySnapshot, getUserActivityStore, isUserActiveWithin } from './user-activity-service.js';
import { logProactiveBroadcast } from './voice-companion-service.js';
import {
  createBolbaReminderPorts,
  getBolbaDueReminderQueue,
  rolloverGatesStateForNewDay,
} from './bolba-due-reminder-service.js';
import { createMorningReportPorts, getBossMorningReportQueue } from './boss-morning-report-service.js';

// ─── 常量 ───

/** 总开关（缺省开；'0' 关）。 */
export const JARVIS_CORE_ENV_KEY = 'TC_JARVIS_CORE';
/** 心跳档的「用户在场」窗口：act 末尾兜底 flush 攒批（覆盖「在场但没说话」）。 */
const JARVIS_ACTIVE_FLUSH_WINDOW_MS = 10 * 60_000;
/** 环境快照「近 N 分钟有输入」窗口（对齐 09·A disruption 因子口径：2 分钟）。 */
const RECENT_INPUT_WINDOW_MS = 2 * 60_000;
/** git poll 每次扫描的提交深度。 */
const GIT_POLL_COMMIT_DEPTH = 20;
/** git 已见提交上限（超出丢最旧，防无界增长）。 */
const GIT_SEEN_COMMITS_CAP = 500;
/** 系统日志「错误突发」观测窗口：近 1h（阈值判定在 sense 内，缺省 ≥5 条报警）。 */
const LOG_ERROR_WINDOW_MS = 60 * 60_000;
/** git 子进程超时/缓冲上限（防挂死）。 */
const GIT_EXEC_TIMEOUT_MS = 5_000;
const GIT_EXEC_MAX_BUFFER = 1024 * 1024;

// ============================================================================
// 实端口 1/6：agent-state（agent-service）
// ============================================================================

/** Agent[] → 快照 Map（status 直用；currentTask→taskLabel、lastError 透传）。 */
export function buildAgentSnapshot(agents: readonly Agent[]): Map<string, AgentStateEntry> {
  const snapshot = new Map<string, AgentStateEntry>();
  for (const agent of agents) {
    snapshot.set(agent.id, {
      name: agent.name,
      status: agent.status,
      ...(agent.currentTask ? { taskLabel: agent.currentTask } : {}),
      ...(agent.lastError ? { lastError: agent.lastError } : {}),
    });
  }
  return snapshot;
}

/** 生产 agent 快照端口。 */
export function createAgentStatePort(): AgentStatePort {
  return { snapshot: () => buildAgentSnapshot(getAllAgents()) };
}

// ============================================================================
// 实端口 2/6：system-health（fs.statfs + system-log）
// ============================================================================

/** statfs 最小形状（便于测试注入假实现）。 */
export interface StatfsLike {
  blocks: number;
  bsize: number;
  bavail: number;
}

export interface SystemHealthPortDeps {
  /** 磁盘读数（测试注入）；缺省真实 fs.statfs。 */
  statfs?: (target: string) => Promise<StatfsLike>;
  /** 错误计数（测试注入）；缺省 countSystemLog({level:'error', since})。 */
  countErrors?: (since: number) => number;
  now?: () => number;
  /** 体检盘根列表（测试注入）；缺省工作盘 + C:。 */
  roots?: readonly string[];
}

/** 默认体检盘：工作目录所在盘 + Windows C:（系统盘）。 */
function defaultDiskRoots(): string[] {
  const roots = new Set<string>();
  try {
    roots.add(path.parse(process.cwd()).root);
  } catch {
    // 极端环境取不到根：忽略
  }
  if (process.platform === 'win32') roots.add('C:\\');
  return [...roots];
}

/** 生产系统体检端口：磁盘（statfs）+ 日志错误计数；逐段隔离，单段失败跳过不误报。 */
export function createSystemHealthPort(deps: SystemHealthPortDeps = {}): SystemHealthPort {
  const doStatfs = deps.statfs ?? ((target: string) => statfs(target));
  const countErrors = deps.countErrors ?? ((since: number) => countSystemLog({ level: 'error', since }));
  const now = deps.now ?? Date.now;
  const roots = deps.roots ?? defaultDiskRoots();

  return {
    probe: async () => {
      const disks: DiskProbe[] = [];
      for (const root of roots) {
        try {
          const stats = await doStatfs(root);
          const totalBytes = stats.blocks * stats.bsize;
          const freeBytes = stats.bavail * stats.bsize;
          if (Number.isFinite(totalBytes) && totalBytes > 0 && Number.isFinite(freeBytes)) {
            disks.push({ mount: root, freePercent: (freeBytes / totalBytes) * 100, freeBytes, totalBytes });
          }
        } catch {
          // 单盘读取失败跳过（不误报磁盘健康）
        }
      }

      let logErrors: LogErrorProbe | undefined;
      try {
        const recentCount = countErrors(now() - LOG_ERROR_WINDOW_MS);
        if (recentCount > 0) logErrors = { recentCount };
      } catch {
        // 日志库不可用（如未初始化）：跳过该段
      }

      return { disks, ...(logErrors ? { logErrors } : {}) };
    },
  };
}

// ============================================================================
// 实端口 3/6：project-events（git CLI）
// ============================================================================

export interface ParsedGitCommit {
  hash: string;
  at: number;
  subject: string;
}

/** 解析 `git log --format=%H%x01%ct%x01%s -n N` 输出（每行 hash␁秒戳␁主题）。 */
export function parseGitLog(stdout: string): ParsedGitCommit[] {
  const commits: ParsedGitCommit[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [hash, ct, subject] = line.split('\u0001');
    const at = Number(ct) * 1_000;
    if (!hash || !Number.isFinite(at)) continue;
    commits.push({ hash, at, subject: subject ?? '' });
  }
  return commits;
}

/** 执行 git 子进程并返回 stdout（超时/非零退出 → reject）。 */
function execGitStdout(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: GIT_EXEC_TIMEOUT_MS, windowsHide: true, maxBuffer: GIT_EXEC_MAX_BUFFER },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

export interface GitProjectEventsOptions {
  /** 仓库目录；缺省 process.cwd()。 */
  cwd?: string;
  /** git 执行器（测试注入）：给定参数返回 stdout，失败应 reject。 */
  execGit?: (args: readonly string[]) => Promise<string>;
  now?: () => number;
  /** 已见提交上限；缺省 500。 */
  maxSeenCommits?: number;
  /** 单次 poll 扫描深度（条）；缺省 20。注意两次 poll 之间 >depth 条提交会漏中间项。 */
  commitDepth?: number;
  projectId?: string;
}

/**
 * 生产 git 项目事件端口：首次 poll 只建基线（历史提交不当新事件），此后产出
 * 新增提交（按时间正序）与分支切换；适配器持 seen/branch，sense 无状态。
 */
export function createGitProjectEventsPort(options: GitProjectEventsOptions = {}): ProjectEventsPort {
  const now = options.now ?? Date.now;
  const depth = options.commitDepth ?? GIT_POLL_COMMIT_DEPTH;
  const cap = options.maxSeenCommits ?? GIT_SEEN_COMMITS_CAP;
  const execGit = options.execGit ?? ((args) => execGitStdout(args, options.cwd ?? process.cwd()));
  const seen = new Set<string>();
  let lastBranch: string | null = null;
  let initialized = false;

  return {
    poll: async () => {
      const [logStdout, branchStdout] = await Promise.all([
        execGit(['log', '--format=%H%x01%ct%x01%s', '-n', String(depth)]),
        execGit(['rev-parse', '--abbrev-ref', 'HEAD']),
      ]);
      const commits = parseGitLog(logStdout);
      const branch = branchStdout.trim() || null;
      const at = now();

      if (!initialized) {
        initialized = true;
        for (const c of commits) seen.add(c.hash);
        lastBranch = branch;
        return [];
      }

      const events: ProjectEventInput[] = [];
      // git log 新→旧返回；按时间正序产出（旧→新），开口点播报顺序即提交顺序。
      for (const c of [...commits].reverse()) {
        if (seen.has(c.hash)) continue;
        seen.add(c.hash);
        events.push({
          kind: 'git_commit',
          at: c.at,
          ...(options.projectId ? { projectId: options.projectId } : {}),
          text: `新提交 ${c.hash.slice(0, 7)}: ${c.subject}`,
          payload: { hash: c.hash },
          dedupeKey: `git-commit:${c.hash}`,
        });
      }
      while (seen.size > cap) {
        const oldest = seen.values().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }

      if (branch && branch !== lastBranch) {
        const previous = lastBranch;
        lastBranch = branch;
        events.push({
          kind: 'branch_changed',
          at,
          ...(options.projectId ? { projectId: options.projectId } : {}),
          text: `分支切换到 ${branch}${previous ? `（原 ${previous}）` : ''}`,
          payload: { branch, previous },
          dedupeKey: `git-branch:${branch}@${at}`,
        });
      }

      return events;
    },
  };
}

// ============================================================================
// 实端口 4/5/6：time-context / user-behavior / memory-signals
// ============================================================================

/** 生产 time-context 端口：用户活动账 lastSpeechAt。 */
export function createTimeContextPort(): TimeContextPort {
  return { lastUserSpeechAt: () => getUserActivitySnapshot().lastSpeechAt };
}

/** 生产 user-behavior 端口：用户活动账快照（字段兼容；lastActivityKind 本 sense 不用）。 */
export function createUserBehaviorPort(): UserBehaviorPort {
  return { read: () => getUserActivitySnapshot() };
}

/** working 层 tag → 记忆信号类别的映射（v1 口径；扩展需在此登记）。 */
const MEMORY_TAG_TO_SIGNAL_KIND: Readonly<Record<string, MemorySignalKind>> = {
  promise: 'promise_unkept',
  'knowledge-gap': 'knowledge_gap',
};

/** working 层活跃条目 → 记忆信号候选（带映射 tag 才产；v1 不产 due，任务 13 在役防双播）。 */
export function mapMemoryEntriesToSignals(entries: readonly MemoryEntry[]): MemorySignalInput[] {
  const inputs: MemorySignalInput[] = [];
  for (const entry of entries) {
    if (entry.status !== 'active') continue;
    const kind = (entry.tags ?? [])
      .map((tag) => MEMORY_TAG_TO_SIGNAL_KIND[tag])
      .find((k): k is MemorySignalKind => k !== undefined);
    if (!kind) continue;
    inputs.push({
      kind,
      itemId: entry.id,
      text: entry.text,
      at: entry.updatedAt,
      payload: { tags: entry.tags ?? [] },
    });
  }
  return inputs;
}

export interface MemorySignalsPortOptions {
  /** 记忆库根目录；缺省 defaultMemoryBaseDir()（XDG 数据目录）。 */
  baseDir?: string;
  /** working 层条目读取（测试注入）；缺省每读新建 FileMemoryStore。 */
  listWorkingEntries?: () => Promise<readonly MemoryEntry[]>;
}

/** 生产记忆信号端口：每读新建 FileMemoryStore（构造即索引缓存，复用会陈旧）。 */
export function createMemorySignalsPort(options: MemorySignalsPortOptions = {}): MemorySignalsPort {
  const listWorking =
    options.listWorkingEntries ??
    (() => new FileMemoryStore({ baseDir: options.baseDir ?? defaultMemoryBaseDir() }).list('working'));
  return { read: async () => mapMemoryEntriesToSignals(await listWorking()) };
}

// ============================================================================
// 四档投递端口（与任务 13/29 同规）
// ============================================================================

/** 主脑队列投递端口：SPEAK/notice 走 logProactiveBroadcast；PREPARE/STORE 仅日志。 */
export function createJarvisDeliveryPorts(): DeliveryPorts {
  const actionOf = (kind: string): string => `jarvis_${kind}`;
  return {
    speak: (signal) => {
      logProactiveBroadcast({ text: signal.text ?? '', action: actionOf(signal.kind) });
    },
    notice: (signal) => {
      // 口播出口缺失/抛错的降级路径（deliverDecision 已判定）：仍走现有通道 + 降级标记。
      logProactiveBroadcast({ text: signal.text ?? '', action: actionOf(signal.kind), degraded: true });
    },
    prepare: (signal, decision) => {
      // 条目已入 queue.prepared 缓冲，等开口点 flush（prepare-flush 注册表）。
      jarvisLogger.debug(`PREPARE 攒批（${signal.kind}，reason=${decision.reason}），等开口点 flush`);
    },
    store: (signal, decision) => {
      jarvisLogger.debug(`STORE 仅登记（${signal.kind}，reason=${decision.reason}）`);
    },
  };
}

/**
 * 注册三方 PREPARE 队列到统一开口点 flush（幂等：同名覆盖）。
 * jarvis-core 主脑队列的 flush 交付用 `jarvis_batched_{kind}`（与即时口播可筛分）；
 * bolba-due / boss-morning 复用各自 speak 端口（保持各自日志账口径）。
 */
export function registerJarvisPreparedFlush(getCoreQueue: () => SignalQueue | null): void {
  registerPreparedQueue({
    name: 'jarvis-core',
    getQueue: getCoreQueue,
    speak: (entries) => {
      for (const entry of entries) {
        logProactiveBroadcast({ text: entry.signal.text ?? '', action: `jarvis_batched_${entry.signal.kind}` });
      }
    },
  });
  registerPreparedQueue({
    name: 'bolba-due',
    getQueue: getBolbaDueReminderQueue,
    speak: async (entries) => {
      const ports = createBolbaReminderPorts();
      for (const entry of entries) await ports.speak?.(entry.signal, entry.decision);
    },
  });
  registerPreparedQueue({
    name: 'boss-morning',
    getQueue: getBossMorningReportQueue,
    speak: async (entries) => {
      const ports = createMorningReportPorts();
      for (const entry of entries) await ports.speak?.(entry.signal, entry.decision);
    },
  });
}

// ============================================================================
// 生命周期（init / shutdown）
// ============================================================================

export interface JarvisCoreProductionHandle {
  heartbeat: Heartbeat<SenseCollection, ConsumedSignal[]>;
  queue: SignalQueue;
  executor: IdempotentExecutor;
}

let production: JarvisCoreProductionHandle | null = null;

/** 总开关：TC_JARVIS_CORE=0 关（缺省开）。 */
export function isJarvisCoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[JARVIS_CORE_ENV_KEY] !== '0';
}

/**
 * 启动 jarvis-core 生产接线（幂等；开关关 / 异常 → 返回 null，业务不受影响）。
 * 启动即 wakeNow 一轮：首轮各源只建基线不产信号，但基线/跨日 rollover/环境快照就位。
 */
export function initJarvisCoreProduction(): JarvisCoreProductionHandle | null {
  if (!isJarvisCoreEnabled()) {
    jarvisLogger.log(`jarvis-core 生产接线关闭（${JARVIS_CORE_ENV_KEY}=0）`);
    return null;
  }
  if (production) return production;

  try {
    const queue = new SignalQueue({ now: Date.now() });
    const executor = new IdempotentExecutor();
    const ports = createJarvisDeliveryPorts();
    const senses = createDefaultSenses({
      agentStatePort: createAgentStatePort(),
      systemHealthPort: createSystemHealthPort(),
      projectEventsPort: createGitProjectEventsPort(),
      timeContextPort: createTimeContextPort(),
      memorySignalsPort: createMemorySignalsPort(),
      userBehaviorPort: createUserBehaviorPort(),
    });

    const heartbeat = new Heartbeat<SenseCollection, ConsumedSignal[]>({
      now: Date.now,
      phases: {
        wake: (ctx) => {
          // 跨日归零预算计数/统计（SignalQueue 明示由接线层负责）。
          queue.restoreState(rolloverGatesStateForNewDay(queue.snapshotState(), new Date(ctx.now)));
          queue.refreshNow(ctx.now);
          // 环境快照（闸门②）：活动账 → recentInput / justSpokeSecondsAgo。
          const activity = getUserActivitySnapshot();
          queue.setEnvironment({
            recentInput:
              activity.lastActivityAt !== null && ctx.now - activity.lastActivityAt <= RECENT_INPUT_WINDOW_MS,
            ...(activity.lastSpeechAt !== null
              ? { justSpokeSecondsAgo: Math.max(0, Math.round((ctx.now - activity.lastSpeechAt) / 1_000)) }
              : {}),
          });
        },
        observe: async (ctx) => {
          const collection = await collectSensesSafely(senses, { now: ctx.now });
          for (const signal of collection.signals) queue.enqueue(signal);
          if (collection.degraded) {
            const degraded = collection.readings
              .filter((r) => r.degraded)
              .map((r) => `${r.name}:${r.degradeReason ?? 'degraded'}`);
            if (degraded.length > 0) jarvisLogger.warn(`jarvis 感知降级：${degraded.join('，')}`);
          }
          return collection;
        },
        reason: () => queue.consumeAll(),
        act: async (consumed, ctx) => {
          for (const entry of consumed) {
            if (entry.decision.tier === 'SPEAK') {
              // 幂等包装：同 dedupeKey 口播只执行一次（队列 seenKeys 之上的第二道保险）。
              await executor.submit({ dedupeKey: entry.signal.dedupeKey, kind: entry.signal.kind }, async () => {
                await deliverDecision(entry.signal, entry.decision, ports);
              });
            } else {
              await deliverDecision(entry.signal, entry.decision, ports);
            }
          }
          // 用户在活跃窗口内 = 自然开口点：兜底 flush 攒批（覆盖「在场但没说话」）。
          if (isUserActiveWithin(JARVIS_ACTIVE_FLUSH_WINDOW_MS, ctx.now)) {
            await flushPreparedAtOpeningPoint('heartbeat_user_active');
          }
          // 活动账落盘（写节流下最多滞后 10s，心搏周期内补写一次）。
          getUserActivityStore().flush();
        },
      },
    });

    registerJarvisPreparedFlush(() => queue);
    heartbeat.start();
    heartbeat.wakeNow();

    production = { heartbeat, queue, executor };
    jarvisLogger.log('jarvis-core 生产接线就绪：六源齐采（agent/system/project/time/memory/user），心跳 15 分钟（初始值非实测）');
    return production;
  } catch (error) {
    jarvisLogger.error('jarvis-core 生产接线失败（降级：不接，业务不受影响）:', error);
    return null;
  }
}

/** 停机清理（幂等）：停心跳 → 注销 flush 注册 → 等活动轮收尾 → 活动账落盘。 */
export async function shutdownJarvisCoreProduction(): Promise<void> {
  const handle = production;
  production = null;
  if (!handle) return;
  try {
    handle.heartbeat.stop();
    unregisterPreparedQueue('jarvis-core');
    unregisterPreparedQueue('bolba-due');
    unregisterPreparedQueue('boss-morning');
    await handle.heartbeat.whenIdle();
    getUserActivityStore().flush();
  } catch (error) {
    jarvisLogger.warn('jarvis-core 停机清理失败（已忽略）:', error);
  }
}

/** 测试专用：当前接线句柄（未接 → null）。 */
export function getJarvisCoreProductionForTests(): JarvisCoreProductionHandle | null {
  return production;
}

/** 测试专用：丢弃进程内接线句柄（不停心跳，测试请优先用 shutdown）。 */
export function resetJarvisCoreProductionForTests(): void {
  production = null;
}
