import { describe, it, expect } from 'vitest';
import { WAV_HEADER_BYTES, pcm16FramesToWav } from './wav.js';

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** 造一帧 PCM16:480 样本(30ms),内容 = 样本序号(小端)。 */
function frame(samples: number, seed = 0): ArrayBuffer {
  const buf = new ArrayBuffer(samples * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, seed + i, true);
  return buf;
}

describe('pcm16FramesToWav', () => {
  it('空帧列表 → 只有 44 字节头,data 长度 0', () => {
    const wav = pcm16FramesToWav([]);
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES);
    const view = new DataView(wav.buffer);
    expect(view.getUint32(4, true)).toBe(36); // RIFF size = 文件 - 8
    expect(view.getUint32(40, true)).toBe(0); // data 长度
  });

  it('头字段符合 16k 单声道 PCM16 约定', () => {
    const wav = pcm16FramesToWav([frame(480), frame(480)]);
    const view = new DataView(wav.buffer);
    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    expect(ascii(wav, 12, 4)).toBe('fmt ');
    expect(ascii(wav, 36, 4)).toBe('data');
    expect(view.getUint32(16, true)).toBe(16); // fmt 块大小
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // 声道
    expect(view.getUint32(24, true)).toBe(16000); // 采样率
    expect(view.getUint32(28, true)).toBe(32000); // 字节率 = 16000×1×2
    expect(view.getUint16(32, true)).toBe(2); // blockAlign
    expect(view.getUint16(34, true)).toBe(16); // 位深
  });

  it('data 长度 = 各帧字节和,RIFF 长度 = 36 + data', () => {
    const wav = pcm16FramesToWav([frame(480), frame(240), frame(480)]);
    const dataBytes = 480 * 2 + 240 * 2 + 480 * 2;
    const view = new DataView(wav.buffer);
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES + dataBytes);
    expect(view.getUint32(40, true)).toBe(dataBytes);
    expect(view.getUint32(4, true)).toBe(36 + dataBytes);
  });

  it('PCM 字节按帧顺序原样拼接(小端 Int16 往返)', () => {
    const wav = pcm16FramesToWav([frame(4, 100), frame(4, 200)]);
    const view = new DataView(wav.buffer, WAV_HEADER_BYTES);
    for (let i = 0; i < 4; i++) expect(view.getInt16(i * 2, true)).toBe(100 + i);
    for (let i = 0; i < 4; i++) expect(view.getInt16((4 + i) * 2, true)).toBe(200 + i);
  });

  it('自定义采样率写入头(采样率变化时字节率同步)', () => {
    const wav = pcm16FramesToWav([frame(160)], 8000);
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(28, true)).toBe(16000);
  });
});
