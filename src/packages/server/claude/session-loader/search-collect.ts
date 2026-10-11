/**
 * 片段收集:SnippetCollector 与逐行扫描入口(scanSessionFileForQuery)。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { type SessionExtractKind, type SessionExtract, SNIPPETS_PER_SESSION } from './search-types.js';
import { SEARCH_MATCHES_PER_FILE_CAP, SEARCH_CACHE_LINES_MAX, SEARCH_CACHE_LINE_LEN_MAX, SNIPPET_RANK_USER, SNIPPET_CONTAINS_BONUS, SNIPPET_NEARBY_BONUS, extractKindForRank, snippetCandidateRank, extractLineTimestamp, extractReadableLineText, windowSnippet } from './search-scan.js';
import { foldAccents, accentFoldPattern, nearbyTokensPattern } from './search-plan.js';
import * as fs from 'fs';
import * as readline from 'readline';

/** Ranked extract candidate — kept while collecting, reduced at the end. */
interface SnippetCandidate {
  text: string;
  rank: number;
  kind: SessionExtractKind;
  order: number;
  timestamp?: string;
}

/**
 * Collector for a session's display extracts. Every matched line offers its
 * readable text; the collector keeps them scored (snippetCandidateRank) and
 * `finish()` returns the SNIPPETS_PER_SESSION best, best-first, distinct
 * (Claude duplicates prompt rows on resume/compaction — a repeated extract
 * would waste a slot), stable in file order among equals. `saturated` lets a
 * scanner stop parsing lines early once the top slots are all ceiling-rank
 * (user prompts containing the needle) — nothing can displace them.
 */
class SnippetCollector {
  private readonly candidates: SnippetCandidate[] = [];
  private readonly seen = new Set<string>();
  private readonly nearbyMatcher?: RegExp;
  private order = 0;

  constructor(private readonly needleLower: string, nearbyTokens?: readonly string[]) {
    const pattern = nearbyTokens ? nearbyTokensPattern(nearbyTokens) : null;
    if (pattern) this.nearbyMatcher = new RegExp(pattern, 'i');
  }

  offer(readable: { text: string; rank: number }, timestamp?: string): void {
    const rank = snippetCandidateRank(readable, this.needleLower, this.nearbyMatcher);
    const text = windowSnippet(readable.text, this.needleLower, this.nearbyMatcher);
    if (!text) return;
    // Dedupe on a normalized key: the same passage reaches us through
    // different rows/escaping levels (a tool result and the tool call that
    // wrote it; parsed newlines vs JSON-escaped `\n`, `\\n`) — one slot, not
    // two. Escapes shift the ±80 window, so key on the escape-stripped span
    // AROUND THE NEEDLE rather than the whole window.
    const norm = foldAccents(
      text.replace(/\\+[nrt]/g, ' ').replace(/\\+/g, '').replace(/\s+/g, ' ').trim().toLowerCase(),
    );
    const at = this.needleLower ? norm.indexOf(this.needleLower) : -1;
    const key = at >= 0 ? norm.slice(Math.max(0, at - 48), at + this.needleLower.length + 48) : norm;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.candidates.push({
      text,
      rank,
      kind: extractKindForRank(readable.rank),
      order: this.order++,
      timestamp,
    });
  }

  offerLine(line: string): void {
    this.offer(extractReadableLineText(line), extractLineTimestamp(line));
  }

  /** True once SNIPPETS_PER_SESSION ceiling-rank extracts are held. */
  get saturated(): boolean {
    const ceiling = SNIPPET_RANK_USER
      + (this.nearbyMatcher ? SNIPPET_NEARBY_BONUS : SNIPPET_CONTAINS_BONUS);
    let n = 0;
    for (const c of this.candidates) if (c.rank >= ceiling && ++n >= SNIPPETS_PER_SESSION) return true;
    return false;
  }

  finish(): SessionExtract[] {
    return [...this.candidates]
      .sort((a, b) => b.rank - a.rank || a.order - b.order)
      .slice(0, SNIPPETS_PER_SESSION)
      .map((c) => ({ text: c.text, kind: c.kind, ...(c.timestamp ? { timestamp: c.timestamp } : {}) }));
  }
}

/**
 * Best display extracts among one file's rg sample lines: user prompts beat
 * assistant text beat tool chatter beat raw JSON — and, above that, a
 * readable text that actually CONTAINS the needle beats one that doesn't.
 * The row highlights the query inside each extract, so a message-rank text
 * whose match sits in a sibling tool block (not in the extracted text) shows
 * nothing to highlight; the tool text that holds the word is the more useful
 * preview. Returns ≤ SNIPPETS_PER_SESSION distinct extracts, best-first,
 * each tagged with who said it.
 */
export function pickExtractsFromLines(
  lines: readonly string[],
  needleLower: string,
  nearbyTokens?: readonly string[],
): SessionExtract[] {
  const collector = new SnippetCollector(needleLower, nearbyTokens);
  for (const line of lines) collector.offerLine(line);
  return collector.finish();
}

