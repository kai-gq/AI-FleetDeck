/**
 * 任务40 办结主动汇报 · 秘书→主管派活登记簿（上行回执链）
 *
 * 秘书把任务派给主管时登记「最近一次派活」快照；主管链路收口时（回合闭包 T1 /
 * 转委派收口 T2）消费一条上行回执（「已回复:{摘要}——{回合末句}」/「已办结:{摘要}」），
 * 复用任务08 的 task_receipt 通道 + 09 闸门播报 —— 客户端与协议零改动。
 *
 * 设计要点（任务书 ⑤F1）：
 * - **独立于下属层 pending-receipt-registry**：那张表被 receipt-timeout-service 的超时
 *   扫描消费（:243），混入上行登记会污染下属层匹配/超时语义（任务40 侦察实测）；
 * - 每 boss 单槽：重复登记覆盖 = 以最近一次派活为准（v1 语义；逐任务链关联待 taskId
 *   注入主管消息后再议，登记在案）；
 * - 消费即删（一次派活至多一条上行回执）；TTL 与 08 同口径 2h，惰性清扫 + 上限驱逐最旧；
 * - 就绪判定 canFireBossUplink：无在飞委派 ∧ 无未匹配下属回执 —— 链路真收口才交付；
 *   不满足时不消费、留待下次触发或 TTL 清扫（宁缺勿误报「办结」）；
 * - 纯逻辑无重依赖（读两个既有只读列表），单测覆盖登记/消费/过期/上限/判定真值表。
 */

import { listActiveDelegations } from './boss-response-handler.js';
import { MAX_TASK_SUMMARY_LENGTH, listPendingReceipts } from './pending-receipt-registry.js';

export interface PendingBossUplink {
  /** 主管 agent id（键；每 boss 单槽）。 */
  bossId: string;
  /** 任务摘要（用户原话，登记时截断 80 —— 与 08 同规则同常量，单一来源）。 */
  taskSummary: string;
  /** 任务14·B：派活归属项目（route.projectRouting.projectId）；回执播报据此加【项目别名】前缀。 */
  projectId?: string;
  /** 秘书侧本回合 taskId（去重键用；主管消息不携带 id，无法反查具体委派链，v1 仅作快照）。 */
  taskId?: string;
  /** 秘书会话 id（诊断用）。 */
  sessionId?: string;
  registeredAt: number;
}

/** 上行回执就绪判定的输入快照（E1 级纯数据，测试可用真值表覆盖）。 */
export interface BossUplinkState {
  /** 该主管名下仍在飞的委派数（activeDelegations 按 bossId 过滤）。 */
  inFlight: number;
  /** 该主管名下已登记但未被完成事件匹配的下属回执数（pendingReceipts matchedAt 未置）。 */
  unmatched: number;
}

/** 上行登记 TTL（与 08 DEFAULT_RECEIPT_TTL_MS 同口径；初值非实测最优，待 L3 标定）。 */
export const DEFAULT_BOSS_UPLINK_TTL_MS = 2 * 60 * 60 * 1000;
/** 条目上限（每 boss 单槽 × 同时在任主管数远小于它；驱逐最旧兜底。初值待标定）。 */
export const MAX_BOSS_UPLINK_ENTRIES = 50;

export interface BossUplinkRegistry {
  register(entry: Omit<PendingBossUplink, 'registeredAt'> & { registeredAt?: number }): void;
  has(bossId: string, at?: number): boolean;
  /** 只读快照（消费前复核 registeredAt 用）；过期即清并返回 undefined。 */
  peek(bossId: string, at?: number): PendingBossUplink | undefined;
  /** 消费即删（返回快照；不存在/过期返回 undefined）—— 一次派活至多一条上行回执。 */
  consume(bossId: string, at?: number): PendingBossUplink | undefined;
  /** 按 bossId 移除（备用：撤回清理钩子，v1 不接线）。 */
  remove(bossId: string): boolean;
  list(at?: number): PendingBossUplink[];
  size(): number;
  clear(): void;
}

/** 与 08 同规则（空白压缩 + 80 截断 + …）；截断长度常量 import 自 08 保单一来源。 */
function truncateSummary(text: string | undefined): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > MAX_TASK_SUMMARY_LENGTH ? `${clean.slice(0, MAX_TASK_SUMMARY_LENGTH)}…` : clean;
}

