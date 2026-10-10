import qrcode from '../vendor/qrcode/qrcode';
import type { ErrorCorrectionLevel } from '../vendor/qrcode/types';

// 上游 qrcode-generator 默认 stringToBytes 只做 ISO-8859-1 截断（c & 0xff），
// 非 ASCII 内容会乱码。qr8BitByte 在 addData 时动态读取 qrcode.stringToBytes，
// 这里覆盖为 UTF-8 编码（含代理对），保证任何扫码内容都能正确成码。
qrcode.stringToBytes = (s: string): number[] => {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    let code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
};

export interface QrPath {
  /** SVG path 数据：每个深色模块一个 `M x y h1 v1 h-1 z` 子路径（坐标含 margin 偏移）。 */
  path: string;
  /** 模块矩阵边长（不含 margin），标准 QR 为 4n+17。 */
  moduleCount: number;
  /** 含 margin 的总边长（模块数），即 viewBox 尺寸。 */
  size: number;
}

/**
 * 把文本编码为二维码并转成单条 SVG path（深色模块）。
 * 纯函数、无 DOM 依赖，可直接单测；渲染交给 QrCodeSvg。
 */
export function buildQrPath(
  value: string,
  level: ErrorCorrectionLevel = 'M',
  margin = 2,
): QrPath {
  const qr = qrcode(0, level); // typeNumber 0 = 自动选版本
  qr.addData(value, 'Byte');
  qr.make();

  const moduleCount = qr.getModuleCount();
  const parts: string[] = [];
  for (let r = 0; r < moduleCount; r += 1) {
    for (let c = 0; c < moduleCount; c += 1) {
      if (qr.isDark(r, c)) {
        parts.push(`M${c + margin} ${r + margin}h1v1h-1z`);
      }
    }
  }
  return {
    path: parts.join(''),
    moduleCount,
    size: moduleCount + margin * 2,
  };
}
