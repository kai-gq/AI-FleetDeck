/**
 * Shell 写摘要与终端命令分类(ShellWriteSummary / classifyTerminalCommand / Presentation)。
 *
 * 自 utils/outputRendering.ts 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { normalizeShellWrapper } from './internal';
import { type CodexExecPresentation } from './codex';
import { getShellReadTargets } from './read-targets';
import { summarizeShellCommand } from './bash-row';
import { type ShellInspectionStep, type ShellReadStep, type ShellScriptReplacement, analyzeShellFileWrites, analyzeShellInspection, parseShellCommands } from '../../../shared/shell-file-writes';

/**
 * Steps that only set up or annotate a chain — `cd` into a directory, `echo` a
 * banner, `export` a var. They never describe what a command is *for*, so they
 * don't count when deciding whether a chain has a single semantic purpose.
 */
const SHELL_SETUP_STEP = /^(?:cd|echo|export|source|\.)\b/;

/**
 * Split on step separators (not pipes — a pipeline is one step) and drop the
 * setup-only steps.
 */
function substantiveShellSteps(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;)\s*/)
    .map((step) => step.trim())
    .filter(Boolean)
    .filter((step) => !SHELL_SETUP_STEP.test(step));
}

/** What a Bash row should headline when its command writes files. */
export interface ShellWriteSummary {
  toolName: 'Write' | 'Edit';
  /** Written files, resolved against a static `cd` in the chain when relative. */
  paths: string[];
  /** Other commands the chain runs, e.g. ['curl', 'python3']; empty for a pure write. */
  otherCommands: string[];
  /**
   * Per path, the literal replacements the command performed — an inline patch
   * script (`s.replace(a, b)`) carries its own diff, so the viewer can show the
   * modified lines without git or a before-snapshot.
   */
  replacements: Record<string, ShellScriptReplacement[]>;
}

const SHELL_WRITE_SUMMARY_CACHE_MAX = 300;

const shellWriteSummaryCache = new Map<string, ShellWriteSummary | null>();

/**
 * File writes worth headlining on a Bash row: every write of a chain that
 * only writes files, or the heredoc-backed writes (`cat > f <<'EOF'`) of a
 * longer chain, where the heredoc body is what otherwise floods the row.
 * Plain redirects inside a bigger script (`npm test > log`) stay BASH.
 * Memoized: rows re-render often and heredoc commands can be 100 KB.
 */
export function getShellWriteSummary(command: string): ShellWriteSummary | null {
  if (!command || !/[>]|<<|\b(?:sed|perl|tee|python3?|node|deno|bun|ruby)\b/.test(command)) return null;
  const cached = shellWriteSummaryCache.get(command);
  if (cached !== undefined) return cached;

  const { writes, pure, otherCommands } = analyzeShellFileWrites(normalizeShellWrapper(command));
  // In a mixed chain, headline the writes whose body IS the row: a heredoc, or
  // an inline python/node script that patches files.
  const shown = pure
    ? writes
    : writes.filter((write) => write.content !== undefined || write.fromScript || write.operation === 'in_place_edit');
  const summary: ShellWriteSummary | null = shown.length === 0
    ? null
    : {
        // A script that patches a file (reads it back or states replacements)
        // is an edit; one that generates it (`Image.save('out.png')`) is a write.
        toolName: shown.every((write) => write.operation === 'overwrite' && (!write.fromScript || !write.patches)) ? 'Write' : 'Edit',
        paths: shown.map((write) => write.path),
        otherCommands: pure ? [] : otherCommands,
        replacements: Object.fromEntries(
          shown
            .filter((write) => write.replacements && write.replacements.length > 0)
            .map((write) => [write.path, write.replacements as ShellScriptReplacement[]]),
        ),
      };

  if (shellWriteSummaryCache.size >= SHELL_WRITE_SUMMARY_CACHE_MAX) {
    const oldest = shellWriteSummaryCache.keys().next().value;
    if (oldest !== undefined) shellWriteSummaryCache.delete(oldest);
  }
  shellWriteSummaryCache.set(command, summary);
  return summary;
}

function formatReadRange(read: ShellReadStep): string | null {
  if (!read.range) return null;
  return read.range.start === read.range.end ? `${read.range.start}` : `${read.range.start}–${read.range.end}`;
}

/** READ/GREP presentation for a chain that only inspects files; labelled by its first step. */
function presentShellInspection(steps: ShellInspectionStep[]): CodexExecPresentation {
  const reads = steps.filter((step): step is ShellReadStep => step.kind === 'read');
  if (steps[0].kind === 'search' || reads.length === 0) {
    const searches = steps.flatMap((step) => (step.kind === 'search' ? [step] : []));
    const patterns = Array.from(new Set(searches.map((search) => search.pattern).filter((pattern): pattern is string => !!pattern)));
    const searchPaths = Array.from(new Set(searches.flatMap((search) => search.paths)));
    if (patterns.length === 0) return { toolName: 'Grep', detail: searches.map((search) => search.command).join('; ') };
    const first = patterns[0];
    const quoted = `"${first.length > 60 ? `${first.slice(0, 60)}…` : first}"${patterns.length > 1 ? ` +${patterns.length - 1}` : ''}`;
    const single = searchPaths.length === 1 ? searchPaths[0] : null;
    // A single file becomes a chip, so naming it again in the detail is noise.
    const chipPath = single && /\.[A-Za-z0-9]+$/.test(single) ? single : null;
    const where = chipPath || single === '.' || single === './'
      ? ''
      : single ? ` in ${single.split('/').pop() || single}`
      : searchPaths.length > 1 ? ` in ${searchPaths.length} files` : '';
    return {
      toolName: 'Grep',
      detail: `${quoted}${where}`,
      // Only a real file opens usefully in the viewer; a directory operand doesn't.
      ...(chipPath ? { filePaths: [chipPath] } : {}),
    };
  }
  const filePaths = Array.from(new Set(reads.map((read) => read.path)));
  const ranges = reads.map(formatReadRange);
  let detail: string;
  if (reads.length === 1) {
    const range = ranges[0];
    detail = range ? `${range.includes('–') ? 'lines' : 'line'} ${range}` : 'viewed';
  } else if (filePaths.length === 1 && ranges.every(Boolean)) {
    const shown = ranges.slice(0, 3).join(', ');
    detail = `lines ${shown}${ranges.length > 3 ? ` +${ranges.length - 3}` : ''}`;
  } else {
    detail = `${reads.length} ranges`;
  }
  return { toolName: 'Read', detail, filePaths };
}

