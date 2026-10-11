/**
 * Bash 行摘要(BashRowStep 拆解与汇总文案)。
 *
 * 自 utils/outputRendering.ts 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { type ShellWord, parseShellCommands } from '../../../shared/shell-file-writes';

const SHELL_STEP_SCAFFOLD = new Set([
  'cd', 'pushd', 'popd', 'export', 'set', 'source', '.', 'echo', 'printf', 'true', ':',
  // Conditional / loop-body keywords are structure, not steps of their own.
  'do', 'done', 'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', '{', '}', '!',
]);

/** `for f in …; do …` — the loop header is worth one step, its keywords are not. */
const SHELL_LOOP_KEYWORDS = new Set(['for', 'while', 'until']);

/** CLIs shaped `tool <verb> [target]`, where the verb alone is not the story. */
const SUBCOMMAND_CLIS = new Set(['git', 'docker', 'podman', 'pm2', 'systemctl', 'kubectl', 'gh', 'docker-compose']);

/** Verbs whose target (container, service, unit) is the interesting part. */
const SUBCOMMAND_TARGET_VERBS = new Set([
  'exec', 'run', 'logs', 'restart', 'start', 'stop', 'kill', 'rm', 'inspect', 'attach', 'pull', 'push',
  'status', 'describe', 'delete', 'apply', 'reload', 'enable', 'disable', 'show',
]);

/**
 * Options whose VALUE is the next word, so that word is never the file/target
 * to name. Only unambiguous ones: short flags differ per tool (`grep -n` is a
 * flag, `head -n` takes a count), and guessing wrong drops a real filename.
 */
const SHELL_VALUE_OPTIONS = new Set([
  '-e', '-c', '--eval', '--exec', '--output', '--format', '--filter', '--tail', '--lines', '--since',
  '--until', '--limit', '--env', '--volume', '--label', '--workdir', '--user', '--name', '--type',
]);

/** A literal path we can show as a chip — not a fragment of an inline script. */
function looksLikeStepPath(value: string): boolean {
  if (!value || value.length > 80) return false;
  if (/[\s'"();|&<>$`]/.test(value)) return false;
  return /\.[A-Za-z0-9]{1,6}$/.test(value) || value.includes('/');
}

/** Package runners: the interesting name is what they run, not the runner. */
const SHELL_RUNNERS = new Set(['npx', 'pnpm', 'yarn', 'bun', 'bunx', 'sudo', 'env', 'time', 'nohup', 'command']);

/** One step of a chain: what it runs, and the file it touches (full path, for a chip). */
export interface BashRowStep {
  label: string;
  file?: string;
}

/** Short label for one step of a chain: the tool it runs and the file it touches. */
function describeShellStep(name: string, args: ShellWord[]): BashRowStep {
  let effectiveName = name;
  let effectiveArgs = args;
  // `npm run build` / `npx tsc …` — step past the runner to the real tool.
  while (SHELL_RUNNERS.has(effectiveName) || effectiveName === 'npm') {
    const runnerOperands = effectiveArgs.filter((arg) => !arg.value.startsWith('-'));
    const skip = effectiveName === 'npm' && (runnerOperands[0]?.value === 'run' || runnerOperands[0]?.value === 'run-script') ? 2 : 1;
    const next = runnerOperands[skip - 1];
    if (!next) break;
    effectiveName = next.value;
    effectiveArgs = effectiveArgs.slice(effectiveArgs.indexOf(next) + 1);
    if (!SHELL_RUNNERS.has(effectiveName) && effectiveName !== 'npm') break;
  }
  if (effectiveName.includes('/')) effectiveName = effectiveName.slice(effectiveName.lastIndexOf('/') + 1);

  const operands: string[] = [];
  for (let index = 0; index < effectiveArgs.length; index += 1) {
    const arg = effectiveArgs[index];
    // `node -e "…"` / `python3 -c "…"`: the next word is a script, not a file.
    if (SHELL_VALUE_OPTIONS.has(arg.value)) { index += 1; continue; }
    if (arg.value.startsWith('-') || arg.dynamic) continue;
    operands.push(arg.value);
  }
  // Name the file a step touches — a bare tool name leaves the reader guessing
  // which file the row is about.
  const file = operands.find(looksLikeStepPath);
  const step = (label: string, withFile = true): BashRowStep => (withFile && file ? { label, file } : { label });

  if (SHELL_LOOP_KEYWORDS.has(effectiveName)) return step('loop');
  if (/vitest|jest/.test(effectiveName)) return step('tests');
  if (effectiveName === 'tsc') return step('type check', false);
  if (effectiveName === 'eslint') return step('lint');
  if (effectiveName === 'build' || effectiveName === 'vite') return step('build', false);
  if (effectiveName === 'playwright') return step('browser tests');

  const firstOperand = operands[0];
  const operand = firstOperand && firstOperand.length <= 24
    ? (firstOperand.includes('/') ? firstOperand.split('/').pop() || firstOperand : firstOperand)
    : undefined;
  if (effectiveName === 'git' && operand === 'diff' && effectiveArgs.some((arg) => arg.value === '--check')) return step('check diff', false);
  if (SUBCOMMAND_CLIS.has(effectiveName)) {
    // `docker exec` says nothing about WHICH container; `docker exec api-1` does.
    // A count (`docker logs --tail 80`) is not the container we want to name.
    const candidate = operands[1];
    const target = candidate && candidate !== file && candidate.length <= 32 && !/^\d+$/.test(candidate)
      ? candidate
      : undefined;
    const parts = [effectiveName, operand, SUBCOMMAND_TARGET_VERBS.has(operand ?? '') ? target : undefined];
    return step(parts.filter(Boolean).join(' '));
  }
  return step(effectiveName);
}

/** The steps of a chain, skipping cd/echo scaffolding. */
function shellRowSteps(command: string): BashRowStep[] {
  const steps: BashRowStep[] = [];
  for (const cmd of parseShellCommands(command)) {
    const words = cmd.words;
    if (words.length === 0) continue;
    let index = 0;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index].value)) index += 1;
    const raw = words[index]?.value;
    if (!raw) continue;
    const name = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
    if (SHELL_STEP_SCAFFOLD.has(name)) continue;
    const step = describeShellStep(name, words.slice(index + 1));
    const previous = steps[steps.length - 1];
    if (previous && previous.label === step.label && previous.file === step.file) continue;
    steps.push(step);
  }
  return steps;
}

