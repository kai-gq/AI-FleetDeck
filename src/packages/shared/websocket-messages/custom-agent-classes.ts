/**
 * 自定义代理类消息:同步/增删改
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type CustomAgentClass } from '../agent-types.js';

// ============================================================================
// Custom Agent Class Messages
// ============================================================================

// Custom agent classes sync message (Server -> Client)
export interface CustomAgentClassesUpdateMessage extends WSMessage {
  type: 'custom_agent_classes_update';
  payload: CustomAgentClass[];
}

// Custom agent class created message (Server -> Client)
export interface CustomAgentClassCreatedMessage extends WSMessage {
  type: 'custom_agent_class_created';
  payload: CustomAgentClass;
}

// Custom agent class updated message (Server -> Client)
export interface CustomAgentClassUpdatedMessage extends WSMessage {
  type: 'custom_agent_class_updated';
  payload: CustomAgentClass;
}

// Custom agent class deleted message (Server -> Client)
export interface CustomAgentClassDeletedMessage extends WSMessage {
  type: 'custom_agent_class_deleted';
  payload: { id: string };
}

// Create custom agent class message (Client -> Server)
export interface CreateCustomAgentClassMessage extends WSMessage {
  type: 'create_custom_agent_class';
  payload: Omit<CustomAgentClass, 'id' | 'createdAt' | 'updatedAt'>;
}

// Update custom agent class message (Client -> Server)
export interface UpdateCustomAgentClassMessage extends WSMessage {
  type: 'update_custom_agent_class';
  payload: { id: string; updates: Partial<CustomAgentClass> };
}

// Delete custom agent class message (Client -> Server)
export interface DeleteCustomAgentClassMessage extends WSMessage {
  type: 'delete_custom_agent_class';
  payload: { id: string };
}
