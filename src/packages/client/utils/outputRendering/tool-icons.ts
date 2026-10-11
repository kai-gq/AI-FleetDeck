/**
 * 工具名 / 图标映射(emoji + IconName)与工具名美化、待办与跟踪状态图标。
 *
 * 自 utils/outputRendering.ts 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { type IconName } from '../../components/Icon';

// Tool icons mapping - used in both Guake terminal and Commander view.
// Emoji variants are kept here because they are rendered inside <canvas> 2D scenes
// (AgentRenderer, EffectsManager) where JSX isn't an option. For React render sites
// prefer `TOOL_ICON_NAMES` + `<Icon name={...} />` below.
export const TOOL_ICONS: Record<string, string> = {
  Read: '📖',
  Write: '✏️',
  Edit: '📝',
  Bash: '💻',
  Glob: '🔍',
  Grep: '🔎',
  Task: '📋',
  TaskCreate: '✅',
  TaskUpdate: '✅',
  Agent: '🤖',
  WebFetch: '🌐',
  WebSearch: '🌍',
  TodoWrite: '✅',
  NotebookEdit: '📓',
  AskFollowupQuestion: '❓',
  AskUserQuestion: '❓',
  AttemptCompletion: '✨',
  ListFiles: '📂',
  SearchFiles: '🔎',
  ExecuteCommand: '⚙️',
  exec: '🧩',
  // Codex subagent collab tools
  spawn_agent: '🧬',
  send_input: '📨',
  wait: '⏳',
  view_image: '🖼️',
  default: '⚡',
};

// Semantic Icon name per tool for React-rendered surfaces. Keep in sync with TOOL_ICONS.

export const TOOL_ICON_NAMES: Record<string, IconName> = {
  Read: 'eye',
  Write: 'edit',
  Edit: 'edit',
  Bash: 'terminal',
  Glob: 'search',
  Grep: 'search',
  Task: 'list-checks',
  TaskCreate: 'list-checks',
  TaskUpdate: 'list-checks',
  Agent: 'robot',
  WebFetch: 'globe',
  WebSearch: 'globe-hemisphere',
  TodoWrite: 'list-checks',
  NotebookEdit: 'edit',
  AskFollowupQuestion: 'question',
  AskUserQuestion: 'question',
  AttemptCompletion: 'sparkle',
  ListFiles: 'folder-open',
  list_dir: 'folder-open',
  SearchFiles: 'search',
  ExecuteCommand: 'gear',
  exec: 'bolt',
  // Grok / agent runtime tools
  get_command_or_subagent_output: 'terminal',
  get_task_output: 'terminal',
  spawn_subagent: 'dna',
  spawn_agent: 'dna',
  send_input: 'send',
  send_message_to_agent: 'send',
  wait: 'hourglass',
  web_search: 'globe-hemisphere',
  open_page: 'globe',
  open_page_with_find: 'globe',
  view_image: 'image',
  default: 'bolt',
};

/**
 * Get the emoji icon for a tool (for canvas/text renderers).
 */
export function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] || TOOL_ICONS.default;
}

/**
 * Get a semantic Icon name for a tool (for JSX render sites).
 */
export function getToolIconName(toolName: string): IconName {
  return TOOL_ICON_NAMES[toolName] || TOOL_ICON_NAMES.default;
}

const TOOL_NAME_TRANSLATION_KEYS: Record<string, string> = {
  Read: 'tools:display.toolNames.read',
  Write: 'tools:display.toolNames.write',
  Edit: 'tools:display.toolNames.edit',
  Bash: 'tools:display.toolNames.bash',
  Glob: 'tools:display.toolNames.glob',
  Grep: 'tools:display.toolNames.grep',
  Task: 'tools:display.toolNames.task',
  Agent: 'tools:display.toolNames.agent',
  WebFetch: 'tools:display.toolNames.webFetch',
  WebSearch: 'tools:display.toolNames.webSearch',
  TodoWrite: 'tools:display.toolNames.todoWrite',
  NotebookEdit: 'tools:display.toolNames.notebookEdit',
  AskFollowupQuestion: 'tools:display.toolNames.askFollowupQuestion',
  AskUserQuestion: 'tools:display.toolNames.askUserQuestion',
  AttemptCompletion: 'tools:display.toolNames.attemptCompletion',
  ListFiles: 'tools:display.toolNames.listFiles',
  list_dir: 'tools:display.toolNames.listFiles',
  SearchFiles: 'tools:display.toolNames.searchFiles',
  ExecuteCommand: 'tools:display.toolNames.executeCommand',
  // Codex subagent collab tools
  spawn_agent: 'tools:display.toolNames.spawnAgent',
  send_input: 'tools:display.toolNames.sendInput',
  wait: 'tools:display.toolNames.wait',
  // Grok / Tide runtime tools (friendly labels)
  get_command_or_subagent_output: 'tools:display.toolNames.taskOutput',
  get_task_output: 'tools:display.toolNames.taskOutput',
  spawn_subagent: 'tools:display.toolNames.spawnAgent',
  send_message_to_agent: 'tools:display.toolNames.sendMessage',
  web_search: 'tools:display.toolNames.webSearch',
  open_page: 'tools:display.toolNames.webFetch',
  open_page_with_find: 'tools:display.toolNames.webFetch',
  view_image: 'tools:display.toolNames.viewImage',
};

/** Prettify snake_case / camelCase tool ids when no i18n key exists. */
export function prettifyToolName(toolName: string): string {
  if (!toolName) return toolName;
  if (toolName.startsWith('mcp__')) {
    const [, server = 'MCP', ...toolParts] = toolName.split('__');
    const tool = toolParts.join('__');
    return `MCP · ${prettifyToolName(server)} · ${prettifyToolName(tool)}`;
  }
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve a localized tool label with fallback to a prettified raw tool name.
 */
export function getLocalizedToolName(
  toolName: string,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const key = TOOL_NAME_TRANSLATION_KEYS[toolName];
  if (!key) return prettifyToolName(toolName);
  return t(key, { defaultValue: prettifyToolName(toolName) }) || prettifyToolName(toolName);
}

/**
 * Resolve an emoji icon for a given tracking status value.
 * Falls back to a neutral indicator for unknown statuses.
 */
export function getTrackingStatusIcon(status: string): string {
  switch (status) {
    case 'need-review': return '✅';
    case 'blocked': return '🚫';
    case 'can-clear-context': return '🧹';
    case 'waiting-subordinates': return '⏳';
    case 'working': return '💻';
    case 'thinking': return '✏️';
    default: return '📍';
  }
}

export function getTrackingStatusIconName(status: string): IconName {
  switch (status) {
    case 'need-review': return 'success';
    case 'blocked': return 'warn';
    case 'can-clear-context': return 'clear';
    case 'waiting-subordinates': return 'hourglass';
    case 'working': return 'terminal';
    case 'thinking': return 'edit';
    default: return 'pin';
  }
}
