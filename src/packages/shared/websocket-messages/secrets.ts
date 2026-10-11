/**
 * 密钥消息:同步/增删改
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type Secret } from '../common-types.js';

// ============================================================================
// Secrets Messages
// ============================================================================

// Secrets sync message (Server -> Client) - sent on connect and when secrets change
export interface SecretsUpdateMessage extends WSMessage {
  type: 'secrets_update';
  payload: Secret[];
}

// Secret created message (Server -> Client)
export interface SecretCreatedMessage extends WSMessage {
  type: 'secret_created';
  payload: Secret;
}

// Secret updated message (Server -> Client)
export interface SecretUpdatedMessage extends WSMessage {
  type: 'secret_updated';
  payload: Secret;
}

// Secret deleted message (Server -> Client)
export interface SecretDeletedMessage extends WSMessage {
  type: 'secret_deleted';
  payload: { id: string };
}

// Create secret message (Client -> Server)
export interface CreateSecretMessage extends WSMessage {
  type: 'create_secret';
  payload: Omit<Secret, 'id' | 'createdAt' | 'updatedAt'>;
}

// Update secret message (Client -> Server)
export interface UpdateSecretMessage extends WSMessage {
  type: 'update_secret';
  payload: { id: string; updates: Partial<Omit<Secret, 'id' | 'createdAt' | 'updatedAt'>> };
}

// Delete secret message (Client -> Server)
export interface DeleteSecretMessage extends WSMessage {
  type: 'delete_secret';
  payload: { id: string };
}
