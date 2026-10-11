/**
 * 运行时进程路由:进程信息(witr)与后台任务列表/输出 tail。
 *
 * 自 agents.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log, runCommandWithTimeout } from './helpers.js';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { agentService, runtimeService } from '../../services/index.js';
import { getBackgroundTasksForAgent } from '../../services/background-tasks.js';

// GET /api/agents/:id/process-output - Get `witr --pid` output for this agent process
export const handleGetIdProcessOutput = async (req: Request<{ id: string }>, res: Response) => {
  try {
    const agentId = req.params.id;
    const agent = agentService.getAgent(agentId);

    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const processInfo = await runtimeService.getAgentRuntimeProcessInfo(agentId);
    if (!processInfo.pid) {
      res.status(404).json({ error: 'No running process found for agent' });
      return;
    }

    const result = await runCommandWithTimeout('witr', ['--pid', String(processInfo.pid)], 8000, agent.cwd);

    res.json({
      agentId,
      pid: processInfo.pid,
      source: processInfo.source,
      command: `witr --pid ${processInfo.pid}`,
      exitCode: result.exitCode,
      output: result.output,
      errorOutput: result.errorOutput,
      fetchedAt: Date.now(),
    });
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      res.status(501).json({ error: 'witr command not found on server' });
      return;
    }

    log.error(' Failed to fetch agent process output:', err);
    res.status(500).json({ error: err?.message || 'Failed to fetch process output' });
  }
};

// GET /api/agents/:id/background-tasks - Active background tasks (backgrounded
// Bash / async subagents) currently tracked for this agent.
export const handleGetIdBackgroundTasks = (req: Request<{ id: string }>, res: Response) => {
  const agent = agentService.getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  res.json({ agentId: agent.id, tasks: getBackgroundTasksForAgent(agent.id) });
};

// GET /api/agents/:id/background-tasks/:key/output?tail=<bytes> - Live tail of a
// background task's output file. `key` is the task's registry key (toolUseId or
// taskId); the file path comes from the registry (parsed from the CLI's launch
// stub) or is derived from the agent's session: <tmp>/claude-<uid>/*/<sessionId>/tasks/<taskId>.output.
export const handleGetIdBackgroundTasksKeyOutput = (req: Request<{ id: string; key: string }>, res: Response) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const task = getBackgroundTasksForAgent(agent.id).find(
      (t) => t.key === req.params.key || t.taskId === req.params.key || t.toolUseId === req.params.key
    );
    if (!task) {
      res.status(404).json({ error: 'Background task not found (it may have finished)' });
      return;
    }

    // Resolve the output file: prefer the stub-reported path, else derive it
    // from the session. Both must land inside the CLI's task-output tree.
    const tasksDirRoot = path.join(os.tmpdir(), `claude-${typeof process.getuid === 'function' ? process.getuid() : 0}`);
    let outputFile = task.outputFile;
    if (!outputFile && task.taskId && agent.sessionId && /^[\w-]+$/.test(task.taskId)) {
      try {
        for (const projectSlug of fs.readdirSync(tasksDirRoot)) {
          const candidate = path.join(tasksDirRoot, projectSlug, agent.sessionId, 'tasks', `${task.taskId}.output`);
          if (fs.existsSync(candidate)) {
            outputFile = candidate;
            break;
          }
        }
      } catch { /* tmp dir absent — treated as no output below */ }
    }
    if (!outputFile) {
      res.json({ agentId: agent.id, key: task.key, exists: false, content: '', size: 0 });
      return;
    }
    // Containment check: only files inside the CLI task-output tree are readable.
    const resolved = path.resolve(outputFile);
    if (!resolved.startsWith(tasksDirRoot + path.sep) || !resolved.endsWith('.output') || !resolved.includes(`${path.sep}tasks${path.sep}`)) {
      res.status(400).json({ error: 'Output file outside the task-output directory' });
      return;
    }
    if (!fs.existsSync(resolved)) {
      res.json({ agentId: agent.id, key: task.key, exists: false, content: '', size: 0, outputFile: resolved });
      return;
    }

    const tailBytes = Math.min(Math.max(Number(req.query.tail) || 4000, 256), 65536);
    const stat = fs.statSync(resolved);
    const start = Math.max(0, stat.size - tailBytes);
    const fd = fs.openSync(resolved, 'r');
    let content: string;
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      content = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // A mid-file start almost always lands inside a line — drop the partial one.
    if (start > 0) {
      const firstNewline = content.indexOf('\n');
      if (firstNewline !== -1) content = content.slice(firstNewline + 1);
    }

    res.json({
      agentId: agent.id,
      key: task.key,
      exists: true,
      content,
      size: stat.size,
      truncated: start > 0,
      mtimeMs: stat.mtimeMs,
      outputFile: resolved,
    });
  } catch (err: any) {
    log.error(' Failed to tail background task output:', err);
    res.status(500).json({ error: err?.message || 'Failed to read task output' });
  }
};
