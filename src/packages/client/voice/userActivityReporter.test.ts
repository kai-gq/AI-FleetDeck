/**
 * 用户活跃上报 —— 单测。
 *
 * 覆盖:start 立即上报 voice-page(force)、全 kind 共享 leading-edge 节流窗口、
 * 窗口过期放行、force 绕过节流并重开窗口、window focus / document 变可见 → focus、
 * stop 移除监听且不再上报、start 幂等、无 DOM(node)no-op、
 * post 同步抛错 / 异步 reject 静默且不影响后续。
 * 时间用注入 now 控制(不 sleep),DOM 用注入的假 target(vitest 环境是 node,无 jsdom)。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createUserActivityReporter,
  type UserActivityKind,
  type UserActivityReporterOptions,
} from './userActivityReporter';

type Listener = (event?: unknown) => void;

/** 最小事件目标假件:记录监听器、可手动 fire,便于断言「挂上/卸掉」。 */
class FakeEventTarget {
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type });
  }

  listenerCount(type?: string): number {
    if (type !== undefined) return this.listeners.get(type)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

class FakeDocument extends FakeEventTarget {
  visibilityState = 'visible';
}

function makeHarness(over: Partial<UserActivityReporterOptions> = {}) {
  const doc = new FakeDocument();
  const win = new FakeEventTarget();
  let clock = 0;
  const posted: UserActivityKind[] = [];
  const reporter = createUserActivityReporter({
    now: () => clock,
    post: (kind) => {
      posted.push(kind);
    },
    target: { document: doc as unknown as Document, window: win as unknown as Window },
    ...over,
  });
  return {
    reporter,
    doc,
    win,
    posted,
    setClock: (value: number) => {
      clock = value;
    },
  };
}

/** 等异步 post 的 rejection 处理链跑完。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createUserActivityReporter', () => {
  it('start 立即上报一次 voice-page(force,不受节流);同一窗口内的输入全被丢弃', () => {
    const { reporter, doc, posted } = makeHarness();
    reporter.start();
    expect(posted).toEqual(['voice-page']);

    doc.fire('keydown');
    doc.fire('pointerdown');
    doc.fire('wheel');
    expect(posted).toEqual(['voice-page']); // 窗口内不再报
    reporter.stop();
  });

  it('窗口过期后放行;仍是 leading edge(窗口内首次触发即上报)', () => {
    const { reporter, doc, win, posted, setClock } = makeHarness();
    reporter.start(); // t=0 voice-page
    setClock(1_000);
    doc.fire('keydown'); // 窗口内 → 丢
    setClock(59_999);
    win.fire('focus'); // 窗口内 → 丢
    expect(posted).toEqual(['voice-page']);

    setClock(60_000);
    doc.fire('keydown'); // 恰好到期 → 报,窗口重开
    expect(posted).toEqual(['voice-page', 'input']);

    setClock(60_500);
    doc.fire('wheel'); // 新窗口内 → 丢
    setClock(119_999);
    doc.fire('pointerdown'); // 新窗口内 → 丢
    expect(posted).toEqual(['voice-page', 'input']);

    setClock(120_000);
    doc.fire('keydown');
    expect(posted).toEqual(['voice-page', 'input', 'input']);
    reporter.stop();
  });

  it('reportNow force 绕过节流,并从 force 时刻重开窗口', () => {
    const { reporter, posted, setClock } = makeHarness();
    reporter.start(); // t=0 voice-page
    setClock(1_000);
    reporter.reportNow('focus');
    expect(posted).toEqual(['voice-page']); // 非 force:窗口内丢

    reporter.reportNow('focus', { force: true });
    expect(posted).toEqual(['voice-page', 'focus']);

    setClock(59_000);
    reporter.reportNow('input'); // 相对 force(1_000)不足 60s → 丢
    expect(posted).toEqual(['voice-page', 'focus']);

    setClock(61_000);
    reporter.reportNow('input');
    expect(posted).toEqual(['voice-page', 'focus', 'input']);
    reporter.stop();
  });

  it('focus 通道:window focus 与 document 变可见各报一次;隐藏时不上报', () => {
    const { reporter, doc, win, posted, setClock } = makeHarness();
    reporter.start();
    setClock(60_000);
    win.fire('focus');
    expect(posted).toEqual(['voice-page', 'focus']);

    setClock(70_000);
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange'); // 隐藏不算活跃
    expect(posted).toEqual(['voice-page', 'focus']);

    setClock(121_000);
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange'); // 变可见 → focus
    expect(posted).toEqual(['voice-page', 'focus', 'focus']);
    reporter.stop();
  });

  it('stop 移除全部监听:事件与 reportNow 都不再上报', () => {
    const { reporter, doc, win, posted } = makeHarness();
    reporter.start();
    expect(doc.listenerCount()).toBe(4); // keydown/pointerdown/wheel/visibilitychange
    expect(win.listenerCount()).toBe(1); // focus

    reporter.stop();
    expect(doc.listenerCount()).toBe(0);
    expect(win.listenerCount()).toBe(0);

    doc.fire('keydown');
    doc.fire('visibilitychange');
    win.fire('focus');
    reporter.reportNow('input', { force: true });
    expect(posted).toEqual(['voice-page']);
    reporter.stop(); // 幂等
  });

  it('start 幂等:重复 start 不重复挂监听、不重复报 voice-page', () => {
    const { reporter, doc, win, posted } = makeHarness();
    reporter.start();
    reporter.start();
    expect(posted).toEqual(['voice-page']);
    expect(doc.listenerCount('keydown')).toBe(1);
    expect(doc.listenerCount()).toBe(4);
    expect(win.listenerCount()).toBe(1);
    reporter.stop();
  });

  it('无 document/window(纯 node)时 start/reportNow 均 no-op,不抛', () => {
    const post = vi.fn();
    const reporter = createUserActivityReporter({ now: () => 0, post });
    expect(() => reporter.start()).not.toThrow();
    reporter.reportNow('input');
    reporter.reportNow('voice-page', { force: true });
    expect(post).not.toHaveBeenCalled();
    reporter.stop();
  });

  it('post 同步抛错 / 异步 reject 一律静默,不影响后续上报', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const doc = new FakeDocument();
      const win = new FakeEventTarget();
      let clock = 0;
      const posted: UserActivityKind[] = [];
      const reporter = createUserActivityReporter({
        now: () => clock,
        post: (kind) => {
          posted.push(kind);
          if (kind === 'voice-page') throw new Error('sync boom');
          return Promise.reject(new Error('async boom'));
        },
        target: { document: doc as unknown as Document, window: win as unknown as Window },
      });

      expect(() => reporter.start()).not.toThrow(); // 同步抛错不炸
      await flush();
      expect(posted).toEqual(['voice-page']); // 抛错也不重试
      expect(doc.listenerCount()).toBe(4); // 监听照常挂上

      clock = 60_000;
      doc.fire('keydown');
      await flush(); // reject 被吞(未处理的 rejection 会让 vitest 报错)
      expect(posted).toEqual(['voice-page', 'input']);

      clock = 120_000;
      doc.fire('keydown'); // 失败不卡死节流状态
      await flush();
      expect(posted).toEqual(['voice-page', 'input', 'input']);
      reporter.stop();
    } finally {
      debug.mockRestore();
    }
  });
});
