/**
 * jarvis-core/sentinel · ⑭ 观测适配（任务 33 ⑦）
 *
 * 钉死：事件构造器（迁移/指令/自愈/降级）的 level 与字段；SentinelEvent →
 * logEvent('system', { source:'sentinel', body.cat:'sentinel' }) 映射；
 * 适配器自身不抛（观测失败不影响主链路）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  SENTINEL_LOG_CAT,
  SENTINEL_SOURCE,
  directiveEvent,
  createSentinelLogObserver,
  phaseTransitionEvent,
  selfHealEvent,
  statsDegradedEvent,
} from './index.js';
import { buildSentinelDirective } from './index.js';
import type { SentinelDegradeDirective, SentinelPhaseTransition, SentinelSelfHealSuggestion } from './index.js';

const AT = new Date(2026, 9, 1, 12).getTime();

const transition: SentinelPhaseTransition = {
  from: 'normal',
  to: 'degraded',
  day: '2026-10-1',
  at: AT,
  verdict: 'critical',
  reason: 'ignore-rate-critical',
};

const directive: SentinelDegradeDirective = buildSentinelDirective('degraded', {
  day: '2026-10-1',
  at: AT,
  verdict: 'critical',
})!;

const suggestion: SentinelSelfHealSuggestion = {
  reason: 'repeated-request',
  action: 'degrade-and-apologize',
  maxTier: 'STORE',
  at: AT,
  count: 3,
  key: '帮我查一下明天的天气',
  samples: ['帮我查一下明天的天气'],
  firstAt: AT - 60_000,
  lastAt: AT,
  similarity: 1,
  windowMs: 30 * 60_000,
};

describe('事件构造器（纯函数）', () => {
  it('相位迁移：进入 degraded 记 warn，其余 info；字段全带', () => {
    const event = phaseTransitionEvent(transition);
    expect(event).toMatchObject({
      kind: 'sentinel.phase.transition',
      level: 'warn',
      at: AT,
      day: '2026-10-1',
      phase: 'degraded',
      fromPhase: 'normal',
      toPhase: 'degraded',
      transitionReason: 'ignore-rate-critical',
      verdict: 'critical',
    });

    const cleared = phaseTransitionEvent({ ...transition, from: 'warning', to: 'normal', reason: 'warning-cleared' });
    expect(cleared.level).toBe('info');
  });

  it('降级指令：store-only 记 warn、reduce-frequency 记 info，指令对象随事件', () => {
    const storeOnly = directiveEvent(directive);
    expect(storeOnly).toMatchObject({ kind: 'sentinel.directive', level: 'warn', directive: { maxTier: 'STORE' } });

    const reduce = directiveEvent(
      buildSentinelDirective('warning', { day: '2026-10-1', at: AT, verdict: 'warning' })!,
    );
    expect(reduce.level).toBe('info');
    expect(reduce.directive?.action).toBe('reduce-frequency');
  });

  it('自愈建议恒 warn，计数/键进 extra；端口降级带原因与错误摘要', () => {
    const event = selfHealEvent(suggestion);
    expect(event.kind).toBe('sentinel.self-heal.suggested');
    expect(event.level).toBe('warn');
    expect(event.extra).toMatchObject({ selfHealReason: 'repeated-request', selfHealCount: 3 });

    const degraded = statsDegradedEvent({ reason: 'port_error', error: new Error('db down') }, AT, '2026-10-1');
    expect(degraded).toMatchObject({ kind: 'sentinel.stats.degraded', level: 'warn', degradeReason: 'port_error' });
    expect(degraded.extra).toMatchObject({ error: 'db down' });
  });
});

describe('createSentinelLogObserver（⑭ system/sentinel）', () => {
  it('映射 body：cat/channel/相位/判词/指令全字段；缺省 channel = sentinel', () => {
    const logEvent = vi.fn();
    const observe = createSentinelLogObserver(logEvent);
    observe(phaseTransitionEvent(transition));
    observe(directiveEvent(directive));

    expect(logEvent).toHaveBeenCalledTimes(2);
    const [category, fields] = logEvent.mock.calls[0];
    expect(category).toBe('system');
    expect(fields.source).toBe(SENTINEL_SOURCE);
    expect(fields.level).toBe('warn');
    expect(fields.body).toMatchObject({
      cat: SENTINEL_LOG_CAT,
      channel: 'sentinel',
      kind: 'sentinel.phase.transition',
      at: AT,
      day: '2026-10-1',
      phase: 'degraded',
      fromPhase: 'normal',
      toPhase: 'degraded',
      transitionReason: 'ignore-rate-critical',
      verdict: 'critical',
    });
    expect(logEvent.mock.calls[1][1].body.directive).toMatchObject({ action: 'store-only', maxTier: 'STORE' });
  });

  it('自定义 channel + 自愈建议 body；(source, body) 可按 source=sentinel 过滤', () => {
    const logEvent = vi.fn();
    const observe = createSentinelLogObserver(logEvent, { channel: 'sentinel-test' });
    observe(selfHealEvent(suggestion));
    const fields = logEvent.mock.calls[0][1];
    expect(fields.body.channel).toBe('sentinel-test');
    expect(fields.body.suggestion).toMatchObject({ reason: 'repeated-request', count: 3 });
    expect(fields.body.selfHealCount).toBe(3);
  });

  it('logEvent 抛错 → 适配器吞掉（绝不打断熔断/自愈链路）', () => {
    const logEvent = vi.fn(() => {
      throw new Error('db down');
    });
    const observe = createSentinelLogObserver(logEvent);
    expect(() => observe(statsDegradedEvent({ reason: 'port_not_wired' }, AT))).not.toThrow();
  });
});
