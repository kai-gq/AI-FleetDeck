/**
 * 用量统计路由:全量按 agent/按天汇总与单 agent 快照。
 *
 * 自 agents.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log } from './helpers.js';
import { Request, Response } from 'express';
import { agentService } from '../../services/index.js';
import { buildClaudeUsageByAgentSummary, buildClaudeUsageByDaySummary, buildClaudeUsageSnapshot } from '../../services/claude-usage-service.js';
import { buildGrokUsageSnapshot } from '../../services/grok-usage-service.js';
import { buildCodexUsageSnapshot } from '../../services/codex-usage-service.js';
import { buildPiSubscriptionUsageSnapshot } from '../../services/pi-subscription-usage-service.js';
import { buildOpencodeUsageSnapshot } from '../../services/opencode-usage-service.js';

// GET /api/agents/usage-by-agent - Claude JSONL usage totals grouped by agent
//
// This mirrors the incident-analysis accounting: assistant messages are
// deduped by Claude requestId and total tokens include input, cache creation,
// cache read, and output tokens.
export const handleGetUsageByAgent = async (req: Request, res: Response) => {
  try {
    const agents = agentService.getAllAgents();
    const summary = await buildClaudeUsageByAgentSummary(agents, {
      since: req.query.since,
      until: req.query.until,
    });
    res.json(summary);
  } catch (err: any) {
    log.error(' Failed to build usage-by-agent summary:', err);
    res.status(500).json({ error: err?.message ?? 'Failed to build usage summary' });
  }
};

// GET /api/agents/usage-by-day - Claude JSONL usage totals grouped by local day
export const handleGetUsageByDay = async (req: Request, res: Response) => {
  try {
    const agents = agentService.getAllAgents();
    const summary = await buildClaudeUsageByDaySummary(agents, {
      since: req.query.since,
      until: req.query.until,
      days: req.query.days,
    });
    res.json(summary);
  } catch (err: any) {
    log.error(' Failed to build usage-by-day summary:', err);
    res.status(500).json({ error: err?.message ?? 'Failed to build daily usage summary' });
  }
};

// GET /api/agents/:id/usage - provider usage snapshot for a single agent
//
// Claude: local agent stats + Anthropic OAuth rate-limit gauges (CLI `/usage`).
// Grok: local agent stats + CLI chat-proxy billing/credit gauges (CLI `/usage`).
// Pi/OpenCode: limits resolved from the selected model's underlying provider.
export const handleGetIdUsage = async (req: Request<{ id: string }>, res: Response) => {
  const agent = agentService.getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  const provider = agent.provider ?? 'claude';
  if (provider !== 'claude' && provider !== 'grok' && provider !== 'codex' && provider !== 'pi' && provider !== 'opencode') {
    res.status(400).json({
      error: 'Usage data is unavailable for this agent provider',
      provider,
    });
    return;
  }
  try {
    const snapshot =
      provider === 'pi'
        ? await buildPiSubscriptionUsageSnapshot(agent)
        : provider === 'opencode'
          ? await buildOpencodeUsageSnapshot(agent)
        : provider === 'codex'
          ? await buildCodexUsageSnapshot(agent)
          : provider === 'grok'
            ? await buildGrokUsageSnapshot(agent)
            : await buildClaudeUsageSnapshot(agent);
    res.json(snapshot);
  } catch (err: any) {
    log.error(`Failed to build ${provider} usage snapshot:`, err);
    res.status(500).json({ error: err?.message ?? 'Failed to build usage snapshot' });
  }
};
