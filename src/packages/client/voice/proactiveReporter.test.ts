import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 上报器默认接 client store;测试注入 source,这里给个空壳避免拉起真实 store
vi.mock('../store', () => ({
  store: {
    getState: () => ({ agents: new Map() }),
    subscribe: () => () => {},
  },
}));

// 任务08② ⑥3 客户端接缝:spy 保留真实实现,单测里 mockReturnValueOnce 让判断层返回「沉默」
vi.mock('../../shared/broadcast-gates', { spy: true });

import {
  diffSnapshots,
  formatEvents,
  createProactiveReporter,
  signalForEvent,
  type AgentSnapshot,
  type AgentSnapshotEntry,
  type ProactiveReceipt,
  type ProactiveSource,
} from './proactiveReporter';
import { DEFAULT_GATES_CONFIG, computeRelevanceScore, decideBroadcast } from '../../shared/broadcast-gates';
import { clearStandbyRequests, markStandbyRequest } from '../store/standbyRequests';
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

  it('待岗(standby)停机不算完成:是用户下线,不是干完了', () => {
    const events = diffSnapshots(
      snap({ a: { status: 'working', taskLabel: '登录页' } }),
      snap({ a: { status: 'idle', taskLabel: '登录页', standby: true } }),
      'important',
      1000,
      NAMES,
    );
    expect(events).toHaveLength(0);
  });

  it('待岗只抑制「完成」:待岗中的报错/提问照报', () => {
    const failed = diffSnapshots(
      snap({ a: { status: 'working', standby: true } }),
      snap({ a: { status: 'error', standby: true, lastError: '构建失败' } }),
      'important',
      1000,
      NAMES,
    );
    expect(failed).toHaveLength(1);
    expect(failed[0].kind).toBe('failed');
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

  it('merges events into one ⟦系统事件⟧ line with circled markers', () => {
    const text = formatEvents(
      [
        { at: 0, kind: 'completed', agentId: 'a', text: '小美 完成任务:登录页' },
        { at: 60_000, kind: 'failed', agentId: 'b', text: '阿强 出错:构建失败' },
      ],
      3 * 60_000,
    );
    expect(text).toContain('⟦系统事件⟧ 过去 3 分钟');
    // 任务35 协议安全化:定界标记必须不可口述——旧普通文本标记不得回潮(它同时是服务端 noop 判定协议)
    expect(text).not.toContain('[系统事件]');
    expect(text).toContain('① 小美 完成任务:登录页');
    expect(text).toContain('② 阿强 出错:构建失败');
  });
});

