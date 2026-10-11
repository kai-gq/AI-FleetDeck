/**
 * exec 包裹命令与 curl 载荷提取、展示截断、任务行匹配。
 *
 * 自 utils/outputRendering.ts 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

/**
 * Split a shell command line into words the way POSIX sh does — single
 * quotes (no escapes inside), double quotes (backslash escapes `"` `\\` `$`
 * `` ` `` and newline), unquoted backslash escapes / line continuations,
 * `$'…'` ANSI-C quoting (basic escapes), and ADJACENT-SEGMENT CONCATENATION:
 * `'{"a":"x'\''y"}'` is ONE word whose value is `{"a":"x'y"}` — the idiom
 * agents use to put a literal single quote inside a single-quoted curl body.
 * Best-effort: no expansions, an unterminated quote consumes to the end.
 */
export function shellSplitWords(cmd: string): string[] {
  const words: string[] = [];
  let cur = '';
  let started = false;
  let i = 0;
  const n = cmd.length;
  const push = () => {
    if (started) words.push(cur);
    cur = '';
    started = false;
  };
  while (i < n) {
    const ch = cmd[i];
    if (ch === "'" ) {
      started = true;
      const end = cmd.indexOf("'", i + 1);
      cur += end === -1 ? cmd.slice(i + 1) : cmd.slice(i + 1, end);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === '$' && cmd[i + 1] === "'") {
      // ANSI-C quoting: $'…' with backslash escapes.
      started = true;
      i += 2;
      while (i < n && cmd[i] !== "'") {
        if (cmd[i] === '\\' && i + 1 < n) {
          const e = cmd[i + 1];
          cur += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          i += 2;
        } else {
          cur += cmd[i++];
        }
      }
      i++; // closing quote
      continue;
    }
    if (ch === '"') {
      started = true;
      i++;
      while (i < n && cmd[i] !== '"') {
        if (cmd[i] === '\\' && i + 1 < n) {
          const e = cmd[i + 1];
          if (e === '"' || e === '\\' || e === '$' || e === '`') { cur += e; i += 2; continue; }
          if (e === '\n') { i += 2; continue; } // line continuation
          cur += cmd[i++]; // literal backslash
          continue;
        }
        cur += cmd[i++];
      }
      i++; // closing quote
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < n) {
        if (cmd[i + 1] === '\n') { i += 2; continue; } // line continuation
        started = true;
        cur += cmd[i + 1];
        i += 2;
        continue;
      }
      started = true;
      cur += ch;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      push();
      i++;
      continue;
    }
    started = true;
    cur += ch;
    i++;
  }
  push();
  return words;
}

/** curl request bodies among shell words: `-d X`, `-dX`, `--data(-raw|-binary|-ascii)[= ]X`, `--json X`.
 * `@file` / `@-` bodies are skipped (heredoc bodies are recovered separately). */
function curlDataBodiesFromWords(words: string[]): string[] {
  const out: string[] = [];
  const dataFlags = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--json']);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (dataFlags.has(w)) {
      const v = words[i + 1];
      if (v !== undefined && !v.startsWith('@')) out.push(v);
      i++;
      continue;
    }
    const eq = /^--(?:data|data-raw|data-binary|data-ascii|json)=([\s\S]*)$/.exec(w);
    if (eq) {
      if (!eq[1].startsWith('@')) out.push(eq[1]);
      continue;
    }
    if (w.length > 2 && w.startsWith('-d') && !w.startsWith('--')) {
      const v = w.slice(2);
      if (!v.startsWith('@')) out.push(v);
    }
  }
  return out;
}

