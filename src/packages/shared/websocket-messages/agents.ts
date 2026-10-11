/**
 * Agent 消息(双向):生命周期/活动/服务器时间/心跳(Server→Client)+ 生成/克隆/命令/重连/移动/上下文/会话恢复(Client→Server)
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type Agent, type AgentClass, type AgentProvider, type PermissionMode, type ClaudeModel, type ClaudeEffort, type CodexModel, type CodexConfig } from '../agent-types.js';
import { type ClaudeEvent } from '../common-types.js';

// ============================================================================
// Agent Messages (Server -> Client)
// ============================================================================

export interface AgentsUpdateMessage extends WSMessage {
  type: 'agents_update';
  payload: Agent[];
}

export interface AgentCreatedMessage extends WSMessage {
  type: 'agent_created';
  payload: Agent;
}

export interface AgentUpdatedMessage extends WSMessage {
  type: 'agent_updated';
  payload: Agent;
}

export interface AgentDeletedMessage extends WSMessage {
  type: 'agent_deleted';
  payload: { id: string };
}

export interface EventMessage extends WSMessage {
  type: 'event';
  payload: ClaudeEvent & { agentId: string };
}

export interface ActivityMessage extends WSMessage {
  type: 'activity';
  payload: {
    agentId: string;
    agentName: string;
    message: string;
    timestamp: number;
  };
}

// Sent once on connection so clients can align their clock with the server's
// before any output arrives. Client-stamped optimistic items (user prompts,
// error rows) sort against server-stamped outputs by epoch ms, so a device
// with a skewed clock (mobile) needs this sample from the very first message.
export interface ServerTimeMessage extends WSMessage {
  type: 'server_time';
  payload: {
    timestamp: number;
  };
}

// Application-level liveness probe (client → server). Mobile sockets can die
// without a close event (doze, WiFi↔cellular switch, NAT timeout) and sit in
// readyState OPEN for minutes while every send goes into a dead pipe. Clients
// send a ping and expect ANY inbound frame within a deadline; if nothing
// arrives they discard the socket and reconnect.
export interface PingMessage extends WSMessage {
  type: 'ping';
  payload: {
    ts: number;
  };
}

// Server reply to PingMessage, echoing the client's timestamp. Sent only to
// the pinging socket, never broadcast.
export interface PongMessage extends WSMessage {
  type: 'pong';
  payload: {
    ts: number;
  };
}

// ============================================================================
// Agent Messages (Client -> Server)
// ============================================================================

export interface SpawnAgentMessage extends WSMessage {
  type: 'spawn_agent';
  payload: {
    name: string;
    class: AgentClass;
    cwd: string;
    position?: { x: number; y: number; z: number };
    sessionId?: string;
    useChrome?: boolean;
    permissionMode?: PermissionMode; // defaults to 'bypass' for backwards compatibility
    provider?: AgentProvider; // defaults to 'claude' for backwards compatibility
    codexConfig?: CodexConfig;
    codexModel?: CodexModel;
    opencodeModel?: string;
    grokModel?: string;
    piModel?: string;
    initialSkillIds?: string[]; // Skills to assign on creation
    model?: ClaudeModel; // Claude model to use (defaults to sonnet)
    effort?: ClaudeEffort;
    customInstructions?: string;  // Custom instructions to append to system prompt
  };
}

// Clone an existing agent (duplicate its configuration into a new agent)
export interface CloneAgentMessage extends WSMessage {
  type: 'clone_agent';
  payload: {
    sourceAgentId: string;
    name?: string; // defaults to "<source name> (Copy)"
    position?: { x: number; y: number; z: number };
  };
}

// Fork an existing agent: duplicate its config AND continue its conversation
// history (Claude/OpenCode). Falls back to a plain clone for unsupported
// providers or agents with no session.
export interface ForkAgentMessage extends WSMessage {
  type: 'fork_agent';
  payload: {
    sourceAgentId: string;
    name?: string; // defaults to "<source name> (Fork)"
    position?: { x: number; y: number; z: number };
  };
}

export interface SendCommandMessage extends WSMessage {
  type: 'send_command';
  payload: {
    agentId: string;
    command: string;
    /**
     * For stdin-closed backends (Grok/Codex/OpenCode): when true, interrupt the
     * in-flight turn and respawn with this prompt immediately. Default is to
     * queue the message until the agent is free.
     */
    forceInterrupt?: boolean;
    /** Queue behind the active turn instead of steering/interleaving it. */
    queueOnly?: boolean;
  };
}

export interface ReattachAgentMessage extends WSMessage {
  type: 'reattach_agent';
  payload: {
    agentId: string;
  };
}

