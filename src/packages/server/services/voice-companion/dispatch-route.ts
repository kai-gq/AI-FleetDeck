/**
 * 语音伙伴服务 — 派发路由纯函数(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * 「任务只走 Boss」:契约意图 → 唯一合法派发目标;违规直派记录供观测。单测覆盖。
 */
import { isBossLikeAgent } from './agents.js';
import type { ProjectResolveResult } from '../../jarvis-core/projects/types.js';

// ============================================================================
// 派发路由(改①:任务只走 Boss)——纯函数,单测覆盖
// ============================================================================

/** 派发目标结构子集(Agent 天然满足;测试可造轻量对象)。 */
export interface DispatchTargetAgent {
  id: string;
  name: string;
  class?: string;
  isBoss?: boolean;
}

/** 违规直派记录:模型仍想把任务直接派给普通 agent 时,告警要落这份信息。 */
export interface DispatchViolation {
  requestedAgentId: string;
  requestedAgentName: string | null;
}

/**
 * 派发路由结果:
 * - boss     = 唯一合法目标(团队主管;Boss 仍可用 send_to_agent 直接对话);
 * - missing  = send_to_agent 指定的目标不存在;
 * - no_boss  = 团队里没有主管可转交(违规直派且无 Boss 时也会带 violation);
 * - need_ask = 任务14·⑪ 项目歧义(All + 多主管 + 三层消不掉):不派发,回去反问一次。
 */
export type DispatchRoute<T extends DispatchTargetAgent = DispatchTargetAgent> =
  | { route: 'boss'; agent: T; violation?: DispatchViolation; projectRouting?: ProjectResolveResult }
  | { route: 'missing' }
  | { route: 'no_boss'; violation?: DispatchViolation }
  | { route: 'need_ask'; decision: ProjectResolveResult; violation?: DispatchViolation };

/**
 * 把契约意图解析成唯一合法的派发目标(改①,决策观测点①):
 * - delegate_to_boss:任务语义,目标固定为主管——模型给了主管 id 就尊重(多主管世界),
 *   给普通 agent id 或留空都改走第一位主管;给普通 agent id 记违规(观测用)。
 *   任务14·⑪:第 4 参传入三层消歧结果(缺省 undefined = 旧行为逐字不变):
 *   模型显式主管 > 项目命中主管 > 歧义反问(need_ask) > 现状首位 Boss 兜底。
 * - send_to_agent:仅主管可达;指向普通 agent = 违规直派 → 标记 violation 并改道主管,
 *   保住「全走 Boss」不变式(供 ⑮ 分析告警频率,而不是让任务丢失)。
 */
export function resolveDispatchRoute<T extends DispatchTargetAgent>(
  action: 'delegate_to_boss' | 'send_to_agent',
  requestedAgentId: string | null,
  agents: readonly T[],
  projectDecision?: ProjectResolveResult,
): DispatchRoute<T> {
  const boss = agents.find((a) => isBossLikeAgent(a));
  const requested = requestedAgentId ? agents.find((a) => a.id === requestedAgentId) : undefined;

  if (action === 'send_to_agent') {
    if (!requested) return { route: 'missing' };
    if (isBossLikeAgent(requested)) return { route: 'boss', agent: requested };
    const violation: DispatchViolation = { requestedAgentId: requested.id, requestedAgentName: requested.name ?? null };
    return boss ? { route: 'boss', agent: boss, violation } : { route: 'no_boss', violation };
  }

  // delegate_to_boss:目标由系统解析,不选执行人。
  if (requested && isBossLikeAgent(requested)) {
    return { route: 'boss', agent: requested, ...(projectDecision ? { projectRouting: projectDecision } : {}) };
  }
  const violation: DispatchViolation | undefined = requested
    ? { requestedAgentId: requested.id, requestedAgentName: requested.name ?? null }
    : undefined;
  // ⑪ 歧义：不派发、不猜，回去只问一次（violation 仍如实带上供观测）。
  if (projectDecision?.needAsk) {
    return { route: 'need_ask', decision: projectDecision, ...(violation ? { violation } : {}) };
  }
  if (!boss) return { route: 'no_boss' };
  // ⑪ 命中（任一层）→ 该项目主管优先于现状首位 Boss。
  if (projectDecision?.bossId) {
    const projectBoss = agents.find((a) => a.id === projectDecision.bossId && isBossLikeAgent(a));
    if (projectBoss) {
      return { route: 'boss', agent: projectBoss, projectRouting: projectDecision, ...(violation ? { violation } : {}) };
    }
  }
  return {
    route: 'boss',
    agent: boss,
    ...(projectDecision ? { projectRouting: projectDecision } : {}),
    ...(violation ? { violation } : {}),
  };
}
