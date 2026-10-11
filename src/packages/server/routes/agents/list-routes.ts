/**
 * Agent 集合路由:列表、简单列表、状态轮询、工具历史、Claude 会话、跟踪状态与新建。
 *
 * 自 agents.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log } from './helpers.js';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { agentService, runtimeService } from '../../services/index.js';

// GET /api/agents/claude-sessions - List all Claude Code sessions
// NOTE: This must be defined BEFORE /:id routes to prevent being interpreted as an ID
export const handleGetClaudeSessions = async (req: Request, res: Response) => {
  try {
    const cwd = req.query.cwd as string | undefined;
    const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

    interface SessionWithProject {
      sessionId: string;
      projectPath: string;
      lastModified: Date;
      messageCount: number;
      firstMessage?: string;
    }

    const allSessions: SessionWithProject[] = [];

    if (cwd) {
      // List sessions for specific directory - optimized for speed
      // Only read file metadata and first few KB to find first message
      const projectDir = path.join(os.homedir(), '.claude', 'projects');
      const encodedPath = cwd.replace(/\/+$/, '').replace(/[/_]/g, '-');
      const sessionDir = path.join(projectDir, encodedPath);

      if (fs.existsSync(sessionDir)) {
        const files = fs.readdirSync(sessionDir);

        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;

          const sessionId = file.replace('.jsonl', '');
          const filePath = path.join(sessionDir, file);

          try {
            const stats = fs.statSync(filePath);

            // Estimate message count from file size (avg ~500 bytes per message)
            const estimatedMessages = Math.max(1, Math.round(stats.size / 500));

            // Only read first 8KB to find first user message (much faster)
            const fd = fs.openSync(filePath, 'r');
            const buffer = Buffer.alloc(8192);
            const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
            fs.closeSync(fd);

            const chunk = buffer.toString('utf-8', 0, bytesRead);
            const lines = chunk.split('\n');

            let firstMessage: string | undefined;
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const parsed = JSON.parse(line);
                if (parsed.type === 'user' && parsed.message?.content) {
                  const msg = typeof parsed.message.content === 'string'
                    ? parsed.message.content
                    : (Array.isArray(parsed.message.content) && parsed.message.content[0]?.text) || '';
                  firstMessage = msg.substring(0, 100);
                  break;
                }
              } catch {
                // Skip invalid/incomplete lines
              }
            }

            allSessions.push({
              sessionId,
              projectPath: cwd,
              lastModified: stats.mtime,
              messageCount: estimatedMessages,
              firstMessage,
            });
          } catch {
            // Skip files that can't be read
          }
        }

        // Sort by last modified, newest first
        allSessions.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
      }
    } else {
      // List all sessions across all projects
      if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
        const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);

        for (const encodedPath of projectDirs) {
          const projectDir = path.join(CLAUDE_PROJECTS_DIR, encodedPath);
          const stats = fs.statSync(projectDir);
          if (!stats.isDirectory()) continue;

          // Decode path: -home-user-project -> /home/user/project
          const decodedPath = encodedPath.replace(/^-/, '/').replace(/-/g, '/');

          const files = fs.readdirSync(projectDir);
          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue;

            const sessionId = file.replace('.jsonl', '');
            const filePath = path.join(projectDir, file);
            const fileStats = fs.statSync(filePath);

            // Count messages quickly
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());
            let messageCount = 0;
            let firstMessage: string | undefined;

            for (const line of lines) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.type === 'user' || parsed.type === 'assistant') {
                  messageCount++;
                  if (!firstMessage && parsed.type === 'user' && parsed.message?.content) {
                    const msg = typeof parsed.message.content === 'string'
                      ? parsed.message.content
                      : parsed.message.content[0]?.text || '';
                    firstMessage = msg.substring(0, 100);
                  }
                }
              } catch {
                // Skip invalid lines
              }
            }

            allSessions.push({
              sessionId,
              projectPath: decodedPath,
              lastModified: fileStats.mtime,
              messageCount,
              firstMessage,
            });
          }
        }

        // Sort by last modified, newest first
        allSessions.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
      }
    }

    // Return top 20 sessions
    res.json({ sessions: allSessions.slice(0, 20) });
  } catch (err: any) {
    log.error(' Failed to list Claude sessions:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/agents/tool-history - Get tool history for all agents
// NOTE: This must be defined BEFORE /:id routes to prevent "tool-history" being interpreted as an ID
export const handleGetToolHistory = async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const result = await agentService.getAllToolHistory(limit);
    res.json(result);
  } catch (err: any) {
    log.error(' Failed to load tool history:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/agents/status - Get lightweight status for all agents (for polling)
// NOTE: Must be before /:id route
export const handleGetStatus = async (_req: Request, res: Response) => {
  try {
    // Sync status before returning
    await runtimeService.syncAllAgentStatus();

    const agents = agentService.getAllAgents();

    // Return lightweight status
    const statuses = agents.map((agent) => ({
      id: agent.id,
      status: agent.status,
      currentTask: agent.currentTask,
      currentTool: agent.currentTool,
      isProcessRunning: runtimeService.isAgentRunning(agent.id),
      standby: agent.standby === true,
    }));

    res.json(statuses);
  } catch (err: any) {
    log.error(' Failed to get agent status:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/agents - List all agents
export const handleGetRoot = (_req: Request, res: Response) => {
  const agents = agentService.getAllAgents();
  res.json(agents);
};

// GET /api/agents/simple - List all agents (ids and names only)
export const handleGetSimple = (_req: Request, res: Response) => {
  const agents = agentService.getAllAgents();
  res.json(agents.map(agent => ({ id: agent.id, name: agent.name })));
};

// POST /api/agents - Create new agent
export const handlePostRoot = async (req: Request, res: Response) => {
  try {
    const { name, class: agentClass, cwd, position } = req.body;

    if (!name || !agentClass || !cwd) {
      res.status(400).json({ error: 'Missing required fields: name, class, cwd' });
      return;
    }

    const agent = await agentService.createAgent(name, agentClass, cwd, position);
    res.status(201).json(agent);
  } catch (err: any) {
    log.error(' Failed to create agent:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/agents/tracking-statuses - List all non-null tracking statuses
// NOTE: This must be defined BEFORE /:id routes to prevent being interpreted as an ID
export const handleGetTrackingStatuses = (_req: Request, res: Response) => {
  const trackingStatuses = agentService
    .getAllAgents()
    .filter(agent => agent.trackingStatus != null)
    .map(agent => ({
      agentId: agent.id,
      agentName: agent.name,
      trackingStatus: agent.trackingStatus,
      trackingStatusDetail: agent.trackingStatusDetail,
      trackingStatusTimestamp: agent.trackingStatusTimestamp,
    }));

  res.json(trackingStatuses);
};
