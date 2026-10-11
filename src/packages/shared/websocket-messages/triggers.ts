/**
 * 触发器消息:同步/增删改/触发与错误通知/手动触发
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type Trigger } from '../trigger-types.js';

// Triggers sync message (Server -> Client) - sent on connect
export interface TriggersUpdateMessage extends WSMessage {
  type: 'triggers_update';
  payload: Trigger[];
}

// Trigger created message (Server -> Client)
export interface TriggerCreatedMessage extends WSMessage {
  type: 'trigger_created';
  payload: Trigger;
}

// Trigger updated message (Server -> Client)
export interface TriggerUpdatedMessage extends WSMessage {
  type: 'trigger_updated';
  payload: Trigger;
}

// Trigger deleted message (Server -> Client)
export interface TriggerDeletedMessage extends WSMessage {
  type: 'trigger_deleted';
  payload: { id: string };
}

// Trigger fired notification (Server -> Client)
export interface TriggerFiredMessage extends WSMessage {
  type: 'trigger_fired';
  payload: {
    triggerId: string;
    agentId: string;
    timestamp: number;
  };
}

// Trigger error notification (Server -> Client)
export interface TriggerErrorMessage extends WSMessage {
  type: 'trigger_error';
  payload: {
    triggerId: string;
    error: string;
  };
}

// Create trigger (Client -> Server)
export interface CreateTriggerMessage extends WSMessage {
  type: 'create_trigger';
  payload: Omit<Trigger, 'id' | 'createdAt' | 'updatedAt' | 'fireCount'>;
}

// Update trigger (Client -> Server)
export interface UpdateTriggerMessage extends WSMessage {
  type: 'update_trigger';
  payload: { id: string; updates: Partial<Trigger> };
}

// Delete trigger (Client -> Server)
export interface DeleteTriggerMessage extends WSMessage {
  type: 'delete_trigger';
  payload: { id: string };
}

// Fire trigger manually (Client -> Server)
export interface FireTriggerMessage extends WSMessage {
  type: 'fire_trigger';
  payload: { id: string; variables?: Record<string, string> };
}

// ============================================================================
// Workflow Messages
// ============================================================================
