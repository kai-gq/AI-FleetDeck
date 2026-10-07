import { describe, it, expect, beforeEach } from 'vitest';
import { clearStandbyRequests, markStandbyRequest, wasStandbyJustRequested } from './standbyRequests';

describe('standbyRequests(待岗手势登记)', () => {
  beforeEach(() => {
    clearStandbyRequests();
  });

  it('只认登记过的 agent', () => {
    expect(wasStandbyJustRequested('a', 1000)).toBe(false);
    markStandbyRequest('a', 1000);
    expect(wasStandbyJustRequested('a', 1000)).toBe(true);
    expect(wasStandbyJustRequested('b', 1000)).toBe(false);
  });

  it('TTL 内有效、过期即失效(边界:恰好 15s 仍有效)', () => {
    markStandbyRequest('a', 1000);
    expect(wasStandbyJustRequested('a', 1000 + 15_000)).toBe(true);
    expect(wasStandbyJustRequested('a', 1000 + 15_001)).toBe(false);
  });

  it('重复登记以最后一次为准(重置 TTL)', () => {
    markStandbyRequest('a', 1000);
    markStandbyRequest('a', 10_000);
    expect(wasStandbyJustRequested('a', 10_000 + 14_000)).toBe(true);
  });

  it('登记新项时顺手清理过期项', () => {
    markStandbyRequest('a', 1000);
    markStandbyRequest('b', 1000 + 20_000); // 触发清理:a 已过期
    expect(wasStandbyJustRequested('a', 1000 + 20_000)).toBe(false);
    expect(wasStandbyJustRequested('b', 1000 + 20_000)).toBe(true);
  });
});
