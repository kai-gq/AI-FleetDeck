/**
 * W7 TTS 预合成缓存专测:命中免请求/在途去重/TTL/LRU/abort 语义/失败重试/语种键。
 * 注入假 synthesize,不触网;storage 依赖整块替掉,避免真实模块副作用。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { TtsPreloadCache } from './ttsPreload';

vi.mock('../utils/storage', () => ({
  apiUrl: (p: string) => p,
  authFetch: vi.fn(),
}));

const blobA = { tag: 'A' } as unknown as Blob;
const blobB = { tag: 'B' } as unknown as Blob;

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const neverAbort = (): AbortSignal => new AbortController().signal;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TtsPreloadCache', () => {
  it('预载后正式合成命中缓存:零请求、同一 Blob', async () => {
    const synthesize = vi.fn(async () => blobA);
    const cache = new TtsPreloadCache({ synthesize });

    cache.preload('嗯,我在', 'zh');
    await Promise.resolve();
    await Promise.resolve();

    const blob = await cache.synthesize('嗯,我在', 'zh', neverAbort());
    expect(blob).toBe(blobA);
    expect(synthesize).toHaveBeenCalledTimes(1); // 只有预载那一次
  });

  it('在途去重:预载未完成时正式合成不发第二次请求', async () => {
    const d = deferred<Blob>();
    const synthesize = vi.fn(() => d.promise);
    const cache = new TtsPreloadCache({ synthesize });

    cache.preload('嗯,我在', 'zh');
    const p = cache.synthesize('嗯,我在', 'zh', neverAbort());
    expect(synthesize).toHaveBeenCalledTimes(1);

    d.resolve(blobA);
    await expect(p).resolves.toBe(blobA);
  });

  it('abort:signal 已中止立即拒绝;等待中被中止也拒绝(共享请求不受影响)', async () => {
    const d = deferred<Blob>();
    const synthesize = vi.fn(() => d.promise);
    const cache = new TtsPreloadCache({ synthesize });

    cache.preload('嗯,我在', 'zh');
    const aborted = new AbortController();
    aborted.abort();
    await expect(cache.synthesize('嗯,我在', 'zh', aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });

    const mid = new AbortController();
    const p = cache.synthesize('嗯,我在', 'zh', mid.signal);
    mid.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });

    // 共享请求未被打断:结果照常入缓存
    d.resolve(blobA);
    await Promise.resolve();
    await Promise.resolve();
    await expect(cache.synthesize('嗯,我在', 'zh', neverAbort())).resolves.toBe(blobA);
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it('预载失败不转嫁:正式合成自起一次重试', async () => {
    const synthesize = vi
      .fn<() => Promise<Blob>>()
      .mockRejectedValueOnce(new Error('preload boom'))
      .mockResolvedValueOnce(blobB);
    const cache = new TtsPreloadCache({ synthesize });

    cache.preload('嗯,我在', 'zh');
    await Promise.resolve();
    await Promise.resolve();

    await expect(cache.synthesize('嗯,我在', 'zh', neverAbort())).resolves.toBe(blobB);
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('TTL:过期后重新合成', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const synthesize = vi.fn(async () => blobA);
    const cache = new TtsPreloadCache({ synthesize }, { ttlMs: 60_000 });
    cache.preload('嗯,我在', 'zh');
    await Promise.resolve();
    await Promise.resolve();
    await cache.synthesize('嗯,我在', 'zh', neverAbort());
    expect(synthesize).toHaveBeenCalledTimes(1);

    now += 61_000;
    await cache.synthesize('嗯,我在', 'zh', neverAbort());
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('LRU:超出条数上限逐最旧', async () => {
    const synthesize = vi.fn(async () => blobA);
    const cache = new TtsPreloadCache({ synthesize }, { maxEntries: 2 });

    cache.preload('A句', 'zh');
    cache.preload('B句', 'zh');
    cache.preload('C句', 'zh');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await cache.synthesize('B句', 'zh', neverAbort()); // 命中
    await cache.synthesize('C句', 'zh', neverAbort()); // 命中
    expect(synthesize).toHaveBeenCalledTimes(3);

    await cache.synthesize('A句', 'zh', neverAbort()); // A 已被逐:重新请求
    expect(synthesize).toHaveBeenCalledTimes(4);
  });

  it('语种参与缓存键:同文不同 lang 不串用', async () => {
    const synthesize = vi.fn(async () => blobA);
    const cache = new TtsPreloadCache({ synthesize });
    cache.preload('你好', 'zh');
    await Promise.resolve();
    await Promise.resolve();
    await cache.synthesize('你好', 'en', neverAbort());
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('空文本预载与合成:预载忽略,文本 trim 后参与键', async () => {
    const synthesize = vi.fn(async () => blobA);
    const cache = new TtsPreloadCache({ synthesize });
    cache.preload('   ', 'zh');
    expect(synthesize).not.toHaveBeenCalled();

    cache.preload(' 嗯,我在 ', 'zh');
    await Promise.resolve();
    await Promise.resolve();
    await cache.synthesize('嗯,我在', 'zh', neverAbort());
    expect(synthesize).toHaveBeenCalledTimes(1);
  });
});
