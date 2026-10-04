/**
 * jarvis-core/reflection · Tier2 人工审查队列（任务 28 ⑤.4）
 *
 * 「未审不下发/不应用」的数据级落点：Tier2 操作只入队持久化，**不碰存储**；
 * 审批 API（listPendingReviews / approveReview / rejectReview）由调用方（未来 UI /
 * 主脑接线）驱动。本轮不做 UI（client/i18n 禁区；主脑登记延后）。
 *
 * 持久化：反思自己的 JSON 文件（默认 XDG 数据目录 jarvis-reflection/
 * pending-reviews.json），原子写（tmp + rename），损坏文件容错为空 + warn，
 * 风格对齐任务 27 FileMemoryStore 的持久化与降级约定。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { jarvisLogger, type JarvisLogger } from '../executors.js';
import type { MemoryStore } from '../memory/types.js';
import { applyReflectionOperations } from './operations.js';
import { defaultReviewQueuePath } from './paths.js';
import type { PlannedOperation, ReviewStatus, Tier2ReviewItem } from './types.js';

export interface Tier2ReviewQueueOptions {
  /** 存储文件；缺省 defaultReviewQueuePath()（测试必须显式注入临时文件）。 */
  filePath?: string;
  now?: () => number;
  logger?: JarvisLogger;
}

interface QueueFileShape {
  version: 1;
  items: Tier2ReviewItem[];
}

function cloneItem(item: Tier2ReviewItem): Tier2ReviewItem {
  return JSON.parse(JSON.stringify(item)) as Tier2ReviewItem;
}

export class Tier2ReviewQueue {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly logger: JarvisLogger;
  private cache: Tier2ReviewItem[] | null = null;

  constructor(options: Tier2ReviewQueueOptions = {}) {
    this.filePath = options.filePath ?? defaultReviewQueuePath();
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? jarvisLogger;
  }

  // --------------------------------------------------------------------------
  // 持久化
  // --------------------------------------------------------------------------

  /** 懒加载；文件不存在 = 空队列（正常）；损坏 = warn + 空队列（容错，不抛）。 */
  private load(): Tier2ReviewItem[] {
    if (this.cache) return this.cache;
    let content: string;
    try {
      content = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      this.cache = [];
      return this.cache;
    }
    try {
      const parsed = JSON.parse(content) as QueueFileShape;
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      this.cache = items.filter(
        (item): item is Tier2ReviewItem =>
          Boolean(item) && typeof item.id === 'string' && typeof item.runId === 'string' && Boolean(item.operation),
      );
    } catch (error) {
      this.logger.warn(`[Reflection] Tier2 队列文件损坏（按空队列处理）: ${this.filePath}`, error);
      this.cache = [];
    }
    return this.cache;
  }

  /** 原子落盘（tmp + rename，与 FileMemoryStore.persist 同型）。 */
  private persist(): void {
    const items = this.load();
    const payload: QueueFileShape = { version: 1, items };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  // --------------------------------------------------------------------------
  // 查询
  // --------------------------------------------------------------------------

  /** 待审列表（createdAt 升序、同刻按 id；返回副本，防外部改内存）。 */
  listPendingReviews(): Tier2ReviewItem[] {
    return this.listReviews('pending');
  }

  /** 按状态列出（缺省全部）；返回副本。 */
  listReviews(status?: ReviewStatus): Tier2ReviewItem[] {
    return this.load()
      .filter((item) => status === undefined || item.status === status)
      .sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id))
      .map(cloneItem);
  }

  getReview(id: string): Tier2ReviewItem | undefined {
    const found = this.load().find((item) => item.id === id);
    return found ? cloneItem(found) : undefined;
  }

  // --------------------------------------------------------------------------
  // 入队 / 审批
  // --------------------------------------------------------------------------

  /** Tier2 操作入队（仅 status='pending'；同 runId+opId 已存在则跳过）。 */
  enqueue(runId: string, operations: readonly PlannedOperation[]): Tier2ReviewItem[] {
    const items = this.load();
    const created: Tier2ReviewItem[] = [];
    for (const operation of operations) {
      if (operation.tier !== 2) continue;
      const id = `${runId}:${operation.opId}`;
      if (items.some((item) => item.id === id)) continue;
      const item: Tier2ReviewItem = {
        id,
        runId,
        createdAt: this.now(),
        status: 'pending',
        tierReason: operation.tierReason,
        operation: JSON.parse(JSON.stringify(operation)) as PlannedOperation,
      };
      items.push(item);
      created.push(cloneItem(item));
    }
    if (created.length > 0) this.persist();
    return created;
  }

  /**
   * 审批通过：可带 store → 立即应用该条操作（走 27 存储 API），并记录
   * applied/applyError；不带 store 则只做数据级状态迁移（主脑接线时注入）。
   * 未找到返回 null；已决记录幂等返回（不重复应用）。
   */
  async approveReview(
    id: string,
    options: { store?: MemoryStore } = {},
  ): Promise<Tier2ReviewItem | null> {
    const item = this.load().find((entry) => entry.id === id);
    if (!item) return null;
    if (item.status !== 'pending') return cloneItem(item);
    item.status = 'approved';
    item.decidedAt = this.now();
    if (options.store) {
      try {
        const [result] = await applyReflectionOperations(options.store, [item.operation], {
          opIds: [item.operation.opId],
        });
        item.applied = result?.applied ?? false;
        if (!item.applied) item.applyError = result?.error ?? result?.reason ?? 'unknown';
      } catch (error) {
        item.applied = false;
        item.applyError = error instanceof Error ? error.message : String(error);
      }
    }
    this.persist();
    return cloneItem(item);
  }

  /** 审批拒绝：仅状态迁移（不应用）。未找到返回 null；已决幂等返回。 */
  async rejectReview(id: string): Promise<Tier2ReviewItem | null> {
    const item = this.load().find((entry) => entry.id === id);
    if (!item) return null;
    if (item.status !== 'pending') return cloneItem(item);
    item.status = 'rejected';
    item.decidedAt = this.now();
    this.persist();
    return cloneItem(item);
  }
}
