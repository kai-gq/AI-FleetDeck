/**
 * 子代理消息:启动/输出/完成/流式(Server→Client)
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type Subagent, type AgentBackgroundTask } from '../agent-types.js';

// ============================================================================
// Subagent Messages
// ============================================================================

// Subagent started message (Server -> Client)
export interface SubagentStartedMessage extends WSMessage {
  type: 'subagent_started';
  payload: Subagent;
}

// Subagent output message (Server -> Client)
export interface SubagentOutputMessage extends WSMessage {
  type: 'subagent_output';
  payload: {
    subagentId: string;
    parentAgentId: string;
    text: string;
    isStreaming: boolean;
    timestamp: number;
  };
}

// Subagent completed message (Server -> Client)
export interface SubagentCompletedMessage extends WSMessage {
  type: 'subagent_completed';
  payload: {
    subagentId: string;
    parentAgentId: string;
    success: boolean;
    resultPreview?: string;           // First 500 chars of result
    subagentName?: string;            // Name of the subagent
    // Completion stats
    durationMs?: number;
    tokensUsed?: number;
    toolUseCount?: number;
  };
}

// Subagent JSONL stream message (Server -> Client)
export interface SubagentStreamMessage extends WSMessage {
  type: 'subagent_stream';
  payload: {
    toolUseId: string;
    parentAgentId: string;
    entries: import('../agent-types.js').SubagentStreamEntry[];
  };
}

// Active-background-task snapshot for one agent (Server -> Client).
// Sent whenever the agent's set of live background tasks changes (task
// launched / finished / cleared) and on connect for agents with active tasks.
export interface BackgroundTasksUpdateMessage extends WSMessage {
  type: 'background_tasks_update';
  payload: {
    agentId: string;
    tasks: AgentBackgroundTask[];
  };
}
