/**
 * TTS 音频格式判型(W1 感知提速:垫片免转码直返 mp3)。
 *
 * edge-tts 垫片默认直返 mp3(EDGE_TTS_MP3=0 回退 24kHz WAV);服务端按
 * 魔数判响应 Content-Type,三个播放端零改动(客户端均为 res.blob() →
 * Audio(blobURL),blob.type 继承响应头,浏览器原生播 mp3)。
 *
 * 判型顺序:wav(RIFF....WAVE)→ mpeg(ID3 标签头 / 帧同步 0xFFEx)→
 * 未知兜底 wav(垫片回退链 piper_real 产出的是 wav,保持旧语义最安全)。
 */

export type TtsAudioMime = 'audio/wav' | 'audio/mpeg';

export function detectAudioMime(buf: Buffer): TtsAudioMime {
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return 'audio/wav';
  }
  // ID3v2("ID3")
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return 'audio/mpeg';
  }
  // MPEG 音频帧同步:11 位全 1(0xFFE0 掩码)
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    return 'audio/mpeg';
  }
  return 'audio/wav';
}
