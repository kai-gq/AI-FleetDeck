/**
 * AgentTerminalPane 的纯助手(消息归一化 / 工具系统输出判定 / 工具调用键)。
 *
 * 自 AgentTerminalPane.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { SYSTEM_NOTICE_PREFIX } from './constants';
import { parseBossContext, parseInjectedInstructions } from '../BossContext';
import { extractToolKeyParam, isCodexExecWrapper, getCodexExecCommand, getCodexExecPresentation, getShellCommandPresentation, normalizeShellCommand } from '../../../utils/outputRendering';

export function normalizeUserMessage(text: string): string {
  const parsedBoss = parseBossContext(text);
  const parsedInjected = parseInjectedInstructions(parsedBoss.userMessage);
  return parsedInjected.userMessage.trim().replace(/\r\n/g, '\n');
}

export function normalizeAssistantMessage(text: string): string {
  return text.trim().replace(/\r\n/g, '\n');
}

/**
 * Dedup key for thinking rows. Live rows accumulate streamed chunks while
 * session history joins reasoning summary parts with '\n' — the same reasoning
 * can differ in internal whitespace between the two, so collapse it.
 */
export function normalizeThinkingMessage(text: string): string {
  return text
    .replace(/^\s*\[thinking\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isToolOrSystemOutput(text: string): boolean {
  return text.startsWith('Using tool:')
    || text.startsWith('Tool input:')
    || text.startsWith('Tool result:')
    || text.startsWith('Bash output:')
    || text.startsWith('Session started:')
    || text.startsWith('[thinking]')
    || text.startsWith('Tokens:')
    || text.startsWith('Cost:')
    || text.startsWith('Context (estimated from Codex turn usage):')
    // Any `[System]` notice, with or without its leading status emoji
    // (🔄 reattach, 📋 resume, 🛑 interrupt, ⚠ model fallback, …).
    || SYSTEM_NOTICE_PREFIX.test(text);
}

/**
 * Stable key for a tool invocation: toolName + primary param (command, path, …).
 * Used to collapse live `grok-early-*` chips against history `call-*` rows and
 * dual live emissions of the same call.
 */
export function makeToolInvocationKey(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
  textFallback?: string,
): string | null {
  const name = (toolName || '').trim();
  if (!name && textFallback?.startsWith('Using tool:')) {
    return makeToolInvocationKey(textFallback.replace('Using tool:', '').trim(), toolInput);
  }
  if (!name) return null;
  if (toolInput && isCodexExecWrapper(toolInput)) {
    const command = getCodexExecCommand(toolInput);
    if (command) {
      const semantic = getCodexExecPresentation(toolInput);
      return `${semantic.toolName}::${normalizeShellCommand(command)}`;
    }
  }
  if (name === 'Bash' && toolInput) {
    const command = typeof toolInput.command === 'string'
      ? toolInput.command
      : typeof toolInput.cmd === 'string' ? toolInput.cmd : '';
    if (command) {
      const semantic = getShellCommandPresentation(command);
      if (semantic.toolName !== 'Bash') {
        return `${semantic.toolName}::${normalizeShellCommand(command)}`;
      }
    }
  }
  let keyParam: string | null = null;
  if (toolInput && typeof toolInput === 'object' && Object.keys(toolInput).length > 0) {
    try {
      keyParam = extractToolKeyParam(name, JSON.stringify(toolInput));
    } catch { /* ignore */ }
  }
  // Prefer a real param so two Reads of different files stay distinct.
  // Empty early cards (no input yet) use name-only and dedupe carefully by time.
  return keyParam ? `${name}::${keyParam}` : `${name}::`;
}

export function historyToolInvocationKey(msg: {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  content?: string;
}): string | null {
  let input = msg.toolInput;
  if ((!input || Object.keys(input).length === 0) && msg.content) {
    try {
      const parsed = JSON.parse(msg.content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch { /* ignore */ }
  }
  return makeToolInvocationKey(msg.toolName, input);
}

// ─── Props & Handle ─────────────────────────────────────────────────────────
