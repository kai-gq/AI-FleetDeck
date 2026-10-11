/**
 * 语音伙伴服务 — 派发执行(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * 打断(可选)+ 主管走 buildBossMessage 注入团队上下文,普通 agent 直发;运行时经动态 import 取。
 */
import { logger } from '../../utils/index.js';
import type { Agent } from '../../../shared/agent-types.js';
import { isBossLikeAgent } from './agents.js';
import { ACTIVE_AGENT_STATUSES } from './constants.js';
import type { CompanionDelivery } from './types.js';

const log = logger.server;

export async function deliverToAgent(agent: Agent, message: string, delivery: CompanionDelivery): Promise<boolean> {
  const { runtimeService, bossMessageService } = await import('../index.js');
  const { buildCustomAgentConfig } = await import('../../websocket/handlers/command-handler.js');

  let interrupted = false;
  if (delivery === 'interrupt' && ACTIVE_AGENT_STATUSES.has(agent.status)) {
    log.log(`[VoiceCompanion] 打断 ${agent.name}(${agent.id}) 当前工作`);
    try {
      // stopAgent 返回即该 agent 的进程槽已清、状态已置 idle(runner 内部负责
      // SIGINT → 500ms SIGTERM → 1500ms SIGKILL 的升级链),紧随其后的
      // sendCommand 直接拉起新回合,不再等固定 250ms(P9:打断延迟专项)。
      await runtimeService.stopAgent(agent.id);
      interrupted = true;
    } catch (err) {
      log.error(`[VoiceCompanion] stopAgent 失败: ${(err as Error).message}`);
    }
  }

  if (isBossLikeAgent(agent)) {
    // 委托消息带完整任务上下文:复用 buildBossMessage(团队快照 + Boss 指令注入)。
    const { message: bossMessage, systemPrompt } = await bossMessageService.buildBossMessage(agent.id, message);
    await runtimeService.sendCommand(agent.id, bossMessage, systemPrompt);
  } else {
    const customAgentConfig = buildCustomAgentConfig(agent.id, agent.class);
    await runtimeService.sendCommand(agent.id, message, undefined, undefined, customAgentConfig);
  }
  return interrupted;
}
