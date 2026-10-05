/**
 * 提醒取件(客户端)—— 单测。
 *
 * 覆盖:标记识别(agentId+id 前缀)、链式包装(保留/还原既有 toast 消费、
 * 被顶掉后自愈重包)、leader 门、busy 挂起补播、WS/轮询去重、串行播报 +
 * 播完回执、播报失败不回执、回执失败不重播、轮询失败重试、5s 定时轮询。
 * deps 全注入(不碰真实 fetch/TTS)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cb } from '../websocket/callbacks';
import {
  VOICE_REMINDER_AGENT_ID,
  createReminderWatcher,
  parseReminderNotification,
  type DueReminder,
  type ReminderWatcherDeps,
} from './reminderWatcher';
import type { AgentNotification } from '../../shared/types';

/** 等待 pump 的微任务链跑完(真实定时器下的零延时宏任务)。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 服务端 buildReminderNotificationMessage 产出的通知形态。 */
function notification(over: Partial<AgentNotification> = {}): AgentNotification {
  return {
    id: 'voice-reminder-vr-1',
    agentId: VOICE_REMINDER_AGENT_ID,
    agentName: '语音提醒',
    agentClass: 'support',
    title: '到点了',
    message: '老大,到点了:喝水。',
    timestamp: 0,
    ...over,
  } as AgentNotification;
}

function makeWatcher(over: Partial<ReminderWatcherDeps> = {}) {
  const logs: string[] = [];
  const deps: ReminderWatcherDeps = {
    isLeader: () => true,
    isBusy: () => false,
    speak: vi.fn(async () => {}),
    ack: vi.fn(async () => {}),
    fetchDue: vi.fn(async () => [] as DueReminder[]),
    log: (message) => logs.push(message),
    ...over,
  };
  const watcher = createReminderWatcher(deps);
  return { watcher, deps, logs };
}

beforeEach(() => {
  cb.onAgentNotification = null;
});

// ============================================================================
// 标记识别(纯函数)
// ============================================================================

describe('parseReminderNotification —— 标记识别', () => {
  it('命中:agentId + id 前缀 → {id, say}', () => {
    expect(parseReminderNotification(notification())).toEqual({ id: 'vr-1', say: '老大,到点了:喝水。' });
  });

  it('非提醒通知/前缀残缺一律 null', () => {
    expect(parseReminderNotification(notification({ agentId: 'agent-1' }))).toBeNull();
    expect(parseReminderNotification(notification({ id: 'other-1' }))).toBeNull();
    expect(parseReminderNotification(notification({ id: 'voice-reminder-' }))).toBeNull();
    expect(parseReminderNotification({})).toBeNull();
  });

  it('message 缺失/空白 → 兜底话术(服务端总会带 say)', () => {
    expect(parseReminderNotification(notification({ message: '' }))?.say).toBe('老大,到点了。');
    expect(parseReminderNotification(notification({ message: '   ' }))?.say).toBe('老大,到点了。');
  });

  it('ingestNotification 返回识别结果(非提醒 false,启动前无副作用)', () => {
    const { watcher, deps } = makeWatcher();
    expect(watcher.ingestNotification(notification())).toBe(true);
    expect(watcher.ingestNotification(notification({ agentId: 'x' }))).toBe(false);
    expect(deps.speak).not.toHaveBeenCalled(); // 未 start:不认领不播
  });
});

// ============================================================================
// 通知通道(链式包装)
// ============================================================================

describe('通知通道(链式包装 cb.onAgentNotification)', () => {
  it('既有 toast 消费保留:toast 先走,提醒照播并回执;stop 还原', async () => {
    const toast = vi.fn();
    cb.onAgentNotification = toast;
    const { watcher, deps } = makeWatcher();
    watcher.start();
    try {
      cb.onAgentNotification?.(notification());
      expect(toast).toHaveBeenCalledTimes(1);
      await flush();
      expect(deps.speak).toHaveBeenCalledWith('老大,到点了:喝水。');
      expect(deps.ack).toHaveBeenCalledWith('vr-1');
    } finally {
      watcher.stop();
    }
    expect(cb.onAgentNotification).toBe(toast);
  });

  it('既有消费回调抛错不阻断提醒', async () => {
    cb.onAgentNotification = () => {
      throw new Error('toast boom');
    };
    const { watcher, deps, logs } = makeWatcher();
    watcher.start();
    try {
      cb.onAgentNotification?.(notification());
      await flush();
      expect(deps.speak).toHaveBeenCalledTimes(1);
      expect(logs.some((m) => m.includes('既有通知消费回调出错'))).toBe(true);
    } finally {
      watcher.stop();
    }
  });

  it('包装被后挂载组件顶掉:下一跳 pollNow 自愈重包(新 handler 保链)', async () => {
    const { watcher, deps } = makeWatcher();
    watcher.start();
    try {
      const lateToast = vi.fn();
      cb.onAgentNotification = lateToast; // 模拟 setCallbacks 后到,顶掉包装
      await watcher.pollNow();
      cb.onAgentNotification?.(notification());
      expect(lateToast).toHaveBeenCalledTimes(1);
      await flush();
      expect(deps.speak).toHaveBeenCalledTimes(1);
    } finally {
      watcher.stop();
    }
  });

  it('stop 时若包装已被顶掉,不触碰别人的 handler', () => {
    const { watcher } = makeWatcher();
    watcher.start();
    const lateToast = vi.fn();
    cb.onAgentNotification = lateToast;
    watcher.stop();
    expect(cb.onAgentNotification).toBe(lateToast);
  });
});

// ============================================================================
// leader 门 / busy 挂起 / 去重
// ============================================================================

