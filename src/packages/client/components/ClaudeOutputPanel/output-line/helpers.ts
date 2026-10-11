/**
 * OutputLine 的纯助手(路径扩展名/基名提取与调试哈希)。
 *
 * 自 OutputLine.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { ClaudeOutput } from '../../../store';

/** Extract file extension (with dot) from a path, e.g. '/foo/bar.tsx' → '.tsx' */
export function getExtFromPath(filePath: string): string {
  const basename = filePath.split('/').pop() || filePath;
  const dotIdx = basename.lastIndexOf('.');
  if (dotIdx <= 0) return '';
  return basename.slice(dotIdx).toLowerCase();
}

/** Extract basename from a path, e.g. '/foo/bar.tsx' → 'bar.tsx' */
export function getBasenameFromPath(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

// Generate a short debug hash for an output (for debugging duplicates)
export function getDebugHash(output: ClaudeOutput): string {
  const textKey = output.text.slice(0, 50);
  const flags = `${output.isUserPrompt ? 'U' : ''}${output.isStreaming ? 'S' : 'F'}${output.isDelegation ? 'D' : ''}`;
  // Simple hash from text
  let hash = 0;
  for (let i = 0; i < textKey.length; i++) {
    hash = ((hash << 5) - hash) + textKey.charCodeAt(i);
    hash |= 0;
  }
  return `${flags}:${(hash >>> 0).toString(16).slice(0, 6)}`;
}
