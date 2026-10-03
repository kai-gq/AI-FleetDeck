/**
 * 语音伙伴 · 批量回退通道的 WAV 封装(纯函数,可单测)
 *
 * 批量转写(/api/stt/transcribe)接受任意容器,服务端只按内容探测:
 * 这里把采集管线里现成的 16k 单声道 PCM16 帧直接拼成 RIFF/WAVE,
 * 不再走 MediaRecorder —— 顺带解决两件事:
 *   - 预滚帧(开段前的 480ms)可以拼进段首,不丢第一个字;
 *   - 不再依赖浏览器支持的录音编码(iOS Safari 无 webm 的兼容分支消失)。
 */

/** RIFF 头固定 44 字节(PCM,无扩展块)。 */
export const WAV_HEADER_BYTES = 44;

const SAMPLE_RATE = 16_000;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

/**
 * PCM16 帧(16k 单声道)→ WAV 字节。
 *
 * @param frames  每帧为一段 PCM16 小端字节(如 30ms = 480 样本 = 960 字节);
 *                帧内字节数按偶数处理(Int16 对齐),奇数尾字节原样保留。
 * @param sampleRate 采样率,默认 16000(与采集管线一致)。
 */
export function pcm16FramesToWav(frames: ArrayBuffer[], sampleRate: number = SAMPLE_RATE): Uint8Array {
  let dataBytes = 0;
  for (const frame of frames) dataBytes += frame.byteLength;

  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(out.buffer);
  const byteRate = sampleRate * CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);

  // --- RIFF 头 ---
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // 文件长度 - 8
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // 格式:PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  // --- PCM 数据 ---
  let offset = WAV_HEADER_BYTES;
  for (const frame of frames) {
    out.set(new Uint8Array(frame), offset);
    offset += frame.byteLength;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
