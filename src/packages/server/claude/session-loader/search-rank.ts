/**
 * 检索排序与总入口:代次防超发、时效衰减评分、合并与 searchAllSessions。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { listAllSessions } from './session-headers.js';
import { type GlobalSessionSearchMatch, type SessionExtract, SNIPPETS_PER_SESSION } from './search-types.js';
import { SEARCH_CACHE_LINES_MAX, searchFileCache } from './search-scan.js';
import { planFileSearch, planTokenFileSearch, storeSearchEntry, foldAccents, nearbyTokensPattern } from './search-plan.js';
import { scanSessionFileForQuery, countSessionFileNearbyMatches } from './search-collect.js';
import { isRgAvailable, searchViaRipgrep, searchOpencodeSessions } from './search-ripgrep.js';
import * as fs from 'fs';

/** Bumped by every searchAllSessions call; in-flight workers of an older
 * generation stop scheduling new files (their partial response is discarded by
 * the client's seq guard anyway). */
export let searchAllSessionsGeneration = 0;

/**
 * Relevance score for a session search hit. Pure newest-first ordering buried
 * topical sessions under fresher ones with a single incidental mention (a
 * 10-hit conversation from two days ago lost to five 1-hit sessions from
 * today and fell past Spotlight's display cap, so "conciliación pase" never
 * surfaced the agent that owned the topic).
 *
 * Multi-word searches need one more signal: raw per-token counts explode in
 * long sessions full of repeated prompts, source listings, and hook output.
 * A session where all words occur near each other is a combined-concept hit;
 * one where they only occur in distant lines is merely an AND-retrieval hit.
 * The former gets a dominant tier, then count × recency ranks within that tier.
 * Single-word scoring remains unchanged.
 */
const SEARCH_RECENCY_HALF_LIFE_DAYS = 7;

export function sessionSearchScore(
  totalMatches: number,
  lastModified: Date,
  now: number,
  nearbyMatches?: number,
): number {
  const ageDays = Math.max(0, (now - lastModified.getTime()) / 86_400_000);
  const decay = Math.exp((-Math.LN2 * ageDays) / SEARCH_RECENCY_HALF_LIFE_DAYS);
  const recencyWeight = 0.5 + decay;
  const rawScore = Math.log2(1 + Math.max(1, totalMatches)) * recencyWeight;
  if (nearbyMatches === undefined) return rawScore;
  // Multi-word words found only in unrelated parts remain discoverable, but
  // cannot bury a genuine combined mention merely because the file is huge.
  if (nearbyMatches <= 0) return rawScore * 0.2;
  const nearbyScore = Math.log2(1 + nearbyMatches) * recencyWeight;
  return 20 + nearbyScore + rawScore * 0.1;
}

/** Sort matches by sessionSearchScore (best first), newest-first on ties. In place. */
export function rankSessionMatches<
  T extends { totalMatches: number; nearbyMatches?: number; lastModified: Date }
>(matches: T[]): T[] {
  const now = Date.now();
  return matches.sort((a, b) =>
    sessionSearchScore(b.totalMatches, b.lastModified, now, b.nearbyMatches)
      - sessionSearchScore(a.totalMatches, a.lastModified, now, a.nearbyMatches)
    || b.lastModified.getTime() - a.lastModified.getTime()
  );
}

/** Merge file-engine and DB matches, best-ranked first, capped. */
function mergeSessionMatches(
  a: GlobalSessionSearchMatch[],
  b: GlobalSessionSearchMatch[],
  limit: number,
): GlobalSessionSearchMatch[] {
  if (b.length === 0) return a.slice(0, limit);
  if (a.length === 0) return b.slice(0, limit);
  const merged = [...a, ...b];
  rankSessionMatches(merged);
  return merged.slice(0, limit);
}

/**
 * Full-text search every Claude session for `query`.
 *
 * Fast paths layered on top of the raw scan (which is O(corpus) and the corpus
 * grows forever): cached headers (listAllSessions), per-file result cache with
 * query-refinement pruning (planFileSearch), a ripgrep cold-scan engine when
 * available (single process, all cores), chunked JS scanning as the fallback,
 * and early termination — sessions are scheduled newest-first and collection
 * stops at 3× the requested limit; the final relevance ranking
 * (sessionSearchScore: nearby all-word evidence + count × recency) then picks
 * the top `limit` from that window, so a topical multi-hit session beats fresher
 * one-hit ones without the scan having to visit the whole corpus.
 */