const stepText = (step: BashRowStep): string => (step.file ? `${step.label} ${step.file.split('/').pop() || step.file}` : step.label);

/** `4 steps · type check → lint a.ts → build +1` for a chain; the command itself when it is one short step. */
export function summarizeShellCommand(command: string): string {
  if (!command) return 'Run terminal command';
  const steps = shellRowSteps(command);
  if (steps.length > 1) {
    const shown = steps.slice(0, 3).map(stepText).join(' → ');
    return `${steps.length} steps · ${shown}${steps.length > 3 ? ` +${steps.length - 3}` : ''}`;
  }
  if (/\bvitest\b/.test(command)) return `Tests · ${command.replace(/^.*?\bvitest\s+(?:run\s+)?/, '') || 'test suite'}`;
  if (/\btsc\b/.test(command)) return 'Type check';
  if (/\b(?:vite|npm\s+run)\s+build\b/.test(command)) return 'Build project';
  if (/\beslint\b/.test(command)) return 'Lint project';
  return command;
}

/** Longer than a row can show, or multi-line: the raw text is noise, summarize it. */
const BASH_ROW_SUMMARY_MIN_CHARS = 180;

export interface BashRowSummary {
  /** Up to 3 steps, each with the file it touches (rendered as a chip). */
  steps: BashRowStep[];
  /** Steps beyond the shown ones. */
  extraSteps: number;
  totalSteps: number;
  lineCount: number;
  charCount: number;
}

/**
 * A compact stand-in for a Bash row whose command is too long or too multi-line
 * to read inline (a heredoc script, a 10-step chain). Null when the command is
 * short enough to show verbatim, which is what most rows want.
 */
export function getBashRowSummary(command: string): BashRowSummary | null {
  if (!command) return null;
  const lineCount = command.split('\n').length;
  if (lineCount < 3 && command.length <= BASH_ROW_SUMMARY_MIN_CHARS) return null;
  const steps = shellRowSteps(command);
  if (steps.length === 0) return null;
  return {
    steps: steps.slice(0, 3),
    extraSteps: Math.max(0, steps.length - 3),
    totalSteps: steps.length,
    lineCount,
    charCount: command.length,
  };
}
