/**
 * W7 垫话预生成状态机专测:阈值/一次性/密封/命中消费/不命中不消费/顶替/TTL/清理/onHint 时机。
 * 纯模块:生成器与 hint 都注入,不触服务、不触网。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFillerPregen, normalizeAsrText, partialMatchesFinal } from './filler-pregen.js';

function deferred(): { promise: Promise<string | null>; resolve: (v: string | null) => void } {
  let resolve!: (v: string | null) => void;
  const promise = new Promise<string | null>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('归一化与匹配', () => {
  it('normalizeAsrText 去空白与标点', () => {
    expect(normalizeAsrText('查一下,最近的 天气。')).toBe('查一下最近的天气');
    expect(normalizeAsrText('主管 a!')).toBe('主管a');
    expect(normalizeAsrText('Hello, world!')).toBe('Helloworld');
  });

  it('partialMatchesFinal:前缀 / 尾部 2 字容忍 / 过短与不符拒绝', () => {
    expect(partialMatchesFinal('查一下最近的天气', '查一下最近的天气')).toBe(true);
    expect(partialMatchesFinal('查一下最近的天气', '查一下最近的天气啊')).toBe(true); // 尾 2 字差
    expect(partialMatchesFinal('查一下最近的天气', '查一下最近的天')).toBe(true); // 前缀
    expect(partialMatchesFinal('晚上吃什么', '查一下最近的天气')).toBe(false);
    expect(partialMatchesFinal('嗯,好的', '嗯')).toBe(false); // 过短不认
    expect(partialMatchesFinal('', '查一下最近的天气')).toBe(false);
  });
});

describe('触发与密封', () => {
  it('阈值 6 字:不足不触发;触发仅一次;后续 partial 只刷新匹配源', async () => {
    const pregen = createFillerPregen();
    const generate = vi.fn(async () => '我在呢');
    const hint = vi.fn();

    pregen.notePartial('查天气', generate, hint);
    expect(generate).not.toHaveBeenCalled();

    pregen.notePartial('查一下最近的天', generate, hint); // 7 字:触发
    pregen.notePartial('查一下最近的天气', generate, hint); // 刷新匹配源
    await tick();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(hint).toHaveBeenCalledWith('我在呢');

    pregen.seal();
    // 匹配用「最后的 partial」:final 带语气词仍命中
    expect(pregen.take('查一下最近的天气啊,谢谢')?.ready).toBe('我在呢');
  });

  it('密封时生成尚未就绪:take 返回 pending,resolve 后拿到文本', async () => {
    const pregen = createFillerPregen();
    const d = deferred();
    const hint = vi.fn();
    pregen.notePartial('查一下最近的天气', () => d.promise, hint);
    pregen.seal();

    const take = pregen.take('查一下最近的天气');
    expect(take).not.toBeNull();
    expect(take!.ready).toBeNull();
    expect(take!.pending).not.toBeNull();

    d.resolve('稍等哈');
    await expect(take!.pending!).resolves.toBe('稍等哈');
    expect(hint).toHaveBeenCalledWith('稍等哈'); // 就绪即推(密封但未消费)
  });

  it('生成失败:take 返回 null(回退常规路径),不推 hint', async () => {
    const pregen = createFillerPregen();
    const d = deferred();
    const hint = vi.fn();
    pregen.notePartial('查一下最近的天气', () => d.promise, hint);
    pregen.seal();
    const take = pregen.take('查一下最近的天气');
    d.resolve(null);
    await expect(take!.pending!).resolves.toBeNull();
    expect(hint).not.toHaveBeenCalled();
  });
});

describe('take 消费语义', () => {
  it('命中即消费:同一槽第二次 take 得 null', async () => {
    const pregen = createFillerPregen();
    pregen.notePartial('查一下最近的天气', async () => '天气的事啊', vi.fn());
    await tick();
    pregen.seal();
    expect(pregen.take('查一下最近的天气')?.ready).toBe('天气的事啊');
    expect(pregen.take('查一下最近的天气')).toBeNull();
  });

  it('不命中不消费:文本不符留槽,下一回合仍可命中', async () => {
    const pregen = createFillerPregen();
    pregen.notePartial('查一下最近的天气', async () => '天气的事啊', vi.fn());
    await tick();
    pregen.seal();
    expect(pregen.take('晚上吃什么')).toBeNull(); // 不符:留槽
    expect(pregen.take('查一下最近的天气')?.ready).toBe('天气的事啊');
  });

  it('新句密封顶替旧槽:旧文本取不到,新文本可命中;被顶替的在途结果不推 hint', async () => {
    const pregen = createFillerPregen();
    const dA = deferred();
    const hintA = vi.fn();
    pregen.notePartial('查一下最近的天气', () => dA.promise, hintA);
    pregen.seal(); // 槽 A:生成在途

    const dB = deferred();
    pregen.notePartial('帮我看看主管的活', () => dB.promise, vi.fn());
    pregen.seal(); // 槽 B 顶替 A

    expect(pregen.take('查一下最近的天气')).toBeNull(); // A 已被顶替
    dA.resolve('天气的事啊');
    await tick();
    expect(hintA).not.toHaveBeenCalled(); // 顶替后 hint 作废

    const takeB = pregen.take('帮我看看主管在干嘛');
    expect(takeB!.pending).not.toBeNull();
    dB.resolve('这就看');
    await expect(takeB!.pending!).resolves.toBe('这就看');
  });
});

describe('TTL 与清理', () => {
  it('密封超过 TTL 未取用 → 未命中', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const pregen = createFillerPregen({ sealedTtlMs: 30_000 });
    pregen.notePartial('查一下最近的天气', async () => '天气的事啊', vi.fn());
    await tick();
    pregen.seal();

    now += 31_000;
    expect(pregen.take('查一下最近的天气')).toBeNull();
  });

  it('dropWorking:半截工作槽作废,新 partial 重新触发;旧在途结果不推 hint', async () => {
    const pregen = createFillerPregen();
    const d1 = deferred();
    const hint1 = vi.fn();
    pregen.notePartial('查一下最近的天气', () => d1.promise, hint1);
    pregen.dropWorking();

    const generate2 = vi.fn(async () => '这就看');
    pregen.notePartial('帮我看看主管的活', generate2, vi.fn());
    expect(generate2).toHaveBeenCalledTimes(1);

    d1.resolve('旧结果');
    await tick();
    expect(hint1).not.toHaveBeenCalled();
    // 旧槽作废:即使文本对得上也取不到(它从未被密封)
    expect(pregen.take('查一下最近的天气')).toBeNull();
  });

  it('drop:全清(密封槽也作废)', async () => {
    const pregen = createFillerPregen();
    const d = deferred();
    const hint = vi.fn();
    pregen.notePartial('查一下最近的天气', () => d.promise, hint);
    pregen.seal();
    pregen.drop();
    expect(pregen.take('查一下最近的天气')).toBeNull();
    d.resolve('天气的事啊');
    await tick();
    expect(hint).not.toHaveBeenCalled();
  });
});
