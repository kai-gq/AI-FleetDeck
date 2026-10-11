/**
 * 检索扫描:文件缓存结构、片段排序权重、时间戳与行文本抽取、窗口切分。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { isObject, truncate } from './message-utils.js';
import { extractClaudeMessageText } from './session-headers.js';
import { type SessionExtractKind, type SessionExtract, SEARCH_SNIPPET_MAX_LEN } from './search-types.js';
import { foldAccents, accentFoldPattern } from './search-plan.js';
import { pickExtractsFromLines } from './search-collect.js';
import { extractCodexMessageText } from './parse-codex.js';
import * as path from 'path';

// ── Global search fast path ──────────────────────────────────────────────────

/** Per-file scan stops counting past this — enough signal for display/ranking,
 * and it stops burning IO on a hot file with thousands of hits. */
export const SEARCH_MATCHES_PER_FILE_CAP = 500;

export const SEARCH_FILE_CACHE_MAX = 6000;

/** Refinement-answer bounds: matching lines are only retained when there are
 * few and they're short — enough to answer every follow-up keystroke from
 * memory for the typical file, without letting the cache balloon. */
export const SEARCH_CACHE_LINES_MAX = 60;

export const SEARCH_CACHE_LINE_LEN_MAX = 4096;

export interface SearchFileCacheEntry {
  mtimeMs: number;
  sizeBytes: number;
  /** Lowercased query this result was computed for. */
  query: string;
  totalMatches: number;
  /** Multi-word proximity count used by ranking. Undefined for single words. */
  nearbyMatches?: number;
  snippet: string;
  /** Ranked extracts (see GlobalSessionSearchMatch.extracts); absent on
   * entries written before extracts existed — derive from `snippet`. */
  extracts?: SessionExtract[];
  /** The COMPLETE set of matching lines, present only when the scan saw all of
   * them within the retention bounds. A refined query (one containing `query`)
   * can then be answered by re-testing just these lines — no file read. */
  matchingLines?: string[];
  /** File size at the moment the scan reached EOF. Session JSONL files are
   * append-only, so a later, larger file can be answered by scanning ONLY
   * [scannedBytes, EOF) and adding the head answer from this entry — that is
   * what keeps actively-streaming sessions (always the newest, always scanned
   * first) from being re-read whole on every keystroke. Absent when the scan
   * stopped early at the per-file match cap. */
  scannedBytes?: number;
}

/** filePath → recent computed outcomes for that file (newest first, small cap).
 * Multiple entries matter for real typing: "vir"→"virtu"→"virtual" then a
 * backspace must hit the still-valid "virtu" entry instead of rescanning. */
export const searchFileCache = new Map<string, SearchFileCacheEntry[]>();

export const SEARCH_CACHE_ENTRIES_PER_FILE = 3;

/**
 * Decide whether a cached per-file result answers `queryLower` without
 * re-reading the file. Exact same query on an unchanged file → reuse. A
 * ZERO-match entry also answers any longer query that CONTAINS the cached one
 * (if "scro" appears nowhere in the file, "scroll" cannot either) — which is
 * exactly what happens on every keystroke while the user types, so refining a
 * query only re-reads the files that were still matching.
 */
/** Head answer (count/snippet/lines) derivable from a cache entry for
 * `queryLower` WITHOUT reading the bytes the entry covers. */
/** Extracts of a cache entry — entries written before extracts existed only
 * carry the single `snippet` (role unknown → 'raw'). */
export function entryExtracts(entry: SearchFileCacheEntry): SessionExtract[] {
  return entry.extracts ?? (entry.snippet ? [{ text: entry.snippet, kind: 'raw' }] : []);
}

export function headAnswerFrom(
  entry: SearchFileCacheEntry,
  queryLower: string,
): { totalMatches: number; snippet: string; extracts: SessionExtract[]; matchingLines?: string[] } | null {
  if (entry.query === queryLower) {
    return { totalMatches: entry.totalMatches, snippet: entry.snippet, extracts: entryExtracts(entry), matchingLines: entry.matchingLines };
  }
  if (!queryLower.includes(entry.query)) return null;
  if (entry.totalMatches === 0) return { totalMatches: 0, snippet: '', extracts: [], matchingLines: [] };
  // Refined query: its matches are a subset of the cached query's matching
  // lines — when we have ALL of them, answer by re-testing just those lines.
  if (entry.matchingLines) {
    const matcher = new RegExp(accentFoldPattern(queryLower), 'i');
    const matchingLines = entry.matchingLines.filter((line) => matcher.test(line));
    const extracts = pickExtractsFromLines(matchingLines, queryLower);
    return { totalMatches: matchingLines.length, snippet: extracts[0]?.text ?? '', extracts, matchingLines };
  }
  return null;
}