export async function searchAllSessions(
  query: string,
  options?: {
    limit?: number;            // cap returned sessions (default 100)
    cwdFilter?: string;        // only search sessions whose recovered cwd contains this substring
  }
): Promise<GlobalSessionSearchMatch[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  // Folded once here — every engine below matches accent-blind against it
  // (cache keys therefore store folded queries, keeping refinement sound).
  const queryLower = foldAccents(trimmed.toLowerCase());
  // AND-of-words: a multi-word query matches a session when EVERY word appears
  // somewhere in it — each word on its own line if need be ("jira krunner" =
  // sessions mentioning both), which a literal phrase search cannot do.
  const tokens = queryLower.split(/\s+/).filter(Boolean);
  const multiToken = tokens.length > 1;
  const limit = options?.limit ?? 100;
  const cwdFilter = options?.cwdFilter?.toLowerCase();

  // Stale-search cancelation: while the user types, each keystroke supersedes
  // the in-flight scan; without this, overlapping searches keep burning IO on
  // results the client will discard (it seq-guards responses).
  const generation = ++searchAllSessionsGeneration;

  // Corpus window: how many newest sessions the search considers. The real
  // corpus (claude + grok + codex + pi files) already exceeds 2.5k — the old
  // 1000 cap silently hid every older conversation from Past Conversations.
  // rg chews through the full set fine, and header enrichment is cached per
  // file, so only the first cold search pays for the wider window.
  const sessions = await listAllSessions({ limit: 5000 });
  const candidates = cwdFilter
    ? sessions.filter((s) => s.projectPath.toLowerCase().includes(cwdFilter))
    : sessions;

  // Opencode sessions live in SQLite, outside the file corpus — searched
  // separately (cheap indexed LIKE) and merged into either engine's results.
  const opencodeMatches = searchOpencodeSessions(tokens, limit, cwdFilter);

  if (isRgAvailable()) {
    const viaRg = await searchViaRipgrep(candidates, trimmed, queryLower, tokens, limit, generation);
    if (viaRg !== null) return mergeSessionMatches(viaRg, opencodeMatches, limit);
    // rg hiccup — fall through to the JS engine.
  }

  const out: GlobalSessionSearchMatch[] = [];
  const concurrency = 10;
  // Collect a wider window than the display cap: files are visited newest-
  // first, but the final order is relevance-ranked, so an older topical
  // session inside the window can still beat a fresh one-hit session.
  const collectCap = limit * 3;
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push((async () => {
      while (true) {
        if (generation !== searchAllSessionsGeneration) break; // superseded
        if (out.length >= collectCap) break; // see early-termination note above
        const idx = cursor++;
        if (idx >= candidates.length) break;
        const session = candidates[idx];
        const filePath = session.filePath;
        const mtimeMs = session.lastModified.getTime();

        // Multi-word queries: scan per word (longest/most-selective first so
        // misses bail early and the snippet comes from the specific word),
        // AND-combine via the minimum count. The phrase cache's tail/refine
        // machinery is unsound for word semantics — see planTokenFileSearch.
        if (multiToken) {
          const tokenPlan = planTokenFileSearch(searchFileCache.get(filePath), queryLower, mtimeMs, session.sizeBytes);
          let tokenResult = tokenPlan;
          if (!tokenResult) {
            let minMatches = Infinity;
            let extracts: SessionExtract[] = [];
            let proximitySourceLines: string[] | undefined;
            let unreadable = false;
            for (const token of [...tokens].sort((a, b) => b.length - a.length)) {
              let scan: Awaited<ReturnType<typeof scanSessionFileForQuery>>;
              try {
                scan = await scanSessionFileForQuery(filePath, token);
              } catch {
                unreadable = true;
                break;
              }
              if (scan.totalMatches === 0) {
                minMatches = 0;
                extracts = [];
                break;
              }
              minMatches = Math.min(minMatches, scan.totalMatches);
              if (extracts.length === 0) {
                extracts = scan.extracts;
                // This is the complete set of lines containing the longest
                // token when it fits the retention bound. Every proximity hit
                // must be in this set, so avoid another file pass when possible.
                proximitySourceLines = scan.matchingLines;
              }
            }
            if (unreadable) continue; // skip file, cache nothing
            const totalMatches = Number.isFinite(minMatches) ? minMatches : 0;
            let nearbyMatches = 0;
            if (totalMatches > 0) {
              const pattern = nearbyTokensPattern(tokens);
              if (pattern && proximitySourceLines) {
                const matcher = new RegExp(pattern, 'i');
                nearbyMatches = proximitySourceLines.filter((line) => matcher.test(line)).length;
              } else {
                try {
                  nearbyMatches = await countSessionFileNearbyMatches(filePath, tokens);
                } catch {
                  unreadable = true;
                }
              }
            }
            if (unreadable) continue;
            tokenResult = { totalMatches, nearbyMatches, snippet: extracts[0]?.text ?? '', extracts };
            storeSearchEntry(filePath, {
              mtimeMs,
              sizeBytes: session.sizeBytes,
              query: queryLower,
              totalMatches: tokenResult.totalMatches,
              nearbyMatches: tokenResult.nearbyMatches,
              snippet: tokenResult.snippet,
              extracts: tokenResult.extracts,
            });
          }
          if (tokenResult.totalMatches > 0) {
            out.push({
              sessionId: session.sessionId,
              projectPath: session.projectPath,
              projectDir: session.projectDir,
              lastModified: session.lastModified,
              totalMatches: tokenResult.totalMatches,
              nearbyMatches: tokenResult.nearbyMatches,
              snippet: tokenResult.snippet,
              extracts: tokenResult.extracts,
              firstPrompt: session.firstPrompt,
              provider: session.provider,
            });
          }
          continue;
        }

        const plan = planFileSearch(searchFileCache.get(filePath), queryLower, mtimeMs, session.sizeBytes);
        let result: { totalMatches: number; snippet: string; extracts: SessionExtract[] };
        if (plan.kind === 'reuse') {
          result = plan;
        } else {
          let scan: Awaited<ReturnType<typeof scanSessionFileForQuery>>;
          try {
            scan = await scanSessionFileForQuery(
              filePath,
              trimmed,
              plan.kind === 'tail' ? plan.startByte : undefined,
            );
          } catch {
            continue; // unreadable — skip
          }
          const head = plan.kind === 'tail'
            ? plan.head
            : { totalMatches: 0, snippet: '', extracts: [] as SessionExtract[], matchingLines: [] as string[] | undefined };
          // Extracts: the cached head's first, topped up (deduped by text)
          // from the freshly scanned tail — a streaming session keeps its
          // extracts stable while new hits still get a slot when there is room.
          const mergedExtracts = [...head.extracts];
          for (const ex of scan.extracts) {
            if (mergedExtracts.length >= SNIPPETS_PER_SESSION) break;
            if (!mergedExtracts.some((m) => m.text === ex.text)) mergedExtracts.push(ex);
          }
          const merged = {
            totalMatches: head.totalMatches + scan.totalMatches,
            snippet: mergedExtracts[0]?.text ?? '',
            extracts: mergedExtracts,
            matchingLines:
              head.matchingLines && scan.matchingLines
                && head.matchingLines.length + scan.matchingLines.length <= SEARCH_CACHE_LINES_MAX
                ? [...head.matchingLines, ...scan.matchingLines]
                : undefined,
          };
          // Resume bookkeeping: where EOF sat when this scan finished. Stat
          // AFTER the read so an append landing mid-scan re-tails next time
          // instead of being skipped forever.
          let scannedBytes: number | undefined;
          if (scan.reachedEof) {
            try { scannedBytes = fs.statSync(filePath).size; } catch { /* keep undefined */ }
          }
          storeSearchEntry(filePath, {
            mtimeMs,
            sizeBytes: session.sizeBytes,
            query: queryLower,
            totalMatches: merged.totalMatches,
            snippet: merged.snippet,
            extracts: merged.extracts,
            matchingLines: merged.matchingLines,
            scannedBytes,
          });
          result = merged;
        }

        if (result.totalMatches > 0) {
          out.push({
            sessionId: session.sessionId,
            projectPath: session.projectPath,
            projectDir: session.projectDir,
            lastModified: session.lastModified,
            totalMatches: result.totalMatches,
            snippet: result.snippet,
            extracts: result.extracts,
            firstPrompt: session.firstPrompt,
            provider: session.provider,
          });
        }
      }
    })());
  }
  await Promise.all(workers);

  rankSessionMatches(out);
  return mergeSessionMatches(out.slice(0, limit), opencodeMatches, limit);
}
