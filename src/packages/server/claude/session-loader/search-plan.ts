/**
 * 检索计划:缓存复用/尾部扫描决策(planFileSearch/planTokenFileSearch)与近邻分词、重音折叠。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { type SessionExtract } from './search-types.js';
import { SEARCH_FILE_CACHE_MAX, type SearchFileCacheEntry, searchFileCache, SEARCH_CACHE_ENTRIES_PER_FILE, entryExtracts, headAnswerFrom } from './search-scan.js';

export type FileSearchPlan =
  | { kind: 'reuse'; totalMatches: number; snippet: string; extracts: SessionExtract[] }
  | { kind: 'tail'; startByte: number; head: { totalMatches: number; snippet: string; extracts: SessionExtract[]; matchingLines?: string[] } }
  | { kind: 'full' };

/**
 * Decide how to answer `queryLower` for one file given its cached outcomes:
 * - unchanged file + answerable from an entry → 'reuse' (no IO at all);
 * - grown file (sessions are append-only) + answerable head → 'tail', scan
 *   only the appended bytes — the actively-streaming sessions are the newest
 *   files, scanned first on every keystroke, and this is what keeps them from
 *   being re-read whole each time;
 * - anything else (shrunk/rewritten file, underivable head) → 'full'.
 * Entries are tried newest-first; the freshest answerable one wins.
 */
export function planFileSearch(
  entries: readonly SearchFileCacheEntry[] | undefined,
  queryLower: string,
  mtimeMs: number,
  sizeBytes: number,
): FileSearchPlan {
  if (!entries || entries.length === 0) return { kind: 'full' };
  let tailPlan: FileSearchPlan | null = null;
  for (const entry of entries) {
    const head = headAnswerFrom(entry, queryLower);
    if (!head) continue;
    if (entry.mtimeMs === mtimeMs && entry.sizeBytes === sizeBytes) {
      return { kind: 'reuse', totalMatches: head.totalMatches, snippet: head.snippet, extracts: head.extracts };
    }
    if (entry.scannedBytes !== undefined && sizeBytes >= entry.scannedBytes) {
      // Prefer the entry that leaves the smallest tail to scan.
      if (tailPlan === null || (tailPlan.kind === 'tail' && entry.scannedBytes > tailPlan.startByte)) {
        tailPlan = { kind: 'tail', startByte: entry.scannedBytes, head };
      }
    }
  }
  return tailPlan ?? { kind: 'full' };
}

/**
 * Cache plan for MULTI-WORD (AND-of-words) queries. Word semantics make the
 * phrase cache's line-refinement and tail-merge unsound (different words match
 * different LINES, and head+tail counts don't min-combine), so only two safe
 * answers are reused — both restricted to an UNCHANGED file:
 * - an entry for the exact same query string;
 * - the zero-prune: an entry with 0 matches whose query is contained in this
 *   one (if "jira" appears nowhere in the file, "jira krunner" cannot
 *   AND-match either — regardless of which semantics produced the 0).
 * Returns null when the file must be scanned.
 */
export function planTokenFileSearch(
  entries: readonly SearchFileCacheEntry[] | undefined,
  queryLower: string,
  mtimeMs: number,
  sizeBytes: number,
): { totalMatches: number; nearbyMatches: number; snippet: string; extracts: SessionExtract[] } | null {
  for (const entry of entries ?? []) {
    if (entry.mtimeMs !== mtimeMs || entry.sizeBytes !== sizeBytes) continue;
    if (entry.query === queryLower && entry.nearbyMatches !== undefined) {
      return {
        totalMatches: entry.totalMatches,
        nearbyMatches: entry.nearbyMatches,
        snippet: entry.snippet,
        extracts: entryExtracts(entry),
      };
    }
    if (entry.totalMatches === 0 && queryLower.includes(entry.query)) {
      return { totalMatches: 0, nearbyMatches: 0, snippet: '', extracts: [] };
    }
  }
  return null;
}

