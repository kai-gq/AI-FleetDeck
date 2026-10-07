/**
 * Runtime availability — which provider CLIs (and which static-catalog
 * models) are usable on this machine.
 *
 * Feeds GET /api/runtimes (the boss pulls it before planning a team) and the
 * client-side filtering of the runtime pickers in the spawn / edit /
 * boss-spawn dialogs.
 *
 * Detection philosophy: never throw and never hide on doubt. A runtime is
 * reported unavailable only when the probe positively concluded "not
 * installed"; any internal error degrades to available=true so a broken
 * probe can never remove a runtime the user actually has.
 *
 * Note on cost: grok / pi / opencode `getExecutablePath()` may run a
 * synchronous `which` (5s timeout) internally — the 60s cache below bounds
 * that to roughly once a minute. No new blocking behavior is introduced.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  GROK_MODELS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_GROK_MODEL,
  DEFAULT_PI_MODEL,
  isDeprecatedClaudeModel,
  isDeprecatedCodexModel,
} from '../../shared/agent-types.js';
import type { AgentProvider, ClaudeModel, CodexModel } from '../../shared/agent-types.js';
import {
  RUNTIME_PROVIDER_ORDER,
  type RuntimeAvailability,
  type RuntimeProviderStatus,
  type RuntimeSource,
} from '../../shared/runtime-availability.js';
import { isPathLike, resolveExecutableOnPath, type PathScanDeps } from '../utils/executable-path.js';
import { ClaudeBackend } from '../claude/backend.js';
import { CodexBackend } from '../codex/backend.js';
import { GrokBackend } from '../grok/backend.js';
import { OpencodeBackend } from '../opencode/backend.js';
import { PiBackend, isPiCodingAgentBinary } from '../pi/backend.js';
import { getCodexBinaryPath } from './system-prompt-service.js';

/** Injectable seams — production callers pass nothing. */
export interface RuntimeProbeDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Defaults to the five real backends. */
  makeBackend?: (provider: AgentProvider) => { getExecutablePath(): string };
  /** Defaults to resolveExecutableOnPath. */
  scan?: (name: string, deps?: PathScanDeps) => string | null;
  exists?: (p: string) => boolean;
  /** Settings-stored codex binary, for source classification. */
  codexBinaryPath?: () => string;
  /** Rejects look-alike `pi` binaries on PATH. */
  validatePiBinary?: (p: string) => boolean;
}

const CACHE_TTL_MS = 60_000;

