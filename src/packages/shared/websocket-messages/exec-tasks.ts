/**
 * Exec 任务消息:启动/快照/输出/完成(流式)
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';

// ============================================================================
// Exec Task Messages
// ============================================================================

// Exec task started message (Server -> Client)
export interface ExecTaskStartedMessage extends WSMessage {
  type: 'exec_task_started';
  payload: {
    taskId: string;
    agentId: string;
    agentName: string;
    command: string;
    cwd: string;
    // Running under a PTY — output chunks are a raw terminal stream to replay
    // through TerminalRenderer instead of appending line-by-line.
    pty?: boolean;
    /** Server-clock start (ms) — matches the server-stamped terminal rows. */
    startedAt?: number;
    /** tool_use id of the Bash call that issued the /api/exec curl (server-paired). */
    toolUseId?: string;
  };
}

// Exec tasks snapshot (Server -> Client, on connection). A page that loads or
// reconnects MID-task would otherwise never see exec_task_started — the live
// card could not exist. Also carries recently-COMPLETED tasks: a short exec
// finishes before a reload/agent-switch lands, and without its task in the
// store the terminal row can never attach the card. Carries a bounded output
// tail to seed the card; the client also resolves any local "running" card
// absent from the snapshot's RUNNING set (its task ended while disconnected).
export interface ExecTasksSnapshotMessage extends WSMessage {
  type: 'exec_tasks_snapshot';
  payload: {
    tasks: Array<{
      taskId: string;
      agentId: string;
      agentName: string;
      command: string;
      cwd: string;
      pty?: boolean;
      startedAt: number;
      toolUseId?: string;
      /** Buffered output so far (tail-capped server-side). */
      outputTail: string;
      /** Absent = running (older servers only sent running tasks). */
      status?: 'running' | 'completed' | 'failed';
      exitCode?: number | null;
      completedAt?: number;
    }>;
  };
}

// Exec task output message (Server -> Client) - streaming output
export interface ExecTaskOutputMessage extends WSMessage {
  type: 'exec_task_output';
  payload: {
    taskId: string;
    agentId: string;
    output: string;
    isError?: boolean;
  };
}

// Exec task completed message (Server -> Client)
export interface ExecTaskCompletedMessage extends WSMessage {
  type: 'exec_task_completed';
  payload: {
    taskId: string;
    agentId: string;
    exitCode: number | null;
    success: boolean;
    /** Server-clock completion time (ms). */
    completedAt?: number;
  };
}
