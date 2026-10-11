/**
 * 工作计划消息:增删改/同步/分析请求 与审批·执行·暂停·取消(Client→Server)
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type WorkPlan, type AnalysisRequest } from '../agent-types.js';

// ============================================================================
// Work Plan Messages
// ============================================================================

// Work plan created (Server -> Client)
export interface WorkPlanCreatedMessage extends WSMessage {
  type: 'work_plan_created';
  payload: WorkPlan;
}

// Work plan updated (Server -> Client)
export interface WorkPlanUpdatedMessage extends WSMessage {
  type: 'work_plan_updated';
  payload: WorkPlan;
}

// Work plan deleted (Server -> Client)
export interface WorkPlanDeletedMessage extends WSMessage {
  type: 'work_plan_deleted';
  payload: { id: string };
}

// Work plans sync (Server -> Client) - sent on connect
export interface WorkPlansUpdateMessage extends WSMessage {
  type: 'work_plans_update';
  payload: WorkPlan[];
}

// Analysis request created (Server -> Client)
export interface AnalysisRequestCreatedMessage extends WSMessage {
  type: 'analysis_request_created';
  payload: AnalysisRequest;
}

// Analysis request completed (Server -> Client)
export interface AnalysisRequestCompletedMessage extends WSMessage {
  type: 'analysis_request_completed';
  payload: AnalysisRequest;
}

// Approve work plan (Client -> Server)
export interface ApproveWorkPlanMessage extends WSMessage {
  type: 'approve_work_plan';
  payload: {
    planId: string;
    autoExecute?: boolean;  // Start execution immediately after approval
  };
}

// Execute work plan (Client -> Server)
export interface ExecuteWorkPlanMessage extends WSMessage {
  type: 'execute_work_plan';
  payload: {
    planId: string;
  };
}

// Pause work plan (Client -> Server)
export interface PauseWorkPlanMessage extends WSMessage {
  type: 'pause_work_plan';
  payload: {
    planId: string;
  };
}

// Cancel work plan (Client -> Server)
export interface CancelWorkPlanMessage extends WSMessage {
  type: 'cancel_work_plan';
  payload: {
    planId: string;
  };
}

// Request work plans for a boss (Client -> Server)
export interface RequestWorkPlansMessage extends WSMessage {
  type: 'request_work_plans';
  payload: {
    bossId: string;
  };
}