export function extractExecPayloadCommand(cmd: string): string | null {
  if (!cmd.includes('curl') || !cmd.includes('/api/exec')) return null;

  const candidates: string[] = [];

  // Preferred: read the `-d` body the way the SHELL passes it (quotes resolved,
  // adjacent segments concatenated) — this yields the exact JSON the server
  // received, so the terminal row can match its ExecTask by inner command.
  // Also descend one level into a wrapper word (`zsh -lc "curl … -d '…'"`).
  const words = shellSplitWords(cmd);
  candidates.push(...curlDataBodiesFromWords(words));
  for (const w of words) {
    if (w !== cmd && w.includes('curl') && w.includes('/api/exec')) {
      candidates.push(...curlDataBodiesFromWords(shellSplitWords(w)));
    }
  }

  const patterns = [
    /(?:-d|--data|--data-raw)\s+'((?:\\'|[^'])*)'/g,
    /(?:-d|--data|--data-raw)\s+"((?:\\"|[^"])*)"/g,
  ];

  for (const regex of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cmd)) !== null) {
      if (match[1]) candidates.push(match[1]);
    }
  }

  // Agents also use a quoted heredoc when the JSON contains enough shell
  // metacharacters that an inline `-d '...'` becomes awkward:
  //
  //   curl ... -d @- <<'EOF'
  //   {"command":"npm test"}
  //   EOF
  //
  // Recovering this body matters beyond presentation: it lets the terminal row
  // match the websocket ExecTask by its exact inner command and attach the live
  // command-output component instead of relying on a narrow timestamp window.
  const heredocPattern = /(?:-d|--data|--data-raw|--data-binary)\s+@-\s*<<(-)?\s*(?:'([^'\r\n]+)'|"([^"\r\n]+)"|([^\s'"\r\n;&|]+))[^\r\n]*(?:\r?\n|$)/g;
  let heredocMatch: RegExpExecArray | null;
  while ((heredocMatch = heredocPattern.exec(cmd)) !== null) {
    const stripLeadingTabs = heredocMatch[1] === '-';
    const delimiter = heredocMatch[2] || heredocMatch[3] || heredocMatch[4];
    if (!delimiter) continue;

    const bodyStart = heredocPattern.lastIndex;
    let lineStart = bodyStart;
    while (lineStart <= cmd.length) {
      const newline = cmd.indexOf('\n', lineStart);
      const lineEnd = newline === -1 ? cmd.length : newline;
      let line = cmd.slice(lineStart, lineEnd).replace(/\r$/, '');
      if (stripLeadingTabs) line = line.replace(/^\t+/, '');
      if (line === delimiter) {
        candidates.push(cmd.slice(bodyStart, lineStart).replace(/\r?\n$/, ''));
        break;
      }
      if (newline === -1) break;
      lineStart = newline + 1;
    }
  }

  for (const raw of candidates) {
    const attempts = [
      raw,
      raw.replace(/\\"/g, '"'),
      raw.replace(/\\'/g, '\''),
      raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
    ];
    for (const attempt of attempts) {
      const trimmed = attempt.trim();
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
      try {
        const parsed = JSON.parse(trimmed) as { command?: unknown };
        if (typeof parsed.command === 'string' && parsed.command.length > 0) {
          return parsed.command;
        }
      } catch {
        // Keep trying with the next variant.
      }
    }
  }

  return null;
}

/**
 * `\bcurl\b[\s\S]*<path>` without the regex: on a long command (a heredoc
 * writing a file full of "curl" words) the greedy `[\s\S]*` backtracks the
 * whole string once per `curl` occurrence — O(n·k), tens of ms per row
 * render. Same truth table: some word `curl` before some `<path>` occurrence
 * whose next char passes `boundary` (default: not a word char, i.e. `\b`).
 */
export function isCurlCommandTo(
  cmd: string,
  path: string,
  boundary: (nextChar: string) => boolean = (c) => !/[A-Za-z0-9_]/.test(c),
): boolean {
  let from = 0;
  for (;;) {
    const idx = cmd.indexOf(path, from);
    if (idx === -1) return false;
    if (boundary(cmd.charAt(idx + path.length)) && /\bcurl\b/.test(cmd.slice(0, idx))) return true;
    from = idx + path.length;
  }
}

/** Display cap for the one-line command chip: the row ellipsizes to a single
 * line, so highlighting + link-splitting a 100 KB heredoc (and setting it as
 * a `title` tooltip) only builds hidden DOM. Cuts on a whitespace boundary so
 * no half-path becomes a clickable link; the click/modal keeps the full text. */
export const BASH_COMMAND_DISPLAY_MAX = 1200;

export function bashCommandDisplaySlice(cmd: string, max: number = BASH_COMMAND_DISPLAY_MAX): string {
  if (cmd.length <= max) return cmd;
  const head = cmd.slice(0, max);
  const cut = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(' '), head.lastIndexOf('\t'));
  return `${cut > max * 0.5 ? head.slice(0, cut) : head} …`;
}

