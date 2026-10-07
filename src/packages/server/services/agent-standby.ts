/**
 * 待岗（standby）守卫——单一事实源。
 *
 * 待岗是用户手动的可逆停用态（Agent.standby，见 shared/agent-types.ts）。置位期间：
 * 进程已停止、会话与档案保留、仅用户可从面板恢复。所有派发通路（send_command、
 * 主管委派、触发器、批量重启、自动压缩、语音投递）都必须先过这里的检查，避免
 * 出现「已待岗还在干活」。
 *
 * 刻意保持纯函数、零依赖（只 import 类型）：6+ 个调用点共用，好单测、防循环依赖。
 */

import type { Agent } from '../../shared/agent-types.js';

/** 稳定错误码：调用方据此区分待岗拒绝与普通失败（勿依赖文案）。 */
export const AGENT_ON_STANDBY = 'AGENT_ON_STANDBY';

type StandbyCheckable = Pick<Agent, 'standby'> | null | undefined;

/** 严格 true 才算待岗（与 initAgents 的归一化口径一致，脏值一律按未待岗）。 */
export function isOnStandby(agent: StandbyCheckable): boolean {
  return agent?.standby === true;
}

/** 面向调用方（终端输出/日志/Boss 流）的统一拒绝文案。 */
export function standbyRefusalMessage(agent: Pick<Agent, 'id' | 'name'>): string {
  return `Agent "${agent.name}" (${agent.id}) is on standby (待岗) — the user must restore them from the agent panel first`;
}

/** 待岗即抛（错误对象带 code=AGENT_ON_STANDBY）；非待岗零开销。 */
export function assertAgentNotOnStandby(agent: Pick<Agent, 'id' | 'name' | 'standby'>): void {
  if (!isOnStandby(agent)) return;
  const error = new Error(standbyRefusalMessage(agent)) as Error & { code: string };
  error.code = AGENT_ON_STANDBY;
  throw error;
}
