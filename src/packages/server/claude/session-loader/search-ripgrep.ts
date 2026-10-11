/**
 * ripgrep 快路径:可用性探测、rg 计数/样本解析与 rg 版检索、OpenCode 库内检索。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log } from './paths.js';
import { getOpencodeDb } from './opencode-db.js';
import { type GlobalSessionInfo, type GlobalSessionSearchMatch, type SessionExtractKind, type SessionExtract, SNIPPETS_PER_SESSION } from './search-types.js';
import { SEARCH_MATCHES_PER_FILE_CAP, SEARCH_CACHE_LINE_LEN_MAX, searchFileCache, entryExtracts, normalizeMessageTimestamp, windowSnippet } from './search-scan.js';
import { planFileSearch, planTokenFileSearch, storeSearchEntry, foldAccents, accentFoldPattern, nearbyTokensPattern } from './search-plan.js';
import { pickExtractsFromLines } from './search-collect.js';
import { searchAllSessionsGeneration, sessionSearchScore, rankSessionMatches } from './search-rank.js';
import { spawn, spawnSync } from 'child_process';

// ── ripgrep engine ───────────────────────────────────────────────────────────
// When rg is on PATH it does the cold scanning: SIMD + all cores make it
// ~10-40× the JS chunk scanner on this corpus (measured 0.1-0.5s vs 2-4.5s).
// The JS scanner remains the fallback engine and the tail-resume path.

let rgAvailableCache: boolean | null = null;

export function isRgAvailable(): boolean {
  if (rgAvailableCache === null) {
    try {
      rgAvailableCache = spawnSync('rg', ['--version'], { timeout: 3000 }).status === 0;
    } catch {
      rgAvailableCache = false;
    }
  }
  return rgAvailableCache;
}

/** Run rg and return stdout ('' on no matches). Null = rg failed to run. */
function runRg(args: string[], timeoutMs = 20_000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // rg exits 0 with matches, 1 with none — both are success here.
      if (code === 0 || code === 1) resolve(Buffer.concat(chunks).toString('utf-8'));
      else resolve(null);
    });
  });
}

/** Parse `rg -c` output (`path:count` per line) into a path → count map. */
export function parseRgCounts(output: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of output.split('\n')) {
    if (!line) continue;
    const sep = line.lastIndexOf(':');
    if (sep <= 0) continue;
    const count = Number(line.slice(sep + 1));
    if (Number.isFinite(count) && count > 0) counts.set(line.slice(0, sep), count);
  }
  return counts;
}

/** How many sample lines pass B asks rg for, per file — enough raw material
 * to pick SNIPPETS_PER_SESSION good extracts (the first hits in a session are
 * often tool output). A cache entry whose totalMatches is within this bound
 * therefore retains its COMPLETE match set and can answer refined queries
 * from memory. */
const RG_SAMPLE_LINES_PER_FILE = 12;

/** Lines the user-prompt pass (B-user) asks for per file. */
const RG_USER_SAMPLE_LINES_PER_FILE = 6;

/** Safety cap on parsed sample lines per file (rg's -m already bounds it). */
const RG_SAMPLE_PARSE_CAP = 32;

/** Parse plain rg output (`path:matched line text`) into path → sample lines.
 * Our absolute session paths contain no ':', so the first colon splits.
 * Lines rg replaced under --max-columns ("[Omitted long matching line]") are
 * dropped — they'd otherwise leak into snippets as literal marker text. */
export function parseRgSampleLines(output: string): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  for (const line of output.split('\n')) {
    if (!line.startsWith('/')) continue;
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const filePath = line.slice(0, sep);
    const text = line.slice(sep + 1);
    if (text.startsWith('[Omitted long')) continue;
    const lines = byPath.get(filePath) ?? [];
    if (lines.length < RG_SAMPLE_PARSE_CAP) lines.push(text);
    byPath.set(filePath, lines);
  }
  return byPath;
}

/**
 * Regex fragment matching JSONL rows that hold text the USER typed, across
 * every harness's line shape (verified against real files):
 *   claude / pi   `"message":{"role":"user","content":"…"}` or
 *                 `…"content":[{"type":"text","text":…` — a user row whose
 *                 content is `[{"tool_use_id"…,"type":"tool_result"…` is a
 *                 tool result, NOT a prompt, and is deliberately excluded;
 *   codex         `"role":"user","content":[{"type":"input_text"…` and the
 *                 event row `"type":"user_message"`;
 *   grok          top-level `"type":"user","content":"…"` / `[{"type":"text"`.
 * Used by pass B-user to pull prompt lines that contain the needle even when
 * the session's first dozen hits are all tool output — the user's own words
 * are the strongest signal of what a conversation is about.
 */
