/**
 * AgentTerminalPane 的常量(重复窗口毫秒 / 系统通知前缀)。
 *
 * 自 AgentTerminalPane.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */


// ─── Constants ──────────────────────────────────────────────────────────────

// The source emits stream-final and result fallback synchronously. Keeping this
// identity fallback window tiny prevents two real, identical turns from ever
// being mistaken for the observed uuid-bearing/uuid-less twin.
export const LIVE_RESULT_FALLBACK_DUPLICATE_WINDOW_MS = 250;

export const HISTORY_ASSISTANT_OUTPUT_DUPLICATE_WINDOW_MS = 120_000;

/**
 * Live thinking rows vs persisted reasoning entries: uuids never match (live
 * mints grok-thinking-* / claude-stream-*; history has the entry id), so dedup
 * is content-based. Wide window — a long reasoning block can stream minutes
 * before the entry is flushed, and identical reasoning twice in 10min = same turn.
 */
export const HISTORY_THINKING_OUTPUT_DUPLICATE_WINDOW_MS = 600_000;

/** Live tool chip vs history tool_use: Grok early uuid ≠ call id, so uuid dedup misses. */
export const HISTORY_TOOL_OUTPUT_DUPLICATE_WINDOW_MS = 180_000;

/** Two live rows for the same tool call (early + call-* dual emit). */
export const LIVE_TOOL_DUPLICATE_WINDOW_MS = 15_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Mirrors the `[System]` notice shape OutputLine/HistoryLine render specially. */
export const SYSTEM_NOTICE_PREFIX = /^\s*[\u{1F300}-\u{1FAFF}☀-➿]?\s*\[System\]/u;
