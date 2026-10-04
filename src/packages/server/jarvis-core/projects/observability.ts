/**
 * jarvis-core · 项目感知与路由（任务 14·⑪）·⑪ 观测适配（决策观测点⑪）
 *
 * 与任务 27 memory/observability.ts、任务 28 reflection/observability.ts 同款
 * 注入式适配：项目模块不 import activity-log/EventDB，只产出 ProjectRoutingEvent；
 * 生产侧由接线层把真实 logEvent 传进来（`createProjectRoutingLogObserver(logEvent)`），
 * 映射为
 *   logEvent('system', { source: 'project-routing', body: { cat:'project-routing', … } })
 * ——⑮ 可按 `querySystemLog({ source:'project-routing' })` 筛选；body 里三层各自
 * 候选/命中（decision.candidates）、最终 Boss（finalBossId）、是否回落首选（fallbackToFirstBoss）、
 * 反问（question）与累计反问次数（askCount）供「消歧反问多 = 记忆卡不准？」分析（Spec §4.14）。
 *
 * 说明：services/activity-log.ts（任务 02）的 ACTIVITY_SOURCE 常量表无本项；本适配
 * **不改该文件**（主脑登记），先以 source='project-routing'（本模块自有的 source 字符串）
 * 纯加法落盘，后续如需并入常量表由主脑统一执行。适配器自身不抛（观测失败不影响主链路）。
 */

import type { SystemLogEventFn } from '../memory/observability.js';
import type { ProjectRoutingEvent } from './types.js';

/** ⑪ 观测 source（自发的 source 字符串；不改 activity-log 常量表）。 */
export const PROJECT_ROUTING_SOURCE = 'project-routing';

export interface ProjectRoutingLogObserverOptions {
  /** 观测渠道标签（body.channel）；缺省 'voice'。 */
  channel?: string;
}

/** ProjectRoutingEvent → ⑭ system/project-routing 行。 */
export function createProjectRoutingLogObserver(
  logEvent: SystemLogEventFn,
  options: ProjectRoutingLogObserverOptions = {},
): (event: ProjectRoutingEvent) => void {
  const channel = options.channel ?? 'voice';
  return (event: ProjectRoutingEvent): void => {
    try {
      const decision = event.decision;
      logEvent('system', {
        source: PROJECT_ROUTING_SOURCE,
        sessionId: event.sessionId,
        level: event.level ?? (event.kind === 'clarify-fallback' ? 'warn' : 'info'),
        body: {
          cat: 'project-routing',
          channel,
          kind: event.kind,
          at: event.at,
          // SystemLogEventFn 结构型顶层无 taskId（memory/observability 镜像类型），
          // 需要它时放 body（真实 logEvent 也把它当普通字段落盘）。
          taskId: event.taskId,
          text: event.text,
          layer: decision?.layer,
          source: decision?.source,
          projectId: decision?.projectId,
          projectName: decision?.projectName,
          bossId: decision?.bossId,
          finalBossId: event.finalBossId ?? decision?.bossId,
          needAsk: decision?.needAsk ?? event.kind === 'need-ask',
          fallbackToFirstBoss: event.fallbackToFirstBoss ?? false,
          degenerate: decision?.degenerate ?? false,
          question: event.question,
          askCount: event.askCount,
          candidates: decision?.candidates ?? [],
        },
      });
    } catch {
      // 观测出口失败静默（与 memory/reflection observability 同型）
    }
  };
}
