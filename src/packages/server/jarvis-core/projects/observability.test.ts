/**
 * jarvis-core/projects · ⑪ 观测适配（任务 14·⑦ 观测点⑪）
 *
 * 钉死：ProjectRoutingEvent → logEvent('system', { source:'project-routing', body.cat })；
 * 三层候选/命中/最终 Boss/反问次数全进 body；适配器自身不抛（观测失败不影响主链路）。
 */

import { describe, expect, it, vi } from 'vitest';

import { createProjectRoutingLogObserver, PROJECT_ROUTING_SOURCE } from './observability.js';
import type { ProjectResolveResult } from './types.js';

function decision(partial: Partial<ProjectResolveResult> = {}): ProjectResolveResult {
  return {
    candidates: [
      { projectId: 'wsB', name: '项目B', layer: 'explicit', source: 'alias:项目b', hit: true },
    ],
    needAsk: false,
    ...partial,
  };
}

describe('createProjectRoutingLogObserver', () => {
  it('route 事件 → ⑭ system 行：source/body 字段全映射', () => {
    const logEvent = vi.fn();
    const observe = createProjectRoutingLogObserver(logEvent, { channel: 'voice' });
    observe({
      kind: 'route',
      at: 1234,
      sessionId: 's1',
      taskId: 't1',
      text: '让项目B的团队做登录页',
      decision: decision({ projectId: 'wsB', projectName: '项目B', bossId: 'bossB', layer: 'explicit', source: 'alias:项目b' }),
      finalBossId: 'bossB',
      fallbackToFirstBoss: false,
    });
    expect(logEvent).toHaveBeenCalledTimes(1);
    const [category, fields] = logEvent.mock.calls[0];
    expect(category).toBe('system');
    expect(fields.source).toBe(PROJECT_ROUTING_SOURCE);
    expect(fields.sessionId).toBe('s1');
    expect(fields.level).toBe('info');
    expect(fields.body).toMatchObject({
      cat: 'project-routing',
      channel: 'voice',
      kind: 'route',
      at: 1234,
      taskId: 't1',
      text: '让项目B的团队做登录页',
      layer: 'explicit',
      source: 'alias:项目b',
      projectId: 'wsB',
      finalBossId: 'bossB',
      fallbackToFirstBoss: false,
      needAsk: false,
    });
    expect(fields.body.candidates).toEqual(decision().candidates);
  });

  it('need-ask 事件：反问句与累计反问次数进 body', () => {
    const logEvent = vi.fn();
    const observe = createProjectRoutingLogObserver(logEvent);
    observe({
      kind: 'need-ask',
      at: 1,
      decision: decision({ needAsk: true, suggestedProjectId: 'wsB', candidates: [] }),
      question: '这活要交给哪个项目？回一句项目名就行。',
      askCount: 1,
    });
    const fields = logEvent.mock.calls[0][1];
    expect(fields.body.needAsk).toBe(true);
    expect(fields.body.question).toContain('哪个项目');
    expect(fields.body.askCount).toBe(1);
  });

  it('clarify-fallback 缺省 warn（回落首位 Boss 是登记项，不静默）', () => {
    const logEvent = vi.fn();
    createProjectRoutingLogObserver(logEvent)({
      kind: 'clarify-fallback',
      at: 2,
      decision: decision({ candidates: [] }),
      finalBossId: 'bossA',
      fallbackToFirstBoss: true,
    });
    const fields = logEvent.mock.calls[0][1];
    expect(fields.level).toBe('warn');
    expect(fields.body.fallbackToFirstBoss).toBe(true);
    expect(fields.body.finalBossId).toBe('bossA');
  });

  it('logEvent 抛错 → 适配器吞掉（绝不打断派发/播报）', () => {
    const logEvent = vi.fn(() => {
      throw new Error('db down');
    });
    const observe = createProjectRoutingLogObserver(logEvent);
    expect(() => observe({ kind: 'route', at: 3 })).not.toThrow();
  });
});
