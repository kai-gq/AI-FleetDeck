/**
 * W7 TTS 预合成缓存:服务端推来垫话预生成 hint({type:'filler'})时,趁用户还在说话
 * 就先把音频合出来;正式句到达时命中缓存直接播,省掉关键路径里的合成段(~0.5–0.8s)。
 *
 * - key = lang + NUL + text;TTL 60s、LRU 4(垫话短句,量小;同一句播前必达);
 * - 在途去重:预载与播报队列对同一句只发一次合成请求(共享 promise 不绑队列 signal);
 * - synthesizeWithCache 是 SpeechQueue 的正式合成入口:命中免请求,未命中即请求并入缓存;
 * - 队列侧 abort 只影响本次 await,不打断共享中的预载(结果仍入缓存,无副作用);
 * - 共享请求失败 → 本句自己重试一次(避免预载时点的瞬时失败转嫁给播报)。
 *
 * 与 React 解耦:类可注入假 synthesize 单测;真实 fetch 实现见文件底部单例。
 */

import { apiUrl, authFetch } from '../utils/storage';

type SynthesizeFn = (text: string, lang: string | undefined, signal: AbortSignal) => Promise<Blob>;

/** 共享请求用的永不中止 signal(缓存使命独立于单个等待方)。 */
const NEVER_ABORT = new AbortController().signal;

export interface TtsPreloadOptions {
  /** 缓存存活期 ms(缺省 60s)。 */
  ttlMs?: number;
  /** 缓存条数上限(缺省 4;超限逐最旧)。 */
  maxEntries?: number;
}

function cacheKey(text: string, lang: string | undefined): string {
  return `${lang ?? ''}\u0000${text}`;
}

/** 把共享 promise 与调用方 signal 竞速:abort 只影响本次等待,不影响共享请求本身。 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export class TtsPreloadCache {
  private readonly deps: { synthesize: SynthesizeFn };
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly cache = new Map<string, { blob: Blob; at: number }>();
  private readonly inflight = new Map<string, Promise<Blob>>();

  constructor(deps: { synthesize: SynthesizeFn }, options: TtsPreloadOptions = {}) {
    this.deps = deps;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 4;
  }

  /** 预合成(fire-and-forget):hint 到达即调用;已有缓存/在途则免发;失败静默。 */
  preload(text: string, lang: string | undefined): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const key = cacheKey(trimmed, lang);
    if (this.lookup(key) || this.inflight.has(key)) return;
    this.startShared(key, trimmed, lang).catch(() => {
      // 预载失败静默:正式句到达时 synthesizeWithCache 会自起一次
    });
  }

  /** 正式合成入口(注入 SpeechQueue):缓存命中直返;否则等待/发起共享请求。 */
  async synthesize(text: string, lang: string | undefined, signal: AbortSignal): Promise<Blob> {
    const trimmed = text.trim();
    const key = cacheKey(trimmed, lang);
    const cached = this.lookup(key);
    if (cached) return cached;
    const shared = this.inflight.get(key) ?? this.startShared(key, trimmed, lang);
    try {
      return await raceAbort(shared, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      // 共享请求失败(多为预载时点的瞬时失败):不转嫁给本句,自己重试一次
      return await raceAbort(this.startShared(key, trimmed, lang), signal);
    }
  }

  private startShared(key: string, text: string, lang: string | undefined): Promise<Blob> {
    const promise = this.deps.synthesize(text, lang, NEVER_ABORT);
    promise
      .then(
        (blob) => this.remember(key, blob),
        () => {
          // 失败由等待方处理
        },
      )
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  private lookup(key: string): Blob | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    // LRU:触碰即前移(Map 迭代序 = 最旧在前)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.blob;
  }

  private remember(key: string, blob: Blob): void {
    this.cache.delete(key);
    this.cache.set(key, { blob, at: Date.now() });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest == null) break;
      this.cache.delete(oldest);
    }
  }
}

/** 真实合成:POST /api/tts/speak(与旧 useSpeechQueue.defaultSynthesize 逐字同形)。 */
async function fetchSynthesize(text: string, lang: string | undefined, signal: AbortSignal): Promise<Blob> {
  const res = await authFetch(apiUrl('/api/tts/speak'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(lang ? { text, lang } : { text }),
    signal,
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
  return res.blob();
}

/** 进程级单例:预载与播报共用一份缓存(垫话短句,跨回合自然过期)。 */
export const ttsPreload = new TtsPreloadCache({ synthesize: fetchSynthesize });

/** 预合成一句话(垫话 hint 到达时调用;失败静默)。 */
export function preloadTtsAudio(text: string, lang: string | undefined): void {
  ttsPreload.preload(text, lang);
}

/** SpeechQueue 的合成入口:命中预载缓存则零请求直返。 */
export function synthesizeWithCache(text: string, lang: string | undefined, signal: AbortSignal): Promise<Blob> {
  return ttsPreload.synthesize(text, lang, signal);
}
