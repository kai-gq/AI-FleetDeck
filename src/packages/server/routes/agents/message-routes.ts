/**
 * 消息与回执路由:派发消息、上下文压缩、模型回退模拟与任务回执上报。
 *
 * 自 agents.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log, broadcastFn } from './helpers.js';
import { Request, Response } from 'express';
import { agentService, runtimeService, bossMessageService } from '../../services/index.js';
import { isOnStandby, standbyRefusalMessage } from '../../services/agent-standby.js';
import { truncateOrEmpty } from '../../utils/string.js';
import { getTaskId, newTaskId } from '../../utils/trace-context.js';
import { buildCustomAgentConfig, expandFileMentions } from '../../websocket/handlers/command-handler.js';
import { completeDelegation, getBossForSubordinate } from '../../websocket/handlers/boss-response-handler.js';
import { notifyTaskCompletion } from '../../websocket/handlers/task-receipt-notifier.js';
import { logDelegation } from '../../services/activity-log.js';

// POST /api/agents/:id/message - Send a message/command to an agent
export const handlePostIdMessage = async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { message } = req.body;
    const agentId = req.params.id;

    if (!message) {
      res.status(400).json({ error: 'Missing required field: message' });
      return;
    }

    const agent = agentService.getAgent(agentId);
    if (!agent) {
      res.status(404).json({ error: `Agent not found: ${agentId}` });
      return;
    }

    if (isOnStandby(agent)) {
      res.status(409).json({ error: standbyRefusalMessage(agent) });
      return;
    }

    log.log(`API message to agent ${agent.name}: "${message.slice(0, 50)}${message.length > 50 ? '...' : ''}"`);

    const expandedMessage = await expandFileMentions(message, agent.cwd);

    // Handle boss agents with their special context building
    try {
      if (agent.isBoss || agent.class === 'boss') {
        const { message: bossMessage, systemPrompt } = await bossMessageService.buildBossMessage(agentId, expandedMessage);
        await runtimeService.sendCommand(agentId, bossMessage, systemPrompt);
      } else {
        // Regular agents get custom agent config (identity header, class instructions, skills)
        const customAgentConfig = buildCustomAgentConfig(agentId, agent.class);
        await runtimeService.sendCommand(agentId, expandedMessage, undefined, undefined, customAgentConfig);
      }
    } catch (err) {
      // 任务 02 埋点：基础四类 ③ —— API 直发派活失败行（channel 与成功行一致，原错误继续上抛）
      logDelegation({
        phase: 'failed',
        channel: 'api',
        toAgentId: agent.id,
        toAgentName: agent.name,
        message: expandedMessage.slice(0, 1000),
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        taskId: getTaskId() ?? newTaskId(),
      });
      throw err;
    }

    // 任务 02 埋点：基础四类 ③ —— API 直发派活（只记录出站，不做委派追踪/回执收敛）
    logDelegation({
      phase: 'dispatched',
      channel: 'api',
      toAgentId: agent.id,
      toAgentName: agent.name,
      message: expandedMessage.slice(0, 1000),
      delivery: 'queue',
      taskId: getTaskId() ?? newTaskId(),
    });

    res.status(200).json({
      success: true,
      agentId: agent.id,
      agentName: agent.name,
      message: 'Command sent successfully'
    });
  } catch (err: any) {
    log.error(' Failed to send message to agent:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/agents/:id/collapse-context — Dispatch provider-native context
// compaction to the agent's runner. Pi uses its RPC compact control command;
// TUI-backed providers use /compact. Plain /message is only a chat prompt and
// cannot invoke harness control commands.
//
// Body (optional):
//   { "waitForIdle": true }  — if the agent is currently busy, queue the
//     /compact and fire it automatically the first time the agent goes idle.
//     The main use case is the SAME agent calling this from inside its own
//     turn (e.g. end-of-flow cron step) — by definition still `working` when
//     the request lands. Default false keeps the existing 409-busy behavior.
export const handlePostIdCollapseContext = async (req: Request<{ id: string }>, res: Response) => {
  try {
    const agentId = req.params.id;
    const body = (req.body ?? {}) as { waitForIdle?: boolean };
    const waitForIdle = body.waitForIdle === true;
    const result = await runtimeService.collapseAgentContext(agentId, { waitForIdle });
    switch (result.status) {
      case 'collapse-initiated':
        log.log(`API collapse-context dispatched for agent ${agentId}`);
        res.status(200).json({ success: true, agentId, status: 'collapse-initiated' });
        return;
      case 'queued':
        log.log(`API collapse-context queued for agent ${agentId} (waiting for idle)`);
        res.status(200).json({ success: true, agentId, status: 'queued' });
        return;
      case 'not-found':
        res.status(404).json({ success: false, agentId, status: 'not-found', error: `Agent not found: ${agentId}` });
        return;
      case 'busy':
        res.status(409).json({ success: false, agentId, status: 'busy', currentStatus: result.currentStatus, error: 'Cannot collapse context while agent is busy' });
        return;
      case 'error':
        log.error(` Failed to collapse context for ${agentId}: ${result.error}`);
        res.status(500).json({ success: false, agentId, status: 'error', error: result.error });
        return;
    }
  } catch (err: any) {
    log.error(' Failed to collapse context (route):', err);
    res.status(500).json({ error: err?.message || 'Failed to collapse context' });
  }
};

// POST /api/agents/:id/simulate-model-fallback - Render a model swap without waiting for one.
//
// The API decides server-side whether to substitute a model, so no prompt can
// force a real fallback on demand. This drives the same code path a real one
// takes (terminal row + header chip + activity) so the UI can be verified.
// Simulation only — the agent keeps running on whatever model it always was.
export const handlePostIdSimulateModelFallback = (req: Request<{ id: string }>, res: Response) => {
  try {
    const agentId = req.params.id;
    const agent = agentService.getAgent(agentId);
    if (!agent) {
      res.status(404).json({ error: `Agent not found: ${agentId}` });
      return;
    }

    const body = (req.body ?? {}) as { requestedModel?: string; servedModel?: string };
    const requestedModel = body.requestedModel || agent.model || 'claude-fable-5-1';
    const servedModel = body.servedModel || 'claude-opus-5-5';

    const emitted = runtimeService.simulateModelFallback(agentId, requestedModel, servedModel);
    log.log(`API simulate-model-fallback for ${agentId}: ${requestedModel} -> ${servedModel} (emitted=${emitted})`);
    res.json({ success: true, agentId, requestedModel, servedModel, emitted, simulated: true });
  } catch (err: any) {
    log.error(' Failed to simulate model fallback:', err);
    res.status(500).json({ error: err?.message || 'Failed to simulate model fallback' });
  }
};

/**
 * 任务17·A3：验收打勾条目形状校验（item 非空字符串 + done 布尔；其余一律视为无效）。
 */
