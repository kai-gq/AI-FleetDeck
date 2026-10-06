/**
 * 任务24 · 委派看板只读 API（Spec §8 台阶二②）
 *
 * 用途：客户端委派看板面板的数据源——「看得见每个任务：进度 / 耗时 / 委派树 / 病历链接」。
 * 设计约束（任务书 ⑤）：
 *   - **只读**：本路由只注册 GET /board，无任何写操作入口（验收④）；
 *   - **不新增数据面**：读委派史（任务21 结果字段）+ 在办追踪快照 + 病历（任务11），
 *     经 team-memory-service 五要素装配（与 Boss 派前命中摘要同源）；
 *   - **不新增推送通道**：客户端靠既有广播（delegation_decision 等）驱动刷新（验收③），
 *     本路由不挂广播 setter。
 */

import { Router, Request, Response } from 'express';

import { agentService } from '../services/index.js';
import * as bossService from '../services/boss-service.js';
import { listActiveDelegations } from '../websocket/handlers/boss-response-handler.js';
import {
  buildTeamMemoryEntries,
  type LiveDelegationInput,
  type TeamMemoryBossInput,
  type TeamMemoryEntry,
} from '../services/team-memory-service.js';
import type { DelegationDecision } from '../../shared/types.js';
import { createLogger } from '../utils/index.js';

const router = Router();
const log = createLogger('DelegationBoard');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Safely extract a single string query param (Express query values can be string | string[] | ...) */
function qs(val: unknown): string | undefined {
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && typeof val[0] === 'string') return val[0];
  return undefined;
}

function qn(val: unknown): number | undefined {
  const s = qs(val);
  return s !== undefined ? Number(s) : undefined;
}

/** 与 voice-companion-service.isBossLikeAgent 同口径（此处内联避免整模块依赖）。 */
function isBossLike(agent: { isBoss?: boolean; class?: string }): boolean {
  return agent.isBoss === true || agent.class === 'boss';
}

function safeHistories(bossId: string): readonly DelegationDecision[] {
  try {
    return bossService.getDelegationHistory(bossId);
  } catch (err) {
    log.warn(`[DelegationBoard] 读取委派史失败(boss ${bossId}),按空处理: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * 装配全量看板条目（五要素）：当前 Boss 的委派史 + 在办追踪快照（HC-B7 重建后）。
 * Boss 已不在 agent 表但追踪仍有记录 → 以孤儿输入呈现，绝不丢在办视角。
 */
function collectBoardEntries(): TeamMemoryEntry[] {
  const agents = agentService.getAllAgents();
  const nameById = new Map(agents.map((a) => [a.id, a.name]));

  const liveByBoss = new Map<string, LiveDelegationInput[]>();
  for (const d of listActiveDelegations()) {
    const live: LiveDelegationInput = {
      bossId: d.bossId,
      subordinateId: d.subordinateId,
      ...(nameById.has(d.subordinateId) ? { subordinateName: nameById.get(d.subordinateId) } : {}),
      taskDescription: d.taskDescription,
      ...(d.decisionId ? { decisionId: d.decisionId } : {}),
      ...(d.taskId ? { taskId: d.taskId } : {}),
      ...(d.taskCard ? { taskCard: d.taskCard } : {}),
    };
    const arr = liveByBoss.get(d.bossId);
    if (arr) arr.push(live);
    else liveByBoss.set(d.bossId, [live]);
  }

  const inputs: TeamMemoryBossInput[] = [];
  const knownBossIds = new Set<string>();
  for (const agent of agents) {
    if (!isBossLike(agent)) continue;
    knownBossIds.add(agent.id);
    inputs.push({
      bossId: agent.id,
      bossName: agent.name,
      histories: safeHistories(agent.id),
      live: liveByBoss.get(agent.id) ?? [],
    });
  }
  for (const [bossId, live] of liveByBoss) {
    if (knownBossIds.has(bossId)) continue;
    inputs.push({
      bossId,
      ...(nameById.has(bossId) ? { bossName: nameById.get(bossId) } : {}),
      histories: [],
      live,
    });
  }

  return buildTeamMemoryEntries(inputs);
}

// ─── 只读看板数据（GET /api/delegations/board） ───

router.get('/board', (req: Request, res: Response) => {
  try {
    const limitRaw = qn(req.query.limit);
    const limit =
      limitRaw !== undefined && Number.isFinite(limitRaw) && limitRaw >= 1
        ? Math.min(Math.floor(limitRaw), MAX_LIMIT)
        : DEFAULT_LIMIT;
    const offsetRaw = qn(req.query.offset);
    const offset =
      offsetRaw !== undefined && Number.isFinite(offsetRaw) && offsetRaw > 0
        ? Math.floor(offsetRaw)
        : 0;
    const bossIdFilter = qs(req.query.bossId);
    const statusFilter = qs(req.query.status);

    const filtered = collectBoardEntries().filter(
      (e) =>
        (!bossIdFilter || e.bossId === bossIdFilter) &&
        (!statusFilter || e.what.status === statusFilter)
    );

    res.json({
      generatedAt: Date.now(),
      total: filtered.length,
      limit,
      offset,
      entries: filtered.slice(offset, offset + limit),
    });
  } catch (err) {
    log.warn(`[DelegationBoard] 看板读取失败: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'delegation board unavailable' });
  }
});

export default router;
