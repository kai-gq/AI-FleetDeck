/**
 * 共享助手:路由日志、WebSocket 广播注册与带超时的子进程执行。
 *
 * 自 agents.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { spawn } from 'child_process';
import { createLogger } from '../../utils/logger.js';
import { ServerMessage } from '../../../shared/types.js';

export const log = createLogger('Routes');

// Store for broadcasting via WebSocket
export let broadcastFn: ((message: ServerMessage) => void) | null = null;

/**
 * Set the broadcast function for sending messages to all WebSocket clients
 */
export function setBroadcast(fn: (message: ServerMessage) => void): void {
  broadcastFn = fn;
}

interface ProcessCommandResult {
  exitCode: number | null;
  output: string;
  errorOutput: string;
}

export function runCommandWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd?: string
): Promise<ProcessCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      const output = Buffer.concat(stdoutChunks).toString('utf-8').trim();
      const errorOutput = Buffer.concat(stderrChunks).toString('utf-8').trim();

      if (timedOut) {
        resolve({
          exitCode: code,
          output,
          errorOutput: errorOutput || `Command timed out after ${timeoutMs}ms`,
        });
        return;
      }

      resolve({
        exitCode: code,
        output,
        errorOutput,
      });
    });
  });
}
