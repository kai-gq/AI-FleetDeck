/**
 * useSpeechQueue —— 分句流式播报的 React 包装(核心逻辑在 client/voice/speechQueue)。
 * 负责真实的 TTS 合成(经 client/voice/ttsPreload:W7 预载缓存优先)与浏览器播放
 * (Audio),并暴露 speaking 供 VAD 防自激 / barge-in 判定使用(语义:队列里还有
 * 内容在合成或播放)。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SpeechQueue } from '../voice/speechQueue';
import { synthesizeWithCache } from '../voice/ttsPreload';

/** 播放 Blob;abort → 立即静音并 reject。 */
function defaultPlay(blob: Blob, signal: AbortSignal): Promise<void> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      URL.revokeObjectURL(url);
    };
    const onAbort = () => {
      try { audio.pause(); } catch { /* ignore */ }
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort);
    audio.onended = () => { cleanup(); resolve(); };
    audio.onerror = () => { cleanup(); reject(new Error('Audio playback failed')); };
    audio.play().catch((err) => { cleanup(); reject(err); });
  });
}

export function useSpeechQueue() {
  const [speaking, setSpeaking] = useState(false);
  const queueRef = useRef<SpeechQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = new SpeechQueue({
      synthesize: synthesizeWithCache,
      play: defaultPlay,
      onSpeakingChange: setSpeaking,
    });
  }

  // 卸载:中止合成/播放,不留悬空音频或定时器
  useEffect(() => () => queueRef.current?.stop(), []);

  const enqueue = useCallback((text: string, lang?: string) => {
    queueRef.current?.enqueue(text, lang);
  }, []);

  const stop = useCallback(() => {
    queueRef.current?.stop();
  }, []);

  const drain = useCallback((): Promise<void> => {
    return queueRef.current?.drain() ?? Promise.resolve();
  }, []);

  return { enqueue, stop, drain, speaking };
}
