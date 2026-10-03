import { describe, it, expect } from 'vitest';
import { findStringField, SentenceChunker, createJsonStringStream, type JsonStringStream } from './contract-stream.js';

describe('findStringField', () => {
  it('finds a complete top-level string field (whitespace tolerant)', () => {
    expect(findStringField('{ "action" : "general_response" }', 'action'))
      .toEqual({ value: 'general_response', complete: true });
  });

  it('returns the partial value while the field is still streaming', () => {
    expect(findStringField('{"responseToUser":"你好。今天', 'responseToUser'))
      .toEqual({ value: '你好。今天', complete: false });
  });

  it('decodes JSON escapes', () => {
    const raw = JSON.stringify({ responseToUser: '他说："好"\n走了\\近路' });
    const hit = findStringField(raw, 'responseToUser');
    expect(hit?.complete).toBe(true);
    expect(hit?.value).toBe('他说："好"\n走了\\近路');
  });

  it('decodes \\uXXXX escapes', () => {
    expect(findStringField('{"responseToUser":"\\u4f60\\u597d"}', 'responseToUser'))
      .toEqual({ value: '你好', complete: true });
  });

  it('holds back a half-written \\u escape', () => {
    const hit = findStringField('{"responseToUser":"\\u4f60\\u59', 'responseToUser');
    expect(hit).toEqual({ value: '你', complete: false });
  });

  it('holds back a trailing lone backslash', () => {
    const hit = findStringField('{"responseToUser":"abc\\', 'responseToUser');
    expect(hit).toEqual({ value: 'abc', complete: false });
  });

  it('does not match the key name appearing inside another string value', () => {
    const raw = '{"messageToAgent":"把 responseToUser 改短一点","responseToUser":"好的。"}';
    expect(findStringField(raw, 'responseToUser')).toEqual({ value: '好的。', complete: true });
  });

  it('does not treat a string value that equals the key as the key', () => {
    expect(findStringField('{"a":"action"}', 'action')).toBeNull();
    expect(findStringField('{"a":"action","action":"noop"}', 'action')).toEqual({ value: 'noop', complete: true });
  });

  it('ignores same-named keys nested deeper', () => {
    expect(findStringField('{"memoryOps":[{"text":"responseToUser"}]}', 'responseToUser')).toBeNull();
  });

  it('tolerates prose and code fences around the JSON', () => {
    const raw = '好的,这是结果:\n```json\n{"responseToUser":"在的。"}\n```\n谢谢';
    expect(findStringField(raw, 'responseToUser')).toEqual({ value: '在的。', complete: true });
  });

  it('handles a truncated key at the tail', () => {
    expect(findStringField('{"actio', 'action')).toBeNull();
    expect(findStringField('{"action', 'action')).toEqual({ value: '', complete: false });
    expect(findStringField('{"action":', 'action')).toEqual({ value: '', complete: false });
  });

  it('returns null for non-string values', () => {
    expect(findStringField('{"action":null}', 'action')).toBeNull();
  });
});

