/**
 * 任务33 接线 · 活动监视器服务单测（W11）
 *
 * 相位持久化 / 每日评估（评昨日、同日幂等、缺源保持）/ 事件闸口（store-only 与
 * 哈希确定性降频）；临时状态文件 + 静态端口替身，now 显式注入，不碰真盘真库。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// logSuppressedVoiceEvent 只验证「落什么」,不落真库
vi.mock('./activity-log.js', () => ({ logDialogMessage: vi.fn() }));

import { logDialogMessage } from './activity-log.js';
import {
  SentinelService,
  __resetSentinelServiceForTest,
  evaluateVoiceEventGate,
  logSuppressedVoiceEvent,
  shouldKeepByHash,
} from './sentinel-service.js';
import {
  createStaticStatsProvider,
  createUnavailableStatsProvider,
  type SentinelEventSink,
  type SentinelPhaseState,
} from '../jarvis-core/sentinel/index.js';
import type { JarvisLogger } from '../jarvis-core/executors.js';

const NOW = new Date(2026, 9, 5, 0, 10, 0, 0).getTime(); // 2026-10-05 00:10 本地
const YESTERDAY = '2026-10-4'; // localDayKey 口径（不补零）

let dir: string;
let file: string;
let sink: ReturnType<typeof vi.fn<SentinelEventSink>>;
let logger: { [K in keyof JarvisLogger]: ReturnType<typeof vi.fn<JarvisLogger[K]>> };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-test-'));
  file = path.join(dir, 'phase-state.json');
  sink = vi.fn<SentinelEventSink>();
  logger = {
    log: vi.fn<JarvisLogger['log']>(),
    debug: vi.fn<JarvisLogger['debug']>(),
    warn: vi.fn<JarvisLogger['warn']>(),
    error: vi.fn<JarvisLogger['error']>(),
  };
  vi.mocked(logDialogMessage).mockClear();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('SentinelService · 初始态与持久化', () => {
  it('无状态文件:normal,闸口放行,不产生落盘副作用', () => {
    const svc = new SentinelService({ filePath: file, port: createUnavailableStatsProvider(), sink, logger });
    expect(svc.load().phase).toBe('normal');
    expect(svc.getDirective(NOW)).toBeNull();
    expect(svc.evaluateEventGate('⟦系统事件⟧ x', NOW)).toEqual({ decision: 'pass', directive: null });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('损坏状态文件:按初始态处理 + warn(不抛)', () => {
    fs.writeFileSync(file, '{oops', 'utf-8');
    const svc = new SentinelService({ filePath: file, port: createUnavailableStatsProvider(), sink, logger });
    expect(svc.load().phase).toBe('normal');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('形态非法(合法 JSON 但字段不合法):按初始态处理 + warn', () => {
    fs.writeFileSync(file, '{"phase":"bogus","updatedAt":1}', 'utf-8');
    const svc = new SentinelService({ filePath: file, port: createUnavailableStatsProvider(), sink, logger });
    expect(svc.load().phase).toBe('normal');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('critical 日 → degraded:落盘 + ⑭ 事件(迁移+指令) + 重启后存量指令不丢', async () => {
    const port = createStaticStatsProvider({
      [YESTERDAY]: { proactiveBroadcasts: 10, ignored: 6, adopted: 4, complaints: 0 }, // 忽略率 0.6 > 0.4
    });
    const svc = new SentinelService({ filePath: file, port, sink, logger });

    const ev = await svc.runDailyScan(NOW);
    expect(ev.verdict).toBe('critical');
    expect(ev.transition).toMatchObject({ from: 'normal', to: 'degraded', reason: 'ignore-rate-critical' });
    expect(ev.directive).toMatchObject({ action: 'store-only', maxTier: 'STORE', speakAllowed: false, speechFactor: 0 });
    expect(svc.evaluateEventGate('⟦系统事件⟧ 任意事件', NOW).decision).toBe('store-only');

    // 落盘内容
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as SentinelPhaseState;
    expect(saved.phase).toBe('degraded');
    expect(saved.lastEvaluatedDay).toBe(YESTERDAY);

    // ⑭ 事件:相位迁移 + 降级指令
    const kinds = sink.mock.calls.map(([e]) => (e as { kind: string }).kind);
    expect(kinds).toContain('sentinel.phase.transition');
    expect(kinds).toContain('sentinel.directive');

    // 新实例读同一文件:保护不中断(重启后存量指令仍在)
    const svc2 = new SentinelService({ filePath: file, port: createUnavailableStatsProvider(), sink, logger });
    expect(svc2.load().phase).toBe('degraded');
    expect(svc2.evaluateEventGate('⟦系统事件⟧ 重启后', NOW).decision).toBe('store-only');
  });

  it('同日重复评估幂等(already-evaluated-today),相位与指令不变', async () => {
    const port = createStaticStatsProvider({
      [YESTERDAY]: { proactiveBroadcasts: 10, ignored: 6, adopted: 4, complaints: 0 },
    });
    const svc = new SentinelService({ filePath: file, port, sink, logger });
    await svc.runDailyScan(NOW);

    const again = await svc.runDailyScan(NOW + 60_000);
    expect(again.skippedReason).toBe('already-evaluated-today');
    expect(again.state.phase).toBe('degraded');
    expect(again.directive).toMatchObject({ action: 'store-only' });
  });

  it('缺源日(端口无该日数据):相位保持 + 判词 insufficient,不发降级事件', async () => {
    const svc = new SentinelService({ filePath: file, port: createStaticStatsProvider({}), sink, logger });
    const ev = await svc.runDailyScan(NOW);
    expect(ev.skippedReason).toBe('insufficient-metrics');
    expect(ev.verdict).toBe('insufficient');
    expect(ev.state.phase).toBe('normal');
    expect(ev.directive).toBeNull();
    expect(sink).not.toHaveBeenCalled();
  });

  it('端口抛错:隔离为 stats.degraded 事件,评估不上抛、相位保持', async () => {
    const port = {
      readDay: () => {
        throw new Error('boom');
      },
    };
    const svc = new SentinelService({ filePath: file, port, sink, logger });
    const ev = await svc.runDailyScan(NOW);
    expect(ev.skippedReason).toBe('insufficient-metrics');
    expect(ev.state.phase).toBe('normal');
    expect(sink.mock.calls.map(([e]) => (e as { kind: string }).kind)).toContain('sentinel.stats.degraded');
  });

  it('开关关:闸口全放行、评估 skipped=disabled 且不落盘', async () => {
    const port = createStaticStatsProvider({
      [YESTERDAY]: { proactiveBroadcasts: 10, ignored: 6, adopted: 4, complaints: 0 },
    });
    const svc = new SentinelService({ filePath: file, port, config: { enabled: false }, sink, logger });
    expect(svc.evaluateEventGate('⟦系统事件⟧ x', NOW)).toEqual({ decision: 'pass', directive: null });
    const ev = await svc.runDailyScan(NOW);
    expect(ev.skippedReason).toBe('disabled');
    expect(sink).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('SentinelService · 事件闸口(降频)', () => {
  it('warning(投诉触线) → reduce-frequency;哈希降频确定性(同文本同日恒同判)且两侧都有样本', async () => {
    const port = createStaticStatsProvider({
      [YESTERDAY]: { proactiveBroadcasts: 10, ignored: null, adopted: null, complaints: 1 },
    });
    const svc = new SentinelService({ filePath: file, port, sink, logger });
    const ev = await svc.runDailyScan(NOW);
    expect(ev.verdict).toBe('warning'); // ignoreRate 缺源,仅投诉触线
    expect(ev.state.phase).toBe('warning');
    expect(ev.directive).toMatchObject({ action: 'reduce-frequency', speakAllowed: true, speechFactor: 0.5 });

    const text = '⟦系统事件⟧ 过去 3 分钟:① 构建完成';
    const first = svc.evaluateEventGate(text, NOW).decision;
    expect(first === 'pass' || first === 'throttle').toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(svc.evaluateEventGate(text, NOW).decision).toBe(first); // 确定性
    }
    const decisions = new Set(
      Array.from({ length: 16 }, (_, i) => svc.evaluateEventGate(`⟦系统事件⟧ 变化样本 ${i}`, NOW).decision),
    );
    expect([...decisions].sort()).toEqual(['pass', 'throttle']); // 50% 降频:两侧都有
  });

  it('shouldKeepByHash:边界(≥1 全放/≤0 全抑)与单调性(0.5 保留 ⇒ 0.9 必保留)', () => {
    expect(shouldKeepByHash('x', 'd', 1)).toBe(true);
    expect(shouldKeepByHash('x', 'd', 0)).toBe(false);
    const kept = shouldKeepByHash('hello', '2026-10-5', 0.5);
    expect(shouldKeepByHash('hello', '2026-10-5', 0.5)).toBe(kept);
    expect(kept ? shouldKeepByHash('hello', '2026-10-5', 0.9) : true).toBe(true);
  });

  it('fail-open:闸口自身异常时放行(绝不吞播报)', () => {
    const spy = vi.spyOn(SentinelService.prototype, 'evaluateEventGate').mockImplementation(() => {
      throw new Error('gate boom');
    });
    try {
      __resetSentinelServiceForTest();
      expect(evaluateVoiceEventGate('⟦系统事件⟧ x', NOW)).toEqual({ decision: 'pass', directive: null });
    } finally {
      spy.mockRestore();
      __resetSentinelServiceForTest();
    }
  });
});

describe('logSuppressedVoiceEvent', () => {
  it('抑制落 dialog 日志(in + isEvent + degraded + sentinel-* action);pass 时不落', () => {
    logSuppressedVoiceEvent('⟦系统事件⟧ 被抑制的事件', { decision: 'store-only', directive: null });
    expect(logDialogMessage).toHaveBeenCalledTimes(1);
    expect(logDialogMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'in',
        text: '⟦系统事件⟧ 被抑制的事件',
        isEvent: true,
        degraded: true,
        action: 'sentinel-store-only',
      }),
    );
    logSuppressedVoiceEvent('x', { decision: 'pass', directive: null });
    expect(logDialogMessage).toHaveBeenCalledTimes(1);
  });

  it('throttle 决策落 sentinel-throttle action(degraded 标记)', () => {
    logSuppressedVoiceEvent('⟦系统事件⟧ 降频被丢的样本', { decision: 'throttle', directive: null });
    expect(logDialogMessage).toHaveBeenCalledTimes(1);
    expect(logDialogMessage).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'in', isEvent: true, degraded: true, action: 'sentinel-throttle' }),
    );
  });
});
