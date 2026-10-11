/**
 * 权限与代理提示消息:权限请求/决议 + AskUserQuestion/ExitPlanMode 提示请求与决议
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type PermissionRequest, type PermissionResponse, type AgentPrompt } from '../common-types.js';

// ============================================================================
// Permission Messages
// ============================================================================

// Permission WebSocket messages (Server -> Client)
export interface PermissionRequestMessage extends WSMessage {
  type: 'permission_request';
  payload: PermissionRequest;
}

export interface PermissionResolvedMessage extends WSMessage {
  type: 'permission_resolved';
  payload: {
    requestId: string;
    approved: boolean;
  };
}

// Permission WebSocket messages (Client -> Server)
export interface PermissionResponseMessage extends WSMessage {
  type: 'permission_response';
  payload: PermissionResponse;
}

// ============================================================================
// Agent Prompt Messages (AskUserQuestion / ExitPlanMode via MCP perm-prompt)
// ============================================================================

// Server -> Client: a new prompt is awaiting human input
export interface AgentPromptRequestMessage extends WSMessage {
  type: 'agent_prompt_request';
  payload: AgentPrompt;
}

// Server -> Client: prompt has been resolved (either via UI response or timeout/cancel)
export interface AgentPromptResolvedMessage extends WSMessage {
  type: 'agent_prompt_resolved';
  payload: {
    requestId: string;
    approved: boolean;
  };
}
