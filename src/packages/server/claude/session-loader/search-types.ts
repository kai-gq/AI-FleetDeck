/**
 * 检索类型与上限:全局会话信息/匹配结构、extract 种类与条数上限常量。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { type SessionProvider } from './session-types.js';

// ============================================================================
// Global session listing & search (cross-project)
// ============================================================================

/**
 * Lightweight session record used by the global session finder UI.
 *
 * Includes everything needed to render a result row and to attach the session
 * onto an agent (`projectPath` is the original `cwd`, recovered from the JSONL
 * itself rather than from the project dir name — the encoding is lossy because
 * `_` and `/` both map to `-`).
 */
export interface GlobalSessionInfo {
  sessionId: string;
  projectPath: string;          // recovered cwd ("" if file is empty/unreadable)
  projectDir: string;            // encoded dir name under the provider's sessions root
  lastModified: Date;
  messageCount: number;          // 0 = unknown / skipped for cost reasons
  firstPrompt: string;           // first user prompt content (truncated)
  sizeBytes: number;
  /** Absolute path of the searchable JSONL (claude: <sessionId>.jsonl, grok: chat_history.jsonl). */
  filePath: string;
  provider: SessionProvider;
}

/**
 * Search hit produced by `searchAllSessions`.
 */
export interface GlobalSessionSearchMatch {
  sessionId: string;
  projectPath: string;
  projectDir: string;
  lastModified: Date;
  totalMatches: number;          // total matching lines in this session (multi-word: bottleneck token count)
  /** Multi-word searches only: lines/parts where every query token occurs
   * within a small window. Distinguishes a conversation about the combined
   * request from a large session that mentions each word in unrelated places. */
  nearbyMatches?: number;
  snippet: string;               // best extract text (= extracts[0].text or '') — kept for single-snippet consumers
  /** Up to SNIPPETS_PER_SESSION distinct extracts, best-first: user prompts
   * containing the query, then agent text/reasoning, then tool output — a
   * glimpse of what the conversation is about, not just one line. Each
   * carries who said it so the UI can color by role. */
  extracts: SessionExtract[];
  firstPrompt: string;           // first user prompt content (truncated) for context
  provider: SessionProvider;
}

/** Who produced an extract's text. `assistant` covers the agent's visible
 * messages AND its reasoning/thinking; `tool` is tool calls/results; `raw`
 * is an unparseable line shown as-is. */
export type SessionExtractKind = 'user' | 'assistant' | 'tool' | 'raw';

export interface SessionExtract {
  text: string;
  kind: SessionExtractKind;
  /** Timestamp of the actual matched message, when the harness records one. */
  timestamp?: string;
}

export const FIRST_PROMPT_MAX_LEN = 240;

export const SEARCH_SNIPPET_MAX_LEN = 280;

/** Extracts returned per session hit (Spotlight shows them stacked under the
 * agent row so the topic is readable at a glance). */
export const SNIPPETS_PER_SESSION = 4;
