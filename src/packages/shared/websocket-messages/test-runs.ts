/**
 * 测试运行与 HTTP 请求运行消息:启动/输出/进度/完成(流式)
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type TestRunnerType, type TestRunResult, type TestRunStatus } from '../test-runner-types.js';
import { type HttpRunResult } from '../http-requests-types.js';

// ============================================================================
// Test Run Messages (Streaming Test Execution)
// ============================================================================

// Test run started message (Server -> Client)
export interface TestRunStartedMessage extends WSMessage {
  type: 'test_run_started';
  payload: {
    runId: string;
    runnerType: TestRunnerType;
    moduleRoot: string;
    command: string;
    label: string;
    targetPath: string; // folder the user clicked "Run Tests" on
    agentId?: string; // set when an agent started the run (streams inline in its terminal)
  };
}

// Test run output message (Server -> Client) - streaming console output
export interface TestRunOutputMessage extends WSMessage {
  type: 'test_run_output';
  payload: {
    runId: string;
    output: string;
    isError?: boolean;
    agentId?: string; // repeated so a late-loading client can associate the run
  };
}

// Test run progress message (Server -> Client) - partial parsed results streamed
// while the run is still in flight (each suite appears as its report is written).
export interface TestRunProgressMessage extends WSMessage {
  type: 'test_run_progress';
  payload: {
    runId: string;
    result: TestRunResult;
  };
}

// Test run completed message (Server -> Client) - carries parsed results
export interface TestRunCompletedMessage extends WSMessage {
  type: 'test_run_completed';
  payload: {
    runId: string;
    status: TestRunStatus;
    exitCode: number | null;
    result: TestRunResult;
    error?: string; // set when the run could not start / produce results
    agentId?: string; // repeated so a late-loading client can associate the run
  };
}

// HTTP request run started (Server -> Client) — fired by POST /api/http-requests/run
// so the initiating agent's terminal shows a live inline card (like test runs).
export interface HttpRunStartedMessage extends WSMessage {
  type: 'http_run_started';
  payload: {
    runId: string;
    agentId?: string; // set when an agent fired the request (renders inline in its terminal)
    folder: string;
    relFile: string;
    requestIndex: number;
    requestName: string;
    method: string;
    url: string; // raw URL as written (may contain {{vars}})
    env?: string;
  };
}

// HTTP request run completed (Server -> Client) — carries the full result.
export interface HttpRunCompletedMessage extends WSMessage {
  type: 'http_run_completed';
  payload: {
    runId: string;
    agentId?: string;
    result: HttpRunResult;
  };
}
