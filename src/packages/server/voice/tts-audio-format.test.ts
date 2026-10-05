import { describe, expect, it } from 'vitest';
import { detectAudioMime } from './tts-audio-format.js';

/** 造一个最小 RIFF/WAVE 头(仅判型所需字段)。 */
function riffHeader(): Buffer {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  return buf;
}

describe('detectAudioMime', () => {
  it('RIFF/WAVE → audio/wav', () => {
    expect(detectAudioMime(riffHeader())).toBe('audio/wav');
  });

  it('ID3 标签头 → audio/mpeg', () => {
    const buf = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100)]);
    expect(detectAudioMime(buf)).toBe('audio/mpeg');
  });

  it('MPEG 帧同步(0xFF Ex)→ audio/mpeg', () => {
    // 0xFF 0xFB = MPEG-1 Layer III 常见帧头
    const buf = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(64)]);
    expect(detectAudioMime(buf)).toBe('audio/mpeg');
  });

  it('帧同步掩码只认高 3 位:0xE0/0xFF → mpeg,低 5 位任意', () => {
    expect(detectAudioMime(Buffer.from([0xff, 0xe0, 0, 0]))).toBe('audio/mpeg');
    expect(detectAudioMime(Buffer.from([0xff, 0xff, 0, 0]))).toBe('audio/mpeg');
  });

  it('未知/空/过短 → 兜底 audio/wav(旧行为)', () => {
    expect(detectAudioMime(Buffer.alloc(0))).toBe('audio/wav');
    expect(detectAudioMime(Buffer.from([1, 2, 3]))).toBe('audio/wav');
    // RIFF 但非 WAVE(如 AVI):不误判为 wav,走兜底
    const avi = Buffer.alloc(16);
    avi.write('RIFF', 0, 'ascii');
    avi.write('AVI ', 8, 'ascii');
    expect(detectAudioMime(avi)).toBe('audio/wav'); // 兜底同为 wav,但路径经魔数检查
    // 0xFF 但次字节非帧同步 → 非 mpeg
    expect(detectAudioMime(Buffer.from([0xff, 0x1f, 0, 0]))).toBe('audio/wav');
  });
});
