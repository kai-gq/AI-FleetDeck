/**
 * 技能消息:同步/增删改/指派/按代理查询与响应
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type Skill } from '../common-types.js';

// ============================================================================
// Skill Messages
// ============================================================================

// Skills sync message (Server -> Client) - sent on connect and when skills change
export interface SkillsUpdateMessage extends WSMessage {
  type: 'skills_update';
  payload: Skill[];
}

// Skill created message (Server -> Client)
export interface SkillCreatedMessage extends WSMessage {
  type: 'skill_created';
  payload: Skill;
}

// Skill updated message (Server -> Client)
export interface SkillUpdatedMessage extends WSMessage {
  type: 'skill_updated';
  payload: Skill;
}

// Skill deleted message (Server -> Client)
export interface SkillDeletedMessage extends WSMessage {
  type: 'skill_deleted';
  payload: { id: string };
}

// Create skill message (Client -> Server)
export interface CreateSkillMessage extends WSMessage {
  type: 'create_skill';
  payload: Omit<Skill, 'id' | 'createdAt' | 'updatedAt'>;
}

// Update skill message (Client -> Server)
export interface UpdateSkillMessage extends WSMessage {
  type: 'update_skill';
  payload: { id: string; updates: Partial<Skill> };
}

// Delete skill message (Client -> Server)
export interface DeleteSkillMessage extends WSMessage {
  type: 'delete_skill';
  payload: { id: string };
}

// Assign skill to agent (Client -> Server)
export interface AssignSkillMessage extends WSMessage {
  type: 'assign_skill';
  payload: {
    skillId: string;
    agentId: string;
  };
}

// Unassign skill from agent (Client -> Server)
export interface UnassignSkillMessage extends WSMessage {
  type: 'unassign_skill';
  payload: {
    skillId: string;
    agentId: string;
  };
}

// Request skills for an agent (Client -> Server)
export interface RequestAgentSkillsMessage extends WSMessage {
  type: 'request_agent_skills';
  payload: {
    agentId: string;
  };
}

// Agent skills response (Server -> Client)
export interface AgentSkillsMessage extends WSMessage {
  type: 'agent_skills';
  payload: {
    agentId: string;
    skills: Skill[];
  };
}