export const RG_USER_PROMPT_MARKER = '"(?:role|type)":"user","content":(?:"|\\[\\{"type":"(?:text|input_text)")|"type":"user_message"';

/** Pattern for "a user-prompt row that also contains the needle" (both
 * orders, so a needle before the marker still qualifies). */
export function userPromptWithNeedlePattern(needlePattern: string): string {
  return `(?:${RG_USER_PROMPT_MARKER}).*(?:${needlePattern})|(?:${needlePattern}).*(?:${RG_USER_PROMPT_MARKER})`;
}

/** Column cap for the snippet RE-sample of files whose first sample lines were
 * ALL over the regular 4096 cap (rg replaces those with an omission marker,
 * which parseRgSampleLines drops — leaving the row with NO snippet). Big tool
 * results and pasted docs routinely run 20–50 KB per JSONL line, so a
 * conversation whose only hits live in them rendered snippet-less: the
 * Spotlight/Session Finder row then showed unrelated fallback text ("ok")
 * with nothing to highlight. Multi-MB attachment lines stay dropped. */
const RG_SAMPLE_LONG_LINE_MAX = 262_144;

/** Lines the long-line fallback asks for per file (each may be ~250 KB). */
const RG_LONG_SAMPLE_LINES_PER_FILE = 5;

/**
 * ripgrep-engined search over the candidate sessions. Two passes:
 *   A) one `rg -c` over every file the cache can't answer → per-file counts
 *      (also learns which files have ZERO matches — that knowledge prunes
 *      every refined query later);
 *   B) `rg -m N` runs over just the displayed top files → sample lines for
 *      readable extracts (user-prompt pass + any-row pass, plus a long-line
 *      fallback) and (small files) the refinement cache.
 * Returns null when rg misbehaves so the caller can use the JS engine.
 */
