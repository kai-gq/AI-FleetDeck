/**
 * 运行时迁移路由(:id/convert-runtime 与旧版 convert-to-pi)及目标模型解析助手。
 *
 * 自 agents.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log } from './helpers.js';
import { Request, Response } from 'express';
import { agentService, runtimeService } from '../../services/index.js';
import { getPiModelCatalog } from '../../pi/model-catalog.js';
import { createTransferredSession, isSessionTransferTarget, removeTransferredSession, SessionTransferError, type CreatedTransfer } from '../../services/session-transfer-service.js';
import { Agent, AgentProvider, ClaudeEffort, CodexConfig, SessionTransferMode, SessionTransferSummary } from '../../../shared/types.js';
import { CLAUDE_MODELS, GROK_MODELS, providerDisplayName } from '../../../shared/types.js';

// POST /api/agents/:id/convert-runtime - Migrate an agent to another harness
// (Claude ⇄ Codex ⇄ Grok ⇄ Pi ⇄ OpenCode). When the target has a writable
// session store, the source conversation is copied into a NEW native session
// for that runtime and the agent is switched atomically. The source session
// stays untouched and archived for rollback via the session history.
const AGENT_PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'opencode', 'grok', 'pi'];

const CLAUDE_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xHigh', 'max']);

const DEFAULT_CONTEXT_LIMITS: Record<AgentProvider, number> = {
  claude: 200_000,
  codex: 258_400,
  opencode: 200_000,
  grok: 500_000,
  pi: 200_000,
};

interface ResolvedTarget {
  provider: AgentProvider;
  model?: string;
  contextLimit: number;
  /** Agent fields that select the model on the target runtime. */
  modelUpdates: Partial<Agent>;
}

/**
 * Validate the requested target model for `provider` and derive its context
 * window plus the agent fields that carry it. Returns an HTTP error tuple when
 * the model is not usable on that runtime.
 */
async function resolveTargetModel(
  provider: AgentProvider,
  rawModel: unknown,
  agent: Agent,
): Promise<ResolvedTarget | { status: number; error: string }> {
  const model = typeof rawModel === 'string' && rawModel.trim() ? rawModel.trim() : undefined;
  switch (provider) {
    case 'claude': {
      const claudeModel = model
        ? agentService.sanitizeModelForProvider('claude', model)
        : agentService.sanitizeModelForProvider('claude', agent.model);
      if (model && !claudeModel) {
        return { status: 400, error: `Unknown Claude model: ${model}` };
      }
      const contextLimit = claudeModel ? CLAUDE_MODELS[claudeModel]?.contextWindow ?? DEFAULT_CONTEXT_LIMITS.claude : DEFAULT_CONTEXT_LIMITS.claude;
      return {
        provider,
        model: claudeModel,
        contextLimit,
        modelUpdates: claudeModel ? { model: claudeModel } : {},
      };
    }
    case 'codex': {
      const codexModel = agentService.sanitizeCodexModel(model) ?? agent.codexModel;
      return {
        provider,
        model: codexModel,
        contextLimit: DEFAULT_CONTEXT_LIMITS.codex,
        modelUpdates: codexModel ? { codexModel } : {},
      };
    }
    case 'grok': {
      const grokModel = agentService.sanitizeGrokModel(model) ?? agent.grokModel;
      return {
        provider,
        model: grokModel,
        contextLimit: (grokModel && GROK_MODELS[grokModel]?.contextWindow) || DEFAULT_CONTEXT_LIMITS.grok,
        modelUpdates: grokModel ? { grokModel } : {},
      };
    }
    case 'opencode': {
      const opencodeModel = agentService.sanitizeOpencodeModel(model) ?? agent.opencodeModel;
      return {
        provider,
        model: opencodeModel,
        contextLimit: DEFAULT_CONTEXT_LIMITS.opencode,
        modelUpdates: opencodeModel ? { opencodeModel } : {},
      };
    }
    case 'pi': {
      const piModel = agentService.sanitizePiModel(model);
      let contextLimit = DEFAULT_CONTEXT_LIMITS.pi;
      if (piModel) {
        try {
          const entry = (await getPiModelCatalog()).find((candidate) => candidate.id === piModel);
          if (!entry) {
            return { status: 400, error: `Pi model is unavailable or has no configured credentials: ${piModel}` };
          }
          contextLimit = entry.contextWindow;
        } catch (err: any) {
          return { status: 503, error: err?.message || 'Could not validate the target Pi model' };
        }
      }
      const piModelProvider = piModel?.includes('/')
        ? piModel.slice(0, piModel.indexOf('/')).trim().toLowerCase() || undefined
        : undefined;
      return {
        provider,
        model: piModel,
        contextLimit,
        modelUpdates: { piModel, piModelProvider },
      };
    }
    default:
      return { status: 400, error: `Unsupported target runtime: ${String(provider)}` };
  }
}