describe('createProactiveReporter', () => {
  interface Ctl {
    agents: Map<string, { name: string; status: AgentStatus; taskLabel?: string; lastError?: string; standby?: boolean }>;
    listeners: Set<() => void>;
  }
  let ctl: Ctl;
  let submitted: string[];
  let busy: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    // 固定到本地 15:00(不在深夜/focus 窗口):分级判定与真实时钟无关,测试可复现
    vi.setSystemTime(new Date(2026, 9, 4, 15, 0));
    ctl = { agents: new Map(), listeners: new Set() };
    submitted = [];
    busy = false;
    clearStandbyRequests();
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

  it('待岗手势兜底:本标签页刚点的待岗,先到的那条 working→idle(标记未落地)也不报完成', () => {
    ctl.agents.set('a', { name: '小美', status: 'working', taskLabel: '登录页' });
    const reporter = makeReporter();
    reporter.start();
    vi.advanceTimersByTime(600);
    fire();

    // 用户点「设为待岗」→ 本地手势;服务端先广播 idle,标记要等下一次广播才来
    markStandbyRequest('a');
    ctl.agents.set('a', { name: '小美', status: 'idle', taskLabel: '登录页' });
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.pendingCount()).toBe(0);

    // 同一 agent 后续的真实完成(手势已过期)照常报
    vi.advanceTimersByTime(16_000);
    ctl.agents.set('a', { name: '小美', status: 'working', taskLabel: '登录页' });
    vi.advanceTimersByTime(600);
    fire();
    ctl.agents.set('a', { name: '小美', status: 'idle', taskLabel: '登录页' });
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.pendingCount()).toBe(1);

    reporter.stop();
  });

  it('待岗标记随快照进来时同样不报完成(与 diffSnapshots 同口径)', () => {
    ctl.agents.set('a', { name: '小美', status: 'working', taskLabel: '登录页' });
    const reporter = makeReporter();
    reporter.start();
    vi.advanceTimersByTime(600);
    fire();

    ctl.agents.set('a', { name: '小美', status: 'idle', taskLabel: '登录页', standby: true });
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.pendingCount()).toBe(0);

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

  // ---- 09·B 四闸门接线 ----

  it('signalForEvent 按事件类型给评分分量(初始值非实测,防回归)', () => {
    expect(computeRelevanceScore(signalForEvent({ at: 1, kind: 'failed', agentId: 'a', text: 'x' }))).toBe(87);
    const waiting = signalForEvent({ at: 2, kind: 'waiting', agentId: 'a', text: 'x' });
    expect(computeRelevanceScore(waiting)).toBe(85);
    expect(waiting.timeSensitive).toBe(true);
    expect(computeRelevanceScore(signalForEvent({ at: 3, kind: 'completed', agentId: 'a', text: 'x' }))).toBe(70);
    expect(computeRelevanceScore(signalForEvent({ at: 4, kind: 'task-changed', agentId: 'a', text: 'x' }))).toBe(61);
  });

  it('failed 过闸为 SPEAK(立即口播)并记录决策观测', () => {
    const reporter = makeReporter();
    reporter.start();
    ctl.agents.set('a', { name: '小美', status: 'working' });
    vi.advanceTimersByTime(600);
    fire();
    ctl.agents.set('a', { name: '小美', status: 'error', lastError: '构建失败' });
    vi.advanceTimersByTime(600);
    fire();

    expect(reporter.pendingCount()).toBe(1);
    const stats = reporter.gatesStats();
    expect(stats.total).toBe(1);
    expect(stats.tierCounts.SPEAK).toBe(1);
    expect(stats.reasonCounts.urgent).toBe(1);
    expect(stats.recent[0]).toMatchObject({ kind: 'failed', tier: 'SPEAK', reason: 'urgent', score: 87 });
    expect(stats.spokenToday).toBe(1);
    expect(stats.instantSpeakToday).toBe(1);

    const text = reporter.flushNow();
    expect(text).toContain('小美 出错');
    expect(submitted).toHaveLength(1);
    reporter.stop();
  });

  it('STORE 档(预算用尽)走上屏通道:不进播报队列、不口播', () => {
    const stored: string[] = [];
    const reporter = makeReporter({
      gatesConfig: () => ({ ...DEFAULT_GATES_CONFIG, baseDailyBudget: 0 }),
      onStore: (t) => stored.push(t),
    });
    reporter.start();
    ctl.agents.set('a', { name: '小美', status: 'working' });
    vi.advanceTimersByTime(600);
    fire();
    ctl.agents.set('a', { name: '小美', status: 'idle' });
    vi.advanceTimersByTime(600);
    fire();

    expect(reporter.pendingCount()).toBe(0);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain('小美 完成任务');
    expect(reporter.gatesStats().reasonCounts.budget_exhausted).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(submitted).toHaveLength(0); // 只上屏,不口播
    reporter.stop();
  });

  it('低相关(SILENT)不进队列也不上屏,仅记幂等键', () => {
    const stored: string[] = [];
    const reporter = makeReporter({
      scope: 'all',
      gatesConfig: () => ({ ...DEFAULT_GATES_CONFIG, relevanceThreshold: 70 }),
      onStore: (t) => stored.push(t),
    });
    reporter.start();
    ctl.agents.set('a', { name: '小美', status: 'working', taskLabel: '任务一' });
    vi.advanceTimersByTime(600);
    fire();
    ctl.agents.set('a', { name: '小美', status: 'working', taskLabel: '任务二' });
    vi.advanceTimersByTime(600);
    fire();

    expect(reporter.pendingCount()).toBe(0);
    expect(stored).toHaveLength(0);
    const stats = reporter.gatesStats();
    expect(stats.tierCounts.SILENT).toBe(1);
    expect(stats.reasonCounts.low_relevance).toBe(1);
    expect(stats.seenKeysCount).toBe(1);
    reporter.stop();
  });

  it('预算预扣只发生一次:出队 flush 不再扣预算、不再过预算闸(残余风险①)', () => {
    const stored: string[] = [];
    const reporter = makeReporter({
      gatesConfig: () => ({ ...DEFAULT_GATES_CONFIG, baseDailyBudget: 2 }),
      onStore: (t) => stored.push(t),
    });
    reporter.start();
    ctl.agents.set('a', { name: '小美', status: 'working' });
    ctl.agents.set('b', { name: '阿强', status: 'working' });
    vi.advanceTimersByTime(600);
    fire();

    // ① failed → SPEAK(主 +1 / 子 +1);flush 出队不应再扣
    ctl.agents.set('a', { name: '小美', status: 'error', lastError: '构建失败' });
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.flushNow()).toContain('小美');
    expect(reporter.gatesStats().spokenToday).toBe(1);
    expect(reporter.gatesStats().instantSpeakToday).toBe(1);

    // ② completed → PREPARE(主 +1 = 2,恰好用尽);若 flush 重复扣①,这里会被判 STORE
    ctl.agents.set('b', { name: '阿强', status: 'idle' });
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.pendingCount()).toBe(1);
    expect(stored).toHaveLength(0);
    expect(reporter.flushNow()).toContain('阿强');
    expect(reporter.gatesStats().spokenToday).toBe(2);

    // ③ 预算硬顶:再一条 completed → STORE 上屏,不口播
    ctl.agents.set('c', { name: '小林', status: 'working' });
    vi.advanceTimersByTime(600);
    fire();
    ctl.agents.set('c', { name: '小林', status: 'idle' });
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.pendingCount()).toBe(0);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain('小林');
    expect(submitted).toHaveLength(2);
    const stats = reporter.gatesStats();
    expect(stats.tierCounts).toMatchObject({ SPEAK: 1, PREPARE: 1, STORE: 1 });
    reporter.stop();
  });

  it('深夜 PREPARE 出队挂起,白天再放行(不再过预算闸)', () => {
    vi.setSystemTime(new Date(2026, 9, 4, 2, 0)); // 02:00 深夜(start 前设定,避免触发 diff 节流)
    const reporter = makeReporter();
    reporter.start();
    ctl.agents.set('a', { name: '小美', status: 'working' });
    vi.advanceTimersByTime(600);
    fire();
    ctl.agents.set('a', { name: '小美', status: 'idle' });
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.pendingCount()).toBe(1);
    expect(reporter.gatesStats().reasonCounts.deep_night).toBe(1);

    expect(reporter.flushNow()).toBeNull(); // 挂起,不开口
    expect(submitted).toHaveLength(0);
    expect(reporter.pendingCount()).toBe(1); // 不丢弃

    vi.setSystemTime(new Date(2026, 9, 4, 12, 0)); // 白天
    expect(reporter.flushNow()).toContain('小美 完成任务');
    expect(submitted).toHaveLength(1);
    reporter.stop();
  });

  it('focus 时段(默认 09:00–11:00)紧急事件降级 PREPARE 并挂起', () => {
    vi.setSystemTime(new Date(2026, 9, 4, 10, 0)); // focus 内(start 前设定,避免触发 diff 节流)
    const reporter = makeReporter();
    reporter.start();
    ctl.agents.set('a', { name: '小美', status: 'working' });
    vi.advanceTimersByTime(600);
    fire();
    ctl.agents.set('a', { name: '小美', status: 'error', lastError: '构建失败' });
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.gatesStats().reasonCounts.focus_time).toBe(1);

    expect(reporter.flushNow()).toBeNull(); // focus 内挂起
    vi.setSystemTime(new Date(2026, 9, 4, 12, 0));
    expect(reporter.flushNow()).toContain('小美 出错');
    reporter.stop();
  });

  it('播报队列溢出(12 条上限)丢最旧前先落 STORE 上屏(沉默≠丢弃)', () => {
    const stored: string[] = [];
    const reporter = makeReporter({
      gatesConfig: () => ({ ...DEFAULT_GATES_CONFIG, baseDailyBudget: 50 }),
      onStore: (t) => stored.push(t),
    });
    reporter.start();
    for (let i = 0; i < 13; i++) {
      const id = `ag${i}`;
      ctl.agents.set(id, { name: `机器人${i}`, status: 'working' });
      vi.advanceTimersByTime(600);
      fire();
      ctl.agents.set(id, { name: `机器人${i}`, status: 'idle' });
      vi.advanceTimersByTime(600);
      fire();
    }
    expect(reporter.pendingCount()).toBe(12);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain('机器人0'); // 最旧一条转上屏,而不是消失
    expect(submitted).toHaveLength(0); // 仍在静默窗口内,未口播
    reporter.stop();
  });

  it('seenKeys 有界:超过 200 条裁剪最旧(残余风险②)', () => {
    const reporter = makeReporter({
      scope: 'all',
      gatesConfig: () => ({ ...DEFAULT_GATES_CONFIG, relevanceThreshold: 70 }),
    });
    reporter.start();
    for (let i = 0; i < 210; i++) {
      ctl.agents.set('a', { name: '小美', status: 'working', taskLabel: `任务${i}` });
      vi.advanceTimersByTime(600);
      fire();
    }
    const stats = reporter.gatesStats();
    expect(stats.reasonCounts.low_relevance).toBe(209); // 第一条 fire 只是登记基线
    expect(stats.seenKeysCount).toBe(200); // 有界,无界增长已封住
    expect(reporter.pendingCount()).toBe(0);
    reporter.stop();
  });

  it('跨日重置每日预算与口播子配额', () => {
    const stored: string[] = [];
    const reporter = makeReporter({
      gatesConfig: () => ({ ...DEFAULT_GATES_CONFIG, baseDailyBudget: 1 }),
      onStore: (t) => stored.push(t),
    });
    reporter.start();
    ctl.agents.set('a', { name: '小美', status: 'working' });
    vi.advanceTimersByTime(600);
    fire();
    ctl.agents.set('a', { name: '小美', status: 'idle' });
    vi.advanceTimersByTime(600);
    fire(); // completed → PREPARE,占满当日预算
    ctl.agents.set('b', { name: '阿强', status: 'working' });
    vi.advanceTimersByTime(600);
    fire();
    ctl.agents.set('b', { name: '阿强', status: 'idle' });
    vi.advanceTimersByTime(600);
    fire(); // 预算用尽 → STORE
    expect(stored).toHaveLength(1);

    vi.setSystemTime(new Date(2026, 9, 5, 15, 0)); // 次日
    ctl.agents.set('c', { name: '小林', status: 'working' });
    vi.advanceTimersByTime(600);
    fire();
    ctl.agents.set('c', { name: '小林', status: 'idle' });
    vi.advanceTimersByTime(600);
    fire(); // 跨日后计数归零 → 恢复为 PREPARE
    expect(reporter.pendingCount()).toBe(2); // 昨日未发的仍在队列
    expect(reporter.gatesStats().spokenToday).toBe(1);
    const text = reporter.flushNow();
    expect(text).toContain('小美');
    expect(text).toContain('小林');
    reporter.stop();
  });

  // ---- 任务08② 回执订阅(派活闭环):同一队列/闸门 + 同目标覆盖抑制 ----

  function receiptOf(overrides: Partial<ProactiveReceipt> = {}): ProactiveReceipt {
    return {
      agentId: 'a',
      success: true,
      matched: true,
      text: '小美 完成任务:登录页',
      at: Date.now(),
      dedupeKey: 'agent-completed:a:t-1',
      taskId: 't-1',
      ...overrides,
    };
  }

  it('⑥3 客户端:mock 判断层返回「沉默」→ 回执不进队列,flush 无口播/无上屏', () => {
    const stored: string[] = [];
    const reporter = makeReporter({ onStore: (t) => stored.push(t) });
    reporter.start();

    vi.mocked(decideBroadcast).mockReturnValueOnce({
      tier: 'SILENT',
      reason: 'low_relevance',
      score: 40,
      disruption: 20,
      budget: 10,
      duplicate: false,
      delta: { seenKeysToAdd: [], dailySpokenDelta: 0, instantSpeechDelta: 0 },
    });

    const result = reporter.ingestReceipt(receiptOf());
    expect(result).toMatchObject({ action: 'silent', tier: 'SILENT' });
    expect(reporter.pendingCount()).toBe(0);
    expect(reporter.flushNow({ force: true })).toBeNull(); // 无音频路径
    expect(submitted).toHaveLength(0);
    expect(stored).toHaveLength(0);
    reporter.stop();
  });

  it('回执入队(稳定键)并覆盖抑制同目标 diff:同一次完成只播一次,文本带任务摘要', () => {
    const reporter = makeReporter();
    reporter.start();
    ctl.agents.set('a', { name: '小美', status: 'working', taskLabel: '登录页' });
    vi.advanceTimersByTime(600);
    fire(); // 基线登记 working

    const result = reporter.ingestReceipt(receiptOf());
    expect(result).toMatchObject({ action: 'queued', tier: 'PREPARE' });
    expect(reporter.pendingCount()).toBe(1);
    expect(reporter.gatesStats().spokenToday).toBe(1); // 与 diff 通道同一预算

    // 完成状态 diff 到达:被回执覆盖抑制(不重复入队、不重复计数)
    ctl.agents.set('a', { name: '小美', status: 'idle', taskLabel: '登录页' });
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.pendingCount()).toBe(1);
    expect(reporter.gatesStats().total).toBe(1);

    const text = reporter.flushNow();
    expect(text).toContain('小美 完成任务:登录页');
    expect(text?.split('完成任务').length).toBe(2); // 恰好一次(不双播)
    expect(submitted).toHaveLength(1);
    reporter.stop();
  });

  it('覆盖抑制只消费一次:后续新任务的完成 diff 正常入队', () => {
    const reporter = makeReporter();
    reporter.start();
    ctl.agents.set('a', { name: '小美', status: 'working' });
    vi.advanceTimersByTime(600);
    fire();

    reporter.ingestReceipt(receiptOf());
    ctl.agents.set('a', { name: '小美', status: 'idle' });
    vi.advanceTimersByTime(600);
    fire(); // 覆盖消费
    expect(reporter.pendingCount()).toBe(1);

    ctl.agents.set('a', { name: '小美', status: 'working' });
    vi.advanceTimersByTime(600);
    fire();
    ctl.agents.set('a', { name: '小美', status: 'idle', taskLabel: '新任务' });
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.pendingCount()).toBe(2); // 第二次完成未被抑制
    reporter.stop();
  });

  it('新任务开始(→working)清覆盖:旧回执不抑制下一次完成', () => {
    const reporter = makeReporter();
    reporter.start();
    ctl.agents.set('a', { name: '小美', status: 'waiting' });
    vi.advanceTimersByTime(600);
    fire(); // 基线登记 waiting

    reporter.ingestReceipt(receiptOf()); // 覆盖登记(kind completed)
    ctl.agents.set('a', { name: '小美', status: 'working' }); // 新任务开始 →working 清覆盖
    vi.advanceTimersByTime(600);
    fire();
    ctl.agents.set('a', { name: '小美', status: 'idle' });
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.pendingCount()).toBe(2); // 回执 1 条 + 本次完成 diff 1 条(未被旧覆盖吞掉)
    reporter.stop();
  });

  it('diff 先到、回执后到:原位合并升级文本与稳定键,重复回执按键沉默', () => {
    const reporter = makeReporter();
    reporter.start();
    ctl.agents.set('a', { name: '小美', status: 'working' });
    vi.advanceTimersByTime(600);
    fire();
    ctl.agents.set('a', { name: '小美', status: 'idle', taskLabel: '登录页' });
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.pendingCount()).toBe(1); // 先是 diff 简版文本

    const merged = reporter.ingestReceipt(receiptOf());
    expect(merged).toMatchObject({ action: 'merged', tier: 'PREPARE' });
    expect(reporter.pendingCount()).toBe(1); // 原位合并,不新增条目
    expect(reporter.gatesStats().spokenToday).toBe(1); // 合并不重复扣预算

    const duplicate = reporter.ingestReceipt(receiptOf()); // 同稳定键再来一次
    expect(duplicate.action).toBe('silent');
    expect(reporter.pendingCount()).toBe(1);

    const text = reporter.flushNow();
    expect(text).toContain('小美 完成任务:登录页');
    expect(text?.split('完成任务').length).toBe(2); // 只播一次
    expect(submitted).toHaveLength(1);
    reporter.stop();
  });

  it('预算统一:回执与 diff 共用当日预算(回执占满后 diff 降级 STORE 上屏)', () => {
    const stored: string[] = [];
    const reporter = makeReporter({
      gatesConfig: () => ({ ...DEFAULT_GATES_CONFIG, baseDailyBudget: 1 }),
      onStore: (t) => stored.push(t),
    });
    reporter.start();
    reporter.ingestReceipt(receiptOf()); // completed → PREPARE,占满预算
    expect(reporter.gatesStats().spokenToday).toBe(1);

    ctl.agents.set('b', { name: '阿强', status: 'working' });
    vi.advanceTimersByTime(600);
    fire();
    ctl.agents.set('b', { name: '阿强', status: 'idle' });
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.pendingCount()).toBe(1); // 队列里只有回执
    expect(stored).toHaveLength(1); // 预算用尽 → 仅上屏
    expect(stored[0]).toContain('阿强');
    reporter.stop();
  });

  it('STORE 档回执上屏后,同目标 diff 被覆盖抑制(同一完成不上屏两条)', () => {
    const stored: string[] = [];
    const reporter = makeReporter({
      gatesConfig: () => ({ ...DEFAULT_GATES_CONFIG, baseDailyBudget: 0 }),
      onStore: (t) => stored.push(t),
    });
    reporter.start();
    ctl.agents.set('a', { name: '小美', status: 'working' });
    vi.advanceTimersByTime(600);
    fire();

    const result = reporter.ingestReceipt(receiptOf());
    expect(result).toMatchObject({ action: 'stored', tier: 'STORE' });
    expect(stored).toHaveLength(1);

    ctl.agents.set('a', { name: '小美', status: 'idle' });
    vi.advanceTimersByTime(600);
    fire();
    expect(stored).toHaveLength(1); // diff 被抑制,不重复上屏
    expect(reporter.pendingCount()).toBe(0);
    reporter.stop();
  });

  // ---- 任务41 「老板问的」回执(requested):人在场提分过破例线 ----

  /** 任务41 样例:boss-uplink 回执(文本 = 主管完整回复)。 */
  function bossReceiptOf(overrides: Partial<ProactiveReceipt> = {}): ProactiveReceipt {
    return receiptOf({
      agentId: 'boss-1',
      text: 'Jarvis 已回复:看下手机验证码——手机通知共 3 条,没有验证码',
      dedupeKey: 'boss-uplink:boss-1:t-41',
      taskId: 't-41',
      requested: true,
      ...overrides,
    });
  }

  it('任务41 深夜:老板问的回执 + 人还在场(窗内提交过)→ 提分过破例线,即刻交播', () => {
    vi.setSystemTime(new Date(2026, 9, 4, 23, 30)); // 深夜
    const activeAt = new Date(2026, 9, 4, 23, 20).getTime(); // 10 分钟前刚提交过
    const reporter = makeReporter({ userActivityAt: () => activeAt });
    reporter.start();

    const result = reporter.ingestReceipt(bossReceiptOf());
    expect(result).toMatchObject({ action: 'queued', tier: 'SPEAK' }); // 提分 95 → 立即档
    expect(reporter.flushNow()).toContain('没有验证码'); // 深夜不挂起
    expect(submitted).toHaveLength(1);
    reporter.stop();
  });

  it('任务41 深夜:老板问的回执 + 人不在场(超护栏窗)→ 照常挂起,白天再放行', () => {
    vi.setSystemTime(new Date(2026, 9, 4, 23, 30));
    const activeAt = new Date(2026, 9, 4, 22, 50).getTime(); // 40 分钟前,超 30 分钟窗
    const reporter = makeReporter({ userActivityAt: () => activeAt });
    reporter.start();

    const result = reporter.ingestReceipt(bossReceiptOf());
    expect(result).toMatchObject({ action: 'queued', tier: 'PREPARE' }); // 普通档
    expect(reporter.flushNow()).toBeNull(); // 深夜挂起,不打扰
    expect(submitted).toHaveLength(0);

    vi.setSystemTime(new Date(2026, 9, 5, 8, 0)); // 白天
    expect(reporter.flushNow()).toContain('没有验证码');
    reporter.stop();
  });

  it('任务41 深夜:diff 先到(70 分挂起),老板问的回执后到合并 → 提分放行且不新增条目', () => {
    vi.setSystemTime(new Date(2026, 9, 4, 23, 30));
    const activeAt = new Date(2026, 9, 4, 23, 29).getTime();
    const reporter = makeReporter({ userActivityAt: () => activeAt });
    reporter.start();
    ctl.agents.set('boss-1', { name: 'Jarvis', status: 'working' });
    vi.advanceTimersByTime(600);
    fire();
    ctl.agents.set('boss-1', { name: 'Jarvis', status: 'idle' });
    vi.advanceTimersByTime(600);
    fire();
    expect(reporter.pendingCount()).toBe(1); // diff 版(70 分)
    expect(reporter.flushNow()).toBeNull(); // 深夜挂起

    const result = reporter.ingestReceipt(bossReceiptOf());
    expect(result.action).toBe('merged'); // 原位合并
    expect(reporter.pendingCount()).toBe(1);
    expect(reporter.flushNow()).toContain('没有验证码'); // 提分后放行,文本用回执完整版
    expect(submitted).toHaveLength(1);
    reporter.stop();
  });
});
