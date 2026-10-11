/**
 * Codex exec 呈现(脚本 / 编辑路径 / 命令提取与整体 Presentation)。
 *
 * 自 utils/outputRendering.ts 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { prettifyToolName } from './tool-icons';
import { codexExecScript, extractJavaScriptStringField } from './internal';
import { classifyTerminalCommand } from './shell';

/**
 * Turn Codex's JavaScript orchestration wrapper into an activity a human can
 * scan. The complete script remains in the tool payload/metadata; this is only
 * the compact Guake/history label.
 */
export function summarizeCodexExecScript(script: string): string {
  const presentation = getCodexExecPresentation(script);
  return presentation.detail;
}

export interface CodexExecPresentation {
  toolName: 'Read' | 'Edit' | 'Grep' | 'Glob' | 'Bash' | 'WebSearch' | 'AskUserQuestion' | 'TodoWrite' | 'ExecuteCommand';
  detail: string;
  filePaths?: string[];
}

export function isCodexExecWrapper(input: unknown): boolean {
  return /\btools\.[A-Za-z0-9_]+\s*\(/.test(codexExecScript(input));
}

/** File paths touched by a Codex apply_patch payload, in patch order. */
export function getCodexExecEditPaths(input: unknown): string[] {
  const script = codexExecScript(input);
  // Persisted exec input is JavaScript source, so patch newlines commonly
  // appear as the two characters `\n` rather than real line breaks.
  const normalized = script.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  const paths: string[] = [];
  for (const match of normalized.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/gm)) {
    const path = match[1].trim();
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** Extract one file's section from a Codex `*** Begin Patch` payload. */
export function getCodexExecPatchForFile(input: unknown, filePath: string): string | null {
  const script = codexExecScript(input);
  const normalized = script.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = normalized.match(new RegExp(`^\\*\\*\\* (?:Update|Add|Delete) File:\\s*${escaped}\\s*$([\\s\\S]*?)(?=^\\*\\*\\* (?:Update|Add|Delete|End Patch)|(?![\\s\\S]))`, 'm'));
  if (!match) return null;
  const header = normalized.match(new RegExp(`^\\*\\*\\* (?:Update|Add|Delete) File:\\s*${escaped}\\s*$`, 'm'))?.[0];
  return header ? `${header}${match[1]}`.trim() : null;
}

/** The actual shell command inside a Codex JavaScript exec wrapper. */
export function getCodexExecCommand(input: unknown): string | null {
  const script = codexExecScript(input);
  return extractJavaScriptStringField(script, 'cmd') || extractJavaScriptStringField(script, 'command');
}

/** Resolve an opaque Codex `exec` wrapper to the activity it represents. */
export function getCodexExecPresentation(input: unknown): CodexExecPresentation {
  const script = codexExecScript(input);
  // Patch bodies may themselves contain strings such as `tools.exec_command(`.
  // Detect the outer apply_patch operation first so those contents do not turn
  // an EDIT card into a misleading mixed EXECUTECOMMAND card.
  const patchPaths = getCodexExecEditPaths(script);
  if (/\btools\.apply_patch\s*\(/.test(script) && patchPaths.length > 0) {
    return {
      toolName: 'Edit',
      detail: patchPaths.length > 1 ? `${patchPaths.length} files` : 'modified',
      filePaths: patchPaths,
    };
  }
  const toolCalls = [...script.matchAll(/\btools\.([A-Za-z0-9_]+)\s*\(/g)].map((match) => match[1]);
  if (toolCalls.length === 0) return { toolName: 'ExecuteCommand', detail: 'Run orchestration step' };

  const counts = new Map<string, number>();
  for (const name of toolCalls) counts.set(name, (counts.get(name) || 0) + 1);
  const total = toolCalls.length;
  const parallel = /Promise\.all\s*\(/.test(script);
  const plural = (noun: string, count = total) => `${count} ${noun}${count === 1 ? '' : 's'}`;

  // Surface the inner operation as a familiar Claude-style activity.
  if (counts.size === 1) {
    const name = toolCalls[0];
    switch (name) {
      case 'exec_command': {
        if (total > 1) return { toolName: 'Bash', detail: `Run ${plural('command')}${parallel ? ' in parallel' : ''}` };
        const command = extractJavaScriptStringField(script, 'cmd') || extractJavaScriptStringField(script, 'command') || '';
        return classifyTerminalCommand(command);
      }
      case 'write_stdin':
        return { toolName: 'Bash', detail: total > 1 ? `Send input to ${plural('terminal')}` : 'Continue terminal command' };
      case 'view_image': {
        const path = extractJavaScriptStringField(script, 'path');
        return { toolName: 'Read', detail: path ? 'image' : 'Inspect image', filePaths: path ? [path] : undefined };
      }
      case 'apply_patch': {
        const paths = getCodexExecEditPaths(script);
        return {
          toolName: 'Edit',
          detail: paths.length > 1 ? `${paths.length} files` : paths.length === 1 ? 'modified' : 'Project files',
          filePaths: paths.length > 0 ? paths : undefined,
        };
      }
      case 'web__run': return { toolName: 'WebSearch', detail: 'Search and inspect web sources' };
      case 'request_user_input': return { toolName: 'AskUserQuestion', detail: 'Ask for input' };
      case 'update_plan': return { toolName: 'TodoWrite', detail: 'Update work plan' };
      case 'wait': return { toolName: 'Bash', detail: 'Wait for running command' };
      default: return { toolName: 'ExecuteCommand', detail: `${prettifyToolName(name)}${total > 1 ? ` · ${total} calls` : ''}` };
    }
  }

  const commandCount = counts.get('exec_command') || 0;
  const inputCount = counts.get('write_stdin') || 0;
  if (commandCount + inputCount === total) {
    const parts: string[] = [];
    if (commandCount) parts.push(plural('command', commandCount));
    if (inputCount) parts.push(`${inputCount} terminal input${inputCount === 1 ? '' : 's'}`);
    return { toolName: 'Bash', detail: `Run ${parts.join(' + ')}${parallel ? ' in parallel' : ''}` };
  }

  return { toolName: 'ExecuteCommand', detail: `Run ${plural('tool action')}${parallel ? ' in parallel' : ''}` };
}
