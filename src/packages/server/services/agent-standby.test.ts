import { describe, expect, it } from 'vitest';
import {
  AGENT_ON_STANDBY,
  assertAgentNotOnStandby,
  isOnStandby,
  standbyRefusalMessage,
} from './agent-standby.js';

describe('agent-standby guard', () => {
  it('isOnStandby: 仅严格 true 成立，脏值/缺省/空一律否', () => {
    expect(isOnStandby({ standby: true })).toBe(true);
    expect(isOnStandby({ standby: false })).toBe(false);
    expect(isOnStandby({ standby: undefined })).toBe(false);
    expect(isOnStandby({})).toBe(false);
    expect(isOnStandby(null)).toBe(false);
    expect(isOnStandby(undefined)).toBe(false);
    // 脏值（旧数据/手改 JSON）不得被当成待岗
    expect(isOnStandby({ standby: 'yes' } as never)).toBe(false);
    expect(isOnStandby({ standby: 1 } as never)).toBe(false);
  });

  it('assertAgentNotOnStandby: 待岗抛带稳定错误码的 Error，文案含姓名与 id', () => {
    const agent = { id: 'a-1', name: 'Worker One', standby: true };
    let caught: (Error & { code?: string }) | null = null;
    try {
      assertAgentNotOnStandby(agent);
    } catch (err) {
      caught = err as Error & { code?: string };
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.code).toBe(AGENT_ON_STANDBY);
    expect(caught?.message).toBe(standbyRefusalMessage(agent));
    expect(caught?.message).toContain('Worker One');
    expect(caught?.message).toContain('a-1');
  });

  it('assertAgentNotOnStandby: 非待岗（含 false/脏值）静默放行', () => {
    expect(() => assertAgentNotOnStandby({ id: 'a-2', name: 'Ok', standby: false })).not.toThrow();
    expect(() => assertAgentNotOnStandby({ id: 'a-3', name: 'Ok' } as never)).not.toThrow();
  });
});
