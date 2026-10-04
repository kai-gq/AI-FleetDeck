/**
 * 任务08② 待回执订阅登记（派活闭环）
 *
 * 派活时（parseBossDelegation 登记）记下 targetAgentId + 任务摘要 + 时间（+ taskId/decisionId），
 * 完成时（runtime 'complete' / report-task 双入口）按 subordinateId 匹配，命中后交由
 * task-receipt-notifier 组信号过 09 判断层。
 *
 * 设计要点（Spec §4.2）：
 * - **独立于委派追踪**（activeDelegations 在回执时被清理，本登记保留到匹配/TTL 过期）；
 * - 匹配后**保留条目**（matchedAt 标记，供第二入口复用同一 taskId → 同一稳定去重键），
 *   至 TTL 过期或被新登记覆盖（同一 agent 一次只挂一条待回执，语义同 activeDelegations）；
 * - 过期清理：register / match 时顺带惰性清扫，另有条目上限驱逐最旧，内存有界；
 * - 纯逻辑无重依赖，单测覆盖 ⑥2「登记/匹配/过期」。
 */

export interface PendingReceipt {
  /** 订阅目标：完成任务的下属 agent。 */
  targetAgentId: string;
  bossId: string;
  /** 服务端进程内 taskId（任务 02 登记限制：跨进程不可达）。 */
  taskId?: string;
  /** 委派史记录 id（delegation-history.json 中 decision.id）。 */
  decisionId?: string;
  /** 任务摘要（派活命令，登记时截断，控制内存与播报长度）。 */
  taskSummary: string;
  registeredAt: number;
  /** 已被完成事件匹配消费的时刻（保留条目用于第二入口同键去重）。 */
  matchedAt?: number;
}

export interface PendingReceiptMatch {
  receipt: PendingReceipt;
  /** true = 该登记已被前一入口消费（同一次完成的第二入口，复用稳定去重键）。 */
  duplicate: boolean;
}

export interface PendingReceiptRegistry {
  register(receipt: Omit<PendingReceipt, 'registeredAt'> & { registeredAt?: number }): void;
  /** 按 targetAgentId 匹配；过期即删并返回 undefined。 */
  match(targetAgentId: string, at: number): PendingReceiptMatch | undefined;
  /** 枚举快照（任务17·A2 超时扫描消费；返回拷贝，外部修改不影响账本；顺带惰性清扫）。 */
  list(at?: number): PendingReceipt[];
  /** 按 targetAgentId 移除（任务16 撤回清理旧回执；返回是否命中）。 */
  remove(targetAgentId: string): boolean;
  size(): number;
  clear(): void;
}

/** 待回执 TTL（初始值待校准：覆盖长任务回合；过期后退化为未匹配完成，仍过判断层不静默）。 */
export const DEFAULT_RECEIPT_TTL_MS = 2 * 60 * 60 * 1000;
/** 条目上限（初始值待校准：同时在跑的派活数远小于它）。 */
export const MAX_PENDING_RECEIPTS = 100;
/** 任务摘要截断长度（内存 + 播报文本长度双重约束）。 */
export const MAX_TASK_SUMMARY_LENGTH = 80;

function truncateSummary(text: string | undefined): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > MAX_TASK_SUMMARY_LENGTH ? `${clean.slice(0, MAX_TASK_SUMMARY_LENGTH)}…` : clean;
}

export function createPendingReceiptRegistry(opts: {
  ttlMs?: number;
  maxEntries?: number;
} = {}): PendingReceiptRegistry {
  const ttlMs = opts.ttlMs ?? DEFAULT_RECEIPT_TTL_MS;
  const maxEntries = opts.maxEntries ?? MAX_PENDING_RECEIPTS;
  const entries = new Map<string, PendingReceipt>();

  /** 惰性清扫：删除已过 TTL 的条目（register / match 时顺带，无定时器）。 */
  function sweep(now: number): void {
    for (const [id, entry] of entries) {
      if (now - entry.registeredAt >= ttlMs) entries.delete(id);
    }
  }

  function register(receipt: Omit<PendingReceipt, 'registeredAt'> & { registeredAt?: number }): void {
    const registeredAt = receipt.registeredAt ?? Date.now();
    sweep(registeredAt);
    entries.set(receipt.targetAgentId, {
      targetAgentId: receipt.targetAgentId,
      bossId: receipt.bossId,
      taskId: receipt.taskId,
      decisionId: receipt.decisionId,
      taskSummary: truncateSummary(receipt.taskSummary),
      registeredAt,
    });
    // 上限驱逐最旧（Map 迭代序=插入序，但覆盖登记会保序错位，这里显式找最旧）
    while (entries.size > maxEntries) {
      let oldestId: string | undefined;
      let oldestAt = Infinity;
      for (const [id, entry] of entries) {
        if (entry.registeredAt < oldestAt) {
          oldestAt = entry.registeredAt;
          oldestId = id;
        }
      }
      if (oldestId === undefined) break;
      entries.delete(oldestId);
    }
  }

  function match(targetAgentId: string, at: number): PendingReceiptMatch | undefined {
    sweep(at);
    const entry = entries.get(targetAgentId);
    if (!entry) return undefined;
    if (entry.matchedAt !== undefined) return { receipt: entry, duplicate: true };
    entry.matchedAt = at;
    return { receipt: entry, duplicate: false };
  }

  function list(at: number = Date.now()): PendingReceipt[] {
    sweep(at);
    return Array.from(entries.values(), (entry) => ({ ...entry }));
  }

  function remove(targetAgentId: string): boolean {
    return entries.delete(targetAgentId);
  }

  return {
    register,
    match,
    list,
    remove,
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}

// ============================================================================
// 模块级单例（生产路径用；测试可 reset）
// ============================================================================

const registry = createPendingReceiptRegistry();

export function registerPendingReceipt(
  receipt: Omit<PendingReceipt, 'registeredAt'> & { registeredAt?: number },
): void {
  registry.register(receipt);
}

export function matchPendingReceipt(targetAgentId: string, at: number): PendingReceiptMatch | undefined {
  return registry.match(targetAgentId, at);
}

/** 任务17·A2：待回执枚举快照（超时扫描用）。 */
export function listPendingReceipts(at?: number): PendingReceipt[] {
  return registry.list(at);
}

/** 任务16：按 targetAgentId 移除待回执（撤回后不再匹配/播报；返回是否命中）。 */
export function removePendingReceiptsForAgent(targetAgentId: string): boolean {
  return registry.remove(targetAgentId);
}

export function pendingReceiptCount(): number {
  return registry.size();
}

export function resetPendingReceiptsForTests(): void {
  registry.clear();
}
