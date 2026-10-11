/**
 * 会话历史与检索路由:sessions/history/injected-prompt/session-history/preview/search/files。
 *
 * 自 agents.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log } from './helpers.js';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { agentService } from '../../services/index.js';
import { getClaudeProjectDir } from '../../data/index.js';
import { loadSession } from '../../claude/session-loader.js';

// GET /api/agents/:id/sessions - List agent's sessions
export const handleGetIdSessions = async (req: Request<{ id: string }>, res: Response) => {
  try {
    const result = await agentService.getAgentSessions(req.params.id);

    if (!result) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    res.json(result);
  } catch (err: any) {
    log.error(' Failed to list sessions:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/agents/:id/history - Get conversation history
export const handleGetIdHistory = async (req: Request<{ id: string }>, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const includeSubagents = req.query.includeSubagents !== 'false'; // default true
    const subagentEntriesLimit = parseInt(req.query.subagentEntriesLimit as string) || 200;
    const result = await agentService.getAgentHistory(req.params.id, limit, offset, includeSubagents, subagentEntriesLimit);

    if (!result) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = agentService.getAgent(req.params.id);
    res.json({
      ...result,
      claudeProjectDir: agent ? getClaudeProjectDir(agent.cwd) : null,
    });
  } catch (err: any) {
    log.error(' Failed to load history:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/agents/:id/injected-prompt - Get the full prompt injected into this agent
export const handleGetIdInjectedPrompt = async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { buildInjectedPromptForAgent } = await import('../../services/prompt-inspection-service.js');
    const prompt = await buildInjectedPromptForAgent(req.params.id);
    if (prompt === null) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json({ prompt });
  } catch (err: any) {
    log.error(' Failed to build injected prompt:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/agents/:id/session-history - Get archived session history for an agent
export const handleGetIdSessionHistory = (_req: Request<{ id: string }>, res: Response) => {
  try {
    const entries = agentService.getAgentSessionHistory(_req.params.id);
    res.json({ entries });
  } catch (err: any) {
    log.error(' Failed to load session history:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/agents/:id/session-preview/:sessionId - Preview messages from an archived session
export const handleGetIdSessionPreviewSessionId = async (req: Request<{ id: string; sessionId: string }>, res: Response) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const limit = parseInt(req.query.limit as string) || 30;
    const history = await loadSession(agent.cwd, req.params.sessionId, limit, 0);
    if (!history) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ messages: history.messages, totalCount: history.totalCount });
  } catch (err: any) {
    log.error(' Failed to load session preview:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/agents/:id/search - Search conversation history
export const handleGetIdSearch = async (req: Request<{ id: string }>, res: Response) => {
  try {
    const query = req.query.q as string;
    const limit = parseInt(req.query.limit as string) || 50;

    if (!query) {
      res.status(400).json({ error: 'Query parameter "q" is required' });
      return;
    }

    const result = await agentService.searchAgentHistory(req.params.id, query, limit);

    if (!result) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    res.json(result);
  } catch (err: any) {
    log.error(' Failed to search history:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/agents/:id/files?q=search — list files/folders in agent cwd for @ mention autocomplete
export const handleGetIdFiles = (req: Request<{ id: string }>, res: Response) => {
  const { q = '' } = req.query as { q?: string };
  const agent = agentService.getAgent(req.params.id);

  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }

  const cwd = agent.cwd;
  const query = String(q).toLowerCase().trim();
  const IGNORED = new Set([
    '.git', 'node_modules', 'dist', '.next', '__pycache__', '.cache',
    'coverage', '.claude', '.idea', '.vscode', 'build', 'out', '.turbo', '.nx',
  ]);

  const results: Array<{ path: string; name: string; type: 'file' | 'dir' }> = [];
  const MAX_RESULTS = 60;
  const MAX_DEPTH = 6;

  // Walk the whole tree (bounded by depth + ignored dirs). We can't early-exit
  // on result count here: depth-first traversal would saturate the cap with
  // deep matches in alphabetically-earlier siblings (e.g. q=src filling up
  // with android/app/src/... before ever visiting the root-level src/),
  // hiding the shallow match the user almost certainly wanted.
  function walk(dir: string, relBase: string, depth: number) {
    if (depth > MAX_DEPTH) return;
    let entries: import('fs').Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (!query || entry.name.toLowerCase().includes(query) || relPath.toLowerCase().includes(query)) {
        results.push({ path: relPath, name: entry.name, type: entry.isDirectory() ? 'dir' : 'file' });
      }
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relPath, depth + 1);
      }
    }
  }

  walk(cwd, '', 0);

  // Sort by relevance, then slice to the cap. Priority:
  //   1. Exact (case-insensitive) name match — definitively what they typed.
  //   2. Name starts with the query — stronger than a midline substring.
  //   3. Directories before files at the same rank.
  //   4. Shallower paths first — root-level matches before nested namesakes.
  //   5. Alphabetical by path as a stable tie-break.
  const depthOf = (p: string) => p.split('/').length;
  results.sort((a, b) => {
    if (query) {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aExact = aName === query;
      const bExact = bName === query;
      if (aExact !== bExact) return aExact ? -1 : 1;
      const aStarts = aName.startsWith(query);
      const bStarts = bName.startsWith(query);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
    }
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    const da = depthOf(a.path);
    const db = depthOf(b.path);
    if (da !== db) return da - db;
    return a.path.localeCompare(b.path);
  });

  res.json({ files: results.slice(0, MAX_RESULTS) });
};
