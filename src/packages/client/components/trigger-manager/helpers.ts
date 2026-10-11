/**
 * TriggerManagerPanel 的纯助手(datetime-local 转换 / 空触发器模板)。
 *
 * 自 TriggerManagerPanel.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { type Trigger } from '../../../shared/trigger-types';

// Convert an ISO datetime string (UTC) to the value format expected by
// <input type="datetime-local"> (YYYY-MM-DDTHH:mm in local time). Returns
// empty string for invalid / missing input.
export function toDatetimeLocal(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const emptyTrigger = (): Partial<Trigger> => ({
  name: '',
  description: '',
  type: 'webhook',
  agentId: '',
  promptTemplate: '',
  enabled: true,
  matchMode: 'structural',
  extractionMode: 'structural',
  config: { method: 'POST' } as any,
});
