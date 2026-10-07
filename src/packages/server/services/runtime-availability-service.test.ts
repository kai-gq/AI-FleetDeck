import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProvider } from '../../shared/agent-types.js';
import {
  getRuntimeAvailability,
  invalidateRuntimeAvailabilityCache,
  probeAllRuntimes,
  type RuntimeProbeDeps,
} from './runtime-availability-service';

const ALL: AgentProvider[] = ['claude', 'codex', 'opencode', 'grok', 'pi'];

/** Every provider resolves to a bare name the fake scan reports as missing. */
function bareDeps(overrides: Partial<RuntimeProbeDeps> = {}): RuntimeProbeDeps {
  return {
    platform: 'win32',
    env: { PATH: 'C:\\bin' } as NodeJS.ProcessEnv,
    makeBackend: (provider) => ({ getExecutablePath: () => provider }),
    scan: () => null,
    exists: () => false,
    codexBinaryPath: () => '',
    validatePiBinary: () => true,
    ...overrides,
  };
}

beforeEach(() => {
  invalidateRuntimeAvailabilityCache();
});

describe('probeAllRuntimes', () => {
  it('reports a PATH hit as available, source "path"', () => {
    const result = probeAllRuntimes(
      bareDeps({
        makeBackend: (provider) => ({ getExecutablePath: () => (provider === 'claude' ? 'claude' : provider) }),
        scan: (name) => (name === 'claude' ? 'C:\\bin\\claude.cmd' : null),
      })
    );
    const claude = result.providers.find((p) => p.provider === 'claude')!;
    expect(claude.available).toBe(true);
    expect(claude.executable).toBe('C:\\bin\\claude.cmd');
    expect(claude.source).toBe('path');
    expect(result.degraded).toBe(false);
  });

  it('marks an absolute existing path as detected', () => {
    const result = probeAllRuntimes(
      bareDeps({
        makeBackend: (provider) => ({
          getExecutablePath: () => (provider === 'claude' ? 'C:\\tools\\claude.exe' : provider),
        }),
        exists: (p) => p === 'C:\\tools\\claude.exe',
      })
    );
    const claude = result.providers.find((p) => p.provider === 'claude')!;
    expect(claude.available).toBe(true);
    expect(claude.source).toBe('detected');
  });

  it('classifies an env override and flags a missing configured path', () => {
    const result = probeAllRuntimes(
      bareDeps({
        env: { PATH: 'C:\\bin', TC_CLAUDE_EXECUTABLE: 'C:\\gone\\claude.exe' } as NodeJS.ProcessEnv,
        makeBackend: (provider) => ({
          getExecutablePath: () => (provider === 'claude' ? 'C:\\gone\\claude.exe' : provider),
        }),
        exists: () => false,
      })
    );
    const claude = result.providers.find((p) => p.provider === 'claude')!;
    expect(claude.available).toBe(false);
    expect(claude.source).toBe('env');
    expect(claude.note).toBe('configured executable not found');
  });

  it('classifies the Settings-stored codex binary', () => {
    const result = probeAllRuntimes(
      bareDeps({
        makeBackend: (provider) => ({
          getExecutablePath: () => (provider === 'codex' ? 'C:\\custom\\codex.cmd' : provider),
        }),
        exists: (p) => p === 'C:\\custom\\codex.cmd',
        codexBinaryPath: () => 'C:\\custom\\codex.cmd',
      })
    );
    const codex = result.providers.find((p) => p.provider === 'codex')!;
    expect(codex.available).toBe(true);
    expect(codex.source).toBe('settings');
  });

  it('keeps a relative configured path visible (fail open)', () => {
    const result = probeAllRuntimes(
      bareDeps({
        makeBackend: (provider) => ({
          getExecutablePath: () => (provider === 'claude' ? '.\\tools\\claude.exe' : provider),
        }),
      })
    );
    const claude = result.providers.find((p) => p.provider === 'claude')!;
    expect(claude.available).toBe(true);
    expect(claude.source).toBe('unknown');
  });

  it('fail open: a throwing backend keeps the runtime and marks degraded', () => {
    const result = probeAllRuntimes(
      bareDeps({
        makeBackend: () => ({
          getExecutablePath: () => {
            throw new Error('boom');
          },
        }),
      })
    );
    expect(result.providers.every((p) => p.available)).toBe(true);
    expect(result.providers[0].source).toBe('unknown');
    expect(result.providers[0].note).toContain('detection failed: boom');
    expect(result.degraded).toBe(true);
  });

  it('rejects a look-alike pi found on PATH', () => {
    const result = probeAllRuntimes(
      bareDeps({
        makeBackend: (provider) => ({ getExecutablePath: () => provider }),
        scan: (name) => (name === 'pi' ? '/usr/bin/pi' : null),
        validatePiBinary: () => false,
      })
    );
    const pi = result.providers.find((p) => p.provider === 'pi')!;
    expect(pi.available).toBe(false);
    expect(pi.note).toContain('different executable named pi');
  });

  it('degrades when nothing is detected, but never throws', () => {
    const result = probeAllRuntimes(bareDeps());
    expect(result.ok).toBe(true);
    expect(result.providers.every((p) => !p.available)).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.notes.some((n) => n.includes('no runtime detected'))).toBe(true);
  });

  it('degrades when PATH is missing', () => {
    const result = probeAllRuntimes(
      bareDeps({
        env: {} as NodeJS.ProcessEnv,
        makeBackend: (provider) => ({
          getExecutablePath: () => (provider === 'claude' ? 'C:\\tools\\claude.exe' : provider),
        }),
        exists: () => true,
      })
    );
    expect(result.degraded).toBe(true);
    expect(result.notes.some((n) => n.includes('PATH is empty'))).toBe(true);
  });

  it('serves static model ids with deprecated entries removed', () => {
    const result = probeAllRuntimes(bareDeps());
    const byProvider = new Map(result.providers.map((p) => [p.provider, p]));
    expect(byProvider.get('claude')!.models).toContain('claude-opus-5-5[1m]');
    expect(byProvider.get('claude')!.models).not.toContain('claude-opus-4-6');
    expect(byProvider.get('claude')!.models).not.toContain('sonnet');
    expect(byProvider.get('codex')!.models).toContain('gpt-6.1-sol');
    expect(byProvider.get('codex')!.models).not.toContain('gpt-6-sol');
    expect(byProvider.get('grok')!.models).toEqual(['grok-4.6', 'grok-4.5']);
    expect(byProvider.get('pi')!.models).toEqual([]);
    expect(byProvider.get('pi')!.modelsEndpoint).toBe('/api/agents/pi/models');
    expect(byProvider.get('opencode')!.modelsEndpoint).toBe('/api/agents/opencode/models');
  });

  it('keeps picker order stable across providers', () => {
    const result = probeAllRuntimes(bareDeps());
    expect(result.providers.map((p) => p.provider)).toEqual(ALL);
  });
});

describe('getRuntimeAvailability cache', () => {
  it('serves the cached value, and refresh bypasses the TTL', () => {
    const makeBackend = vi.fn((provider: AgentProvider) => ({
      getExecutablePath: () => provider,
    }));
    const deps = bareDeps({ makeBackend });

    getRuntimeAvailability({ deps });
    getRuntimeAvailability({ deps });
    expect(makeBackend).toHaveBeenCalledTimes(ALL.length); // second call came from cache

    getRuntimeAvailability({ deps, refresh: true });
    expect(makeBackend).toHaveBeenCalledTimes(ALL.length * 2);
  });

  it('never throws even when the whole probe blows up', () => {
    const broken = new Error('total failure');
    Object.defineProperty(broken, 'name', { value: 'Error' });
    const result = getRuntimeAvailability({
      refresh: true,
      deps: {
        makeBackend: () => {
          throw broken;
        },
      },
    });
    // Per-provider failures are caught inside probeAllRuntimes — the result
    // is a valid, degraded payload rather than an exception.
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.providers).toHaveLength(ALL.length);
  });
});
