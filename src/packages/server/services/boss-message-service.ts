/**
 * Boss Message Service
 * Builds context and instructions for boss agent commands
 */

import { BOSS_CONTEXT_START, BOSS_CONTEXT_END } from '../../shared/types.js';
import type { TaskCard } from '../../shared/agent-types.js';
import * as agentService from './agent-service.js';
import * as skillService from './skill-service.js';
import { createLogger } from '../utils/index.js';
import { buildBossContext } from './subordinate-context-service.js';
import { formatTaskCardForBoss, parseTaskCardFromText } from './task-card-service.js';
import { buildAssetHitBlock } from './team-memory-service.js';

const log = createLogger('BossMessage');

/**
 * Build minimal system prompt for boss agent.
 * The detailed instructions are injected in the user message instead.
 */
export function buildBossSystemPrompt(bossName: string, bossId: string): string {
  const agent = agentService.getAgent(bossId);
  const customInstructions = agent?.customInstructions;

  let prompt = `You are "${bossName}", a Boss Agent dispatcher with ID \`${bossId}\`. You NEVER do work yourself. You delegate EVERYTHING to your subordinates — no exceptions. You do not read code, write code, search code, or explore the codebase. You are a pure dispatcher: receive request, pick agent(s), delegate immediately, done. Keep your entire team busy by parallelizing aggressively.

Your agent ID for notifications: ${bossId}`;

  // Append agent-specific custom instructions
  if (customInstructions) {
    prompt += `\n\n# Custom Instructions\n\n${customInstructions}`;
  }

  // HC-B2 修复（2026-10-05）：显式拼接该 agent 的技能内容（含 boss-instructions 的
  // ```delegation 委派协议）。此前唯一物化通道是 buildCustomAgentConfig（command-handler），
  // 但它对 class==='boss' 早退——协议从未到达主管会话，决策/任务卡/回执/撤回审计链
  // 全历史零行（真人战役 C2 取证；上游同源缺陷）。技能读取失败时降级为基座提示词。
  try {
    const skillsContent = skillService.buildSkillPromptContent(bossId, agent?.class ?? 'boss', true);
    if (skillsContent.trim()) {
      prompt += `\n\n${skillsContent}`;
    }
  } catch (err) {
    log.warn(` skill content skipped for boss ${bossId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return prompt;
}

/**
 * Build the dynamic context to inject in user message for boss agents.
 * Only contains the "no subordinates" notice when team is empty.
 * Static boss instructions are now injected via the 'boss-instructions' built-in skill.
 */
export function buildBossInstructionsForMessage(bossName: string, hasSubordinates: boolean): string {
  if (!hasSubordinates) {
    return `# BOSS STATUS

You are "${bossName}", a Boss Agent in Tide Commander.

**CURRENT TEAM:** No subordinates assigned yet.

To be effective, you need subordinate agents assigned to your team. Ask the user to assign agents to you.`;
  }

  // When subordinates exist, static instructions come from the boss-instructions skill.
  // Only dynamic team context (built by buildBossContext) is injected per-message.
  return '';
}

/**
 * Build full boss message with instructions and context injected at the beginning.
 * Both instructions and context are wrapped in delimiters for the frontend to detect and collapse.
 *
 * ⑦ 任务对象化：可选的第三参 taskCard（或命令文本中的 ```task-card 围栏块）会以
 * 「任务卡」形式注入到 Boss 用户消息里，供拆解时按验收标准判断「做完没」。
 * 没有任务卡时输出与旧版逐字节一致（向后兼容，vcs 等旧签名调用方不受影响）。
 */
export async function buildBossMessage(
  bossId: string,
  command: string,
  taskCard?: TaskCard
): Promise<{ message: string; systemPrompt: string }> {
  const agent = agentService.getAgent(bossId);
  const bossName = agent?.name || 'Boss';

  const context = await buildBossContext(bossId);
  const hasSubordinates = context !== null;
  const systemPrompt = buildBossSystemPrompt(bossName, bossId);
  const instructions = buildBossInstructionsForMessage(bossName, hasSubordinates);

  // 显式传入优先；否则尝试从命令文本解析任务卡；都没有 → 纯文本原样
  const card = taskCard ?? parseTaskCardFromText(command);
  const commandBlock = card ? `${formatTaskCardForBoss(card)}\n\n${command}` : command;

  // 任务23 · Boss 派活先查：注入资产库命中摘要（只读；总/行双长度上限见 team-memory-service）。
  // fail-open：库故障/无命中时 hitsSection=''，输出与旧版逐字节一致（本文件测试钉死该形态）。
  const assetHits = buildAssetHitBlock(command);
  const hitsSection = assetHits ? `\n\n${assetHits}` : '';

  if (!context) {
    // No subordinates - just inject instructions
    const message = `${BOSS_CONTEXT_START}
${instructions}${hitsSection}
${BOSS_CONTEXT_END}

${commandBlock}`;
    return { message, systemPrompt };
  }

  // Inject dynamic team context at the beginning of the user message with delimiters.
  // Static boss instructions are injected once via the boss-instructions skill.
  const contextBlock = instructions ? `${instructions}\n\n${context}` : context;
  const message = `${BOSS_CONTEXT_START}
${contextBlock}${hitsSection}
${BOSS_CONTEXT_END}

${commandBlock}`;

  return { message, systemPrompt };
}