/** Snippet quality ranks — higher wins. The Session Finder shows the snippet
 * to a human: real conversation text beats tool chatter beats raw JSON. */
export const SNIPPET_RANK_RAW = 1;

const SNIPPET_RANK_TOOL = 2;

const SNIPPET_RANK_MESSAGE = 3;

/** Text the USER typed (a prompt) — the strongest signal of what a
 * conversation is about, so it outranks the assistant's own prose. */
export const SNIPPET_RANK_USER = 4;

/** Added on top of the readable rank when the extracted text itself contains
 * the needle — dominates the readable tiers (10 > 4), so "shows the match"
 * beats "is conversation text" while readability still breaks ties. */
export const SNIPPET_CONTAINS_BONUS = 10;

/** A readable extract containing every multi-word query token nearby is the
 * best possible preview and outranks a prompt containing only one word. */
export const SNIPPET_NEARBY_BONUS = 20;

/** Readable rank → who said it (1:1 — the rank IS the role tier). */
export function extractKindForRank(rank: number): SessionExtractKind {
  if (rank >= SNIPPET_RANK_USER) return 'user';
  if (rank >= SNIPPET_RANK_MESSAGE) return 'assistant';
  if (rank >= SNIPPET_RANK_TOOL) return 'tool';
  return 'raw';
}

/** Snippet candidate score for a matched line's readable text: the readable
 * rank plus the contains-needle bonus. `needleLower` is already accent-folded
 * and lowercased (the search entry points fold once). */
export function snippetCandidateRank(
  readable: { text: string; rank: number },
  needleLower: string,
  nearbyMatcher?: RegExp,
): number {
  if (nearbyMatcher?.test(readable.text)) return readable.rank + SNIPPET_NEARBY_BONUS;
  const contains = needleLower.length > 0 && foldAccents(readable.text.toLowerCase()).includes(needleLower);
  return readable.rank + (contains ? SNIPPET_CONTAINS_BONUS : 0);
}

/** The agent's reasoning text (`{type:'thinking', thinking}` blocks — Claude
 * and Pi share the shape), joined. Surfaced as agent-side text when a row has
 * no visible text: what the agent was thinking about the query is a better
 * glimpse than the tool call it made next. */
function extractThinkingText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; thinking?: unknown };
    if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) parts.push(b.thinking);
  }
  return parts.join('\n');
}

/** Joined text of reasoning-summary blocks (`[{text}]`, grok and codex). */
function summaryBlocksText(summary: unknown[]): string {
  return summary
    .map((s) => (s && typeof s === 'object' && typeof (s as { text?: unknown }).text === 'string' ? (s as { text: string }).text : ''))
    .filter(Boolean)
    .join(' ');
}

/** Readable one-liner for a grok `tool_calls` entry (`{name, arguments}`), if any. */
function firstGrokToolCallText(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls)) return '';
  for (const call of toolCalls) {
    if (!call || typeof call !== 'object') continue;
    const c = call as { name?: unknown; arguments?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = typeof c.name === 'string' ? c.name : typeof c.function?.name === 'string' ? c.function.name : 'tool';
    const args = typeof c.arguments === 'string' ? c.arguments : typeof c.function?.arguments === 'string' ? c.function.arguments : '';
    if (name || args) return `${name}: ${args}`;
  }
  return '';
}

/** Readable one-liner for a tool_use / tool_result content block, if any. */
function firstToolText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; name?: string; input?: unknown; content?: unknown };
    if (b.type === 'tool_use') {
      const input = b.input as Record<string, unknown> | undefined;
      const arg = input && (input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.description);
      const argText = typeof arg === 'string' ? arg : input ? JSON.stringify(input) : '';
      return `${b.name ?? 'tool'}: ${argText}`;
    }
    if (b.type === 'tool_result') {
      const inner = b.content;
      if (typeof inner === 'string' && inner.trim()) return inner;
      if (Array.isArray(inner)) {
        for (const part of inner) {
          const text = (part as { text?: unknown } | null)?.text;
          if (typeof text === 'string' && text.trim()) return text;
        }
      }
    }
  }
  return '';
}