/** Single best extract text (see pickExtractsFromLines) or '' when there is none. */
export function pickSnippetFromLines(lines: readonly string[], needleLower: string): string {
  return pickExtractsFromLines(lines, needleLower)[0]?.text ?? '';
}

/**
 * Scan one session file for a case-insensitive substring match.
 *
 * Reads 1 MB chunks and runs ONE compiled case-insensitive regex over each
 * chunk; a chunk is split into lines only when it matched. The previous
 * readline implementation allocated a string per line PLUS a lowercased copy
 * of every line — ~2× the corpus in throwaway allocations per search (the
 * session corpus here is measured in GBs, and single lines carrying base64
 * attachments run to hundreds of KB).
 */
export async function scanSessionFileForQuery(
  filePath: string,
  query: string,
  startByte?: number,
  /** Also collect the first N matching lines (windowed around the match when
   * huge) regardless of the refinement-cache retention rules — used by the
   * preview's raw-match fallback, which must SHOW hits that live outside the
   * parsed conversation. */
  keepFirst?: number,
): Promise<{ totalMatches: number; snippet: string; extracts: SessionExtract[]; matchingLines?: string[]; firstLines?: string[]; reachedEof: boolean }> {
  const matcher = new RegExp(accentFoldPattern(query), 'i');
  const queryLower = foldAccents(query.toLowerCase());
  let totalMatches = 0;
  const snippets = new SnippetCollector(queryLower);
  let snippetAttempts = 0;
  let reachedEof = true;
  const firstLines: string[] | undefined = keepFirst ? [] : undefined;
  const FIRST_LINE_WINDOW = 2400;
  // Matching lines retained for refinement answers (see SearchFileCacheEntry);
  // null once the file exceeds the retention bounds.
  let matchingLines: string[] | null = [];
  // Cap how much un-newlined text accumulates (giant single lines): scan and
  // drop, keeping a query-sized overlap so a match can't fall through the cut.
  // Counts may be ±1 on such lines — irrelevant for display.
  const MAX_CARRY = 4 * 1024 * 1024;
  let carry = '';

  const countMatchingLines = (text: string) => {
    if (!matcher.test(text)) return;
    for (const line of text.split('\n')) {
      if (!line || !matcher.test(line)) continue;
      totalMatches++;
      if (firstLines && keepFirst && firstLines.length < keepFirst) {
        if (line.length <= FIRST_LINE_WINDOW) {
          firstLines.push(line);
        } else {
          const at = foldAccents(line.toLowerCase()).indexOf(queryLower);
          const start = Math.max(0, at - 400);
          const end = Math.min(line.length, start + FIRST_LINE_WINDOW);
          firstLines.push(`${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`);
        }
      }
      // Collect extract candidates until the top slots hold user prompts
      // CONTAINING the query (bounded: each attempt JSON-parses one matched
      // line). Same scoring as the rg engine's pickExtractsFromLines.
      if (snippetAttempts < 30 && !snippets.saturated) {
        snippetAttempts++;
        snippets.offerLine(line);
      }
      if (matchingLines) {
        // Partial giant-line slices are also unsafe to retain, but they always
        // exceed the length bound anyway.
        if (line.length > SEARCH_CACHE_LINE_LEN_MAX || matchingLines.length >= SEARCH_CACHE_LINES_MAX) {
          matchingLines = null;
        } else {
          matchingLines.push(line);
        }
      }
    }
  };

  const stream = fs.createReadStream(filePath, {
    encoding: 'utf-8',
    highWaterMark: 1 << 20,
    start: startByte,
  });
  try {
    for await (const chunk of stream) {
      const text = carry + (chunk as string);
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) {
        if (text.length > MAX_CARRY) {
          countMatchingLines(text);
          const overlap = Math.max(query.length - 1, 0);
          carry = overlap > 0 ? text.slice(-overlap) : '';
        } else {
          carry = text;
        }
        continue;
      }
      countMatchingLines(text.slice(0, lastNewline));
      carry = text.slice(lastNewline + 1);
      if (totalMatches >= SEARCH_MATCHES_PER_FILE_CAP) {
        reachedEof = false;
        break;
      }
    }
  } finally {
    stream.destroy();
  }
  if (reachedEof && carry) countMatchingLines(carry);
  const picked = snippets.finish();
  return {
    totalMatches,
    snippet: picked[0]?.text ?? '',
    extracts: picked,
    // Only a COMPLETE set answers refinements (a capped scan saw a subset).
    matchingLines: matchingLines !== null && reachedEof ? matchingLines : undefined,
    firstLines,
    reachedEof,
  };
}

/** JS-fallback proximity count for a multi-word query. The rg engine computes
 * the same metric with `rg -c`; this keeps ranking behavior consistent on
 * systems without ripgrep. */
export async function countSessionFileNearbyMatches(filePath: string, tokens: readonly string[]): Promise<number> {
  const pattern = nearbyTokensPattern(tokens);
  if (!pattern) return 0;
  const matcher = new RegExp(pattern, 'i');
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of lines) {
      if (matcher.test(line)) count++;
      if (count >= SEARCH_MATCHES_PER_FILE_CAP) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return count;
}
