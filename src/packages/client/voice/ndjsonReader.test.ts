import { describe, it, expect } from 'vitest';
import { readNdjsonLines, type NdjsonLine } from './ndjsonReader.js';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i++]));
    },
  });
}

function streamFromByteChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i++]);
    },
  });
}

describe('readNdjsonLines', () => {
  it('reassembles lines split across chunk boundaries', async () => {
    const lines: NdjsonLine[] = [];
    await readNdjsonLines(
      streamFromChunks(['{"type":"sen', 'tence","text":"你好。"}\n{"type":"fi', 'nal","spoke":true}\n']),
      (line) => lines.push(line),
    );
    expect(lines).toEqual([
      { type: 'sentence', text: '你好。' },
      { type: 'final', spoke: true },
    ]);
  });

  it('handles a trailing line without a newline', async () => {
    const lines: NdjsonLine[] = [];
    await readNdjsonLines(streamFromChunks(['{"a":1}\n{"b":2}']), (line) => lines.push(line));
    expect(lines).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips blank and non-JSON lines', async () => {
    const lines: NdjsonLine[] = [];
    await readNdjsonLines(streamFromChunks(['\nnot json\n{"ok":true}\n\n']), (line) => lines.push(line));
    expect(lines).toEqual([{ ok: true }]);
  });

  it('emits nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const lines: NdjsonLine[] = [];
    await readNdjsonLines(streamFromChunks(['{"a":1}\n']), (line) => lines.push(line), controller.signal);
    expect(lines).toEqual([]);
  });

  // ---- 阶段一补测:编码与中断边界 ----

  it('decodes multi-byte UTF-8 characters split across chunk boundaries', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('{"text":"你好"}\n');
    // '{"text":"' 是 9 个 ASCII 字节,在第 10 个字节(「你」的首字节)之后切开
    const lines: NdjsonLine[] = [];
    await readNdjsonLines(
      streamFromByteChunks([bytes.slice(0, 10), bytes.slice(10)]),
      (line) => lines.push(line),
    );
    expect(lines).toEqual([{ text: '你好' }]);
  });

  it('handles CRLF line endings', async () => {
    const lines: NdjsonLine[] = [];
    await readNdjsonLines(streamFromChunks(['{"a":1}\r\n{"b":2}\r\n']), (line) => lines.push(line));
    expect(lines).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('stops delivering lines once the signal aborts mid-stream', async () => {
    const encoder = new TextEncoder();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    const lines: NdjsonLine[] = [];
    const ac = new AbortController();
    const done = readNdjsonLines(
      stream,
      (line) => {
        lines.push(line);
        ac.abort(); // 第一行到达即中断
      },
      ac.signal,
    );

    ctrl.enqueue(encoder.encode('{"a":1}\n'));
    ctrl.enqueue(encoder.encode('{"b":2}\n')); // 已入队但中断后不再读取
    await done;

    expect(lines).toEqual([{ a: 1 }]);
  });
});
