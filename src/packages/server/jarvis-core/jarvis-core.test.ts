/**
 * jarvis-core · 端到端骨架联测（任务 26 ⑥「心跳可跑、信号包可入队、幂等去重生效」）
 *
 * 串起三层：Heartbeat（事件唤醒 + wake→observe→reason→act）→ SignalQueue
 * （归一化入队 + 判定预扣 + 攒批）→ IdempotentExecutor（幂等执行 + 降级出口）。
 */

import { describe, expect, it } from 'vitest';

import type { Signal } from '../../shared/broadcast-gates.js';
import { IdempotentExecutor, deliverDecision, type JarvisLogger } from './executors.js';
import { Heartbeat } from './heartbeat.js';
import { SignalQueue, type ConsumedSignal, type RawSignal } from './signal-queue.js';

const silentLogger: JarvisLogger = {
  log: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

/** 本地 14:00（非深夜、非 focus time）。 */
const DAY = new Date(2026, 0, 15, 14, 0, 0).getTime();

describe('心跳 → 信号队列 → 执行器（骨架联测）', () => {
  it('事件唤醒跑完整链路；重复轮同 dedupeKey 不重执行；flush 不复扣预算', async () => {
    const queue = new SignalQueue({ now: DAY, logger: silentLogger });
    const executor = new IdempotentExecutor({ logger: silentLogger, sleep: async () => {}, now: () => DAY });
    const delivered: string[] = [];
    const rawSignals: RawSignal[] = [
      { source: 'agent', kind: 'agent_completed', dedupeKey: 'agent-completed:a1:t1', score: 95, text: '任务完成' },
      { source: 'system', kind: 'disk_low', dedupeKey: 'system:disk_low:1', score: 70, text: '磁盘 90%' },
    ];

    const heartbeat = new Heartbeat<readonly RawSignal[], ConsumedSignal[]>({
      logger: silentLogger,
      now: () => DAY, // 与 queue 同源显式时刻（残余风险③）
      phases: {
        wake: (ctx) => queue.refreshNow(ctx.now),
        // 骨架：直接返回原始信号；任务 30 接真实六路（collectSignalsSafely 逐源隔离）
        observe: () => rawSignals,
        reason: (raw) => {
          for (const item of raw) queue.enqueue(item);
          return queue.consumeAll();
        },
        act: async (consumed) => {
          for (const item of consumed) {
            if (item.decision.tier === 'SILENT') continue;
            await executor.submit({ dedupeKey: item.signal.dedupeKey, kind: item.signal.kind }, async () => {
              await deliverDecision(
                item.signal,
                item.decision,
                {
                  speak: (signal: Signal) => {
                    delivered.push(signal.dedupeKey);
                  },
                },
                { logger: silentLogger },
              );
            });
          }
        },
      },
    });

    // 第 1 轮：高分 SPEAK 出口执行一次；中分 PREPARE 只攒批不出声
    expect(heartbeat.wakeNow()).toBe(true);
    await heartbeat.whenIdle();
    expect(heartbeat.stats.cycles).toBe(1);
    expect(delivered).toEqual(['agent-completed:a1:t1']);
    expect(queue.preparedCount).toBe(1);
    expect(queue.snapshotState().spokenToday).toBe(2); // SPEAK + PREPARE 各预扣 1
    expect(queue.snapshotState().instantSpeakToday).toBe(1);

    // 第 2 轮：同 dedupeKey → 判断层 duplicate（seenKeys）+ 执行器已完成键，双保险不重执行
    expect(heartbeat.wakeNow()).toBe(true);
    await heartbeat.whenIdle();
    expect(heartbeat.stats.cycles).toBe(2);
    expect(delivered).toEqual(['agent-completed:a1:t1']);
    expect(queue.snapshotState().spokenToday).toBe(2);

    // PREPARE 到自然开口点出队交付：只出队，不复扣预算（残余风险①）
    const prepared = queue.flushPrepared();
    expect(prepared).toHaveLength(1);
    expect(prepared[0]!.signal.dedupeKey).toBe('system:disk_low:1');
    expect(prepared[0]!.budgetCharged).toBe(true);
    expect(queue.snapshotState().spokenToday).toBe(2);
    expect(queue.preparedCount).toBe(0);
  });
});