export function normalizeMessageTimestamp(value: unknown): string | undefined {
  let millis: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    millis = value < 10_000_000_000 ? value * 1000 : value;
  } else if (typeof value === 'string' && value.trim()) {
    millis = Date.parse(value);
    if (!Number.isFinite(millis) && /^\d+(?:\.\d+)?$/.test(value.trim())) {
      const numeric = Number(value);
      millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }
  } else {
    return undefined;
  }
  // Reject process-relative counters and malformed/far-future values.
  if (!Number.isFinite(millis) || millis < Date.UTC(2000, 0, 1) || millis > Date.now() + 86_400_000) {
    return undefined;
  }
  return new Date(millis).toISOString();
}

/** Timestamp attached to the matched message row across supported harnesses. */
export function extractLineTimestamp(line: string): string | undefined {
  try {
    const row = JSON.parse(line) as Record<string, unknown>;
    const message = isObject(row.message) ? row.message : undefined;
    const payload = isObject(row.payload) ? row.payload : undefined;
    const candidates = [
      row.timestamp,
      row.created_at,
      row.createdAt,
      row.time,
      row.time_created,
      message?.timestamp,
      message?.created_at,
      message?.createdAt,
      payload?.timestamp,
      payload?.created_at,
      payload?.createdAt,
    ];
    for (const candidate of candidates) {
      const timestamp = normalizeMessageTimestamp(candidate);
      if (timestamp) return timestamp;
    }
  } catch { /* raw line without message metadata */ }
  return undefined;
}

