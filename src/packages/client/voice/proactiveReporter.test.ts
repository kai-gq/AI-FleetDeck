import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 上报器默认接 client store;测试注入 source,这里给个空壳避免拉起真实 store
vi.mock('../store', () => ({
  store: {
    getState: () => ({ agents: new Map() }),
    subscribe: () => () => {},
  },
}));

import {
  diffSnapshots,
  formatEvents,
  createProactiveReporter,
  type AgentSnapshot,
  type AgentSnapshotEntry,
  type ProactiveSource,
} from './proactiveReporter';
import type { AgentStatus } from '../../shared/types';

const NAMES = new Map([
  ['a', '小美'],
  ['b', '阿强'],
]);

function snap(entries: Record<string, Partial<AgentSnapshotEntry>>): AgentSnapshot {
  const map: AgentSnapshot = new Map();
  for (const [id, entry] of Object.entries(entries)) {
    map.set(id, { status: 'idle', taskLabel: '', lastError: '', ...entry });
  }
  return map;
}

describe('diffSnapshots', () => {
  it('reports working→idle as completed with the task label', () => {
    const events = diffSnapshots(
      snap({ a: { status: 'working', taskLabel: '登录页' } }),
      snap({ a: { status: 'idle', taskLabel: '登录页' } }),
      'important',
      1000,
      NAMES,
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('completed');
    expect(events[0].text).toContain('小美');
    expect(events[0].text).toContain('完成任务');
    expect(events[0].text).toContain('登录页');
  });

  it('reports →error as failed with a truncated lastError', () => {
    const events = diffSnapshots(
      snap({ b: { status: 'working' } }),
      snap({ b: { status: 'error', lastError: `构建失败 ${'x'.repeat(200)}` } }),
      'important',
      1000,
      NAMES,
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('failed');
    expect(events[0].text).toContain('阿强');
    expect(events[0].text).toContain('出错');
    expect(events[0].text.length).toBeLessThan(120);
  });

  it('reports →waiting / →waiting_permission as waiting', () => {
    const waiting = diffSnapshots(
      snap({ a: { status: 'working' } }),
      snap({ a: { status: 'waiting' } }),
      'important',
      1000,
      NAMES,
    );
    expect(waiting[0].kind).toBe('waiting');
    expect(waiting[0].text).toContain('等待确认');

    const perm = diffSnapshots(
      snap({ a: { status: 'working' } }),
      snap({ a: { status: 'waiting_permission' } }),
      'important',
      1000,
      NAMES,
    );
    expect(perm[0].text).toContain('等待授权');
  });

  it('reports a changed lastError even when the status is unchanged', () => {
    const events = diffSnapshots(
      snap({ a: { status: 'idle', lastError: '旧错误' } }),
      snap({ a: { status: 'idle', lastError: '新错误' } }),
      'important',
      1000,
      NAMES,
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('failed');
    expect(events[0].text).toContain('新错误');
  });

  it('ignores noise: new agents, removed agents, →offline, unchanged state', () => {
    const events = diffSnapshots(
      snap({ a: { status: 'working' } }),
      snap({ b: { status: 'working' }, a: { status: 'working' } }),
      'important',
      1000,
      NAMES,
    );
    expect(events).toEqual([]);

    const offline: AgentStatus = 'offline';
    expect(
      diffSnapshots(
        snap({ a: { status: 'working' } }),
        snap({ a: { status: offline } }),
        'important',
        1000,
        NAMES,
      ),
    ).toEqual([]);
  });

  it('reports task label changes only when scope=all and the agent is working', () => {
    const prev = snap({ a: { status: 'working', taskLabel: '旧任务' } });
    const next = snap({ a: { status: 'working', taskLabel: '新任务' } });
    expect(diffSnapshots(prev, next, 'important', 1000, NAMES)).toEqual([]);
    const events = diffSnapshots(prev, next, 'all', 1000, NAMES);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('task-changed');

    // 非 working 的标签变化不报
    expect(
      diffSnapshots(
        snap({ a: { status: 'idle', taskLabel: '旧' } }),
        snap({ a: { status: 'idle', taskLabel: '新' } }),
        'all',
        1000,
        NAMES,
      ),
    ).toEqual([]);
  });
});

describe('formatEvents', () => {
  it('returns null for an empty queue', () => {
    expect(formatEvents([], 1000)).toBeNull();
  });

  it('merges events into one [系统事件] line with circled markers', () => {
    const text = formatEvents(
      [
        { at: 0, kind: 'completed', agentId: 'a', text: '小美 完成任务:登录页' },
        { at: 60_000, kind: 'failed', agentId: 'b', text: '阿强 出错:构建失败' },
      ],
      3 * 60_000,
    );
    expect(text).toContain('[系统事件] 过去 3 分钟');
    expect(text).toContain('① 小美 完成任务:登录页');
    expect(text).toContain('② 阿强 出错:构建失败');
  });
});

describe('createProactiveReporter', () => {
  interface Ctl {
    agents: Map<string, { name: string; status: AgentStatus; taskLabel?: string; lastError?: string }>;
    listeners: Set<() => void>;
  }
  let ctl: Ctl;
  let submitted: string[];
  let busy: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    ctl = { agents: new Map(), listeners: new Set() };
    submitted = [];
    busy = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeReporter(opts: Partial<Parameters<typeof createProactiveReporter>[0]> = {}) {
    const source: ProactiveSource = {
      agents: () => ctl.agents,
      subscribe: (listener) => {
        ctl.listeners.add(listener);
        return () => ctl.listeners.delete(listener);
      },
    };
    return createProactiveReporter({
      quietWindowMs: 45_000,
      intervalMs: 30 * 60_000,
      scope: 'important',
      isBusy: () => busy,
      onSubmit: (text) => submitted.push(text),
      source,
      ...opts,
    });
  }

  function fire(): void {
    for (const listener of ctl.listeners) listener();
  }

  it('baselines on start, debounces into the quiet window, then submits once', () => {
    ctl.agents.set('a', { name: '小美', status: 'working', taskLabel: '登录页' });
    const reporter = makeReporter();
    reporter.start();

    // 启动基线:不产生事件
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.pendingCount()).toBe(0);

    // 完成 → 入队
    ctl.agents.set('a', { name: '小美', status: 'idle', taskLabel: '登录页' });
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.pendingCount()).toBe(1);

    // 静默窗口内再攒一条,窗口到期合并提交一次
    ctl.agents.set('b', { name: '阿强', status: 'working' });
    vi.advanceTimersByTime(600);
    fire();
    ctl.agents.set('b', { name: '阿强', status: 'error', lastError: '构建失败' });
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.pendingCount()).toBe(2);

    vi.advanceTimersByTime(45_000);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain('① 小美 完成任务');
    expect(submitted[0]).toContain('② 阿强 出错');

    reporter.stop();
  });

  it('defers the flush while busy and retries later', () => {
    const reporter = makeReporter();
    reporter.start();
    vi.advanceTimersByTime(600);
    ctl.agents.set('a', { name: '小美', status: 'working' });
    fire();
    ctl.agents.set('a', { name: '小美', status: 'idle' });
    vi.advanceTimersByTime(600);
    fire();

    busy = true;
    vi.advanceTimersByTime(45_000);
    expect(submitted).toHaveLength(0); // 忙碌:推迟
    vi.advanceTimersByTime(10_000);
    expect(submitted).toHaveLength(0);

    busy = false;
    vi.advanceTimersByTime(10_000);
    expect(submitted).toHaveLength(1);

    reporter.stop();
  });

  it('stays silent on the interval patrol when nothing happened', () => {
    const reporter = makeReporter({ intervalMs: 60_000 });
    reporter.start();
    vi.advanceTimersByTime(3 * 60_000);
    expect(submitted).toHaveLength(0);
    expect(reporter.pendingCount()).toBe(0);
    reporter.stop();
  });

  it('flushNow({force:true}) submits even while busy', () => {
    const reporter = makeReporter();
    reporter.start();
    vi.advanceTimersByTime(600);
    ctl.agents.set('a', { name: '小美', status: 'working' });
    fire();
    ctl.agents.set('a', { name: '小美', status: 'idle' });
    vi.advanceTimersByTime(600);
    fire();

    busy = true;
    const text = reporter.flushNow({ force: true });
    expect(text).toContain('小美');
    expect(submitted).toHaveLength(1);
    expect(reporter.pendingCount()).toBe(0);
    reporter.stop();
  });

  // ---- 阶段一补测:生命周期边界 ----

  it('start() is idempotent (double start keeps a single subscription)', () => {
    const reporter = makeReporter();
    reporter.start();
    reporter.start();
    expect(ctl.listeners.size).toBe(1);
    reporter.stop();
    expect(ctl.listeners.size).toBe(0);
  });

  it('stop() drops pending events and never submits afterwards', () => {
    ctl.agents.set('a', { name: '小美', status: 'working', taskLabel: '登录页' });
    const reporter = makeReporter();
    reporter.start();
    vi.advanceTimersByTime(600);
    ctl.agents.set('a', { name: '小美', status: 'idle', taskLabel: '登录页' });
    fire();
    expect(reporter.pendingCount()).toBe(1);

    reporter.stop();
    expect(reporter.pendingCount()).toBe(0); // 待发事件被清空
    vi.advanceTimersByTime(10 * 60_000); // 静默窗与巡查定时器都已清掉
    expect(submitted).toHaveLength(0);
  });

  it('flushNow on an empty queue returns null, force or not', () => {
    const reporter = makeReporter();
    expect(reporter.flushNow()).toBeNull();
    expect(reporter.flushNow({ force: true })).toBeNull();
    expect(submitted).toHaveLength(0);
  });
});
