/**
 * 主管代理消息:生成/指派/委派决策/委派历史/任务书触发与回执/任务开始·输出·完成
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type Agent, type AgentClass, type AgentProvider, type PermissionMode, type ClaudeModel, type CodexModel, type CodexConfig, type DelegationDecision } from '../agent-types.js';

// ============================================================================
// Boss Agent Messages
// ============================================================================

// Spawn a boss agent (Client -> Server)
export interface SpawnBossAgentMessage extends WSMessage {
  type: 'spawn_boss_agent';
  payload: {
    name: string;
    class?: AgentClass;  // Boss class (default: 'boss')
    cwd: string;
    position?: { x: number; y: number; z: number };
    subordinateIds?: string[];  // Initial subordinates (optional)
    useChrome?: boolean;
    permissionMode?: PermissionMode;
    provider?: AgentProvider; // defaults to 'claude' for backwards compatibility
    codexConfig?: CodexConfig;
    codexModel?: CodexModel;
    model?: ClaudeModel; // Claude model to use (defaults to sonnet)
    customInstructions?: string;  // Custom instructions to append to system prompt
    initialSkillIds?: string[];  // Initial skills to assign to the boss
  };
}

// Assign subordinates to a boss (Client -> Server)
export interface AssignSubordinatesMessage extends WSMessage {
  type: 'assign_subordinates';
  payload: {
    bossId: string;
    subordinateIds: string[];
  };
}

// Remove subordinate from boss (Client -> Server)
export interface RemoveSubordinateMessage extends WSMessage {
  type: 'remove_subordinate';
  payload: {
    bossId: string;
    subordinateId: string;
  };
}

// Send command to boss for delegation (Client -> Server)
export interface SendBossCommandMessage extends WSMessage {
  type: 'send_boss_command';
  payload: {
    bossId: string;
    command: string;
  };
}

// Request delegation history (Client -> Server)
export interface RequestDelegationHistoryMessage extends WSMessage {
  type: 'request_delegation_history';
  payload: {
    bossId: string;
  };
}

// Delegation decision notification (Server -> Client)
export interface DelegationDecisionMessage extends WSMessage {
  type: 'delegation_decision';
  payload: DelegationDecision;
}

// Boss subordinates updated (Server -> Client)
export interface BossSubordinatesUpdatedMessage extends WSMessage {
  type: 'boss_subordinates_updated';
  payload: {
    bossId: string;
    subordinateIds: string[];
  };
}

// Delegation history response (Server -> Client)
export interface DelegationHistoryMessage extends WSMessage {
  type: 'delegation_history';
  payload: {
    bossId: string;
    decisions: DelegationDecision[];
  };
}

// Boss spawned agent notification (Server -> Client)
// Used when a boss spawns a subordinate - client should NOT auto-select and should walk to boss
export interface BossSpawnedAgentMessage extends WSMessage {
  type: 'boss_spawned_agent';
  payload: {
    agent: Agent;
    bossId: string;
    bossPosition: { x: number; y: number; z: number };
  };
}

// Agent task started notification (Server -> Client)
// Sent when a subordinate starts working on a delegated task
export interface AgentTaskStartedMessage extends WSMessage {
  type: 'agent_task_started';
  payload: {
    bossId: string;
    subordinateId: string;
    subordinateName: string;
    taskDescription: string;
  };
}

// Agent task output notification (Server -> Client)
// Streaming output from a subordinate working on a delegated task
export interface AgentTaskOutputMessage extends WSMessage {
  type: 'agent_task_output';
  payload: {
    bossId: string;
    subordinateId: string;
    output: string;
  };
}

// Agent task completed notification (Server -> Client)
// Sent when a subordinate completes a delegated task
export interface AgentTaskCompletedMessage extends WSMessage {
  type: 'agent_task_completed';
  payload: {
    bossId: string;
    subordinateId: string;
    success: boolean;
  };
}

// Task receipt notification (Server -> Client)
// 任务08② 回执订阅播报：服务端回执管线（登记→匹配→09 判断层）过筛后转发给客户端播报桥。
// 只在该次判定非 SILENT 时发送（SILENT 在服务端已留 🔴② 埋点，不推送）。
export interface TaskReceiptMessage extends WSMessage {
  type: 'task_receipt';
  payload: {
    /** 完成任务的 agent（订阅匹配对象）。 */
    agentId: string;
    agentName?: string;
    success: boolean;
    /** 是否命中待回执登记（派活闭环）；false = 未匹配完成（防漏报路径）。 */
    matched: boolean;
    taskId?: string;
    decisionId?: string;
    /** 任务摘要（登记时的派活命令，截断 80）。 */
    taskSummary?: string;
    /** 播报文本（服务端判断层过筛后的原样透传；客户端权威复判后出口使用）。 */
    text: string;
    at: number;
    /** 入口来源：runtime 回合结束 / report-task 显式回执。 */
    source: 'runtime' | 'report-task';
    /** 稳定幂等键：agent-completed:{agentId}:{taskId}（无 taskId 回退 @ts 唯一键）。 */
    dedupeKey: string;
    /**
     * 任务41：老板语音直接问的派活回执（登记快照带语音会话 id）。text 为完整回复
     * （非回合末句），客户端在「人还在场」时提分过破例线即刻播；缺省 = 普通回执。
     */
    requested?: boolean;
    /** 服务端观测判定（DEFAULT_GATES_CONFIG 口径；客户端权威判定以其本地判断层为准）。 */
    observed: {
      tier: 'SPEAK' | 'PREPARE' | 'STORE' | 'SILENT';
      reason: string;
      score: number;
    };
  };
}
