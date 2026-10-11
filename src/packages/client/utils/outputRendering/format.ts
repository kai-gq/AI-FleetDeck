/**
 * 通用格式化小工具(时间戳 / 截断 / 短 ID / 待办状态图标)。
 *
 * 自 utils/outputRendering.ts 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

/** Shorten long ids like call-d2f2a9b9-…-290 for chip display. */
export function shortenId(id: string, head = 8, tail = 4): string {
  if (!id || id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/**
 * Status icons for todo items
 */
export function getTodoStatusIcon(status: string): string {
  switch (status) {
    case 'completed': return '✓';
    case 'in_progress': return '►';
    default: return '○';
  }
}

/**
 * Format timestamp for display (HH:MM:SS in 24h format)
 * Accepts either a number (epoch ms) or ISO string
 */
// One shared formatter: `toLocaleTimeString(locale, options)` builds a new
// Intl.DateTimeFormat on every call (~30 µs), and every rendered row formats
// its timestamp on every render.
let timestampFormatter: Intl.DateTimeFormat | null = null;

export function formatTimestamp(timestamp: number | string): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : new Date(timestamp);
  if (!timestampFormatter) {
    timestampFormatter = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }
  return timestampFormatter.format(date);
}

/**
 * Truncate a string with ellipsis if it exceeds maxLength
 */
export function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

/**
 * Truncate a file path, showing only the last N segments if too long
 */
export function truncateFilePath(filePath: string, maxLength: number = 50): string {
  if (filePath.length <= maxLength) return filePath;
  const parts = filePath.split('/');
  return '.../' + parts.slice(-2).join('/');
}