export function createBossUplinkRegistry(opts: {
  ttlMs?: number;
  maxEntries?: number;
} = {}): BossUplinkRegistry {
  const ttlMs = opts.ttlMs ?? DEFAULT_BOSS_UPLINK_TTL_MS;
  const maxEntries = opts.maxEntries ?? MAX_BOSS_UPLINK_ENTRIES;
  const entries = new Map<string, PendingBossUplink>();

  /** 惰性清扫：删除已过 TTL 的条目（register / peek 时顺带，无定时器）。 */
  function sweep(now: number): void {
    for (const [id, entry] of entries) {
      if (now - entry.registeredAt >= ttlMs) entries.delete(id);
    }
  }

  function register(entry: Omit<PendingBossUplink, 'registeredAt'> & { registeredAt?: number }): void {
    const registeredAt = entry.registeredAt ?? Date.now();
    sweep(registeredAt);
    // 单槽覆盖：同 boss 重复登记 = 以最近一次派活为准（注册在案；Map.set 覆盖且保插入序）
    entries.set(entry.bossId, {
      bossId: entry.bossId,
      taskSummary: truncateSummary(entry.taskSummary),
      ...(entry.projectId ? { projectId: entry.projectId } : {}),
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      registeredAt,
    });
    // 上限驱逐最旧（与 08 同款：显式找最旧，覆盖登记会打乱 Map 迭代序的假设）
    while (entries.size > maxEntries) {
      let oldestId: string | undefined;
      let oldestAt = Infinity;
      for (const [id, e] of entries) {
        if (e.registeredAt < oldestAt) {
          oldestAt = e.registeredAt;
          oldestId = id;
        }
      }
      if (oldestId === undefined) break;
      entries.delete(oldestId);
    }
  }

  function peek(bossId: string, at: number = Date.now()): PendingBossUplink | undefined {
    sweep(at);
    const entry = entries.get(bossId);
    return entry ? { ...entry } : undefined;
  }

  function consume(bossId: string, at: number = Date.now()): PendingBossUplink | undefined {
    const entry = peek(bossId, at);
    if (!entry) return undefined;
    entries.delete(bossId);
    return entry;
  }

  return {
    register,
    has: (bossId, at) => peek(bossId, at) !== undefined,
    peek,
    consume,
    remove: (bossId) => entries.delete(bossId),
    list: (at: number = Date.now()) => {
      sweep(at);
      return Array.from(entries.values(), (entry) => ({ ...entry }));
    },
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}

// ============================================================================
// 模块级单例（生产路径用；测试可 reset）
// ============================================================================

const registry = createBossUplinkRegistry();

export function registerBossUplinkReceipt(
  entry: Omit<PendingBossUplink, 'registeredAt'> & { registeredAt?: number },
): void {
  registry.register(entry);
}

export function hasBossUplinkReceipt(bossId: string, at?: number): boolean {
  return registry.has(bossId, at);
}

export function peekBossUplinkReceipt(bossId: string, at?: number): PendingBossUplink | undefined {
  return registry.peek(bossId, at);
}

/** 消费即删：调用方在交付回执前调用；重复消费返回 undefined（天然幂等）。 */
export function consumeBossUplinkReceipt(bossId: string, at?: number): PendingBossUplink | undefined {
  return registry.consume(bossId, at);
}

/** 备用：撤回路径清理钩子（v1 不接线，登记在案）。 */
export function removeBossUplinkReceipt(bossId: string): boolean {
  return registry.remove(bossId);
}

export function listBossUplinks(at?: number): PendingBossUplink[] {
  return registry.list(at);
}

export function resetBossUplinksForTests(): void {
  registry.clear();
}

/**
 * 就绪状态采集：该主管无在飞委派、无未匹配下属回执时才算链路真收口。
 * 两个来源均为既有只读列表（ensureActiveDelegationsRebuilt 懒触发，低频调用）。
 */
export function collectBossUplinkState(bossId: string): BossUplinkState {
  return {
    inFlight: listActiveDelegations().filter((d) => d.bossId === bossId).length,
    unmatched: listPendingReceipts().filter((r) => r.bossId === bossId && r.matchedAt === undefined).length,
  };
}

/** 就绪判定（纯函数）：无在飞 ∧ 无未匹配。 */
export function canFireBossUplink(state: BossUplinkState): boolean {
  return state.inFlight === 0 && state.unmatched === 0;
}

/**
 * 开关（单一真源，登记与触发两处共用）：缺省开，`TC_VOICE_BOSS_RECEIPT=0` 全链逐字回退
 * （F1 不登记 + F4 早退 —— 既有链路零感知）。
 */
export function isBossUplinkReceiptEnabled(): boolean {
  return process.env.TC_VOICE_BOSS_RECEIPT !== '0';
}
