/**
 * 批量操作路由:删除/停止/清上下文/改模型/移动区域/技能增删与筛选项。
 *
 * 自 agents.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log } from './helpers.js';
import { Request, Response } from 'express';
import { agentService, runtimeService, skillService } from '../../services/index.js';
import { loadAreas, saveAreas } from '../../data/index.js';
import { getAllCustomClasses } from '../../services/custom-class-service.js';
import { ClaudeModel } from '../../../shared/types.js';
import { CLAUDE_MODELS } from '../../../shared/types.js';

// ============================================================================
// Bulk Operations Routes
// NOTE: Must be defined BEFORE /:id routes to prevent "bulk" being interpreted as an ID
// ============================================================================

// POST /api/agents/bulk/delete - Delete multiple agents by IDs
export const handlePostBulkDelete = async (req: Request, res: Response) => {
  try {
    const { agentIds } = req.body as { agentIds?: string[] };

    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      res.status(400).json({ error: 'agentIds must be a non-empty array of strings' });
      return;
    }

    const deleted: string[] = [];
    const failed: string[] = [];

    for (const agentId of agentIds) {
      try {
        const agent = agentService.getAgent(agentId);
        if (!agent) {
          failed.push(agentId);
          continue;
        }
        await runtimeService.stopAgent(agentId);
        const success = agentService.deleteAgent(agentId);
        if (success) {
          deleted.push(agentId);
        } else {
          failed.push(agentId);
        }
      } catch (err) {
        log.error(` Bulk delete failed for agent ${agentId}:`, err);
        failed.push(agentId);
      }
    }

    log.log(`Bulk delete: ${deleted.length} deleted, ${failed.length} failed`);
    res.json({ deleted, failed });
  } catch (err: any) {
    log.error(' Bulk delete failed:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/agents/bulk/stop - Stop multiple agents
export const handlePostBulkStop = async (req: Request, res: Response) => {
  try {
    const { agentIds } = req.body as { agentIds?: string[] };

    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      res.status(400).json({ error: 'agentIds must be a non-empty array of strings' });
      return;
    }

    const stopped: string[] = [];
    const failed: string[] = [];

    for (const agentId of agentIds) {
      try {
        const agent = agentService.getAgent(agentId);
        if (!agent) {
          failed.push(agentId);
          continue;
        }
        await runtimeService.stopAgent(agentId);
        agentService.updateAgent(agentId, {
          status: 'idle',
          currentTask: undefined,
          currentTool: undefined,
        });
        stopped.push(agentId);
      } catch (err) {
        log.error(` Bulk stop failed for agent ${agentId}:`, err);
        failed.push(agentId);
      }
    }

    log.log(`Bulk stop: ${stopped.length} stopped, ${failed.length} failed`);
    res.json({ stopped, failed });
  } catch (err: any) {
    log.error(' Bulk stop failed:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/agents/bulk/clear-context - Clear context/reset session for multiple agents
export const handlePostBulkClearContext = async (req: Request, res: Response) => {
  try {
    const { agentIds } = req.body as { agentIds?: string[] };

    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      res.status(400).json({ error: 'agentIds must be a non-empty array of strings' });
      return;
    }

    const cleared: string[] = [];
    const failed: string[] = [];

    for (const agentId of agentIds) {
      try {
        const agent = agentService.getAgent(agentId);
        if (!agent) {
          failed.push(agentId);
          continue;
        }
        await runtimeService.stopAgent(agentId);
        agentService.updateAgent(agentId, {
          status: 'idle',
          currentTask: undefined,
          taskLabel: undefined,
          currentTool: undefined,
          lastAssignedTask: undefined,
          lastAssignedTaskTime: undefined,
          sessionId: undefined,
          tokensUsed: 0,
          contextUsed: 0,
          contextStats: undefined,
        });
        cleared.push(agentId);
      } catch (err) {
        log.error(` Bulk clear-context failed for agent ${agentId}:`, err);
        failed.push(agentId);
      }
    }

    log.log(`Bulk clear-context: ${cleared.length} cleared, ${failed.length} failed`);
    res.json({ cleared, failed });
  } catch (err: any) {
    log.error(' Bulk clear-context failed:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/agents/bulk/change-model - Change model for multiple agents.
// The existing provider-native session is preserved and resumed with the new
// model; changing a model must never implicitly perform a clear-context.
export const handlePostBulkChangeModel = async (req: Request, res: Response) => {
  try {
    const { agentIds, provider, model, effort } = req.body as {
      agentIds?: string[];
      provider?: 'claude' | 'codex' | 'opencode' | 'grok' | 'pi';
      model?: string;
      effort?: string | null;
    };

    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      res.status(400).json({ error: 'agentIds must be a non-empty array of strings' });
      return;
    }
    if (typeof provider !== 'string' || typeof model !== 'string') {
      res.status(400).json({ error: 'provider and model are required strings' });
      return;
    }

    let sanitized: string | undefined;
    if (provider === 'claude') {
      sanitized = agentService.sanitizeModelForProvider('claude', model);
    } else if (provider === 'codex') {
      sanitized = agentService.sanitizeCodexModel(model);
    } else if (provider === 'opencode') {
      sanitized = agentService.sanitizeOpencodeModel(model);
    } else if (provider === 'grok') {
      sanitized = agentService.sanitizeGrokModel(model);
    } else if (provider === 'pi') {
      sanitized = agentService.sanitizePiModel(model);
    }

    if (!sanitized) {
      res.status(400).json({ error: `Invalid model "${model}" for provider "${provider}"` });
      return;
    }

    // Effort is Claude/Grok/Pi. `null` means "clear back to default"; undefined means "leave unchanged".
    const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xHigh', 'max']);
    let effortUpdate: { set: true; value: string | undefined } | { set: false } = { set: false };
    if (effort !== undefined && (provider === 'claude' || provider === 'grok' || provider === 'pi')) {
      if (effort === null) {
        effortUpdate = { set: true, value: undefined };
      } else if (typeof effort === 'string' && VALID_EFFORTS.has(effort)) {
        effortUpdate = { set: true, value: effort };
      } else {
        res.status(400).json({ error: `Invalid effort "${effort}" — expected one of: low, medium, high, xHigh, max, or null` });
        return;
      }
    }

    const changed: string[] = [];
    const failed: string[] = [];

    for (const agentId of agentIds) {
      try {
        const agent = agentService.getAgent(agentId);
        if (!agent || (agent.provider ?? 'claude') !== provider) {
          failed.push(agentId);
          continue;
        }

        if (runtimeService.isAgentRunning(agentId)) {
          const switchedInPlace = await runtimeService.switchAgentModel(
            agentId,
            sanitized,
            effortUpdate.set ? effortUpdate.value : agent.effort,
          );
          if (!switchedInPlace) {
            log.log(`Bulk change-model: ${agentId} has no live switch control; saved model will apply on its next native turn/process`);
          }
        }

        const modelUpdates: Record<string, unknown> = {
          status: 'idle',
          currentTask: undefined,
          currentTool: undefined,
        };
        if (provider === 'claude') {
          modelUpdates.model = sanitized;
          // The window comes from the model (1M vs 200K): refresh it now, like
          // a single-agent model change, instead of showing the old size.
          const contextWindow = CLAUDE_MODELS[sanitized as ClaudeModel]?.contextWindow;
          if (contextWindow) {
            modelUpdates.contextLimit = contextWindow;
            const statsWindow = agent.contextStats?.contextWindow;
            if (statsWindow !== undefined && statsWindow !== contextWindow) {
              modelUpdates.contextStats = undefined;
            }
          }
        } else if (provider === 'codex') modelUpdates.codexModel = sanitized;
        else if (provider === 'opencode') modelUpdates.opencodeModel = sanitized;
        else if (provider === 'grok') modelUpdates.grokModel = sanitized;
        else if (provider === 'pi') {
          modelUpdates.piModel = sanitized;
          modelUpdates.piModelProvider = sanitized?.includes('/')
            ? sanitized.slice(0, sanitized.indexOf('/')).trim().toLowerCase() || undefined
            : undefined;
          const piContextLimit = await agentService.resolvePiModelContextLimit(sanitized);
          if (piContextLimit) {
            modelUpdates.contextLimit = piContextLimit;
            modelUpdates.contextStats = undefined;
          }
        }

        if (effortUpdate.set) modelUpdates.effort = effortUpdate.value;

        agentService.updateAgent(agentId, modelUpdates);
        changed.push(agentId);
      } catch (err) {
        log.error(` Bulk change-model failed for agent ${agentId}:`, err);
        failed.push(agentId);
      }
    }

    const effortLabel = effortUpdate.set ? ` effort=${effortUpdate.value ?? 'default'}` : '';
    log.log(`Bulk change-model: ${changed.length} changed to ${provider}:${sanitized}${effortLabel}, ${failed.length} failed`);
    res.json({ changed, failed });
  } catch (err: any) {
    log.error(' Bulk change-model failed:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/agents/bulk/move-area - Move multiple agents to an area
export const handlePostBulkMoveArea = async (req: Request, res: Response) => {
  try {
    const { agentIds, areaId } = req.body as { agentIds?: string[]; areaId?: string | null };

    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      res.status(400).json({ error: 'agentIds must be a non-empty array of strings' });
      return;
    }

    const areas = loadAreas();
    const moved: string[] = [];
    const failed: string[] = [];

    for (const agentId of agentIds) {
      try {
        const agent = agentService.getAgent(agentId);
        if (!agent) {
          failed.push(agentId);
          continue;
        }

        // Remove agent from all areas first
        for (const area of areas) {
          area.assignedAgentIds = area.assignedAgentIds.filter(id => id !== agentId);
        }

        // Add to target area if specified
        if (areaId) {
          const targetArea = areas.find(a => a.id === areaId);
          if (!targetArea) {
            failed.push(agentId);
            continue;
          }
          if (!targetArea.assignedAgentIds.includes(agentId)) {
            targetArea.assignedAgentIds.push(agentId);
          }
        }

        moved.push(agentId);
      } catch (err) {
        log.error(` Bulk move-area failed for agent ${agentId}:`, err);
        failed.push(agentId);
      }
    }

    // Save areas once after all moves
    if (moved.length > 0) {
      saveAreas(areas);
    }

    log.log(`Bulk move-area: ${moved.length} moved to ${areaId || 'none'}, ${failed.length} failed`);
    res.json({ moved, failed });
  } catch (err: any) {
    log.error(' Bulk move-area failed:', err);
    res.status(500).json({ error: err.message });
  }
};

// Normalize body { skillId?: string; skillIds?: string[] } into a deduped array.
// Accepts the legacy single-skill form so older callers keep working.
function normalizeSkillIds(body: { skillId?: unknown; skillIds?: unknown }): string[] | null {
  const list: string[] = [];
  if (Array.isArray(body.skillIds)) {
    for (const id of body.skillIds) {
      if (typeof id === 'string' && id) list.push(id);
    }
  }
  if (typeof body.skillId === 'string' && body.skillId) list.push(body.skillId);
  const deduped = Array.from(new Set(list));
  return deduped.length > 0 ? deduped : null;
}

// POST /api/agents/bulk/skills/add - Assign one or more skills to multiple agents (idempotent)
export const handlePostBulkSkillsAdd = (req: Request, res: Response) => {
  try {
    const { agentIds } = req.body as { agentIds?: string[] };
    const skillIds = normalizeSkillIds(req.body ?? {});

    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      res.status(400).json({ error: 'agentIds must be a non-empty array of strings' });
      return;
    }
    if (!skillIds) {
      res.status(400).json({ error: 'skillIds (or legacy skillId) is required' });
      return;
    }

    for (const sid of skillIds) {
      if (!skillService.getSkill(sid)) {
        res.status(404).json({ error: `Skill not found: ${sid}` });
        return;
      }
    }

    const results: { skillId: string; skillName: string; updated: string[]; alreadyHad: string[]; failed: string[] }[] = [];
    for (const sid of skillIds) {
      const updated: string[] = [];
      const alreadyHad: string[] = [];
      const failed: string[] = [];
      const initialSkill = skillService.getSkill(sid)!;
      for (const agentId of agentIds) {
        try {
          const agent = agentService.getAgent(agentId);
          if (!agent) {
            failed.push(agentId);
            continue;
          }
          // Lifts a per-agent exclusion when the class already covers it,
          // otherwise assigns directly.
          const result = skillService.addSkillForAgent(sid, agent);
          if (!result) {
            failed.push(agentId);
            continue;
          }
          if (result.changed) updated.push(agentId);
          else alreadyHad.push(agentId);
        } catch (err) {
          log.error(` Bulk add-skill failed for agent ${agentId} / skill ${sid}:`, err);
          failed.push(agentId);
        }
      }
      log.log(`Bulk add-skill ${initialSkill.name}: ${updated.length} added, ${alreadyHad.length} already had, ${failed.length} failed`);
      results.push({ skillId: sid, skillName: initialSkill.name, updated, alreadyHad, failed });
    }

    // Legacy flat shape (kept for single-skill callers) + new shape.
    const legacy = results.length === 1
      ? { skillId: results[0].skillId, updated: results[0].updated, alreadyHad: results[0].alreadyHad, failed: results[0].failed }
      : {};
    res.json({ skillIds, results, ...legacy });
  } catch (err: any) {
    log.error(' Bulk add-skill failed:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/agents/bulk/skills/remove - Unassign one or more skills from multiple agents (idempotent)
export const handlePostBulkSkillsRemove = (req: Request, res: Response) => {
  try {
    const { agentIds } = req.body as { agentIds?: string[] };
    const skillIds = normalizeSkillIds(req.body ?? {});

    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      res.status(400).json({ error: 'agentIds must be a non-empty array of strings' });
      return;
    }
    if (!skillIds) {
      res.status(400).json({ error: 'skillIds (or legacy skillId) is required' });
      return;
    }

    for (const sid of skillIds) {
      if (!skillService.getSkill(sid)) {
        res.status(404).json({ error: `Skill not found: ${sid}` });
        return;
      }
    }

    const results: { skillId: string; skillName: string; updated: string[]; didNotHave: string[]; failed: string[] }[] = [];
    for (const sid of skillIds) {
      const updated: string[] = [];
      const didNotHave: string[] = [];
      const failed: string[] = [];
      const initialSkill = skillService.getSkill(sid)!;
      for (const agentId of agentIds) {
        try {
          const agent = agentService.getAgent(agentId);
          if (!agent) {
            failed.push(agentId);
            continue;
          }
          // Direct assignments are dropped; class/'*' ones exclude this agent.
          const result = skillService.removeSkillForAgent(sid, agent);
          if (!result) {
            failed.push(agentId);
            continue;
          }
          if (result.changed) updated.push(agentId);
          else didNotHave.push(agentId);
        } catch (err) {
          log.error(` Bulk remove-skill failed for agent ${agentId} / skill ${sid}:`, err);
          failed.push(agentId);
        }
      }
      log.log(`Bulk remove-skill ${initialSkill.name}: ${updated.length} removed, ${didNotHave.length} didn't have, ${failed.length} failed`);
      results.push({ skillId: sid, skillName: initialSkill.name, updated, didNotHave, failed });
    }

    const legacy = results.length === 1
      ? { skillId: results[0].skillId, updated: results[0].updated, didNotHave: results[0].didNotHave, failed: results[0].failed }
      : {};
    res.json({ skillIds, results, ...legacy });
  } catch (err: any) {
    log.error(' Bulk remove-skill failed:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/agents/bulk/filters - Return available filter values
export const handleGetBulkFilters = (_req: Request, res: Response) => {
  try {
    const agents = agentService.getAllAgents();
    const areas = loadAreas();
    const customClasses = getAllCustomClasses();

    // Collect unique statuses from agents
    const statuses = [...new Set(agents.map(a => a.status))];

    // Collect unique providers
    const providers = [...new Set(agents.map(a => a.provider))];

    // Collect unique models
    const models = [...new Set(agents.map(a => a.model).filter(Boolean))] as string[];

    // Collect all classes (built-in + custom)
    const builtInClasses = ['scout', 'builder', 'debugger', 'architect', 'warrior', 'support', 'boss'];
    const customClassIds = customClasses.map(c => c.id);
    const classes = [...new Set([...builtInClasses, ...customClassIds, ...agents.map(a => a.class)])];

    res.json({
      statuses,
      areas: areas.map(a => ({ id: a.id, name: a.name })),
      providers,
      models,
      classes,
    });
  } catch (err: any) {
    log.error(' Failed to get bulk filters:', err);
    res.status(500).json({ error: err.message });
  }
};
