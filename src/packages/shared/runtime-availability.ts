// ============================================================================
// Runtime availability — shared contract
// ============================================================================
//
// Which provider CLIs are installed on the machine running the server, plus
// the model ids each one can be given. Produced by the server probe behind
// GET /api/runtimes; consumed by the boss instructions (team planning) and by
// the spawn / edit / boss-spawn dialogs (they only offer detected runtimes).
//
// Detection philosophy lives in the service: never throw, and on doubt report
// `available: true` — a broken probe must never hide a runtime the user has.

import type { AgentProvider } from './agent-types.js';

/** Picker order shared by every runtime selector and the API response. */
export const RUNTIME_PROVIDER_ORDER: readonly AgentProvider[] = ['claude', 'codex', 'opencode', 'grok', 'pi'];

/** How the executable path was resolved (diagnostics for the UI note). */
export type RuntimeSource =
  | 'env' // explicit env override (TC_CLAUDE_EXECUTABLE, CODEX_BINARY, …)
  | 'settings' // Settings-stored path (codex binary only, today)
  | 'detected' // one of the CLI's known install locations
  | 'path' // found by scanning PATH
  | 'unknown' // could not classify (relative path, failed probe) — never hidden
  | 'none'; // positively not found

export interface RuntimeProviderStatus {
  provider: AgentProvider;
  /** False only when detection positively concluded "not installed". */
  available: boolean;
  /** Resolved executable (may be a bare command name when unresolved). */
  executable: string | null;
  source: RuntimeSource;
  /** Human-readable detail for degraded / missing-config / rejected-binary cases. */
  note?: string;
  /**
   * Selectable model ids, in picker order. Static catalog (deprecated models
   * removed) for claude/codex/grok; empty for pi/opencode, whose live catalog
   * is fetched from `modelsEndpoint` (it requires spawning the CLI).
   */
  models: string[];
  /** Model preselected for new agents ('' = the CLI's own configured default). */
  defaultModel: string;
  /** Dynamic providers: server endpoint returning the live model catalog. */
  modelsEndpoint?: string;
}

export interface RuntimeAvailability {
  ok: boolean;
  generatedAt: number;
  platform: string;
  /**
   * True when any probe failed, PATH is missing, or nothing was detected —
   * consumers must fall back to showing everything rather than hiding.
   */
  degraded: boolean;
  providers: RuntimeProviderStatus[];
  /** Global diagnostics ("PATH is empty", per-provider probe failures, …). */
  notes: string[];
}
