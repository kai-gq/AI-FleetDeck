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

  // ---- 阶段一补测:预取上界/打断代际/参数透传 ----

  it('caps synthesis at SYNTH_AHEAD_MAX (2) sentences ahead of playback', async () => {
    const synthesized: string[] = [];
    const playGate = deferred<void>();
    const queue = new SpeechQueue({
      synthesize: async (text) => { synthesized.push(text); return makeBlob(text); },
      play: async () => { await playGate.promise; },
    });

    for (const t of ['一。', '二。', '三。', '四。', '五。']) queue.enqueue(t);
    await tick();

    // 播放被堵住:blobQueue 已到 2 句上限,合成恰停在 2 次,不抢跑。
    expect(synthesized).toEqual(['一。', '二。']);

    playGate.resolve();
    await queue.drain();
    expect(synthesized).toEqual(['一。', '二。', '三。', '四。', '五。']);
  });

  it('stop() during playback aborts the active play and stays silent', async () => {
    let playAbortSeen = false;
    const queue = new SpeechQueue({
      synthesize: async (text) => makeBlob(text),
      play: (_blob, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          playAbortSeen = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
        // 模拟长音频:不主动结束,只能被 abort 打断
      }),
    });

    queue.enqueue('长句。');
    await tick();
    expect(queue.speaking).toBe(true);

    queue.stop();
    await tick();
    expect(playAbortSeen).toBe(true);
    expect(queue.speaking).toBe(false);
  });

  it('multiple stop() calls discard every stale generation; the next generation plays normally', async () => {
    const gates = new Map<string, Deferred<Blob>>();
    const played: string[] = [];
    const queue = new SpeechQueue({
      synthesize: (text) => { const d = deferred<Blob>(); gates.set(text, d); return d.promise; },
      play: async (blob) => { played.push(blobText(blob)); },
    });

    queue.enqueue('A。');
    await tick();
    queue.stop();
    queue.enqueue('B。');
    await tick();
    queue.stop();
    queue.enqueue('C。');
    await tick();

    // B 在第二次 stop 前就被清出队列,从未进入合成
    expect(gates.has('B。')).toBe(false);

    gates.get('A。')!.resolve(makeBlob('A。')); // 两次 stop 之后的旧代结果
    await tick();
    expect(played).toEqual([]);

    gates.get('C。')!.resolve(makeBlob('C。'));
    await queue.drain();
    expect(played).toEqual(['C。']);
  });

  it('enqueue trims text and passes lang through to synthesis', async () => {
    const seen: Array<{ text: string; lang: string | undefined }> = [];
    const queue = new SpeechQueue({
      synthesize: async (text, lang) => { seen.push({ text, lang }); return makeBlob(text); },
      play: async () => { /* instant */ },
    });

    queue.enqueue('  带空格的句子。  ', 'zh-CN');
    queue.enqueue('no-lang。');
    await queue.drain();

    expect(seen).toEqual([
      { text: '带空格的句子。', lang: 'zh-CN' },
      { text: 'no-lang。', lang: undefined },
    ]);
  });

  it('resolves concurrent drain() waiters together when playback finishes', async () => {
    const playGate = deferred<void>();
    const queue = new SpeechQueue({
      synthesize: async (text) => makeBlob(text),
      play: async () => { await playGate.promise; },
    });

    queue.enqueue('一。');
    await tick();
    expect(queue.speaking).toBe(true);

    const first = queue.drain();
    const second = queue.drain();
    playGate.resolve();
    await Promise.all([first, second]);
    expect(queue.speaking).toBe(false);
  });

  it('a throwing onSpeakingChange callback does not break the queue', async () => {
    const played: string[] = [];
    const queue = new SpeechQueue({
      synthesize: async (text) => makeBlob(text),
      play: async (blob) => { played.push(blobText(blob)); },
      onSpeakingChange: () => { throw new Error('listener boom'); },
    });

    queue.enqueue('一。');
    await queue.drain();
    expect(played).toEqual(['一。']);
  });
});
