import { describe, it, expect } from 'vitest';
import { SpeechQueue } from './speechQueue.js';

/** fake Blob:用 __text 标记内容,断言播放顺序。 */
function makeBlob(text: string): Blob {
  return { __text: text } as unknown as Blob;
}
function blobText(blob: Blob): string {
  return (blob as unknown as { __text: string }).__text;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SpeechQueue', () => {
  it('synthesizes and plays queued sentences in order; speaking flips true→false', async () => {
    const synthesized: string[] = [];
    const played: string[] = [];
    const speakingLog: boolean[] = [];
    const queue = new SpeechQueue({
      synthesize: async (text) => { synthesized.push(text); return makeBlob(text); },
      play: async (blob) => { played.push(blobText(blob)); },
      onSpeakingChange: (s) => speakingLog.push(s),
    });

    queue.enqueue('第一句。');
    queue.enqueue('第二句。');
    queue.enqueue('第三句。');
    await queue.drain();

    expect(synthesized).toEqual(['第一句。', '第二句。', '第三句。']);
    expect(played).toEqual(['第一句。', '第二句。', '第三句。']);
    expect(speakingLog).toEqual([true, false]);
    expect(queue.speaking).toBe(false);
  });

  it('prefetches the next sentence while the current one is still playing', async () => {
    const synthesized: string[] = [];
    const played: string[] = [];
    const playGate = deferred<void>();
    const queue = new SpeechQueue({
      synthesize: async (text) => { synthesized.push(text); return makeBlob(text); },
      play: async (blob) => { played.push(blobText(blob)); await playGate.promise; },
    });

    queue.enqueue('一。');
    queue.enqueue('二。');
    await tick();

    // 第一句还在播(play 未 resolve),第二句已经合成完毕 —— 这就是预取。
    expect(played).toEqual(['一。']);
    expect(synthesized).toEqual(['一。', '二。']);

    playGate.resolve();
    await queue.drain();
    expect(played).toEqual(['一。', '二。']);
  });

  it('stop() aborts in-flight synthesis, clears the queue, and goes silent', async () => {
    let abortSeen = false;
    const played: string[] = [];
    const queue = new SpeechQueue({
      synthesize: (_text, _lang, signal) => new Promise<Blob>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          abortSeen = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
        // 永远不主动完成:模拟慢合成
      }),
      play: async (blob) => { played.push(blobText(blob)); },
    });

    queue.enqueue('慢句子。');
    await tick();
    expect(queue.speaking).toBe(true);

    queue.stop();
    await tick();

    expect(abortSeen).toBe(true);
    expect(queue.speaking).toBe(false);
    expect(played).toEqual([]);
  });

  it('discards a late blob from before stop() instead of playing it', async () => {
    const gates = new Map<string, Deferred<Blob>>();
    const played: string[] = [];
    const queue = new SpeechQueue({
      synthesize: (text) => {
        const d = deferred<Blob>();
        gates.set(text, d);
        return d.promise;
      },
      play: async (blob) => { played.push(blobText(blob)); },
    });

    queue.enqueue('旧句。');
    await tick();
    queue.stop();
    queue.enqueue('新句。');
    await tick();

    gates.get('旧句。')!.resolve(makeBlob('旧句。')); // 迟到的旧代结果
    await tick();
    expect(played).toEqual([]);

    gates.get('新句。')!.resolve(makeBlob('新句。'));
    await queue.drain();
    expect(played).toEqual(['新句。']);
  });

  it('skips a failed sentence without blocking the rest', async () => {
    const played: string[] = [];
    const queue = new SpeechQueue({
      synthesize: async (text) => {
        if (text === '坏句。') throw new Error('synthesis failed');
        return makeBlob(text);
      },
      play: async (blob) => { played.push(blobText(blob)); },
    });

    queue.enqueue('坏句。');
    queue.enqueue('好句。');
    await queue.drain();

    expect(played).toEqual(['好句。']);
  });

  it('skips a sentence whose playback fails', async () => {
    const played: string[] = [];
    const queue = new SpeechQueue({
      synthesize: async (text) => makeBlob(text),
      play: async (blob) => {
        if (blobText(blob) === '一。') throw new Error('play failed');
        played.push(blobText(blob));
      },
    });

    queue.enqueue('一。');
    queue.enqueue('二。');
    await queue.drain();

    expect(played).toEqual(['二。']);
  });

  it('drain() resolves immediately when idle and after a stop()', async () => {
    const queue = new SpeechQueue({
      synthesize: async (text) => makeBlob(text),
      play: async () => { /* instant */ },
    });

    await queue.drain(); // 空闲:立即

    queue.enqueue('一。');
    const pending = queue.drain();
    queue.stop();
    await pending; // stop 后也要结算,不能挂起
    expect(queue.speaking).toBe(false);
  });

  it('ignores empty sentences', async () => {
    const synthesized: string[] = [];
    const queue = new SpeechQueue({
      synthesize: async (text) => { synthesized.push(text); return makeBlob(text); },
      play: async () => { /* instant */ },
    });

    queue.enqueue('   ');
    queue.enqueue('');
    queue.enqueue('在的。');
    await queue.drain();

    expect(synthesized).toEqual(['在的。']);
  });
});