/** Best human-readable text for a matched JSONL line, with its quality rank. */
export function extractReadableLineText(line: string): { text: string; rank: number } {
  try {
    const obj = JSON.parse(line) as { type?: string; message?: unknown; content?: unknown; summary?: unknown; payload?: unknown };
    if (obj.type === 'user' || obj.type === 'assistant') {
      // Text the user typed outranks the assistant's prose (Claude/Grok mark
      // the role at the row level; a user row holding only tool_result blocks
      // has no text and falls through to the tool rank).
      const roleRank = obj.type === 'user' ? SNIPPET_RANK_USER : SNIPPET_RANK_MESSAGE;
      const text = extractClaudeMessageText(obj.message);
      if (text.trim()) return { text, rank: roleRank };
      const content = (obj.message as { content?: unknown } | undefined)?.content;
      if (obj.type === 'assistant') {
        const thinking = extractThinkingText(content);
        if (thinking) return { text: thinking, rank: SNIPPET_RANK_MESSAGE };
      }
      const toolText = firstToolText(content);
      if (toolText) return { text: toolText, rank: SNIPPET_RANK_TOOL };
      // Grok chat_history rows carry content at the TOP level (no `message`):
      // a string, or an array of {type:'text', text} blocks.
      const grokText = typeof obj.content === 'string' ? obj.content : extractClaudeMessageText(obj);
      if (grokText.trim()) return { text: grokText, rank: roleRank };
      // Grok assistant tool calls: top-level `tool_calls: [{name, arguments}]`
      // with empty content — the call is the readable part (tool voice).
      const grokCall = firstGrokToolCallText((obj as { tool_calls?: unknown }).tool_calls);
      if (grokCall) return { text: grokCall, rank: SNIPPET_RANK_TOOL };
    }
    // Pi rows: {type:'message', message:{role, content:[{type:'text', text}]}}
    // — role is 'user' | 'assistant' | 'toolResult'.
    if (obj.type === 'message' && isObject(obj.message)) {
      const role = (obj.message as { role?: unknown }).role;
      const text = extractClaudeMessageText(obj.message);
      if (text.trim()) {
        const rank = role === 'user' ? SNIPPET_RANK_USER : role === 'toolResult' ? SNIPPET_RANK_TOOL : SNIPPET_RANK_MESSAGE;
        return { text, rank };
      }
      if (role === 'assistant') {
        const thinking = extractThinkingText((obj.message as { content?: unknown }).content);
        if (thinking) return { text: thinking, rank: SNIPPET_RANK_MESSAGE };
      }
    }
    // Codex rows: {type:'message', role, content:[{type:'input_text'|'output_text', text}]}
    // at the top level (old format) or wrapped in response_item.payload (new).
    const codexRec = obj.type === 'response_item' && isObject(obj.payload) ? obj.payload : (obj as Record<string, unknown>);
    if (codexRec.type === 'message' && (codexRec.role === 'user' || codexRec.role === 'assistant')) {
      const text = extractCodexMessageText(codexRec.content);
      if (text.trim()) return { text, rank: codexRec.role === 'user' ? SNIPPET_RANK_USER : SNIPPET_RANK_MESSAGE };
    }
    // Codex reasoning item: {type:'reasoning', summary:[{type:'summary_text', text}]} — agent reasoning.
    if (codexRec.type === 'reasoning' && Array.isArray(codexRec.summary)) {
      const text = summaryBlocksText(codexRec.summary);
      if (text.trim()) return { text, rank: SNIPPET_RANK_MESSAGE };
    }
    // Codex tool rows: the call ({type:'function_call'|'custom_tool_call', name, arguments|input})
    // and its output ({type:'function_call_output', output}).
    if (codexRec.type === 'function_call_output' && typeof codexRec.output === 'string' && codexRec.output.trim()) {
      return { text: codexRec.output, rank: SNIPPET_RANK_TOOL };
    }
    if ((codexRec.type === 'function_call' || codexRec.type === 'custom_tool_call') && typeof codexRec.name === 'string') {
      const arg = typeof codexRec.arguments === 'string' ? codexRec.arguments : typeof codexRec.input === 'string' ? codexRec.input : '';
      return { text: `${codexRec.name}: ${arg}`, rank: SNIPPET_RANK_TOOL };
    }
    if (obj.type === 'event_msg' && isObject(obj.payload)) {
      const payload = obj.payload;
      if (payload.type === 'user_message' && typeof payload.message === 'string' && payload.message.trim()) {
        return { text: payload.message, rank: SNIPPET_RANK_USER };
      }
      // The agent's visible reply and its reasoning stream — both agent voice.
      if (payload.type === 'agent_message' && typeof payload.message === 'string' && payload.message.trim()) {
        return { text: payload.message, rank: SNIPPET_RANK_MESSAGE };
      }
      if (payload.type === 'agent_reasoning' && typeof payload.text === 'string' && payload.text.trim()) {
        return { text: payload.text, rank: SNIPPET_RANK_MESSAGE };
      }
    }
    if (obj.type === 'queue-operation' && typeof obj.content === 'string' && obj.content.trim()) {
      return { text: obj.content, rank: SNIPPET_RANK_USER };
    }
    // Claude bookkeeping row echoing the user's latest prompt verbatim.
    const lastPrompt = (obj as { lastPrompt?: unknown }).lastPrompt;
    if (obj.type === 'last-prompt' && typeof lastPrompt === 'string' && lastPrompt.trim()) {
      return { text: lastPrompt, rank: SNIPPET_RANK_USER };
    }
    // Grok tool_result rows: plain string content.
    if (obj.type === 'tool_result' && typeof obj.content === 'string' && obj.content.trim()) {
      return { text: obj.content, rank: SNIPPET_RANK_TOOL };
    }
    if (typeof obj.summary === 'string' && obj.summary.trim()) {
      return { text: obj.summary, rank: SNIPPET_RANK_TOOL };
    }
    // Grok reasoning rows: summary is an ARRAY of {text} blocks — the agent's
    // own reasoning, so it ranks (and colors) as agent text.
    if (Array.isArray(obj.summary)) {
      const text = summaryBlocksText(obj.summary);
      if (text.trim()) return { text, rank: SNIPPET_RANK_MESSAGE };
    }
  } catch { /* not JSON — treat as raw */ }
  return { text: line, rank: SNIPPET_RANK_RAW };
}

/** Collapse to one line and window around the first query occurrence, so the
 * user sees the matched context instead of the start of a long message. */
export function windowSnippet(text: string, queryLower: string, nearbyMatcher?: RegExp): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= SEARCH_SNIPPET_MAX_LEN) return collapsed;
  // For multi-word searches, center on the first place where all words occur
  // nearby. Otherwise center on the single display needle. Accent folding is
  // length-preserving, so indexes stay aligned with the original string.
  const nearbyAt = nearbyMatcher?.exec(collapsed)?.index ?? -1;
  const at = nearbyAt >= 0
    ? nearbyAt
    : queryLower ? foldAccents(collapsed.toLowerCase()).indexOf(queryLower) : -1;
  if (at <= 80) return truncate(collapsed, SEARCH_SNIPPET_MAX_LEN);
  const start = at - 80;
  const end = Math.min(collapsed.length, start + SEARCH_SNIPPET_MAX_LEN - 2);
  return `…${collapsed.slice(start, end)}${end < collapsed.length ? '…' : ''}`;
}
