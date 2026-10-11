/**
 * 语音伙伴服务 — 查询材料与确定性汇报(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * 两跳来源材料(fetchAgentOutputExcerpt)+ 任务07·④ 委派树查询材料与观测点④ + list_agents 兜底汇报。
 */
import { logger } from '../../utils/index.js';
import * as agentService from '../agent-service.js';
import * as bossService from '../boss-service.js';
import { isOnStandby } from '../agent-standby.js';
import { logEvent } from '../../data/system-log.js';
import type { DelegationDecision } from '../../../shared/agent-types.js';
import { buildQueryChainLogBody, type QueryChainLogInput, type SubordinateQueryEntry } from '../../voice/delegation-query.js';
import { HISTORY_EXCERPT_COUNT, HISTORY_ITEM_CHARS, HISTORY_MESSAGES, HISTORY_TOTAL_CHARS } from './constants.js';
import { isAgentBusy } from './agents.js';

const log = logger.server;

export async function fetchAgentOutputExcerpt(agentId: string): Promise<string> {
  const history = await agentService.getAgentHistory(agentId, HISTORY_MESSAGES, 0, false, 0);
  if (!history || history.messages.length === 0) return '(没有可用的会话记录)';
  const assistantTexts = history.messages
    .filter((m) => m.type === 'assistant' && typeof m.content === 'string' && m.content.trim())
    .slice(-HISTORY_EXCERPT_COUNT);
  if (assistantTexts.length === 0) return '(最近没有助手输出)';

  const parts: string[] = [];
  let total = 0;
  for (const m of assistantTexts) {
    let text = m.content.replace(/\s+/g, ' ').trim();
    if (text.length > HISTORY_ITEM_CHARS) text = `${text.slice(0, HISTORY_ITEM_CHARS)}…`;
    if (total + text.length > HISTORY_TOTAL_CHARS) break;
    parts.push(text);
    total += text.length;
  }
  return parts.join('\n---\n');
}

// ============================================================================
// 任务07·④ 委派树查询(query 目标为 Boss)
// ============================================================================

/** 读单个 Boss 的委派史:文件缺失/读取失败按空处理,不打断查询链路(与 collectDelegationHistory 同一降级口径)。 */
export function readBossDelegationHistory(bossId: string): DelegationDecision[] {
  try {
    return bossService.getDelegationHistory(bossId);
  } catch (err) {
    log.warn(`[VoiceCompanion] 读取委派史失败(boss ${bossId}),按空处理: ${(err as Error).message}`);
    return [];
  }
}

/**
 * 把一条委派决策转成 hop2 材料的下属条目:
 * agent 已不在快照(被删/未加载)→ 名字回退委派记录、状态未知;
 * 历史读取失败 → 按「无产出」处理(材料会如实说暂无进展,不编造)。
 * excerptOverride(单 agent 查询用):传入即不再逐条读会话 —— 同一 agent 的多条记录共享
 * 一次读取的产出(新→旧里只有最新那条给真产出,其余传 '' 走「无产出」分支,避免同文重复)。
 */
export async function buildSubordinateQueryEntry(
  decision: DelegationDecision,
  excerptOverride?: string,
): Promise<SubordinateQueryEntry> {
  const subordinate = agentService.getAgent(decision.selectedAgentId);
  let excerpt: string;
  if (excerptOverride !== undefined) {
    excerpt = excerptOverride;
  } else {
    try {
      excerpt = await fetchAgentOutputExcerpt(decision.selectedAgentId);
    } catch (err) {
      log.warn(`[VoiceCompanion] 读取下属产出失败(${decision.selectedAgentId}),按无产出处理: ${(err as Error).message}`);
      excerpt = '';
    }
  }
  // ⑦ 任务卡为可选字段(旧委派记录无卡) → 按无卡处理,绝不假定存在。
  const objective = decision.taskCard?.objective;
  return {
    agentId: decision.selectedAgentId,
    agentName: subordinate?.name ?? decision.selectedAgentName,
    status: subordinate?.status,
    taskCardObjective: typeof objective === 'string' && objective.trim() ? objective.trim() : undefined,
    userCommand: decision.userCommand,
    excerpt,
    // ⑧ 病历(任务11)透传:旧记录无 completion/userRating → undefined,材料层走原三分支
    completion: decision.completion,
    userRating: decision.userRating,
  };
}

/**
 * 🔴 决策观测点④ 查询链路:落一条 system_log(category='system' + source='voice-companion' +
 * body.cat='query-chain')。phase='request' 在请求入口即写,保证 hop2 卡住/中止时也有「查过谁」
 * 的证据(「查一下→没下文」复现依据);phase='failed' 走 warn 全量落盘。
 */
export function logQueryChain(input: QueryChainLogInput, ctx: { sessionId?: string; taskId?: string }): void {
  logEvent('system', {
    source: 'voice-companion',
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    level: input.phase === 'failed' ? 'warn' : 'info',
    body: buildQueryChainLogBody(input),
  });
}

// ============================================================================
// Dispatch
// ============================================================================

/**
 * list_agents 且模型没说人话时的确定性兜底汇报(不依赖模型)。
 * 待岗者不计入「忙/闲」(恢复前派不了活):忙/闲只数在岗者,待岗单独点名报出。
 */
export function buildAgentListFallback(): string {
  const agents = agentService.getAllAgents();
  if (agents.length === 0) return '现在还没有任何 agent。';
  const standbyList = agents.filter((a) => isOnStandby(a));
  const active = agents.filter((a) => !isOnStandby(a));
  const standbyNames = standbyList.slice(0, 4).map((a) => a.name).join('、');
  const standbyMore = standbyList.length > 4 ? '等' : '';
  if (active.length === 0) {
    return `现有 ${agents.length} 个 agent,全部待岗(${standbyNames}${standbyMore})——需你先恢复上岗才能派活。`;
  }
  const working = active.filter((a) => isAgentBusy(a));
  const names = working.slice(0, 4).map((a) => a.name).join('、');
  const standbyNote = standbyList.length > 0
    ? `;另有 ${standbyList.length} 个待岗:${standbyNames}${standbyMore},需你恢复`
    : '';
  if (working.length === 0) {
    return standbyList.length > 0
      ? `现有 ${agents.length} 个 agent,在岗的 ${active.length} 个都空闲${standbyNote}。`
      : `现有 ${agents.length} 个 agent,都在空闲。`;
  }
  const more = working.length > 4 ? '等' : '';
  const idleCount = active.length - working.length;
  return `现有 ${agents.length} 个 agent;${working.length} 个在忙:${names}${more};其余 ${idleCount} 个空闲${standbyNote}。`;
}
