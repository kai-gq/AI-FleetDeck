/**
 * 声纹注册 WAV 工具单测(纯函数;node 环境,无 jsdom)
 */

import { describe, it, expect } from 'vitest';
import { pcm16FramesToWav } from './wav';
import { bytesToBase64, wavDurationSeconds } from './voiceprintWav';

describe('bytesToBase64', () => {
  it('与 Buffer.toString(base64) 完全一致(含 >0x8000 分包的跨块数据)', () => {
    const bytes = new Uint8Array(70_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
    const encoded = bytesToBase64(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
    expect(new Uint8Array(Buffer.from(encoded, 'base64'))).toEqual(bytes);
  });

  it('空输入 → 空串', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });
});

describe('wavDurationSeconds', () => {
  it('1 秒(两帧各 0.5s)', () => {
    const wav = pcm16FramesToWav([new ArrayBuffer(16_000), new ArrayBuffer(16_000)]);
    expect(wavDurationSeconds(wav)).toBeCloseTo(1, 5);
  });

  it('20 秒(与服务端注册录音时长一致)', () => {
    const wav = pcm16FramesToWav([new ArrayBuffer(32_000 * 20)]);
    expect(wavDurationSeconds(wav)).toBeCloseTo(20, 5);
  });

  it('声明长度超过实际字节 → 按实际算', () => {
    const wav = pcm16FramesToWav([new ArrayBuffer(32_000)]); // 实际 1s
    const view = new DataView(wav.buffer);
    view.setUint32(40, 32_000 * 10, true); // 头声明 10s
    expect(wavDurationSeconds(wav)).toBeCloseTo(1, 5);
  });

  it('非 WAV / 空数据 → 0', () => {
    expect(wavDurationSeconds(new Uint8Array(0))).toBe(0);
    expect(wavDurationSeconds(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBe(0);
    const garbage = new Uint8Array(60); // 全 0:无 RIFF 头
    expect(wavDurationSeconds(garbage)).toBe(0);
  });
});
