/**
 * 工作流消息:定义同步/实例状态/步骤进度/变量/完成与错误/手动转移
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type WorkflowDefinition, type CreateWorkflowPayload, type UpdateWorkflowPayload } from '../workflow-types.js';
import { type WorkflowInstanceRow, type WorkflowStepLogRow, type VariableChangeRow } from '../event-types.js';

// Workflow definitions sync (Server -> Client) - sent on connect
export interface WorkflowDefinitionsUpdateMessage extends WSMessage {
  type: 'workflow_definitions_update';
  payload: WorkflowDefinition[];
}

// Workflow definition created (Server -> Client)
export interface WorkflowDefinitionCreatedMessage extends WSMessage {
  type: 'workflow_definition_created';
  payload: WorkflowDefinition;
}

// Workflow definition updated (Server -> Client)
export interface WorkflowDefinitionUpdatedMessage extends WSMessage {
  type: 'workflow_definition_updated';
  payload: WorkflowDefinition;
}

// Workflow definition deleted (Server -> Client)
export interface WorkflowDefinitionDeletedMessage extends WSMessage {
  type: 'workflow_definition_deleted';
  payload: { id: string };
}

// Workflow instance created (Server -> Client)
export interface WorkflowInstanceCreatedMessage extends WSMessage {
  type: 'workflow_instance_created';
  payload: WorkflowInstanceRow;
}

// Workflow instance updated (Server -> Client)
export interface WorkflowInstanceUpdatedMessage extends WSMessage {
  type: 'workflow_instance_updated';
  payload: WorkflowInstanceRow;
}

// Workflow state changed (Server -> Client)
export interface WorkflowStateChangedMessage extends WSMessage {
  type: 'workflow_state_changed';
  payload: {
    instanceId: string;
    fromState: string;
    toState: string;
    transition: string;
    stepLogId: number;
  };
}

// Workflow step progress update (Server -> Client)
export interface WorkflowStepUpdateMessage extends WSMessage {
  type: 'workflow_step_update';
  payload: {
    instanceId: string;
    step: WorkflowStepLogRow;
  };
}

// Workflow variable changed (Server -> Client)
export interface WorkflowVariableChangedMessage extends WSMessage {
  type: 'workflow_variable_changed';
  payload: {
    instanceId: string;
    change: VariableChangeRow;
  };
}

// Workflow completed (Server -> Client)
export interface WorkflowCompletedMessage extends WSMessage {
  type: 'workflow_completed';
  payload: { instanceId: string };
}

// Workflow error (Server -> Client)
export interface WorkflowErrorMessage extends WSMessage {
  type: 'workflow_error';
  payload: { instanceId: string; error: string };
}

// Create workflow definition (Client -> Server)
export interface CreateWorkflowDefMessage extends WSMessage {
  type: 'create_workflow_def';
  payload: CreateWorkflowPayload;
}

// Update workflow definition (Client -> Server)
export interface UpdateWorkflowDefMessage extends WSMessage {
  type: 'update_workflow_def';
  payload: { id: string; updates: UpdateWorkflowPayload };
}

// Delete workflow definition (Client -> Server)
export interface DeleteWorkflowDefMessage extends WSMessage {
  type: 'delete_workflow_def';
  payload: { id: string };
}

// Start workflow (Client -> Server)
export interface StartWorkflowMessage extends WSMessage {
  type: 'start_workflow';
  payload: {
    workflowDefId: string;
    initialVariables?: Record<string, unknown>;
  };
}

// Pause workflow (Client -> Server)
export interface PauseWorkflowMessage extends WSMessage {
  type: 'pause_workflow';
  payload: { instanceId: string };
}

// Resume workflow (Client -> Server)
export interface ResumeWorkflowMessage extends WSMessage {
  type: 'resume_workflow';
  payload: { instanceId: string };
}

// Cancel workflow (Client -> Server)
export interface CancelWorkflowMessage extends WSMessage {
  type: 'cancel_workflow';
  payload: { instanceId: string };
}

// Manual transition (Client -> Server)
export interface ManualTransitionMessage extends WSMessage {
  type: 'manual_transition';
  payload: { instanceId: string; transitionId: string };
}