export interface MoveAgentMessage extends WSMessage {
  type: 'move_agent';
  payload: {
    agentId: string;
    position: { x: number; y: number; z: number };
  };
}

export interface KillAgentMessage extends WSMessage {
  type: 'kill_agent';
  payload: {
    agentId: string;
  };
}

// Stop current operation (but keep agent alive)
export interface StopAgentMessage extends WSMessage {
  type: 'stop_agent';
  payload: {
    agentId: string;
  };
}

// Toggle standby (待岗) — reversible user-only deactivation. standby=true stops
// the agent and makes it refuse every command; false restores it (idle, no
// auto-resume). Only the user's panel sends this; the REST API blocks it.
export interface SetAgentStandbyMessage extends WSMessage {
  type: 'set_agent_standby';
  payload: {
    agentId: string;
    standby: boolean;
  };
}

// Clear agent's context/session (force new session on next command)
export interface ClearContextMessage extends WSMessage {
  type: 'clear_context';
  payload: {
    agentId: string;
  };
}

// ── browser bridge (server ⇄ extension live-page commands) ──
// The extension side panel registers its WebSocket as able to run browser
// commands (DOM / console / network / screenshot reads in the user's live,
// logged-in session). One register per open panel.
export interface BrowserRegisterMessage extends WSMessage {
  type: 'browser_register';
  payload: { origin?: string };
}

// The extension returns the result of a relayed browser command, correlated to
// the originating request by reqId.
export interface BrowserResultMessage extends WSMessage {
  type: 'browser_result';
  payload: { reqId: string; ok: boolean; result?: unknown; error?: string };
}

// Server → extension: run a command in the live page (reqId for correlation).
export interface BrowserCommandMessage extends WSMessage {
  type: 'browser_command';
  payload: { reqId: string; cmd: string; args?: Record<string, unknown> };
}

// Restore a previous session for an agent
export interface RestoreSessionMessage extends WSMessage {
  type: 'restore_session';
  payload: {
    agentId: string;
    sessionId: string;
    /** Optional cwd to attach to the agent alongside the session — used for
     *  cross-project restore from the global Session Finder. */
    cwd?: string;
  };
}

// Restore a session onto a BRAND-NEW agent (Session Finder "Restore to new
// agent"). The server copies the config+skills of the most similar existing
// agent (most recently worked, same cwd as the session) or spawns defaults.
export interface RestoreSessionNewAgentMessage extends WSMessage {
  type: 'restore_session_new_agent';
  payload: {
    sessionId: string;
    /** The session's project path — becomes the new agent's cwd. */
    cwd: string;
    name?: string;
  };
}

// Request session history for an agent
export interface RequestSessionHistoryMessage extends WSMessage {
  type: 'request_session_history';
  payload: {
    agentId: string;
  };
}

// Server -> client: session history response
export interface SessionHistoryMessage extends WSMessage {
  type: 'session_history';
  payload: {
    agentId: string;
    entries: import('../agent-types.js').SessionHistoryEntry[];
  };
}

// Collapse context (compact the session to save tokens)
export interface CollapseContextMessage extends WSMessage {
  type: 'collapse_context';
  payload: {
    agentId: string;
  };
}

// Request detailed context stats (triggers /context command)
export interface RequestContextStatsMessage extends WSMessage {
  type: 'request_context_stats';
  payload: {
    agentId: string;
  };
}

export interface CreateDirectoryMessage extends WSMessage {
  type: 'create_directory';
  payload: {
    path: string;
    name: string;
    class: AgentClass;
  };
}

// Remove agent from UI and persistence (keeps Claude session running)
export interface RemoveAgentMessage extends WSMessage {
  type: 'remove_agent';
  payload: {
    agentId: string;
  };
}

// Rename agent
export interface RenameAgentMessage extends WSMessage {
  type: 'rename_agent';
  payload: {
    agentId: string;
    name: string;
  };
}

// Update agent properties (class, permission mode, skills, model)
export interface UpdateAgentPropertiesMessage extends WSMessage {
  type: 'update_agent_properties';
  payload: {
    agentId: string;
    updates: {
      class?: AgentClass;
      permissionMode?: PermissionMode;
      provider?: AgentProvider;
      model?: ClaudeModel;
      codexModel?: CodexModel;
      codexConfig?: CodexConfig;
      opencodeModel?: string;
      grokModel?: string;
      piModel?: string;
      effort?: ClaudeEffort;
      useChrome?: boolean;
      skillIds?: string[];  // Complete list of skill IDs to assign (replaces existing)
      cwd?: string;
      shortcut?: string;
    };
  };
}
