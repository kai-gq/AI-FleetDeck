/**
 * Bash 特殊命令解析(search / notification / task-label / report-task / tracking / memory)。
 *
 * 自 utils/outputRendering.ts 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

export interface BashSearchCommandInfo {
  shellPrefix?: string;
  commandBody: string;
  searchTerm: string;
}

export interface BashNotificationCommandInfo {
  shellPrefix?: string;
  commandBody: string;
  title?: string;
  message?: string;
  viaCurl: boolean;
  viaGdbus: boolean;
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith('\'') && value.endsWith('\''))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse Bash commands that search terms via: rg --files | rg <term>
 * Returns null when the command is not a search-term pattern.
 */
export function parseBashSearchCommand(command: string): BashSearchCommandInfo | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  let shellPrefix: string | undefined;
  let commandBody = trimmed;

  const shellWrapped = trimmed.match(/^(\S+)\s+-lc\s+([\s\S]+)$/);
  if (shellWrapped) {
    shellPrefix = `${shellWrapped[1]} -lc`;
    commandBody = stripWrappingQuotes(shellWrapped[2].trim());
  }

  if (!/\brg\s+--files\b/.test(commandBody) || !/\|\s*rg\b/.test(commandBody)) {
    return null;
  }

  const pipeSearchMatch = commandBody.match(/\|\s*rg\b\s+(.+)$/);
  if (!pipeSearchMatch) return null;

  const searchArgs = pipeSearchMatch[1].trim();
  if (!searchArgs) return null;

  const termWithoutFlags = searchArgs.replace(/^(?:-\S+\s+)*/, '').trim();
  const searchTerm = stripWrappingQuotes(termWithoutFlags || searchArgs);
  if (!searchTerm) return null;

  return {
    shellPrefix,
    commandBody,
    searchTerm,
  };
}

/**
 * Parse Bash commands that send Tide notifications via curl api/notify and/or gdbus Notify.
 * Returns null when command does not look like a notification command.
 */
