/**
 * Git 监听与流式输出:git 轮询推送/输出行/插件输出/上下文统计/压缩状态/错误/命令启动/会话更新/目录缺失
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type AgentClass, type ContextStats } from '../agent-types.js';
import { type SkillUpdateData } from '../common-types.js';
import { type PluginOutputMessagePayload, type PluginOutputPatchMessagePayload } from '../plugin-types.js';

// ============================================================================
// Git Watch (server-side git polling pushed over WS)
// ============================================================================
// Replaces per-client HTTP polling of /api/files/git-status + git-branch:
// clients declare the directories they care about (git_watch), the server
// polls the union once for everyone and pushes git_status_update only when a
// directory's status actually changed.

export interface GitWatchedFile {
  /** Absolute, '/'-separated path of the changed file. */
  path: string;
  name: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'conflict';
  oldPath?: string;
}

export interface GitWatchedDirStatus {
  /** The watched directory exactly as the client requested it. */
  path: string;
  isGitRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  mergeInProgress: boolean;
  /**
   * Changed files, capped at MAX_STATUS_FILES (git-watch-service). A repo with
   * a large untracked tree (build output, caches) can report tens of thousands
   * of entries — serializing all of them produced multi-MB pushes that stalled
   * both the server event loop and every client that parsed them.
   */
  files: GitWatchedFile[];
  /** Real number of changed files, even when `files` is capped. */
  totalFiles: number;
  /** True when `files` holds only the first MAX_STATUS_FILES entries. */
  truncated: boolean;
}

/** Client -> Server: replace this socket's full set of watched directories. */
export interface GitWatchMessage extends WSMessage {
  type: 'git_watch';
  payload: {
    paths: string[];
  };
}

/** Client -> Server: recompute these directories now and push the result. */
export interface GitRefreshMessage extends WSMessage {
  type: 'git_refresh';
  payload: {
    paths: string[];
  };
}

/** Server -> Client: a watched directory's git status (on change or subscribe). */
export interface GitStatusUpdateMessage extends WSMessage {
  type: 'git_status_update';
  payload: GitWatchedDirStatus;
}

// Streaming output from Claude
export interface OutputMessage extends WSMessage {
  type: 'output';
  payload: {
    agentId: string;
    text: string;
    isStreaming: boolean;
    timestamp: number;
    isDelegation?: boolean; // True if this is a delegation message from a boss agent
    skillUpdate?: SkillUpdateData; // Skill update notification (UI only, not injected into conversation)
    subagentName?: string; // Name of subagent if this output is from a delegated task
    uuid?: string; // Unique message UUID for deduplication
    // Tool information extracted from text for better debugger display
    toolName?: string; // Name of tool being used (e.g., "Bash", "Read")
    toolInput?: Record<string, unknown>; // Parsed tool input parameters
    toolInputRaw?: string; // Raw tool input if JSON parsing failed
    toolOutput?: string; // Tool output/result
    reasoningTokens?: number; // Provider-reported hidden reasoning token count
    reasoningSummaryCount?: number; // Plaintext summaries exposed by the provider
    reasoningEncrypted?: boolean; // Detailed reasoning is an encrypted payload
    reasoningSummaryOnly?: boolean; // Visible thinking is only a provider summary
  };
}

/** Structured output emitted by a trusted-local plugin. */
export interface PluginOutputMessage extends WSMessage {
  type: 'plugin_output';
  payload: PluginOutputMessagePayload;
}

/** Replace the data in an existing plugin output instance after an action. */
export interface PluginOutputPatchMessage extends WSMessage {
  type: 'plugin_output_patch';
  payload: PluginOutputPatchMessagePayload;
}

// Context stats response (detailed breakdown from /context command)
export interface ContextStatsMessage extends WSMessage {
  type: 'context_stats';
  payload: {
    agentId: string;
    stats: ContextStats;
  };
}

// Lightweight real-time context update (from usage_snapshot events during streaming)
export interface ContextUpdateMessage extends WSMessage {
  type: 'context_update';
  payload: {
    agentId: string;
    contextUsed: number;
    contextLimit: number;
  };
}

// Context compaction status (active/finished)
export interface CompactingStatusMessage extends WSMessage {
  type: 'compacting_status';
  payload: {
    agentId: string;
    active: boolean;
  };
}

export interface ErrorMessage extends WSMessage {
  type: 'error';
  payload: { message: string };
}

// Command started message - sent when a command begins execution
export interface CommandStartedMessage extends WSMessage {
  type: 'command_started';
  payload: {
    agentId: string;
    command: string;
    /** True when the prompt was queued for delivery after the current turn (stdin-closed backends). */
    queued?: boolean;
  };
}

// Session updated message - sent when an orphaned agent's session file is updated
// Clients should refresh the agent's history when receiving this
export interface SessionUpdatedMessage extends WSMessage {
  type: 'session_updated';
  payload: {
    agentId: string;
  };
}

// Directory not found error - prompts user to create directory
export interface DirectoryNotFoundMessage extends WSMessage {
  type: 'directory_not_found';
  payload: {
    path: string;
    name: string;
    class: AgentClass;
  };
}
