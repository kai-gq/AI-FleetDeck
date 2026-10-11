/**
 * AgentOverviewPanel 的纯助手(消息摘要缓存 / 数组与集合保留性比较)。
 *
 * 自 AgentOverviewPanel.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { type AgentMessageSummary } from './types';
import { EMPTY_MESSAGE_SUMMARY } from './constants';
import { store } from '../../../store';
import { type Agent } from '../../../../shared/types';
import { type ClaudeOutput } from '../../../store/types';

const messageSummaryCache = new WeakMap<ClaudeOutput[], AgentMessageSummary>();

function isMeaningfulMessage(output: ClaudeOutput): boolean {
  if (output.isStreaming) return false;
  const text = output.text;
  if (
    text.startsWith('Using tool:')
    || text.startsWith('Tool input:')
    || text.startsWith('Tool result:')
    || text.startsWith('Bash output:')
    || text.startsWith('Tokens:')
    || text.startsWith('Cost:')
    || text.startsWith('Context:')
  ) {
    return false;
  }
  return text.trim().length > 0;
}

/**
 * Compute the count and latest meaningful message in one pass. Output actions
 * replace arrays immutably, so the array identity is a safe cache key. This is
 * especially important when selecting a boss: dozens of subordinate cards can
 * update together, but their unchanged histories should not be rescanned.
 */
export function getMessageSummary(agentId: string): AgentMessageSummary {
  const outputs = store.getState().agentOutputs.get(agentId);
  if (!outputs || outputs.length === 0) return EMPTY_MESSAGE_SUMMARY;
  const cached = messageSummaryCache.get(outputs);
  if (cached) return cached;

  let lastMessage: ClaudeOutput | null = null;
  let messageCount = 0;
  for (const output of outputs) {
    if (!isMeaningfulMessage(output)) continue;
    lastMessage = output;
    messageCount++;
  }

  const summary = { lastMessage, messageCount };
  messageSummaryCache.set(outputs, summary);
  return summary;
}

/** True when agent has any explicit user instruction (assigned task or user prompt output) */
function _hasUserInstruction(agent: Agent): boolean {
  if (agent.lastAssignedTask?.trim()) return true;

  const outputs = store.getState().agentOutputs.get(agent.id);
  if (!outputs) return false;

  return outputs.some(o => o.isUserPrompt && o.text.trim().length > 0);
}

/** Truncate text with ellipsis */
export function truncate(text: string, maxLen: number): string {
  const line = text.split('\n')[0];
  return line.length > maxLen ? line.slice(0, maxLen) + '...' : line;
}

// ── Identity preservation for derived collections ──
// This panel re-renders on every agent update while agents work (it lists
// them, sorted by recency). Everything derived from `agents` is recomputed
// then, but most of it comes out identical — returning the PREVIOUS
// collection when the new one is element-wise equal keeps `renderAgentCards`
// (and the memoized area sections / AgentCards below it) stable, so a single
// agent update rebuilds one section instead of the whole list.
function sameArray<T>(a: readonly T[] | undefined, b: readonly T[]): a is T[] {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function keepArray<T>(prev: readonly T[] | undefined, next: T[]): T[] {
  return sameArray(prev, next) ? (prev as T[]) : next;
}

export function keepMap<K, V>(prev: Map<K, V>, next: Map<K, V>, eq: (a: V, b: V) => boolean = (a, b) => a === b): Map<K, V> {
  if (prev.size !== next.size) return next;
  for (const [k, v] of next) {
    const pv = prev.get(k);
    if (pv === undefined || !eq(pv, v)) return next;
  }
  return prev;
}

export function keepSet<T>(prev: Set<T> | null, next: Set<T> | null): Set<T> | null {
  if (!prev || !next) return prev === next ? prev : next;
  if (prev.size !== next.size) return next;
  for (const v of next) if (!prev.has(v)) return next;
  return prev;
}
