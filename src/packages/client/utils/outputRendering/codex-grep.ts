/**
 * Codex grep 结果解析(搜索命令词法 → 结构化 matches)。
 *
 * 自 utils/outputRendering.ts 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { normalizeShellWrapper } from './internal';
import { getCodexExecCommand } from './codex';

export interface CodexGrepMatch { path: string; line: number; text: string }

export interface CodexGrepResults { query: string; matches: CodexGrepMatch[] }

const GREP_OPTIONS_WITH_VALUE = new Set([
  '-A', '-B', '-C', '-f', '-g', '-m', '-T', '-t',
  '--after-context', '--before-context', '--context', '--file', '--glob',
  '--iglob', '--max-count', '--type', '--type-not',
]);

// Enough shell tokenization for generated rg/grep commands: preserve quoted
// phrases and escaped spaces without attempting to execute or fully parse
// shell syntax.
function tokenizeGrepCommand(command: string): string[] {
  const tokens: string[] = [];
  const tokenPattern = /(?:^|\s)(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+))/g;
  let tokenMatch: RegExpExecArray | null;
  while ((tokenMatch = tokenPattern.exec(command)) !== null) {
    const token = tokenMatch[1] ?? tokenMatch[2] ?? tokenMatch[3] ?? '';
    tokens.push(token.replace(/\\([\\"'\s])/g, '$1'));
  }
  return tokens;
}

function extractGrepQuery(command: string): string {
  const tokens = tokenizeGrepCommand(command);
  const commandIndex = tokens.findIndex((token) => /(?:^|\/)(?:rg|grep)$/.test(token));
  if (commandIndex < 0) return '';

  for (let index = commandIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') return tokens[index + 1] || '';
    if (token === '-e' || token === '--regexp') return tokens[index + 1] || '';
    if (token.startsWith('--regexp=')) return token.slice('--regexp='.length);
    if (GREP_OPTIONS_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token;
  }
  return '';
}

// rg/grep drop the path prefix from output lines (`line:text`) when given
// exactly one explicit file target — recover that target from the command so
// those lines can still be attributed to a clickable file. Returns '' when
// there are zero or several targets (their output keeps the path prefix).
function extractGrepSingleFileTarget(command: string): string {
  const tokens = tokenizeGrepCommand(command);
  const commandIndex = tokens.findIndex((token) => /(?:^|\/)(?:rg|grep)$/.test(token));
  if (commandIndex < 0) return '';

  const targets: string[] = [];
  let sawQuery = false;
  for (let index = commandIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    // A shell operator ends this command's argument list (`| head`,
    // `2>/dev/null`, `&& …`, `; …`).
    if (/^(?:\||&|;|[012]?>)/.test(token)) break;
    if (token === '--') continue;
    if (token === '-e' || token === '--regexp') {
      index += 1;
      sawQuery = true;
      continue;
    }
    if (token.startsWith('--regexp=')) {
      sawQuery = true;
      continue;
    }
    if (GREP_OPTIONS_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-') && token.length > 1) continue;
    // First positional argument is the pattern; the rest are search targets.
    if (!sawQuery) {
      sawQuery = true;
      continue;
    }
    targets.push(token);
  }
  if (targets.length !== 1 || targets[0] === '.' || targets[0].endsWith('/')) return '';
  return targets[0];
}

/** Parse an rg/grep exec command and its captured output for the results modal. */
export function parseCodexGrepResults(input: unknown, output?: string): CodexGrepResults | null {
  const inputRecord = input && typeof input === 'object'
    ? input as Record<string, unknown>
    : null;
  const directCommand = input && typeof input === 'object' && typeof (input as Record<string, unknown>).command === 'string'
    ? String((input as Record<string, unknown>).command)
    : '';
  const command = getCodexExecCommand(input) || directCommand;
  const normalized = normalizeShellWrapper(command);
  // Claude's native Grep tool sends `{ pattern, path, output_mode, ... }`
  // rather than a shell command. Prefer that explicit pattern when present.
  const nativePattern = typeof inputRecord?.pattern === 'string' ? inputRecord.pattern : '';
  const query = (nativePattern || extractGrepQuery(normalized)).trim();
  if (!query) return null;

  let searchable = output || '';
  try {
    const parsed = JSON.parse(searchable) as unknown;
    const strings: string[] = [];
    const collect = (value: unknown) => {
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(collect);
    };
    collect(parsed);
    searchable = strings.join('\n');
  } catch { /* plain tool output */ }
  searchable = searchable
    .replace(/\\n/g, '\n')
    // ANSI color flags occasionally leak into captured rg output and break
    // the path/line matcher.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

  const matches: CodexGrepMatch[] = [];
  const nativePath = typeof inputRecord?.path === 'string' ? inputRecord.path : '';
  // Searches against a single file return line:text with no path prefix — the
  // missing filename comes from the native Grep input path or, for shell
  // commands, the command's lone file argument.
  const scopedPath = nativePath || extractGrepSingleFileTarget(normalized);
  for (const line of searchable.split('\n')) {
    // Normal rg format: path:line:text. With context flags, rg uses `-` as
    // the separator. Try the scoped line:text form first so separators inside
    // the matched text cannot be misread as a path split.
    const scopedMatch = scopedPath ? line.match(/^(\d+):(.*)$/) : null;
    const match = scopedMatch ? null : line.match(/^(.+?)(?::|-)(\d+)(?::|-)(.*)$/);
    if (!match && !scopedMatch) continue;
    const path = match ? match[1].trim() : scopedPath;
    const lineNumber = Number(match ? match[2] : scopedMatch![1]);
    if (!path || !lineNumber) continue;
    matches.push({
      path,
      line: lineNumber,
      text: (match ? match[3] : scopedMatch![2]).trim(),
    });
  }

  // Files-only output (`rg -l`, `grep -l`, native Grep files_with_matches or
  // count modes) carries no line numbers, so the pass above finds nothing.
  // Surface each file as a whole-file entry (line 0 = no specific line).
  if (matches.length === 0) {
    const lines = searchable
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line
        && !/^Found \d+ files?$/i.test(line)
        && !/^No (?:files|matches) found/i.test(line));
    const looksLikeFile = (line: string): boolean =>
      /^\S+$/.test(line) && (line.includes('/') || /\.[A-Za-z0-9]{1,8}(?::\d+)?$/.test(line));
    if (lines.length > 0 && lines.every(looksLikeFile)) {
      for (const line of lines) {
        // Count mode appends `:N` to the path — strip it.
        matches.push({ path: line.replace(/:\d+$/, ''), line: 0, text: '' });
      }
    }
  }
  return { query, matches };
}