/** Insert/replace an outcome in a file's entry list (newest first, capped). */
export function storeSearchEntry(filePath: string, entry: SearchFileCacheEntry): void {
  if (searchFileCache.size >= SEARCH_FILE_CACHE_MAX) searchFileCache.clear();
  const existing = searchFileCache.get(filePath) ?? [];
  const kept = existing.filter((e) => e.query !== entry.query);
  kept.unshift(entry);
  searchFileCache.set(filePath, kept.slice(0, SEARCH_CACHE_ENTRIES_PER_FILE));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Accent-insensitive matching ──────────────────────────────────────────────
// The corpus is Spanish-heavy and inconsistently accented: users type
// "conciliacion" while conversations say "conciliación" (and vice versa) —
// both spellings must find each other in every engine (JS scanner, rg,
// opencode SQLite). The query is folded once at the search entry points and
// every text comparison folds its haystack the same way.

/** Length-preserving fold: accented vowels / ñ collapse to their base
 * lowercase letter (uppercase variants included; other chars keep case).
 * 1:1 per char, so indexes computed on a folded copy remain valid on the
 * original string — snippet windowing relies on that. */
export function foldAccents(s: string): string {
  return s
    .replace(/[áàäâÁÀÄÂ]/g, 'a')
    .replace(/[éèëêÉÈËÊ]/g, 'e')
    .replace(/[íìïîÍÌÏÎ]/g, 'i')
    .replace(/[óòöôÓÒÖÔ]/g, 'o')
    .replace(/[úùüûÚÙÜÛ]/g, 'u')
    .replace(/[ñÑ]/g, 'n');
}

/** Regex source matching `literal` accent-insensitively (pair with the `i`
 * flag — JS RegExp or rg -i): each foldable letter becomes a character class
 * of its variants, everything else is escaped. Produces the same pattern
 * whether `literal` arrives accented or folded. */
export function accentFoldPattern(literal: string): string {
  const CLASSES: Record<string, string> = {
    a: '[aáàäâ]', e: '[eéèëê]', i: '[iíìïî]', o: '[oóòöô]', u: '[uúùüû]', n: '[nñ]',
  };
  let out = '';
  for (const ch of literal) {
    out += CLASSES[foldAccents(ch.toLowerCase())] ?? escapeRegExp(ch);
  }
  return out;
}

/** Maximum distance between adjacent query words for a multi-word hit to be
 * considered one topical mention rather than unrelated words in a huge log. */
const SEARCH_NEARBY_TOKEN_GAP = 80;

const SEARCH_NEARBY_PERMUTATION_LIMIT = 4;

function tokenPermutations(tokens: readonly string[]): string[][] {
  if (tokens.length <= 1) return [tokens.slice()];
  const out: string[][] = [];
  tokens.forEach((token, index) => {
    const rest = [...tokens.slice(0, index), ...tokens.slice(index + 1)];
    for (const suffix of tokenPermutations(rest)) out.push([token, ...suffix]);
  });
  return out;
}

/**
 * Accent-blind regex for lines where every token occurs nearby, in any order.
 * Typical Spotlight queries have 2–4 words, for which all orders are covered.
 * Longer queries use entered + reverse order to keep the regex bounded while
 * still requiring every word (this metric improves ranking; retrieval remains
 * the full order-independent AND-of-words search).
 */
export function nearbyTokensPattern(tokens: readonly string[]): string | null {
  const unique = [...new Set(tokens.map((t) => foldAccents(t.trim().toLowerCase())).filter(Boolean))];
  if (unique.length === 0) return null;
  const orders = unique.length <= SEARCH_NEARBY_PERMUTATION_LIMIT
    ? tokenPermutations(unique)
    : [unique, [...unique].reverse()];
  const alternatives = orders.map((order) =>
    order.map(accentFoldPattern).join(`.{0,${SEARCH_NEARBY_TOKEN_GAP}}`)
  );
  return `(?:${alternatives.join('|')})`;
}
