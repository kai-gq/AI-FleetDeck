/**
 * 语音伙伴 · 主动汇报
 *
 * 订阅 store(零改作者文件),对 agents 做「快照 diff」:
 *   - working → idle = 完成;→ error / 新 lastError = 报错;
 *   → waiting/waiting_permission = 提问;taskLabel 变化(scope=all 时)= 换任务。
 * 事件先入队,静默窗口(默认 45s)去抖合并;flush 需要「非 busy」(聆听/转写/
 * 思考/播报中不插话,推迟到静默窗口后再试);另有定时巡查兜底(默认 30 分钟,
 * 仅在有事件时提前 flush,无事不打扰)。合并文本形如:
 *   [系统事件] 过去 3 分钟:① 小美 完成任务:登录页改版;② 阿强 出错:构建失败
 * 交给组件 → POST /api/voice-companion/process { text, event:true }。
 *
 * diffSnapshots / formatEvents 为纯函数,单测覆盖;上报器本体只做计时与订阅。
 */

import { store } from '../store';
import type { AgentStatus } from '../../shared/types';

/** 单个 agent 的两个关键字段(status + taskLabel)与错误串。 */
export interface AgentSnapshotEntry {
  status: AgentStatus;
  taskLabel: string;
  lastError: string;
}

export type AgentSnapshot = Map<string, AgentSnapshotEntry>;

export type ProactiveEventKind = 'completed' | 'failed' | 'waiting' | 'task-changed';

export interface ProactiveEvent {
  at: number;
  kind: ProactiveEventKind;
  agentId: string;
  text: string;
}

const MAX_EVENTS = 12;
const DIFF_THROTTLE_MS = 500;
/** 忙碌时的推迟重试间隔。 */
const BUSY_RETRY_MS = 5_000;

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
        events.push({ at: now, kind: 'completed', agentId: id, text: `${name} 完成任务${cur.taskLabel ? `:${cur.taskLabel}` : ''}` });
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
  return `[系统事件] 过去 ${minutes} 分钟:${body}`;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// ============================================================================
// 上报器
// ============================================================================

/** agent 数据源(默认接 store;单测注入桩,避免拉起真实 store)。 */
export interface ProactiveSource {
  agents: () => Map<string, { name: string; status: AgentStatus; taskLabel?: string; lastError?: string }>;
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
  /** 数据源(默认 store;测试注入)。 */
  source?: ProactiveSource;
}

export interface ProactiveReporterHandle {
  start: () => void;
  stop: () => void;
  /** 尝试 flush;返回提交的文本(null = 无事可报 / 忙碌推迟)。force 跳过忙碌判定。 */
  flushNow: (opts?: { force?: boolean }) => string | null;
  pendingCount: () => number;
}

export function createProactiveReporter(options: ProactiveReporterOptions): ProactiveReporterHandle {
  const source = options.source ?? storeSource();
  let snapshot: AgentSnapshot = new Map();
  let events: ProactiveEvent[] = [];
  let unsubscribe: (() => void) | null = null;
  // 裸定时器(node 测试环境无 window);ReturnType 兼容 DOM(number)与 Node(Timeout)
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let lastDiffAt = 0;

  function takeSnapshot(): AgentSnapshot {
    const map: AgentSnapshot = new Map();
    for (const [id, agent] of source.agents()) {
      map.set(id, {
        status: agent.status,
        taskLabel: agent.taskLabel ?? '',
        lastError: agent.lastError ?? '',
      });
    }
    return map;
  }

  function names(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [id, agent] of source.agents()) map.set(id, agent.name);
    return map;
  }

  function scheduleQuietFlush(delay = options.quietWindowMs): void {
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      quietTimer = null;
      flushNow();
    }, delay);
  }

  function flushNow(opts: { force?: boolean } = {}): string | null {
    const text = formatEvents(events, Date.now());
    if (!text) return null;
    if (!opts.force && options.isBusy()) {
      // 忙碌:等下一轮(静默窗口后重试)
      scheduleQuietFlush(BUSY_RETRY_MS);
      return null;
    }
    events = [];
    options.onSubmit(text);
    return text;
  }

  function tick(): void {
    const now = Date.now();
    if (now - lastDiffAt < DIFF_THROTTLE_MS) return; // 高频 notify 节流
    lastDiffAt = now;
    const next = takeSnapshot();
    const fresh = diffSnapshots(snapshot, next, options.scope, now, names());
    snapshot = next;
    if (fresh.length === 0) return;
    events.push(...fresh);
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    scheduleQuietFlush();
  }

  function start(): void {
    if (unsubscribe) return;
    snapshot = takeSnapshot(); // 基线:启动前的状态不产生事件
    lastDiffAt = Date.now();
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
  }

  return { start, stop, flushNow, pendingCount: () => events.length };
}