/**
 * If this is a curl /api/exec wrapper command, return the wrapped inner command.
 * Otherwise returns the original command.
 */
export function extractExecWrappedCommand(cmd: string): string {
  return extractExecPayloadCommand(cmd) || cmd;
}

/** Time-window fallback for matching a `curl … /api/exec` row to its ExecTask
 * when the body can't be parsed: the exec starts right after the tool_start
 * row is stamped (both server clock), so a small negative slack covers
 * ordering jitter and a few seconds of positive slack covers a slow spawn. */
const EXEC_MATCH_WINDOW_BEFORE_MS = 2_000;

const EXEC_MATCH_WINDOW_AFTER_MS = 10_000;

/**
 * Pick the ExecTask (streamed `/api/exec` run) that a terminal `curl …
 * /api/exec` row spawned, so its live card renders under that row.
 *
 * 0. Identity: the server pairs each exec with the Bash tool call that issued
 *    the curl (`task.toolUseId` === the row's tool_use id) — no parsing, no
 *    clocks. This is the path that always works when the server saw the call.
 * 1. Exact match on the inner command (the shell-resolved `-d` body's
 *    `command` equals the task's command as the server received it) — most
 *    recent wins when the same command ran several times.
 * 2. Otherwise the most recent task that started within the time window
 *    around the row's timestamp. Both timestamps are in the SERVER clock
 *    domain (rows are server-stamped; tasks carry the server's startedAt).
 *
 * Shared by OutputLine (live) and HistoryLine (reloaded) — the two renderers
 * must agree or a card that showed live disappears after a reload.
 */
export function findExecTaskForCurlRow<T extends { command: string; startedAt: number; toolUseId?: string }>(
  execTasks: readonly T[],
  bashCommand: string,
  rowTimestampMs: number,
  rowToolUseId?: string,
): T | undefined {
  if (execTasks.length === 0) return undefined;
  const newest = (tasks: T[]) => tasks.reduce((latest, cur) => (cur.startedAt > latest.startedAt ? cur : latest));
  // Closest-in-time beats newest for the heuristics: when the SAME command ran
  // twice, "newest wins" attached BOTH rows to the second task (two cards
  // showing identical output). Each row pairs with the task that started
  // nearest its own timestamp instead.
  const closest = (tasks: T[]) => tasks.reduce((best, cur) => (
    Math.abs(cur.startedAt - rowTimestampMs) < Math.abs(best.startedAt - rowTimestampMs) ? cur : best
  ));
  if (rowToolUseId) {
    const byId = execTasks.filter((t) => t.toolUseId === rowToolUseId);
    if (byId.length > 0) return newest(byId);
  }
  // Tasks identity-claimed by a DIFFERENT tool call likely belong to other
  // rows — prefer unclaimed ones (a re-run of the same command must not put
  // one task under two rows). Rows without an id can't reason about claims,
  // so they keep the full set.
  const unclaimed = rowToolUseId ? execTasks.filter((t) => !t.toolUseId) : [...execTasks];
  const inner = extractExecPayloadCommand(bashCommand);
  if (inner) {
    const byCommand = unclaimed.filter((t) => t.command === inner);
    if (byCommand.length > 0) return rowTimestampMs ? closest(byCommand) : newest(byCommand);
    // Exact inner-command equality is strong identity — when the id pairing
    // missed (a row whose uuid differs from the tool_use id the server
    // registered), a claimed task must still be matchable, or it becomes an
    // orphan NO row can ever render. Closest-in-time keeps re-runs of the
    // same command on their own rows.
    const byCommandClaimed = execTasks.filter((t) => t.toolUseId && t.toolUseId !== rowToolUseId && t.command === inner);
    if (byCommandClaimed.length > 0) return rowTimestampMs ? closest(byCommandClaimed) : newest(byCommandClaimed);
  }
  // The time-window fallback is weak evidence — claimed tasks stay excluded.
  if (!rowTimestampMs || unclaimed.length === 0) return undefined;
  const inWindow = unclaimed.filter(
    (t) => t.startedAt >= rowTimestampMs - EXEC_MATCH_WINDOW_BEFORE_MS && t.startedAt <= rowTimestampMs + EXEC_MATCH_WINDOW_AFTER_MS,
  );
  return inWindow.length > 0 ? closest(inWindow) : undefined;
}
