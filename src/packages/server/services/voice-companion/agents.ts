/**
 * 语音伙伴服务 — Agent 领域谓词(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * 「主管」「忙」的判定单一事实源:快照/派发路由/派活/收尾兜底共用。
 */
import { isOnStandby } from '../agent-standby.js';
import { ACTIVE_AGENT_STATUSES } from './constants.js';

/**
 * 语音侧「忙」的统一口径:在岗(未待岗)且状态属于 ACTIVE_AGENT_STATUSES。
 * 待岗者进程已停、恢复前派不了活 —— 既不算忙也不算闲,忙/闲统计一律走这里。
 */
export function isAgentBusy(agent: { status: string; standby?: boolean }): boolean {
  return !isOnStandby(agent) && ACTIVE_AGENT_STATUSES.has(agent.status);
}

/** 主管判定:与 boss-service / deliverToAgent 一致(isBoss 或 class==='boss')。 */
export function isBossLikeAgent(agent: { isBoss?: boolean; class?: string }): boolean {
  return agent.isBoss === true || agent.class === 'boss';
}