/** `then sed, curl, python3 +2` — the steps a write chain runs besides writing. */
export function formatShellWriteFollowUp(otherCommands: string[]): string {
  const unique = Array.from(new Set(otherCommands));
  if (unique.length === 0) return '';
  const shown = unique.slice(0, 3).join(', ');
  return unique.length > 3 ? `then ${shown} +${unique.length - 3}` : `then ${shown}`;
}

export function classifyTerminalCommand(command: string): CodexExecPresentation {
  const clean = normalizeShellWrapper(command);
  // File writes stay on the Bash row, which headlines them (WRITE + file chip)
  // while keeping exec/test cards attached. Checked first: `cat > f <<'EOF'`
  // starts with `cat` and used to land in the Read branch below.
  if (getShellWriteSummary(clean)) {
    return { toolName: 'Bash', detail: summarizeShellCommand(clean) };
  }
  // Inspection chains (`cd repo; sed -n 1,20p a.ts; echo ---; grep -n x b.ts`)
  // read as READ/GREP instead of a raw BASH one-liner.
  const inspection = analyzeShellInspection(clean);
  if (inspection) return presentShellInspection(inspection);
  // Reads take precedence: a filename/path may itself contain words such as
  // "grep", which must not turn `sed -n ... GrepPanel.tsx` into GREP.
  if (/^(?:sed\s+-n|cat|head|tail)\b/.test(clean)) {
    const readTargets = getShellReadTargets(clean);
    if (readTargets.length > 1) {
      return { toolName: 'Read', detail: `${readTargets.length} ranges`, filePaths: readTargets.map((target) => target.path) };
    }
    if (readTargets.length === 1) {
      const range = readTargets[0].highlightRange;
      const detail = range ? `lines ${range.offset}–${range.offset + range.limit - 1}` : 'viewed';
      return { toolName: 'Read', detail, filePaths: [readTargets[0].path] };
    }
    const sed = clean.match(/\bsed\s+-n\s+["']?(\d+)\s*,\s*(\d+)p["']?\s+(?:--\s+)?["']?([^"';&|]+?)["']?\s*$/);
    if (sed) return { toolName: 'Read', detail: `lines ${sed[1]}–${sed[2]}`, filePaths: [sed[3].trim()] };
    const simple = clean.match(/^\s*(?:cat|head|tail)\b[^;&|]*?\s+(?:--\s+)?["']?([^"'\s;&|]+)["']?\s*$/);
    return simple
      ? { toolName: 'Read', detail: 'viewed', filePaths: [simple[1]] }
      : { toolName: 'Read', detail: clean };
  }
  // The rules below match a keyword anywhere in the string, which is only safe
  // for a command with one job. A build gate like
  // `cd x && tsc && eslint && jest | grep -E "^Tests:" && npm run build`
  // was landing on GREP because of one late pipe stage. Once `cd`/`echo`
  // scaffolding is stripped, more than one remaining step means it's a script:
  // fall through to Bash, whose step summary is more informative anyway.
  const steps = substantiveShellSteps(clean);
  if (steps.length > 1) {
    return { toolName: 'Bash', detail: summarizeShellCommand(clean) };
  }
  // Match against the substantive step so a path like /home/erick/grep-tools
  // in a leading `cd` can't decide the label either.
  const subject = steps.length === 1 ? steps[0] : clean;

  if (/\b(?:rg\s+--files|find|ls)(?:\s|$)/.test(subject)) {
    const [first] = parseShellCommands(subject);
    const target = first?.words
      .slice(1)
      .find((word) => !word.value.startsWith('-') && word.value !== '--files' && !word.dynamic)?.value;
    return { toolName: 'Glob', detail: target ? `listed ${target}` : clean };
  }
  if (/\b(?:rg|grep)\b/.test(subject)) {
    return { toolName: 'Grep', detail: clean };
  }
  if (/\b(?:apply_patch|perl\s+-[pi]|git\s+apply)\b/.test(subject)) {
    return { toolName: 'Edit', detail: clean };
  }
  if (/^git\s+(?:diff|show|status)\b/.test(subject)) {
    const path = clean.match(/\s--\s+["']?([^"']+)["']?\s*$/)?.[1];
    return { toolName: 'Read', detail: 'Git changes', filePaths: path ? [path.trim()] : undefined };
  }
  return { toolName: 'Bash', detail: summarizeShellCommand(clean) };
}

/** Semantic presentation for a direct native Bash command, when applicable. */
export function getShellCommandPresentation(command: string): CodexExecPresentation {
  return classifyTerminalCommand(command);
}

/** Stable comparison form for wrapped vs direct shell command deduplication. */
export function normalizeShellCommand(command: string): string {
  return normalizeShellWrapper(command).replace(/\s+/g, ' ').trim();
}
