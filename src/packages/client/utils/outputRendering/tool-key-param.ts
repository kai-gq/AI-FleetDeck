/**
 * 工具调用关键参数摘要(extractToolKeyParam / web search 摘要)。
 *
 * 自 utils/outputRendering.ts 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { shortenId } from './format';
import { summarizeCodexExecScript } from './codex';
import { extractExecWrappedCommand } from './exec-payload';

/**
 * Human label for a web-search payload, from either the tool input or the
 * tool RESULT (they share a shape).
 *
 * Codex's app-server emits `itemStarted` for a webSearch BEFORE the query or
 * action is known, so the input is empty and only the result carries data:
 * `{query, actionType, actionQuery, actionQueries, actionUrl}` — where for an
 * `openPage` action `query` holds the opened URL. Returns null when nothing
 * useful is present, so callers can keep hiding the bare row.
 */
export function summarizeWebSearch(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;

  const url = str(p.actionUrl) || str(p.url);
  if (url) return url;

  const queries = Array.isArray(p.actionQueries)
    ? (p.actionQueries as unknown[]).map(str).filter((q): q is string => !!q)
    : [];
  if (queries.length) return queries.map((q) => `"${q}"`).join(', ');

  const query = str(p.query) || str(p.actionQuery) || str(p.q) || str(p.search);
  // An openPage action puts the URL in `query`; don't wrap that in quotes.
  if (query) return /^https?:\/\//i.test(query) ? query : `"${query}"`;

  return null;
}

/**
 * Extract key parameter from tool input JSON for display
 * Returns a human-readable summary of what the tool is operating on
 * NO TRUNCATION - shows full content for readability
 */