async function handleConvertRuntime(
  req: Request<{ id: string }>,
  res: Response,
  body: {
    targetProvider?: unknown;
    mode?: unknown;
    model?: unknown;
    effort?: unknown;
    stopActive?: unknown;
    codexConfig?: unknown;
  },
): Promise<void> {
  const agent = agentService.getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }

  const sourceProvider: AgentProvider = agent.provider ?? 'claude';
  const targetProvider = body.targetProvider;
  if (typeof targetProvider !== 'string' || !AGENT_PROVIDERS.includes(targetProvider as AgentProvider)) {
    res.status(400).json({ error: `targetProvider must be one of ${AGENT_PROVIDERS.join(', ')}` });
    return;
  }
  const target = targetProvider as AgentProvider;
  if (target === sourceProvider) {
    res.status(400).json({ error: `Agent already runs on ${providerDisplayName(target)}.` });
    return;
  }

  const transferMode: SessionTransferMode = (body.mode as SessionTransferMode | undefined) ?? 'smart';
  if (transferMode !== 'smart' && transferMode !== 'full' && transferMode !== 'fresh') {
    res.status(400).json({ error: 'mode must be smart, full, or fresh' });
    return;
  }
  if (transferMode !== 'fresh' && !isSessionTransferTarget(target)) {
    res.status(422).json({
      error: `${providerDisplayName(target)} sessions cannot be written by Commander yet. Choose Fresh Start.`,
      code: 'target-unsupported',
    });
    return;
  }
  if (body.model !== undefined && body.model !== null && typeof body.model !== 'string') {
    res.status(400).json({ error: 'model must be a string' });
    return;
  }

  const effort = body.effort;
  if (effort !== undefined && effort !== null && (typeof effort !== 'string' || !CLAUDE_EFFORTS.has(effort))) {
    res.status(400).json({ error: 'effort must be low, medium, high, xHigh, max, null, or omitted' });
    return;
  }
  const targetSupportsEffort = target === 'claude' || target === 'grok' || target === 'pi';
  const targetEffort: ClaudeEffort | undefined = !targetSupportsEffort
    ? agent.effort
    : effort === null
      ? undefined
      : typeof effort === 'string' ? (effort as ClaudeEffort) : agent.effort;

  const codexConfig = body.codexConfig;
  if (codexConfig !== undefined && (codexConfig === null || typeof codexConfig !== 'object' || Array.isArray(codexConfig))) {
    res.status(400).json({ error: 'codexConfig must be an object' });
    return;
  }

  const resolved = await resolveTargetModel(target, body.model, agent);
  if ('error' in resolved) {
    res.status(resolved.status).json({ error: resolved.error });
    return;
  }

  const hasActiveTask = agent.status === 'working'
    || agent.status === 'waiting'
    || agent.status === 'waiting_permission'
    || agent.status === 'orphaned';
  const hasLiveRuntime = runtimeService.isAgentRunning(agent.id);
  if (hasActiveTask && body.stopActive !== true) {
    res.status(409).json({
      error: 'Agent is active. Confirm “stop the active task” before converting.',
      code: 'agent-active',
    });
    return;
  }

  const sourceSessionId = agent.sessionId;
  let created: CreatedTransfer | undefined;
  try {
    // Native CLI processes commonly remain alive while their agent is idle so
    // they can accept another prompt. Stop that resident runtime as part of the
    // handoff, but only require confirmation when an actual task is active.
    if (hasLiveRuntime || hasActiveTask) await runtimeService.stopAgent(agent.id);

    if (transferMode !== 'fresh') {
      created = await createTransferredSession(agent, {
        targetProvider: target as Parameters<typeof createTransferredSession>[1]['targetProvider'],
        mode: transferMode,
        contextLimit: resolved.contextLimit,
        targetModel: resolved.model,
      });
    }

    // Refuse to overwrite a session/provider that changed while the snapshot
    // was being prepared. The newly-created target session is safe to remove
    // because it has not yet been attached to the agent.
    const latest = agentService.getAgent(agent.id);
    if (!latest || latest.provider !== sourceProvider || latest.sessionId !== sourceSessionId) {
      if (created) removeTransferredSession(created);
      res.status(409).json({ error: 'The source agent changed during conversion. Nothing was switched.' });
      return;
    }

    agentService.archiveCurrentSession(agent.id);
    const updated = agentService.updateAgent(agent.id, {
      provider: target,
      sessionId: created?.sessionId,
      forkSourceSessionId: undefined,
      ...resolved.modelUpdates,
      ...(target !== 'pi' ? { piModelProvider: undefined } : {}),
      ...(target === 'codex' && codexConfig ? { codexConfig: codexConfig as CodexConfig } : {}),
      effort: targetEffort,
      status: 'idle',
      currentTask: undefined,
      currentTool: undefined,
      isDetached: false,
      lastError: undefined,
      tokensUsed: 0,
      contextUsed: created?.summary.estimatedTokens ?? 0,
      contextLimit: resolved.contextLimit,
      contextStats: undefined,
    }, false);
    if (!updated) {
      if (created) removeTransferredSession(created);
      res.status(404).json({ error: 'Agent disappeared during conversion. Nothing was switched.' });
      return;
    }

    const transfer: SessionTransferSummary = created?.summary ?? {
      sourceProvider,
      targetProvider: target,
      sourceSessionId,
      targetSessionId: undefined,
      mode: 'fresh',
      sourceMessageCount: 0,
      importedTurnCount: 0,
      droppedTurnCount: 0,
      droppedToolResultBodies: 0,
      estimatedTokens: 0,
      contextLimit: resolved.contextLimit,
      warnings: sourceSessionId ? [`The ${providerDisplayName(sourceProvider)} session was archived without importing its conversation.`] : [],
    };

    log.log(
      `Converted agent ${agent.name} from ${sourceProvider} to ${target}` +
      (created ? ` (${created.summary.importedTurnCount} turns → ${created.sessionId})` : ' (fresh start)')
    );
    res.json({ agent: updated, transfer });
  } catch (err: any) {
    if (created) removeTransferredSession(created);
    log.error(`Failed to convert agent ${agent.name} to ${target}:`, err);
    if (err instanceof SessionTransferError) {
      const status = err.code === 'source-provider-mismatch' ? 409 : 422;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: err?.message || `Failed to convert session to ${providerDisplayName(target)}` });
  }
}

export const handlePostIdConvertRuntime = async (req: Request<{ id: string }>, res: Response) => {
  await handleConvertRuntime(req, res, (req.body ?? {}) as Parameters<typeof handleConvertRuntime>[2]);
};

// Backward-compatible alias for the original Pi-only endpoint.
export const handlePostIdConvertToPi = async (req: Request<{ id: string }>, res: Response) => {
  const body = (req.body ?? {}) as { piModel?: unknown; model?: unknown } & Record<string, unknown>;
  await handleConvertRuntime(req, res, {
    ...body,
    targetProvider: 'pi',
    model: body.model ?? body.piModel,
  });
};