export function parseBashNotificationCommand(command: string): BashNotificationCommandInfo | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  let shellPrefix: string | undefined;
  let commandBody = trimmed;

  const shellWrapped = trimmed.match(/^(\S+)\s+-lc\s+([\s\S]+)$/);
  if (shellWrapped) {
    shellPrefix = `${shellWrapped[1]} -lc`;
    commandBody = stripWrappingQuotes(shellWrapped[2].trim());
  }

  const viaCurl = /\bcurl\b[\s\S]*\/api\/notify\b/.test(commandBody);
  const viaGdbus = /\bgdbus\b[\s\S]*org\.freedesktop\.Notifications\.Notify\b/.test(commandBody);
  if (!viaCurl && !viaGdbus) return null;

  let title: string | undefined;
  let message: string | undefined;

  // Try curl JSON payload first: -d '{"title":"...","message":"..."}'
  const payloadMatch = commandBody.match(/-d\s+((['"])([\s\S]*?)\2)/);
  if (payloadMatch) {
    const rawPayload = stripWrappingQuotes(payloadMatch[1]).replace(/\\"/g, '"');
    const parsedTitle = rawPayload.match(/"title"\s*:\s*"([^"]*)"/);
    const parsedMessage = rawPayload.match(/"message"\s*:\s*"([^"]*)"/);
    if (parsedTitle?.[1]) title = parsedTitle[1];
    if (parsedMessage?.[1]) message = parsedMessage[1];
  }

  // Fallback to gdbus notify args: ... 'ICON' 'TITLE' 'MESSAGE' '[]' '{}' 5000
  if (!title || !message) {
    const gdbusArgs = commandBody.match(/Notifications\.Notify[\s\S]*?\s'[^']*'\s+\d+\s+'[^']*'\s+'([^']*)'\s+'([^']*)'/);
    if (!title && gdbusArgs?.[1]) title = gdbusArgs[1];
    if (!message && gdbusArgs?.[2]) message = gdbusArgs[2];
  }

  return {
    shellPrefix,
    commandBody,
    title,
    message,
    viaCurl,
    viaGdbus,
  };
}

export interface BashTaskLabelCommandInfo {
  shellPrefix?: string;
  commandBody: string;
  taskLabel: string;
}

/**
 * Parse Bash commands that set a task label via curl PATCH /api/agents/...
 * Detects: curl ... -X PATCH .../api/agents/... -d '{"taskLabel":"..."}'
 * Returns null when command does not look like a task label command.
 */
export function parseBashTaskLabelCommand(command: string): BashTaskLabelCommandInfo | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  let shellPrefix: string | undefined;
  let commandBody = trimmed;

  const shellWrapped = trimmed.match(/^(\S+)\s+-lc\s+([\s\S]+)$/);
  if (shellWrapped) {
    shellPrefix = `${shellWrapped[1]} -lc`;
    commandBody = stripWrappingQuotes(shellWrapped[2].trim());
  }

  // Must be a curl PATCH to /api/agents/ with taskLabel in payload
  if (!/\bcurl\b/.test(commandBody)) return null;
  if (!/PATCH/.test(commandBody)) return null;
  if (!/\/api\/agents\//.test(commandBody)) return null;

  // Extract taskLabel from JSON payload
  const payloadMatch = commandBody.match(/-d\s+((['"])([\s\S]*?)\2)/);
  if (!payloadMatch) return null;

  const rawPayload = stripWrappingQuotes(payloadMatch[1]).replace(/\\"/g, '"');
  const labelMatch = rawPayload.match(/"taskLabel"\s*:\s*"([^"]*)"/);
  if (!labelMatch?.[1]) return null;

  return {
    shellPrefix,
    commandBody,
    taskLabel: labelMatch[1],
  };
}

export interface BashReportTaskCommandInfo {
  shellPrefix?: string;
  commandBody: string;
  summary: string;
  status: 'completed' | 'failed';
}

export type TrackingStatusValue =
  | 'need-review'
  | 'blocked'
  | 'can-clear-context'
  | 'waiting-subordinates'
  | 'working'
  | string;

export interface BashTrackingStatusCommandInfo {
  shellPrefix?: string;
  commandBody: string;
  trackingStatus: TrackingStatusValue;
  trackingStatusDetail?: string;
}

/**
 * Parse Bash commands that update agent tracking status via curl PATCH /api/agents/...
 * Detects: curl ... -X PATCH .../api/agents/... -d '{"trackingStatus":"...","trackingStatusDetail":"..."}'
 * Returns null when command does not look like a tracking-status command.
 */
export function parseBashTrackingStatusCommand(command: string): BashTrackingStatusCommandInfo | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  let shellPrefix: string | undefined;
  let commandBody = trimmed;

  const shellWrapped = trimmed.match(/^(\S+)\s+-lc\s+([\s\S]+)$/);
  if (shellWrapped) {
    shellPrefix = `${shellWrapped[1]} -lc`;
    commandBody = stripWrappingQuotes(shellWrapped[2].trim());
  }

  if (!/\bcurl\b/.test(commandBody)) return null;
  if (!/PATCH/.test(commandBody)) return null;
  if (!/\/api\/agents\//.test(commandBody)) return null;

  const payloadMatch = commandBody.match(/-d\s+((['"])([\s\S]*?)\2)/);
  if (!payloadMatch) return null;

  const rawPayload = stripWrappingQuotes(payloadMatch[1]).replace(/\\"/g, '"');
  const statusMatch = rawPayload.match(/"trackingStatus"\s*:\s*"([^"]*)"/);
  if (!statusMatch?.[1]) return null;

  const detailMatch = rawPayload.match(/"trackingStatusDetail"\s*:\s*"([^"]*)"/);

  return {
    shellPrefix,
    commandBody,
    trackingStatus: statusMatch[1],
    trackingStatusDetail: detailMatch?.[1],
  };
}

/**
 * Parse Bash commands that report task completion to boss via curl POST /api/agents/.../report-task
 * Returns null when command does not look like a report-task command.
 */
export function parseBashReportTaskCommand(command: string): BashReportTaskCommandInfo | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  let shellPrefix: string | undefined;
  let commandBody = trimmed;

  const shellWrapped = trimmed.match(/^(\S+)\s+-lc\s+([\s\S]+)$/);
  if (shellWrapped) {
    shellPrefix = `${shellWrapped[1]} -lc`;
    commandBody = stripWrappingQuotes(shellWrapped[2].trim());
  }

  if (!/\bcurl\b/.test(commandBody)) return null;
  if (!/\/api\/agents\/.*\/report-task\b/.test(commandBody)) return null;

  // Extract summary and status from JSON payload (supports both -d inline and heredoc)
  let summary = '';
  let status: 'completed' | 'failed' = 'completed';

  // Try heredoc format: -d @- <<'EOF'\n{...}\nEOF
  const heredocMatch = commandBody.match(/<<'?EOF'?\s*\n([\s\S]*?)\nEOF/);
  if (heredocMatch) {
    try {
      const parsed = JSON.parse(heredocMatch[1].trim());
      summary = parsed.summary || '';
      status = parsed.status === 'failed' ? 'failed' : 'completed';
    } catch { /* ignore parse errors */ }
  } else {
    // Try inline -d format
    const payloadMatch = commandBody.match(/-d\s+((['"])([\s\S]*?)\2)/);
    if (payloadMatch) {
      const rawPayload = stripWrappingQuotes(payloadMatch[1]).replace(/\\"/g, '"');
      const summaryMatch = rawPayload.match(/"summary"\s*:\s*"([^"]*)"/);
      const statusMatch = rawPayload.match(/"status"\s*:\s*"([^"]*)"/);
      if (summaryMatch) summary = summaryMatch[1];
      if (statusMatch?.[1] === 'failed') status = 'failed';
    }
  }

  return {
    shellPrefix,
    commandBody,
    summary,
    status,
  };
}

export type BashMemoryKind = 'read' | 'save' | 'clear';

export interface BashMemoryCommandInfo {
  shellPrefix?: string;
  commandBody: string;
  kind: BashMemoryKind;
  agentId: string;
  bodyLength?: number;
}

export interface BashMemoryResponseInfo {
  length?: number;
  failed: boolean;
}

const MEMORY_URL_RE = /\/api\/agents\/([a-zA-Z0-9_-]+)\/memory\b/;

export function parseBashMemoryCommand(command: string): BashMemoryCommandInfo | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  let shellPrefix: string | undefined;
  let commandBody = trimmed;

  const shellWrapped = trimmed.match(/^(\S+)\s+-lc\s+([\s\S]+)$/);
  if (shellWrapped) {
    shellPrefix = `${shellWrapped[1]} -lc`;
    commandBody = stripWrappingQuotes(shellWrapped[2].trim());
  }

  if (!/\bcurl\b/.test(commandBody)) return null;
  const urlMatch = commandBody.match(MEMORY_URL_RE);
  if (!urlMatch) return null;

  const agentId = urlMatch[1];
  const methodMatch = commandBody.match(/(?:-X|--request)\s+(?:["']?)(GET|POST|PATCH|PUT|DELETE)(?:["']?)/i);
  const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';

  let kind: BashMemoryKind;
  if (method === 'PATCH' || method === 'PUT' || method === 'POST') kind = 'save';
  else if (method === 'DELETE') kind = 'clear';
  else kind = 'read';

  let bodyLength: number | undefined;
  if (kind === 'save') {
    bodyLength = extractMemoryBodyLength(commandBody);
  }

  return {
    shellPrefix,
    commandBody,
    kind,
    agentId,
    bodyLength,
  };
}

function extractMemoryBodyLength(commandBody: string): number | undefined {
  const heredocMatch = commandBody.match(/<<\s*['"]?(\w+)['"]?\s*\r?\n([\s\S]*?)\r?\n\1\b/);
  const heredocPayload = heredocMatch?.[2];

  let rawPayload: string | undefined;
  if (heredocPayload) {
    rawPayload = heredocPayload.trim();
  } else {
    const inlineMatch = commandBody.match(/-d\s+((['"])([\s\S]*?)\2)/);
    if (inlineMatch) {
      rawPayload = stripWrappingQuotes(inlineMatch[1]).replace(/\\"/g, '"');
    }
  }

  if (!rawPayload) return undefined;

  try {
    const parsed = JSON.parse(rawPayload);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { memory?: unknown }).memory === 'string') {
      return (parsed as { memory: string }).memory.length;
    }
  } catch {
    // Best-effort: extract "memory":"..." with a forgiving regex, count chars after un-escaping JSON sequences.
    const memMatch = rawPayload.match(/"memory"\s*:\s*"([\s\S]*?)"\s*[,}]/);
    if (memMatch) {
      const escaped = memMatch[1];
      try {
        const decoded = JSON.parse(`"${escaped}"`);
        if (typeof decoded === 'string') return decoded.length;
      } catch {
        return escaped.length;
      }
    }
  }
  return undefined;
}

export function parseMemoryResponseInfo(output: string | undefined | null): BashMemoryResponseInfo {
  if (!output) return { failed: false };
  const trimmed = output.trim();
  if (!trimmed) return { failed: false };

  if (/HTTP\/\d\.\d\s+(4|5)\d\d/.test(trimmed)) {
    return { failed: true };
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    return { failed: /\berror\b/i.test(trimmed) || /"ok"\s*:\s*false/.test(trimmed) };
  }

  const jsonSlice = trimmed.slice(firstBrace, lastBrace + 1);
  try {
    const parsed = JSON.parse(jsonSlice);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as { ok?: unknown; length?: unknown; error?: unknown };
      const failed = obj.ok === false || typeof obj.error === 'string';
      const length = typeof obj.length === 'number' ? obj.length : undefined;
      return { length, failed };
    }
  } catch {
    const lengthMatch = jsonSlice.match(/"length"\s*:\s*(\d+)/);
    const failed = /"ok"\s*:\s*false/.test(jsonSlice) || /"error"\s*:\s*"/.test(jsonSlice);
    return {
      length: lengthMatch ? Number.parseInt(lengthMatch[1], 10) : undefined,
      failed,
    };
  }
  return { failed: false };
}
