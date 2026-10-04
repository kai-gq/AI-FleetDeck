/**
 * 时间窗解析（⑮ P1）：支持「昨天/今天/近24小时/近7天」预设与显式 from/to。
 *
 * 预设按本地时区自然日切分（"昨天"= 本地昨日 00:00:00.000 起 24 小时），
 * 与用户口语（"查一下昨天的日志"）一致；显式 from/to（epoch ms）优先级最高。
 */

import type { LogWindow } from './types.js';

export type TimeWindowPreset = 'today' | 'yesterday' | 'last24h' | 'last7d';

export interface TimeWindowInput {
  preset?: TimeWindowPreset;
  /** 显式起点（epoch ms），给定时优先于 preset */
  from?: number;
  /** 显式终点（epoch ms，含） */
  to?: number;
  /** 测试注入"当前时刻"，缺省 Date.now() */
  now?: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** 本地自然日零点（用本地时区字段构造，避免 toISOString 的 UTC 偏移坑）。 */
export function localMidnight(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function formatLocal(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 解析时间窗。规则：
 *   - from/to 都给定 → 直接用（to < from 时交换，容错）；
 *   - 只给定一端 → 另一端按 [from, from+24h] / [to-24h, to] 推断；
 *   - preset：today=本地零点→now；yesterday=本地昨日零点→本地今日零点；
 *     last24h=now-24h→now；last7d=now-7d→now；
 *   - 缺省 last24h。
 */
export function resolveTimeWindow(input: TimeWindowInput = {}): LogWindow {
  const now = input.now ?? Date.now();
  let from: number;
  let to: number;

  if (input.from !== undefined && input.to !== undefined) {
    from = Math.min(input.from, input.to);
    to = Math.max(input.from, input.to);
  } else if (input.from !== undefined) {
    from = input.from;
    to = input.from + DAY_MS;
  } else if (input.to !== undefined) {
    to = input.to;
    from = input.to - DAY_MS;
  } else {
    switch (input.preset) {
      case 'today':
        from = localMidnight(now);
        to = now;
        break;
      case 'yesterday': {
        const todayStart = localMidnight(now);
        from = todayStart - DAY_MS;
        to = todayStart;
        break;
      }
      case 'last7d':
        from = now - 7 * DAY_MS;
        to = now;
        break;
      case 'last24h':
      default:
        from = now - DAY_MS;
        to = now;
        break;
    }
  }

  return { from, to, label: `${formatLocal(from)} ~ ${formatLocal(to)}` };
}
