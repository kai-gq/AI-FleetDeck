/**
 * 声纹注册 · WAV 工具(纯函数,可单测)
 *
 * bytesToBase64 与 useContinuousListening 内的私有同名函数同款(那处不导出,
 * 复制 8 行 = 不把整条聆听依赖拉进本模块);
 * wavDurationSeconds 与 tools/voiceprint/enroll.mjs 的 wavSeconds 同口径
 * (数据块字节数 / 32000;16k 单声道 16bit)。
 */

/** 字节 → base64(分包拼接避免超长参数)。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 16k / 单声道 / 16bit → 每秒 32000 字节。 */
const BYTES_PER_SECOND = 16_000 * 2;

/**
 * WAV 时长(秒);非 WAV / 无 data 块 → 0。
 * 声明长度超过实际字节时按实际算(截断文件不虚报)。
 */
export function wavDurationSeconds(bytes: Uint8Array): number {
  const length = bytes.byteLength;
  if (length < 12) return 0;
  const ascii = (off: number): string =>
    String.fromCharCode(bytes[off]!, bytes[off + 1]!, bytes[off + 2]!, bytes[off + 3]!);
  if (ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  let off = 12;
  while (off + 8 <= length) {
    const id = ascii(off);
    const size = view.getUint32(off + 4, true);
    if (id === 'data') return Math.max(0, Math.min(size, length - off - 8)) / BYTES_PER_SECOND;
    off += 8 + size + (size % 2);
  }
  return 0;
}