export async function searchViaRipgrep(
  candidates: GlobalSessionInfo[],
  query: string,
  queryLower: string,
  tokens: string[],
  limit: number,
  generation: number,
): Promise<GlobalSessionSearchMatch[] | null> {
  interface Hit {
    session: GlobalSessionInfo;
    filePath: string;
    totalMatches: number;
    nearbyMatches?: number;
    snippet: string;
    extracts: SessionExtract[];
  }
  const multiToken = tokens.length > 1;
  const nearbyPattern = multiToken ? nearbyTokensPattern(tokens) : null;
  // Snippets for multi-word queries window around the LONGEST word (the most
  // selective one) — proximity samples below make the preview show the words
  // together whenever the session contains a genuine combined mention.
  const snippetNeedle = multiToken ? tokens.reduce((a, b) => (b.length > a.length ? b : a)) : query;
  const snippetNeedleLower = foldAccents(snippetNeedle.toLowerCase());
  const reused: Hit[] = [];
  const toScan: Array<{ session: GlobalSessionInfo; filePath: string; mtimeMs: number }> = [];

  for (const session of candidates) {
    const filePath = session.filePath;
    const mtimeMs = session.lastModified.getTime();
    if (multiToken) {
      const plan = planTokenFileSearch(searchFileCache.get(filePath), queryLower, mtimeMs, session.sizeBytes);
      if (plan) {
        if (plan.totalMatches > 0) reused.push({
          session,
          filePath,
          totalMatches: plan.totalMatches,
          nearbyMatches: plan.nearbyMatches,
          snippet: plan.snippet,
          extracts: plan.extracts,
        });
      } else {
        toScan.push({ session, filePath, mtimeMs });
      }
      continue;
    }
    const plan = planFileSearch(searchFileCache.get(filePath), queryLower, mtimeMs, session.sizeBytes);
    if (plan.kind === 'reuse') {
      if (plan.totalMatches > 0) reused.push({ session, filePath, totalMatches: plan.totalMatches, snippet: plan.snippet, extracts: plan.extracts });
    } else {
      toScan.push({ session, filePath, mtimeMs });
    }
  }

  let counts = new Map<string, number>();
  let nearbyCounts = new Map<string, number>();
  if (toScan.length > 0 && !multiToken) {
    // accentFoldPattern (not --fixed-strings): accent-blind matching — see
    // the fold helpers above.
    const output = await runRg([
      '-i', '-a', '--no-config', '--no-messages', '-c', '--',
      accentFoldPattern(query), ...toScan.map((f) => f.filePath),
    ]);
    if (output === null) return null;
    if (generation !== searchAllSessionsGeneration) return []; // superseded — client discards
    counts = parseRgCounts(output);
  } else if (toScan.length > 0) {
    // AND-of-words: one `rg -c` per word, then intersect — a file qualifies
    // only when EVERY word appears somewhere in it, and its match count is the
    // bottleneck word's count (the honest "at most this many joint hits").
    const perToken: Map<string, number>[] = [];
    for (const token of tokens) {
      const output = await runRg([
        '-i', '-a', '--no-config', '--no-messages', '-c', '--',
        accentFoldPattern(token), ...toScan.map((f) => f.filePath),
      ]);
      if (output === null) return null;
      if (generation !== searchAllSessionsGeneration) return []; // superseded
      perToken.push(parseRgCounts(output));
    }
    for (const f of toScan) {
      let min = Infinity;
      for (const tokenCounts of perToken) {
        const c = tokenCounts.get(f.filePath) ?? 0;
        if (c < min) min = c;
        if (min === 0) break;
      }
      if (min > 0 && Number.isFinite(min)) counts.set(f.filePath, min);
    }

    // Ranking quality: count only lines where ALL words occur close together,
    // in any order. Raw per-word counts are badly inflated by large sessions
    // whose boilerplate/tool logs mention the words in unrelated places.
    if (nearbyPattern) {
      const nearbyOutput = await runRg([
        '-i', '-a', '--no-config', '--no-messages', '-c', '--',
        nearbyPattern, ...toScan.map((f) => f.filePath),
      ]);
      if (nearbyOutput !== null) nearbyCounts = parseRgCounts(nearbyOutput);
      if (generation !== searchAllSessionsGeneration) return []; // superseded
    }
  }

  const all: Hit[] = [
    ...reused,
    ...toScan
      .filter((f) => (counts.get(f.filePath) ?? 0) > 0)
      .map((f) => ({
        session: f.session,
        filePath: f.filePath,
        totalMatches: counts.get(f.filePath) as number,
        nearbyMatches: multiToken ? (nearbyCounts.get(f.filePath) ?? 0) : undefined,
        snippet: '',
        extracts: [] as SessionExtract[],
      })),
  ];
  // Relevance ranking BEFORE the cut — `all` holds every matching session, so
  // the top-`limit` here is exact (snippets are then fetched only for those).
  const rgNow = Date.now();
  all.sort((a, b) =>
    sessionSearchScore(b.totalMatches, b.session.lastModified, rgNow, b.nearbyMatches)
      - sessionSearchScore(a.totalMatches, a.session.lastModified, rgNow, a.nearbyMatches)
    || b.session.lastModified.getTime() - a.session.lastModified.getTime()
  );
  const top = all.slice(0, limit);

  // Pass B — sample lines for the displayed hits that still lack extracts.
  // Two rg runs over the same files, both bounded by -m and the 4096 column
  // cap (over-long lines come back as omission markers the parser drops):
  //   B-user: rows holding text the USER typed that contain the needle —
  //           pulled explicitly because a session's first dozen hits are
  //           usually tool output, and the user's own words are the best
  //           glimpse of what the conversation is about;
  //   B-any:  the first N matching rows of any kind (assistant text, tool
  //           output) — filler for the remaining slots, and (small files)
  //           the refinement cache's retained match set.
  // Both feed one ranked collector per file → ≤ SNIPPETS_PER_SESSION extracts.
  const needLines = top.filter((h) => h.extracts.length === 0).map((h) => h.filePath);
  let samples = new Map<string, string[]>();
  let userSamples = new Map<string, string[]>();
  let nearbyUserSamples = new Map<string, string[]>();
  let nearbySamples = new Map<string, string[]>();
  if (needLines.length > 0) {
    const needlePattern = accentFoldPattern(snippetNeedle);
    const [userOutput, anyOutput] = await Promise.all([
      runRg([
        '-i', '-a', '--no-config', '--no-messages', '--with-filename',
        '--max-columns', '4096', '-m', String(RG_USER_SAMPLE_LINES_PER_FILE), '--',
        userPromptWithNeedlePattern(needlePattern), ...needLines,
      ]),
      runRg([
        '-i', '-a', '--no-config', '--no-messages', '--with-filename',
        '--max-columns', '4096', '-m', String(RG_SAMPLE_LINES_PER_FILE), '--',
        needlePattern, ...needLines,
      ]),
    ]);
    if (userOutput !== null) userSamples = parseRgSampleLines(userOutput);
    if (anyOutput !== null) samples = parseRgSampleLines(anyOutput);

    // For concentrated multi-word hits, prepend lines that contain ALL query
    // words nearby. The preview then explains why the row ranked highly instead
    // of showing a line that contains only the most common individual word.
    const nearbyNeedLines = nearbyPattern
      ? top.filter((h) => h.extracts.length === 0 && (h.nearbyMatches ?? 0) > 0).map((h) => h.filePath)
      : [];
    if (nearbyPattern && nearbyNeedLines.length > 0) {
      const [nearbyUserOutput, nearbyOutput] = await Promise.all([
        // Initial prompts include the injected task instructions and often
        // exceed 4096 columns; allow realistic long user rows so the actual
        // combined request is not replaced by a later one-word follow-up.
        runRg([
          '-i', '-a', '--no-config', '--no-messages', '--with-filename',
          '--max-columns', String(RG_SAMPLE_LONG_LINE_MAX), '-m', String(RG_USER_SAMPLE_LINES_PER_FILE), '--',
          userPromptWithNeedlePattern(nearbyPattern), ...nearbyNeedLines,
        ]),
        runRg([
          '-i', '-a', '--no-config', '--no-messages', '--with-filename',
          '--max-columns', '4096', '-m', String(RG_SAMPLE_LINES_PER_FILE), '--',
          nearbyPattern, ...nearbyNeedLines,
        ]),
      ]);
      if (nearbyUserOutput !== null) nearbyUserSamples = parseRgSampleLines(nearbyUserOutput);
      if (nearbyOutput !== null) nearbySamples = parseRgSampleLines(nearbyOutput);
    }
  }

  const setExtracts = (hit: Hit, lines: readonly string[]) => {
    hit.extracts = pickExtractsFromLines(lines, snippetNeedleLower, multiToken ? tokens : undefined);
    hit.snippet = hit.extracts[0]?.text ?? '';
  };
  for (const hit of top) {
    if (hit.extracts.length > 0) continue;
    // Nearby lines lead so the preview shows the combined concept; user-prompt
    // and generic token samples fill the remaining slots. The collector still
    // ranks user voice above assistant/tool rows and dedupes overlap.
    setExtracts(hit, [
      ...(nearbyUserSamples.get(hit.filePath) ?? []),
      ...(nearbySamples.get(hit.filePath) ?? []),
      ...(userSamples.get(hit.filePath) ?? []),
      ...(samples.get(hit.filePath) ?? []),
    ]);
  }

  // Long-line fallback: a hit whose first N matching lines were ALL over the
  // 4096 column cap got no usable sample (rg emitted only omission markers,
  // which the parser drops) → still no extract. Re-sample just those files
  // with a far larger cap so a 20–50 KB tool result / pasted doc still yields
  // a readable, windowed preview. Only displayed hits pay, only when needed;
  // the retention cache below still uses pass B-any's ≤4096 lines.
  const stillBare = top.filter((h) => h.extracts.length === 0).map((h) => h.filePath);
  if (stillBare.length > 0) {
    const output = await runRg([
      '-i', '-a', '--no-config', '--no-messages', '--with-filename',
      '--max-columns', String(RG_SAMPLE_LONG_LINE_MAX), '-m', String(RG_LONG_SAMPLE_LINES_PER_FILE), '--',
      accentFoldPattern(snippetNeedle), ...stillBare,
    ]);
    if (output !== null) {
      const longSamples = parseRgSampleLines(output);
      for (const hit of top) {
        if (hit.extracts.length > 0) continue;
        setExtracts(hit, longSamples.get(hit.filePath) ?? []);
      }
    }
  }

  // A cache-reused hit that carried NO extracts (it was outside the displayed
  // top when its entry was written, or an older run found no sample) just had
  // them fetched above — write them back so the next keystroke reuses them
  // instead of re-running the sample passes for that file.
  for (const hit of reused) {
    if (hit.extracts.length === 0) continue;
    const entry = searchFileCache.get(hit.filePath)?.find((e) => e.query === queryLower);
    if (entry && entryExtracts(entry).length === 0) {
      entry.extracts = hit.extracts;
      entry.snippet = hit.snippet;
    }
  }

  // Refresh the cache with everything this run learned — zero-match files
  // included (that's the refinement pruning for the next keystrokes).
  const topByPath = new Map(top.map((h) => [h.filePath, h]));
  for (const f of toScan) {
    const totalMatches = counts.get(f.filePath) ?? 0;
    const lines = samples.get(f.filePath);
    // Retained lines must be the COMPLETE, untruncated match set: rg's
    // --max-columns replaces over-long lines with an omission marker, so
    // "every line still contains the query" is the integrity check.
    const matchingLines = totalMatches === 0
      ? []
      : lines !== undefined
          && totalMatches <= RG_SAMPLE_LINES_PER_FILE
          && lines.length >= totalMatches
          && lines.every((l) => l.length <= SEARCH_CACHE_LINE_LEN_MAX && foldAccents(l.toLowerCase()).includes(queryLower))
        ? lines.slice(0, totalMatches)
        : undefined;
    storeSearchEntry(f.filePath, {
      mtimeMs: f.mtimeMs,
      sizeBytes: f.session.sizeBytes,
      query: queryLower,
      totalMatches,
      nearbyMatches: multiToken ? (nearbyCounts.get(f.filePath) ?? 0) : undefined,
      snippet: topByPath.get(f.filePath)?.snippet ?? '',
      extracts: topByPath.get(f.filePath)?.extracts ?? [],
      matchingLines,
    });
  }

  return top.map((h) => ({
    sessionId: h.session.sessionId,
    projectPath: h.session.projectPath,
    projectDir: h.session.projectDir,
    lastModified: h.session.lastModified,
    totalMatches: h.totalMatches,
    nearbyMatches: h.nearbyMatches,
    snippet: h.snippet,
    extracts: h.extracts,
    firstPrompt: h.session.firstPrompt,
    provider: h.session.provider,
  }));
}