describe('leader 门 / busy 挂起 / 去重', () => {
  it('非 leader 不认领;接管为 leader 后由轮询补播', async () => {
    let leader = false;
    const { watcher, deps } = makeWatcher({
      isLeader: () => leader,
      fetchDue: vi.fn(async () => [{ id: 'vr-9', say: '老大,到点了。' }]),
    });
    watcher.start();
    try {
      await flush();
      expect(deps.speak).not.toHaveBeenCalled();
      leader = true;
      await watcher.pollNow();
      await flush();
      expect(deps.speak).toHaveBeenCalledWith('老大,到点了。');
      expect(deps.ack).toHaveBeenCalledWith('vr-9');
    } finally {
      watcher.stop();
    }
  });

  it('busy(聆听/思考/播报中)挂起,下一 tick 补播', async () => {
    let busy = true;
    const { watcher, deps } = makeWatcher({ isBusy: () => busy });
    watcher.start();
    try {
      cb.onAgentNotification?.(notification());
      await flush();
      expect(deps.speak).not.toHaveBeenCalled();
      expect(watcher.pendingCount()).toBe(1);

      busy = false;
      await watcher.pollNow();
      await flush();
      expect(deps.speak).toHaveBeenCalledTimes(1);
      expect(watcher.pendingCount()).toBe(0);
    } finally {
      watcher.stop();
    }
  });

  it('WS 与轮询同一条:只播一次、只回执一次', async () => {
    const { watcher, deps } = makeWatcher({
      fetchDue: vi.fn(async () => [{ id: 'vr-1', say: '老大,到点了:喝水。' }]),
    });
    watcher.start();
    try {
      cb.onAgentNotification?.(notification());
      await watcher.pollNow();
      await flush();
      expect(deps.speak).toHaveBeenCalledTimes(1);
      expect(deps.ack).toHaveBeenCalledTimes(1);
    } finally {
      watcher.stop();
    }
  });
});

// ============================================================================
// 播报与回执
// ============================================================================

describe('播报与回执', () => {
  it('多条串行:前一条回执完成后才播第二条', async () => {
    const order: string[] = [];
    const gate = deferred();
    const speak = vi.fn(async (text: string) => {
      order.push(`speak:${text}`);
      if (text.includes('喝水')) await gate.promise;
    });
    const ack = vi.fn(async (id: string) => {
      order.push(`ack:${id}`);
    });
    const { watcher } = makeWatcher({
      speak,
      ack,
      fetchDue: vi.fn(async () => [
        { id: 'a', say: '老大,到点了:喝水。' },
        { id: 'b', say: '老大,到点了。' },
      ]),
    });
    watcher.start();
    try {
      await flush();
      expect(order).toEqual(['speak:老大,到点了:喝水。']);
      gate.resolve();
      await flush();
      expect(order).toEqual([
        'speak:老大,到点了:喝水。',
        'ack:a',
        'speak:老大,到点了。',
        'ack:b',
      ]);
    } finally {
      watcher.stop();
    }
  });

  it('播报失败不 ack(保持 due 补播);后续条目照常', async () => {
    const speak = vi.fn(async (text: string) => {
      if (text.includes('喝水')) throw new Error('tts down');
    });
    const { watcher, deps, logs } = makeWatcher({
      speak,
      fetchDue: vi.fn(async () => [
        { id: 'a', say: '老大,到点了:喝水。' },
        { id: 'b', say: '老大,到点了。' },
      ]),
    });
    watcher.start();
    try {
      await flush();
      expect(deps.ack).toHaveBeenCalledTimes(1);
      expect(deps.ack).toHaveBeenCalledWith('b');
      expect(logs.some((m) => m.includes('播报失败'))).toBe(true);
    } finally {
      watcher.stop();
    }
  });

  it('回执失败:本页不重播同一条(下回进页补播),日志留痕', async () => {
    const ack = vi.fn(async () => {
      throw new Error('net');
    });
    const { watcher, deps, logs } = makeWatcher({
      ack,
      fetchDue: vi.fn(async () => [{ id: 'a', say: '老大,到点了。' }]),
    });
    watcher.start();
    try {
      await flush();
      await watcher.pollNow();
      await flush();
      expect(deps.speak).toHaveBeenCalledTimes(1); // 服务端仍 due,但本页 seen 拦住重播
      expect(logs.some((m) => m.includes('回执失败'))).toBe(true);
    } finally {
      watcher.stop();
    }
  });

  it('轮询失败不炸;下一次轮询重试并补播', async () => {
    const fetchDue = vi
      .fn<() => Promise<DueReminder[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([{ id: 'a', say: '老大,到点了。' }]);
    const { watcher, deps, logs } = makeWatcher({ fetchDue });
    watcher.start();
    try {
      await flush();
      expect(logs.some((m) => m.includes('轮询失败'))).toBe(true);
      await watcher.pollNow();
      await flush();
      expect(deps.speak).toHaveBeenCalledTimes(1);
    } finally {
      watcher.stop();
    }
  });
});

// ============================================================================
// 定时轮询
// ============================================================================

describe('定时轮询(5s tick)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cb.onAgentNotification = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('启动立即补拉一次,之后每 5s 一跳;stop 后停止', async () => {
    const fetchDue = vi.fn(async () => [] as DueReminder[]);
    const { watcher } = makeWatcher({ fetchDue });
    watcher.start();
    expect(fetchDue).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchDue).toHaveBeenCalledTimes(2);

    watcher.stop();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchDue).toHaveBeenCalledTimes(2);
  });

  it('间隔可注入(pollIntervalMs)', async () => {
    const fetchDue = vi.fn(async () => [] as DueReminder[]);
    const { watcher } = makeWatcher({ fetchDue, pollIntervalMs: 1_000 });
    watcher.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchDue).toHaveBeenCalledTimes(3); // 启动 1 + 2 tick
    watcher.stop();
  });
});