export function extractToolKeyParam(toolName: string, inputJson: string): string | null {
  try {
    const input = JSON.parse(inputJson);

    if (toolName.startsWith('mcp__')) {
      const server = typeof input.server === 'string' ? input.server : undefined;
      const primary = input.query || input.url || input.path || input.file_path || input.documentId || input.script;
      if (typeof primary === 'string' && primary) {
        const value = primary.length > 140 ? `${primary.slice(0, 137)}...` : primary;
        return server ? `${server} · ${value}` : value;
      }
      return server || null;
    }

    switch (toolName) {
      case 'exec': {
        const script = typeof input === 'string'
          ? input
          : (input.input || input.code || input.script);
        if (typeof script === 'string' && script.trim()) {
          return summarizeCodexExecScript(script);
        }
        break;
      }
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'NotebookEdit':
      // Codex `view_image` — the path is the label, never the `detail` hint.
      case 'view_image': {
        // Claude uses file_path; Grok/OpenCode-style tools use target_file / path.
        const filePath =
          input.file_path
          || input.filePath
          || input.target_file
          || input.targetFile
          || input.path
          || input.notebook_path
          || input.notebookPath;
        if (typeof filePath === 'string' && filePath) {
          return filePath; // Full path, no truncation
        }
        break;
      }
      case 'ListFiles':
      case 'list_dir': {
        const dir =
          input.target_directory
          || input.targetDirectory
          || input.path
          || input.directory;
        if (typeof dir === 'string' && dir) {
          return dir;
        }
        break;
      }
      case 'get_command_or_subagent_output':
      case 'get_task_output': {
        const ids = input.task_ids ?? input.taskIds ?? input.task_id ?? input.taskId;
        const timeout = input.timeout_ms ?? input.timeoutMs ?? input.timeout;
        const idList = Array.isArray(ids)
          ? ids.map((x) => String(x))
          : typeof ids === 'string'
            ? [ids]
            : [];
        const parts: string[] = [];
        if (idList.length === 1) {
          parts.push(shortenId(idList[0]));
        } else if (idList.length > 1) {
          parts.push(`${idList.length} tasks`);
        }
        if (typeof timeout === 'number' && timeout > 0) {
          parts.push(timeout >= 1000 ? `${Math.round(timeout / 1000)}s` : `${timeout}ms`);
        }
        if (parts.length > 0) return parts.join(' · ');
        break;
      }
      case 'spawn_subagent':
      case 'spawn_agent': {
        const desc = input.description || input.prompt || input.name;
        if (typeof desc === 'string' && desc) {
          return desc.length > 120 ? `${desc.slice(0, 117)}…` : desc;
        }
        break;
      }
      case 'send_message_to_agent':
      case 'send_input': {
        const to = input.agent_id || input.agentId || input.to || input.receiver_thread_ids;
        const msg = input.message || input.prompt || input.text;
        if (typeof to === 'string' && typeof msg === 'string') {
          return `→ ${shortenId(to)}: ${msg.length > 80 ? `${msg.slice(0, 77)}…` : msg}`;
        }
        if (typeof msg === 'string' && msg) {
          return msg.length > 100 ? `${msg.slice(0, 97)}…` : msg;
        }
        break;
      }
      case 'Bash':
      case 'ExecuteCommand': {
        const cmd = input.command || input.cmd;
        if (typeof cmd === 'string' && cmd) {
          return extractExecWrappedCommand(cmd);
        }
        if (typeof input.description === 'string' && input.description) {
          return input.description;
        }
        break;
      }
      case 'Grep':
      case 'SearchFiles': {
        const pattern = input.pattern || input.query;
        const path = input.path || input.target_directory || input.targetDirectory;
        if (pattern && path) {
          return `"${pattern}" in ${path}`;
        }
        if (typeof pattern === 'string' && pattern) {
          return `"${pattern}"`;
        }
        break;
      }
      case 'Glob': {
        const pattern = input.pattern || input.glob;
        const path = input.path || input.target_directory || input.targetDirectory;
        if (pattern && path) {
          return `${pattern} in ${path}`;
        }
        if (typeof pattern === 'string' && pattern) {
          return pattern;
        }
        break;
      }
      case 'WebFetch': {
        const url = input.url || input.target_url || input.targetUrl;
        if (typeof url === 'string' && url) {
          return url; // Full URL
        }
        break;
      }
      case 'WebSearch':
      case 'web_search': {
        const label = summarizeWebSearch(input);
        if (label) return label;
        break;
      }
      case 'Task':
      case 'Agent': {
        const desc = input.description;
        const agentType = input.subagent_type || input.subagentType;
        if (desc) {
          return agentType ? `[${agentType}] ${desc}` : desc;
        }
        if (input.prompt) {
          return input.prompt;
        }
        break;
      }
      case 'ExitPlanMode':
      case 'EnterPlanMode': {
        const prompts = input.allowedPrompts;
        if (Array.isArray(prompts) && prompts.length > 0) {
          return prompts.map((p: { tool?: string; prompt?: string }) => p.prompt || p.tool || '').filter(Boolean).join(', ');
        }
        if (toolName === 'ExitPlanMode' && typeof input.plan === 'string' && input.plan.trim().length > 0) {
          return input.plan.trim();
        }
        return toolName === 'ExitPlanMode' ? 'Plan ready' : 'Entering plan mode';
      }
      case 'TodoWrite': {
        const todos = input.todos;
        if (Array.isArray(todos) && todos.length > 0) {
          // Return summary for text fallback (component rendering preferred)
          const done = todos.filter((t: { status?: string }) => t.status === 'completed').length;
          const active = todos.filter((t: { status?: string }) => t.status === 'in_progress').length;
          const pending = todos.filter((t: { status?: string }) => t.status === 'pending').length;
          const parts: string[] = [];
          if (done > 0) parts.push(`${done} done`);
          if (active > 0) parts.push(`${active} active`);
          if (pending > 0) parts.push(`${pending} pending`);
          return `${todos.length} items (${parts.join(', ')})`;
        }
        break;
      }
      case 'AskUserQuestion':
      case 'AskFollowupQuestion': {
        const questions = input.questions || input.question;
        if (questions) {
          const q = Array.isArray(questions) ? questions[0]?.question : questions;
          if (q) {
            return q; // Full question
          }
        }
        break;
      }
      default: {
        // Try to find any meaningful string parameter
        for (const [, value] of Object.entries(input)) {
          if (typeof value === 'string' && value.length > 0) {
            return value; // Full value, no truncation
          }
        }
        break;
      }
    }
  } catch {
    // Not valid JSON
  }
  return null;
}
