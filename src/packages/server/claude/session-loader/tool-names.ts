/**
 * 各运行时工具名归一:OpenCode/Grok/Pi 工具名映射表与 normalize 函数。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */


// OpenCode uses lowercase tool names on disk; normalize to the capitalized
// variants the frontend expects. Kept in sync with json-event-parser.ts.
const OPENCODE_TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Task',
  agent: 'Agent',
  skill: 'Skill',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todowrite: 'TodoWrite',
  notebookedit: 'NotebookEdit',
  askuserquestion: 'AskUserQuestion',
  askfollowupquestion: 'AskFollowupQuestion',
  toolsearch: 'ToolSearch',
  enterplanmode: 'EnterPlanMode',
  exitplanmode: 'ExitPlanMode',
};

export function normalizeOpencodeToolName(raw: string): string {
  return OPENCODE_TOOL_NAME_MAP[raw.toLowerCase()] || raw;
}

// Grok CLI tool names → Tide UI names (keep in sync with grok/session-watcher.ts)
const GROK_TOOL_NAME_MAP: Record<string, string> = {
  list_dir: 'ListFiles',
  read_file: 'Read',
  search_replace: 'Edit',
  write: 'Write',
  run_terminal_cmd: 'Bash',
  run_terminal_command: 'Bash',
  grep: 'Grep',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  open_page: 'WebFetch',
  open_page_with_find: 'WebFetch',
  spawn_subagent: 'Task',
  todo_write: 'TodoWrite',
};

export function normalizeGrokToolName(raw: string): string {
  return GROK_TOOL_NAME_MAP[raw.toLowerCase()] || raw;
}

// Pi uses lowercase tool names on disk; normalize to the capitalized variants
// the frontend expects. Kept in sync with pi/json-event-parser.ts.
const PI_TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  multiedit: 'MultiEdit',
  glob: 'Glob',
  grep: 'Grep',
  ls: 'LS',
  find: 'Find',
  todowrite: 'TodoWrite',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  // pi-web-access extension tools
  web_search: 'WebSearch',
  fetch_content: 'WebFetch',
  get_search_content: 'WebFetch',
};

export function normalizePiToolName(raw: string): string {
  return PI_TOOL_NAME_MAP[raw.toLowerCase()] || raw;
}