const ENV_OVERRIDE: Partial<Record<AgentProvider, string>> = {
  claude: 'TC_CLAUDE_EXECUTABLE',
  codex: 'CODEX_BINARY',
  grok: 'GROK_BINARY',
  pi: 'PI_BINARY',
  // opencode has no override env var.
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultMakeBackend(provider: AgentProvider): { getExecutablePath(): string } {
  switch (provider) {
    case 'claude':
      return new ClaudeBackend();
    case 'codex':
      return new CodexBackend();
    case 'grok':
      return new GrokBackend();
    case 'opencode':
      return new OpencodeBackend();
    case 'pi':
      return new PiBackend();
  }
}

/**
 * Static model info per provider, in picker order (the catalog key order is
 * the picker order). pi/opencode have live catalogs behind `modelsEndpoint`;
 * spawning their CLIs from a page-load endpoint is not acceptable (no
 * negative cache → a credentials-less install would re-spawn on every call),
 * so their `models` stay empty here and consumers fetch the endpoint.
 */
function staticModelInfo(provider: AgentProvider): Pick<RuntimeProviderStatus, 'models' | 'defaultModel' | 'modelsEndpoint'> {
  switch (provider) {
    case 'claude':
      return {
        models: (Object.keys(CLAUDE_MODELS) as ClaudeModel[]).filter((m) => !isDeprecatedClaudeModel(m)),
        defaultModel: DEFAULT_CLAUDE_MODEL,
      };
    case 'codex':
      return {
        models: (Object.keys(CODEX_MODELS) as CodexModel[]).filter((m) => !isDeprecatedCodexModel(m)),
        defaultModel: DEFAULT_CODEX_MODEL,
      };
    case 'grok':
      return { models: Object.keys(GROK_MODELS), defaultModel: DEFAULT_GROK_MODEL };
    case 'pi':
      return { models: [], defaultModel: DEFAULT_PI_MODEL, modelsEndpoint: '/api/agents/pi/models' };
    case 'opencode':
      return { models: [], defaultModel: '', modelsEndpoint: '/api/agents/opencode/models' };
  }
}

interface ProbeIo {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  makeBackend: (provider: AgentProvider) => { getExecutablePath(): string };
  scan: (name: string, deps?: PathScanDeps) => string | null;
  exists: (p: string) => boolean;
  codexBinaryPath: () => string;
  validatePiBinary: (p: string) => boolean;
}

function classifySource(provider: AgentProvider, resolved: string, io: ProbeIo): RuntimeSource {
  const envName = ENV_OVERRIDE[provider];
  if (envName && (io.env[envName] ?? '').trim() === resolved) return 'env';
  if (provider === 'codex') {
    try {
      if (io.codexBinaryPath() === resolved) return 'settings';
    } catch {
      /* settings unavailable — fall through */
    }
  }
  return path.isAbsolute(resolved) ? 'detected' : 'unknown';
}

function probeProvider(provider: AgentProvider, io: ProbeIo): { status: RuntimeProviderStatus; probeFailed: boolean } {
  const base = { provider, ...staticModelInfo(provider) };

  let resolved: string;
  try {
    resolved = (io.makeBackend(provider).getExecutablePath() ?? '').trim();
  } catch (err) {
    // Fail open: an internal detection error must not hide a runtime.
    return {
      status: {
        ...base,
        available: true,
        executable: null,
        source: 'unknown',
        note: `detection failed: ${errorMessage(err)}`,
      },
      probeFailed: true,
    };
  }

  if (!resolved) {
    return { status: { ...base, available: false, executable: null, source: 'none' }, probeFailed: false };
  }

  if (isPathLike(resolved)) {
    if (!path.isAbsolute(resolved)) {
      // Relative to the future agent's working directory — cannot be judged
      // from here; keep it (fail open).
      return {
        status: {
          ...base,
          available: true,
          executable: resolved,
          source: classifySource(provider, resolved, io),
          note: 'relative path — resolved against the agent working directory',
        },
        probeFailed: false,
      };
    }
    const ok = io.exists(resolved);
    return {
      status: {
        ...base,
        available: ok,
        executable: resolved,
        source: classifySource(provider, resolved, io),
        ...(ok ? {} : { note: 'configured executable not found' }),
      },
      probeFailed: false,
    };
  }

  // Bare command name — every known install location missed; fall back to a
  // PATH scan (honours PATHEXT on Windows).
  const hit = io.scan(resolved, { platform: io.platform, pathValue: io.env.PATH ?? io.env.Path });
  if (!hit) {
    return { status: { ...base, available: false, executable: resolved, source: 'none' }, probeFailed: false };
  }
  if (provider === 'pi') {
    let valid = true;
    try {
      valid = io.validatePiBinary(hit);
    } catch {
      valid = false;
    }
    if (!valid) {
      // A different `pi` (e.g. anaconda's python tool) — pi itself would
      // refuse it too; report unavailable rather than mislead.
      return {
        status: {
          ...base,
          available: false,
          executable: hit,
          source: 'none',
          note: 'a different executable named pi is on PATH',
        },
        probeFailed: false,
      };
    }
  }
  return { status: { ...base, available: true, executable: hit, source: 'path' }, probeFailed: false };
}

/** Pure probe (no cache) — exported for tests and future callers. */
export function probeAllRuntimes(deps: RuntimeProbeDeps = {}): RuntimeAvailability {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const io: ProbeIo = {
    platform,
    env,
    makeBackend: deps.makeBackend ?? defaultMakeBackend,
    scan: deps.scan ?? ((name, scanDeps) => resolveExecutableOnPath(name, scanDeps)),
    exists: deps.exists ?? ((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    }),
    codexBinaryPath: deps.codexBinaryPath ?? getCodexBinaryPath,
    validatePiBinary: deps.validatePiBinary ?? isPiCodingAgentBinary,
  };

  const providers: RuntimeProviderStatus[] = [];
  const notes: string[] = [];
  let probeFailed = false;

  for (const provider of RUNTIME_PROVIDER_ORDER) {
    const { status, probeFailed: failed } = probeProvider(provider, io);
    if (failed) {
      probeFailed = true;
      notes.push(`${provider}: ${status.note}`);
    }
    providers.push(status);
  }

  const pathValue = (env.PATH ?? env.Path ?? '').trim();
  if (!pathValue) notes.push('PATH is empty — path-based detection is unreliable');
  const allUnavailable = providers.every((p) => !p.available);
  if (allUnavailable) {
    notes.push('no runtime detected — check that the CLIs are installed and that PATH reaches the server process');
  }
  const degraded = probeFailed || !pathValue || allUnavailable;

  return { ok: true, generatedAt: Date.now(), platform, degraded, providers, notes };
}

let cache: { at: number; value: RuntimeAvailability } | null = null;

/** Cached probe; `refresh` bypasses the 60s TTL. Never throws. */
export function getRuntimeAvailability(opts: { refresh?: boolean; deps?: RuntimeProbeDeps } = {}): RuntimeAvailability {
  const now = Date.now();
  if (!opts.refresh && cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  let value: RuntimeAvailability;
  try {
    value = probeAllRuntimes(opts.deps);
  } catch (err) {
    value = {
      ok: false,
      generatedAt: now,
      platform: process.platform,
      degraded: true,
      providers: [],
      notes: [`detection failed: ${errorMessage(err)}`],
    };
  }
  cache = { at: now, value };
  return value;
}

export function invalidateRuntimeAvailabilityCache(): void {
  cache = null;
}
