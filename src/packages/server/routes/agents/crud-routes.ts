/**
 * Agent 基础路由:单查/更新/删除、记忆、消息队列与终端。
 *
 * 自 agents.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log } from './helpers.js';
import { Request, Response } from 'express';
import { agentService, runtimeService } from '../../services/index.js';
import { isInteractiveModeEnabled } from '../../services/system-prompt-service.js';
import { startAgentTerminal, stopAgentTerminal } from '../../services/agent-terminal-service.js';
import { providerDisplayName } from '../../../shared/types.js';

// GET /api/agents/:id - Get single agent
export const handleGetId = (req: Request<{ id: string }>, res: Response) => {
  const agent = agentService.getAgent(req.params.id);

  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }

  res.json(agent);
};

// PATCH /api/agents/:id - Update agent
export const handlePatchId = (req: Request<{ id: string }>, res: Response) => {
  // Protect sessionId from being accidentally cleared via API
  // Only allow explicit session management through dedicated endpoints
  const { sessionId, ...safeUpdates } = req.body;
  if (sessionId !== undefined) {
    log.warn(`API attempted to modify sessionId for agent ${req.params.id} - blocked`);
  }

  // standby（待岗）是用户专属开关：只有面板的 WS set_agent_standby 能切换。
  // 不封堵的话，任何 agent（含 Boss 用 curl）都能靠 {"standby":false} 自我恢复。
  if ('standby' in safeUpdates) {
    log.warn(`API attempted to modify standby for agent ${req.params.id} - blocked`);
    res.status(400).json({
      error: 'standby can only be toggled from the agent panel by the user',
      code: 'standby-user-only',
    });
    return;
  }

  const existing = agentService.getAgent(req.params.id);
  if (safeUpdates.provider && existing && safeUpdates.provider !== (existing.provider ?? 'claude') && existing.sessionId) {
    res.status(409).json({
      error: `Use POST /api/agents/${req.params.id}/convert-runtime so Commander migrates the ${providerDisplayName(existing.provider)} session instead of resuming it on ${providerDisplayName(safeUpdates.provider)}.`,
      code: 'use-convert-runtime',
    });
    return;
  }

  if ('trackingStatus' in safeUpdates) {
    safeUpdates.trackingStatusTimestamp = safeUpdates.trackingStatus == null ? undefined : Date.now();
    if (safeUpdates.trackingStatus == null && !('trackingStatusDetail' in safeUpdates)) {
      safeUpdates.trackingStatusDetail = undefined;
    }
  }

  const updated = agentService.updateAgent(req.params.id, safeUpdates);

  if (!updated) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }

  // Slim response: agents PATCH this endpoint several times per turn (taskLabel, trackingStatus),
  // and returning the full agent — which includes multi-KB `lastAssignedTask`/`currentTask` strings —
  // bloated agent context. Full agent state is already broadcast to clients via the WS `agent_updated`
  // channel, so the response only needs to confirm the fields an agent typically cares about.
  res.json({
    id: updated.id,
    name: updated.name,
    status: updated.status,
    trackingStatus: updated.trackingStatus,
    trackingStatusDetail: updated.trackingStatusDetail,
    taskLabel: updated.taskLabel,
    lastActivity: updated.lastActivity,
    isBoss: updated.isBoss,
    ok: true,
  });
};

// ============================================================================
// Agent Memory Routes — per-agent persistent notes injected into system prompt
// ============================================================================

// GET /api/agents/:id/memory - Read the agent's current memory string
export const handleGetIdMemory = (req: Request<{ id: string }>, res: Response) => {
  const agent = agentService.getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  const memory = typeof agent.memory === 'string' ? agent.memory : '';
  res.json({ memory, length: memory.length });
};

// PATCH /api/agents/:id/memory - Replace the agent's memory (full replace).
// Body: { memory: string }
export const handlePatchIdMemory = (req: Request<{ id: string }>, res: Response) => {
  const { memory } = req.body as { memory?: unknown };
  if (typeof memory !== 'string') {
    res.status(400).json({ error: 'memory must be a string' });
    return;
  }

  const updated = agentService.updateAgent(req.params.id, { memory }, false);
  if (!updated) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }

  log.log(`Agent ${updated.name} (${updated.id}): memory updated (${memory.length} chars)`);
  res.json({ ok: true, id: updated.id, length: memory.length });
};

// DELETE /api/agents/:id/memory - Clear the agent's memory
export const handleDeleteIdMemory = (req: Request<{ id: string }>, res: Response) => {
  const updated = agentService.updateAgent(req.params.id, { memory: '' }, false);
  if (!updated) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  log.log(`Agent ${updated.name} (${updated.id}): memory cleared`);
  res.json({ ok: true, id: updated.id });
};

// GET /api/agents/:id/queue - Snapshot of the server-side mid-run message
// queue (messages awaiting delivery once the agent's current turn ends).
// Positional: each entry's `index` is only valid against THIS snapshot.
export const handleGetIdQueue = (req: Request<{ id: string }>, res: Response) => {
  const agent = agentService.getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  const messages = runtimeService.getQueuedMessagesForAgent(req.params.id);
  res.json({ messages: messages.map((text, index) => ({ index, text })) });
};

// DELETE /api/agents/:id/queue/:index - Remove one queued message. Body:
// { text } — must match the entry at `index` (guards against a queue that
// drained/mutated since the caller's snapshot; on mismatch → 409, refetch).
export const handleDeleteIdQueueIndex = (req: Request<{ id: string; index: string }>, res: Response) => {
  const agent = agentService.getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  const index = Number.parseInt(req.params.index, 10);
  const { text } = (req.body ?? {}) as { text?: unknown };
  if (!Number.isInteger(index) || index < 0 || typeof text !== 'string') {
    res.status(400).json({ error: 'index must be a non-negative integer and text a string' });
    return;
  }
  const removed = runtimeService.removeQueuedMessageForAgent(req.params.id, index, text);
  if (!removed) {
    res.status(409).json({ error: 'Queue changed since snapshot — refetch', removed: false });
    return;
  }
  log.log(`Agent ${agent.name} (${agent.id}): queued message ${index} removed via API`);
  res.json({ removed: true });
};

// POST /api/agents/:id/terminal - Start (or reuse) a ttyd attached to the
// agent's interactive-TUI tmux session (Classic TUI view). Returns the proxy URL.
export const handlePostIdTerminal = async (req: Request<{ id: string }>, res: Response) => {
  const agent = agentService.getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  if (!isInteractiveModeEnabled()) {
    res.status(400).json({ error: 'Interactive mode is not enabled' });
    return;
  }
  try {
    const result = await startAgentTerminal(req.params.id);
    if (!result.success) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.json({ url: result.url });
  } catch (err: any) {
    log.error(' Failed to start agent terminal:', err);
    res.status(500).json({ error: err.message });
  }
};

// DELETE /api/agents/:id/terminal - Stop the agent's ttyd viewer (the tmux
// session is left running).
export const handleDeleteIdTerminal = (req: Request<{ id: string }>, res: Response) => {
  stopAgentTerminal(req.params.id);
  res.json({ ok: true });
};

// DELETE /api/agents/:id - Delete agent
export const handleDeleteId = (req: Request<{ id: string }>, res: Response) => {
  const deleted = agentService.deleteAgent(req.params.id);

  if (!deleted) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }

  res.status(204).end();
};
