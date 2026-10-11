/**
 * 会话核心类型:SessionProvider/ResolvedSessionFile 与消息、会话、历史、工具执行、文件变更类型。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */


export type SessionProvider = 'claude' | 'codex' | 'opencode' | 'grok' | 'pi';

export interface ResolvedSessionFile {
  provider: SessionProvider;
  filePath: string;
  // When set, the opencode session lives in the SQLite DB and filePath points
  // at opencode.db (used only for a stat-based fallback mtime).
  opencodeDbSessionId?: string;
  // Grok: path to the session directory (chat_history.jsonl lives inside).
  grokSessionDir?: string;
}

// Message types from Claude session files
export interface SessionMessage {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string;
  timestamp: string;
  uuid: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string; // For linking tool_use with tool_result
  reasoningTokens?: number;
  reasoningSummaryCount?: number;
  reasoningEncrypted?: boolean;
  reasoningSummaryOnly?: boolean;
}

export interface SessionInfo {
  sessionId: string;
  projectPath: string;
  lastModified: Date;
  messageCount: number;
}

export interface ConversationHistory {
  sessionId: string;
  messages: SessionMessage[];
  cwd: string;
  totalCount: number;
  hasMore: boolean;
}

export interface ToolExecution {
  agentId: string;
  agentName: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  timestamp: number;
}

export interface FileChange {
  agentId: string;
  agentName: string;
  action: 'created' | 'modified' | 'deleted' | 'read';
  filePath: string;
  timestamp: number;
}