/**
 * Search opencode conversations. Opencode stores sessions in a SQLite DB
 * (`part` rows carry the message text as JSON, indexed by session_id) — not
 * per-session files — so they can't ride the rg/JS file engines. One indexed
 * substring pass per word gives the same AND-of-words semantics; counts
 * intersect via the bottleneck word (min), then same-part proximity improves
 * topical ranking just like the file engines.
 */
export function searchOpencodeSessions(tokens: string[], limit: number, cwdFilter?: string): GlobalSessionSearchMatch[] {
  const db = getOpencodeDb();
  if (!db || tokens.length === 0) return [];
  try {
    // length() guard: giant parts are base64 image payloads (screenshots,
    // read-image outputs) where case-insensitive LIKE matches short words by
    // pure chance ("PoEm" occurs in random base64) — count only realistic
    // text-sized parts.
    let combined: Map<string, number> | null = null;
    for (const token of tokens) {
      // instr(tc_fold(...)) instead of LIKE: accent-blind substring match.
      // The leading-wildcard LIKE was already a full scan, so the UDF does
      // not change the asymptotics — the length() guard bounds the work.
      const rows = db
        .prepare('SELECT session_id AS sid, COUNT(*) AS c FROM part WHERE length(data) < 65536 AND instr(tc_fold(data), ?) > 0 GROUP BY session_id')
        .all(token) as Array<{ sid: string; c: number }>;
      const counts = new Map(rows.map((r) => [r.sid, r.c]));
      if (combined === null) {
        combined = counts;
      } else {
        for (const [sid, c] of combined) {
          const other = counts.get(sid) ?? 0;
          if (other === 0) combined.delete(sid);
          else combined.set(sid, Math.min(c, other));
        }
      }
      if (combined.size === 0) return [];
    }
    if (!combined) return [];

    // Count parts where all words are genuinely nearby. OpenCode has one JSON
    // value per message part rather than JSONL files, so prefilter in SQLite
    // (all tokens in the part) and apply the same bounded-distance regex in JS.
    const nearbyBySession = new Map<string, number>();
    const nearbyPattern = tokens.length > 1 ? nearbyTokensPattern(tokens) : null;
    if (nearbyPattern) {
      const where = tokens.map(() => 'instr(tc_fold(data), ?) > 0').join(' AND ');
      const rows = db
        .prepare(`SELECT session_id AS sid, data FROM part WHERE length(data) < 65536 AND ${where}`)
        .all(...tokens) as Array<{ sid: string; data: string }>;
      const matcher = new RegExp(nearbyPattern, 'i');
      for (const row of rows) {
        if (!combined.has(row.sid) || !matcher.test(row.data)) continue;
        const current = nearbyBySession.get(row.sid) ?? 0;
        if (current < SEARCH_MATCHES_PER_FILE_CAP) nearbyBySession.set(row.sid, current + 1);
      }
    }

    // Snippets window around the longest (most selective) word. Prefer TEXT
    // parts (real conversation) — the word often also hits tool-output parts
    // whose JSON has no `.text` to show.
    const snippetNeedle = tokens.reduce((a, b) => (b.length > a.length ? b : a));
    const sessionStmt = db.prepare('SELECT id, directory, title, time_updated FROM session WHERE id = ? LIMIT 1');
    // Text parts joined to their message so each extract knows WHO said it
    // (opencode keeps the role on the message row, not the part). Ordered
    // user-first so prompts take the top slots, like the JSONL engines.
    const textPartStmt = db.prepare(
      'SELECT p.data AS data, m.data AS mdata, p.time_created AS timeCreated FROM part p LEFT JOIN message m ON m.id = p.message_id '
      + 'WHERE p.session_id = ? AND length(p.data) < 65536 AND instr(tc_fold(p.data), ?) > 0 AND p.data LIKE \'%"type":"text"%\' '
      + 'ORDER BY CASE WHEN m.data LIKE \'%"role":"user"%\' THEN 0 ELSE 1 END, p.time_created LIMIT 8'
    );
    const anyPartStmt = db.prepare('SELECT data FROM part WHERE session_id = ? AND length(data) < 65536 AND instr(tc_fold(data), ?) > 0 LIMIT 1');
    const out: GlobalSessionSearchMatch[] = [];
    for (const [sid, totalMatches] of combined) {
      const session = sessionStmt.get(sid) as { id: string; directory: string | null; title: string | null; time_updated: number } | undefined;
      if (!session) continue;
      const directory = session.directory ?? '';
      if (cwdFilter && !directory.toLowerCase().includes(cwdFilter)) continue;
      const needleParam = snippetNeedle;
      // Up to SNIPPETS_PER_SESSION distinct text-part extracts, user prompts
      // first (see the ORDER BY), each tagged with its message's role;
      // raw-part fallback when no text part holds the word.
      const extracts: SessionExtract[] = [];
      for (const row of textPartStmt.all(sid, needleParam) as Array<{
        data: string;
        mdata: string | null;
        timeCreated: number | string | null;
      }>) {
        if (extracts.length >= SNIPPETS_PER_SESSION) break;
        try {
          const data = JSON.parse(row.data) as { text?: unknown };
          if (typeof data.text === 'string' && data.text.trim()) {
            const text = windowSnippet(data.text, snippetNeedle);
            if (text && !extracts.some((e) => e.text === text)) {
              let kind: SessionExtractKind = 'assistant';
              try {
                const role = row.mdata ? (JSON.parse(row.mdata) as { role?: unknown }).role : undefined;
                if (role === 'user') kind = 'user';
              } catch { /* role unknown — keep assistant */ }
              const timestamp = normalizeMessageTimestamp(row.timeCreated);
              extracts.push({ text, kind, ...(timestamp ? { timestamp } : {}) });
            }
          }
        } catch { /* unparseable part — try the next */ }
      }
      if (extracts.length === 0) {
        const row = anyPartStmt.get(sid, needleParam) as { data: string } | undefined;
        if (row) extracts.push({ text: windowSnippet(row.data, snippetNeedle), kind: 'raw' });
      }
      out.push({
        sessionId: sid,
        projectPath: directory,
        projectDir: 'opencode',
        lastModified: new Date(session.time_updated),
        totalMatches,
        nearbyMatches: tokens.length > 1 ? (nearbyBySession.get(sid) ?? 0) : undefined,
        snippet: extracts[0]?.text ?? '',
        extracts,
        firstPrompt: session.title ?? '',
        provider: 'opencode',
      });
    }
    rankSessionMatches(out);
    return out.slice(0, limit);
  } catch (err) {
    log.warn(`opencode session search failed: ${String(err)}`);
    return [];
  }
}