function isAcceptanceItem(value: unknown): value is { item: string; done: boolean } {
  if (!value || typeof value !== 'object') return false;
  const v = value as { item?: unknown; done?: unknown };
  return typeof v.item === 'string' && v.item.trim().length > 0 && typeof v.done === 'boolean';
}

// POST /api/agents/:id/report-task - Subordinate reports task completion to its boss
export const handlePostIdReportTask = async (req: Request<{ id: string }>, res: Response) => {
  try {
    const subordinateId = req.params.id;
    const { summary, status, acceptance, outputLocation } = req.body as {
      summary?: string;
      status?: 'completed' | 'failed';
      /** 任务17·A3：验收自检逐条打勾（completed 必填，逐条 {item, done}）。 */
      acceptance?: unknown;
      /** 任务17·A3：产出位置（completed 必填，非空白字符串）。 */
      outputLocation?: unknown;
    };

    const agent = agentService.getAgent(subordinateId);
    if (!agent) {
      res.status(404).json({ error: `Agent not found: ${subordinateId}` });
      return;
    }

    // Try active delegation tracking first, fall back to agent.bossId if delegation has cleared
    const delegation = getBossForSubordinate(subordinateId);
    const resolvedBossId = delegation?.bossId || agent.bossId;
    const taskStatus = status || 'completed';
    const success = taskStatus === 'completed';

    // 任务17·A3：completed 回执必须带「逐条打勾 + 产出位置」——
    // 缺任一 → 400 + 重发指引（无条件口径，简单可测；放在任何副作用之前，避免半截回执）；
    // failed 不强制（失败报告如实优先）。
    const validAcceptance =
      Array.isArray(acceptance) && acceptance.length > 0 && acceptance.every(isAcceptanceItem)
        ? (acceptance as Array<{ item: string; done: boolean }>)
        : undefined;
    const cleanOutputLocation =
      typeof outputLocation === 'string' && outputLocation.trim() ? outputLocation : undefined;
    if (taskStatus === 'completed') {
      const missing: string[] = [];
      if (!validAcceptance) missing.push('acceptance');
      if (!cleanOutputLocation) missing.push('outputLocation');
      if (missing.length > 0) {
        log.log(`Rejected completed report from ${agent.name}: missing ${missing.join(', ')}`);
        res.status(400).json({
          success: false,
          error: `Completed report rejected: missing or invalid ${missing.join(', ')}`,
          missing,
          expected: {
            summary: 'what was done and the result',
            status: 'completed',
            outputLocation: 'path or link to the deliverable',
            acceptance: [{ item: 'acceptance criterion verified', done: true }],
          },
          hint: `Resend POST /api/agents/${subordinateId}/report-task with a non-empty acceptance array of {item, done} objects and a non-blank outputLocation.`,
        });
        return;
      }
    }

    // 任务08② 回执订阅播报：report-task 入口统一通知（放在无 boss 早退之前——
    // 无 boss 回执同样过判断层留证，不静默丢弃；runtime 入口通常先到，
    // 第二入口命中稳定去重键后不再转发，消除同一完成双通道重复播）。
    notifyTaskCompletion({
      subordinateId: agent.id,
      agentName: agent.name,
      success,
      summary,
      source: 'report-task',
      at: Date.now(),
      // 任务14·B：项目归属透传（回执【项目别名】前缀的兜底来源；登记命中时用其 projectId）
      projectId: delegation?.taskCard?.projectId,
      broadcast: broadcastFn,
    });

    if (!resolvedBossId) {
      log.log(`Agent ${agent.name} reported task ${taskStatus} but has no boss association. Accepting and logging: "${(summary || '').slice(0, 120)}"`);
      // 任务 02 埋点：基础四类 ③ —— 回执（无 boss 关联，未转发）
      logDelegation({
        phase: 'reported',
        channel: 'subordinate',
        fromAgentId: agent.id,
        fromName: agent.name,
        message: summary,
        status: taskStatus,
        forwarded: false,
        taskId: delegation?.taskId,
      });
      res.status(200).json({
        success: true,
        subordinateId: agent.id,
        subordinateName: agent.name,
        bossId: null,
        bossName: null,
        taskStatus,
        accepted: true,
        forwarded: false,
        reason: 'No active delegation and no recorded boss — report logged only.',
      });
      return;
    }

    const bossAgent = agentService.getAgent(resolvedBossId);
    const bossName = bossAgent?.name || resolvedBossId;
    const taskDescription = delegation?.taskDescription || '(no active delegation record — original task unknown)';

    log.log(`Agent ${agent.name} reporting task ${taskStatus} to boss ${bossName}${delegation ? '' : ' (via fallback bossId, delegation already cleared)'}: "${(summary || '').slice(0, 80)}"`);

    // 1. Broadcast agent_task_completed to update the progress indicator on the client
    if (broadcastFn) {
      broadcastFn({
        type: 'agent_task_completed',
        payload: {
          bossId: resolvedBossId,
          subordinateId,
          success,
        },
      } as any);
    }

    // 2. ⑦⑧ 完成入口：任务卡迁移到 done + 病历写回（⑧ summary/产出位置/验收打勾透传）
    //    + 清理委派追踪（无追踪时 no-op）；failed 携带的无效 acceptance/outputLocation 一律不落库。
    completeDelegation(subordinateId, {
      success,
      reason: 'report-task',
      summary,
      ...(cleanOutputLocation ? { outputLocation: cleanOutputLocation } : {}),
      ...(validAcceptance ? { acceptance: validAcceptance } : {}),
    });

    // 3. Send a message to the boss so it knows the task finished and can decide next steps.
    // If the boss agent is no longer available, accept the report without failing.
    let forwarded = false;
    if (bossAgent) {
      // Truncate the original task description: the boss already issued the
      // delegation and has it in its own conversation history; replaying it
      // verbatim wastes tokens and can blow past line-length limits in the
      // CLI's stream-json input. A short label is enough to disambiguate
      // which delegation this report refers to.
      const taskLabel = truncateOrEmpty(taskDescription, 160);
      const reportMessage = `[TASK REPORT from ${agent.name} (${subordinateId})]\n\nStatus: ${taskStatus === 'completed' ? 'COMPLETED' : 'FAILED'}\nOriginal task: ${taskLabel}\n${summary ? `\nSummary: ${summary}` : ''}\n\nYou may review the result, give follow-up instructions, or dismiss this agent's progress indicator.`;

      try {
        if (bossAgent.isBoss || bossAgent.class === 'boss') {
          const { message: bossMessage, systemPrompt } = await bossMessageService.buildBossMessage(resolvedBossId, reportMessage);
          await runtimeService.sendCommand(resolvedBossId, bossMessage, systemPrompt);
        } else {
          await runtimeService.sendCommand(resolvedBossId, reportMessage);
        }
        forwarded = true;
      } catch (forwardErr: any) {
        log.error(` Failed to forward task report to boss ${bossName}, accepting report anyway:`, forwardErr);
      }
    } else {
      log.log(` Boss agent ${resolvedBossId} not found — accepting report without forwarding.`);
    }

    // 任务 02 埋点：基础四类 ③ —— 下属回执（taskId 与 delegated/closed 关联）
    logDelegation({
      phase: 'reported',
      channel: 'subordinate',
      fromAgentId: agent.id,
      fromName: agent.name,
      toAgentId: resolvedBossId,
      toAgentName: bossName,
      message: summary,
      status: taskStatus,
      forwarded,
      taskId: delegation?.taskId,
    });

    res.status(200).json({
      success: true,
      subordinateId: agent.id,
      subordinateName: agent.name,
      bossId: resolvedBossId,
      bossName,
      taskStatus,
      accepted: true,
      forwarded,
    });
  } catch (err: any) {
    log.error(' Failed to report task to boss:', err);
    res.status(500).json({ error: err.message });
  }
};
