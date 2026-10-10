import { memo, useMemo } from 'react';
import { buildQrPath } from '../../utils/wechatQr';
import type { ErrorCorrectionLevel } from '../../vendor/qrcode/types';

interface QrCodeSvgProps {
  /** 要编码的内容。 */
  value: string;
  /** 渲染边长（px），默认 208。 */
  size?: number;
  level?: ErrorCorrectionLevel;
  margin?: number;
  className?: string;
  label?: string;
}

/**
 * 内联 SVG 二维码（无图片、无 innerHTML）。
 *
 * 黑白用固定色（不随主题变量）——二维码必须保持可扫描对比度，
 * 深色主题下也渲染为白底黑码。
 */
export const QrCodeSvg = memo(function QrCodeSvg({
  value,
  size = 208,
  level = 'M',
  margin = 2,
  className = '',
  label = 'QR code',
}: QrCodeSvgProps) {
  const { path, size: viewSize } = useMemo(
    () => buildQrPath(value, level, margin),
    [value, level, margin],
  );

  return (
    <svg
      className={`qr-code-svg${className ? ` ${className}` : ''}`}
      viewBox={`0 0 ${viewSize} ${viewSize}`}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      focusable="false"
    >
      <rect width={viewSize} height={viewSize} fill="#ffffff" />
      <path d={path} fill="#111111" shapeRendering="crispEdges" />
    </svg>
  );
});
