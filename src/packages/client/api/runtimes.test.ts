import { describe, expect, it } from 'vitest';
import { hiddenProviders, isFiltering, visibleProviders, type RuntimeAvailabilityState } from './runtimes';
import type { AgentProvider } from '../../shared/agent-types';

function state(
  available: AgentProvider[],
  overrides: Partial<RuntimeAvailabilityState> = {}
): RuntimeAvailabilityState {
  return {
    loaded: true,
    degraded: false,
    providers: available.map((provider) => ({
      provider,
      available: true,
      executable: provider,
      source: 'path' as const,
      models: [],
      defaultModel: '',
    })),
    ...overrides,
  };
}

describe('visibleProviders', () => {
  it('shows everything until the server has answered (fail open)', () => {
    expect(visibleProviders({ loaded: false, degraded: false, providers: [] })).toEqual([
      'claude', 'codex', 'opencode', 'grok', 'pi',
    ]);
  });

  it('shows everything when the server flagged the probe as degraded', () => {
    expect(visibleProviders(state([], { degraded: true }))).toEqual([
      'claude', 'codex', 'opencode', 'grok', 'pi',
    ]);
  });

  it('shows everything when nothing at all was detected (suspicious)', () => {
    expect(visibleProviders(state([]))).toEqual(['claude', 'codex', 'opencode', 'grok', 'pi']);
  });

  it('keeps only detected providers, in picker order', () => {
    expect(visibleProviders(state(['claude', 'pi']))).toEqual(['claude', 'pi']);
    expect(hiddenProviders(state(['claude', 'pi']))).toEqual(['codex', 'opencode', 'grok']);
    expect(isFiltering(state(['claude', 'pi']))).toBe(true);
  });

  it('never hides a runtime that is in use', () => {
    // Current agent runs on codex, which this machine does not have.
    expect(visibleProviders(state(['claude']), 'codex')).toEqual(['claude', 'codex']);
  });

  it('does not duplicate the kept provider when it is available anyway', () => {
    expect(visibleProviders(state(['claude']), 'claude')).toEqual(['claude']);
  });

  it('is not "filtering" when everything is available', () => {
    expect(isFiltering(state(['claude', 'codex', 'opencode', 'grok', 'pi']))).toBe(false);
  });
});