describe('SentenceChunker', () => {
  it('splits complete sentences on Chinese/ASCII terminators', () => {
    expect(new SentenceChunker().push('你好。今天天气不错!', true)).toEqual(['你好。', '今天天气不错!']);
  });

  it('waits for the next character when a terminator dangles at the buffer end', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('第一句。')).toEqual([]);
    expect(chunker.push('第')).toEqual(['第一句。']);
  });

  it('merges too-short fragments into the following sentence', () => {
    expect(new SentenceChunker().push('嗯。好的。', true)).toEqual(['嗯。好的。']);
  });

  it('keeps consecutive terminators and closing quotes in the same sentence', () => {
    expect(new SentenceChunker().push('他说：“好的。”', true)).toEqual(['他说：“好的。”']);
    expect(new SentenceChunker().push('真的吗？！那太好了。', true)).toEqual(['真的吗？！', '那太好了。']);
  });

  it('does not split an ellipsis run across pushes', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('让我想想…')).toEqual([]);
    expect(chunker.push('…')).toEqual([]);
    expect(chunker.push('嗯。', true)).toEqual(['让我想想……', '嗯。']);
  });

  it('soft-cuts a long run-on sentence at the last readable point', () => {
    const long = `${'句'.repeat(40)}，${'句'.repeat(40)}。`;
    const sentences = new SentenceChunker().push(long, true);
    expect(sentences).toHaveLength(2);
    expect(sentences[0].endsWith('，')).toBe(true);
    expect(sentences[1].endsWith('。')).toBe(true);
    expect(sentences.join('')).toBe(long);
  });

  it('never re-emits or drops characters', () => {
    const chunker = new SentenceChunker();
    const first = chunker.push('甲乙。丙丁', false);
    const second = chunker.push('。', false);
    const rest = chunker.flush();
    expect(first).toEqual(['甲乙。']);
    expect(second).toEqual([]);
    expect(rest).toEqual(['丙丁。']);
    expect(chunker.flush()).toEqual([]);
  });

  it('flushes a terminator-less tail as one sentence', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('没有标点的结尾', false)).toEqual([]);
    expect(chunker.flush()).toEqual(['没有标点的结尾']);
  });

  it('flushTerminated emits a dangling terminated sentence on grace expiry', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('第一句。')).toEqual([]); // 正常路径:等下一个字符
    expect(chunker.flushTerminated()).toEqual(['第一句。']); // 宽限:不再等
    expect(chunker.flushTerminated()).toEqual([]); // 已吐出,不重发
    expect(chunker.flush()).toEqual([]);
  });

  it('flushTerminated does not force an unterminated remainder', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('还在写')).toEqual([]);
    expect(chunker.flushTerminated()).toEqual([]); // 无终结符:继续挂起
    expect(chunker.flush()).toEqual(['还在写']);
  });

  it('flushTerminated still merges a too-short fragment', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('嗯。')).toEqual([]);
    expect(chunker.flushTerminated()).toEqual([]); // 「嗯。」太短:并给下一句
    expect(chunker.flush()).toEqual(['嗯。']);
  });

  it('grace-flushing a dangling ellipsis after long silence is allowed (trade-off documented)', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('让我想想…')).toEqual([]);
    // 正常路径会等第二个「…」(见上一条用例);静默满宽限则按整句吐出。
    expect(chunker.flushTerminated()).toEqual(['让我想想…']);
  });
});

function feedAll(stream: JsonStringStream, raw: string, step: number): string[] {
  const out: string[] = [];
  for (let i = step; i <= raw.length; i += step) {
    out.push(...stream.pushRaw(raw.slice(0, i)));
  }
  out.push(...stream.pushRaw(raw));
  return out;
}

describe('createJsonStringStream', () => {
  const contract = JSON.stringify({
    action: 'general_response',
    responseToUser: '好的,我看看。稍等,我确认一下再回你。',
    memoryOps: [],
  });

  it('reassembles the exact field value regardless of chunk size', () => {
    const expected = '好的,我看看。稍等,我确认一下再回你。';
    for (const step of [1, 3, 7, contract.length]) {
      const sentences = feedAll(createJsonStringStream('responseToUser'), contract, step);
      expect(sentences.join('')).toBe(expected);
    }
  });

  it('emits the first sentence before the field is complete', () => {
    const stream = createJsonStringStream('responseToUser');
    const partial = '{"action":"general_response","responseToUser":"第一句好了。第二句还';
    const sentences = stream.pushRaw(partial);
    expect(sentences).toEqual(['第一句好了。']);
  });

  it('is not confused by the key name inside another value', () => {
    const raw = '{"messageToAgent":"responseToUser 别太长","responseToUser":"明白。"}';
    const sentences = feedAll(createJsonStringStream('responseToUser'), raw, 5);
    expect(sentences.join('')).toBe('明白。');
  });

  it('trims surrounding whitespace but keeps inner text', () => {
    const raw = JSON.stringify({ responseToUser: '  先看 A。再看 B。  ' });
    const sentences = feedAll(createJsonStringStream('responseToUser'), raw, 1);
    expect(sentences).toEqual(['先看 A。', '再看 B。']);
  });

  it('emits nothing for noop-style empty values', () => {
    const raw = JSON.stringify({ action: 'noop', responseToUser: '' });
    expect(feedAll(createJsonStringStream('responseToUser'), raw, 1)).toEqual([]);
  });

  it('flushTerminated emits the dangling first sentence, then normal flow resumes', () => {
    const stream = createJsonStringStream('responseToUser');
    const partial = '{"action":"general_response","responseToUser":"第一句。';
    expect(stream.pushRaw(partial)).toEqual([]); // 句号悬尾:正常路径按住
    expect(stream.flushTerminated()).toEqual(['第一句。']); // 宽限到期:先吐
    expect(stream.pushRaw(`${partial}第二句。"}`)).toEqual(['第二句。']); // 后续不重不漏
    expect(stream.flushTerminated()).toEqual([]);
  });

  it('flushTerminated is a no-op after the field closed', () => {
    const stream = createJsonStringStream('responseToUser');
    expect(stream.pushRaw(contract)).toEqual(['好的,我看看。', '稍等,我确认一下再回你。']);
    expect(stream.flushTerminated()).toEqual([]);
  });
});
