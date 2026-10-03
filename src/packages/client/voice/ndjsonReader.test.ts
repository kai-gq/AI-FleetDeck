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
});
