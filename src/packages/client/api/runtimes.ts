/**
 * Runtime availability — which provider CLIs are installed on the server
 * machine, shared by the spawn / edit / boss-spawn dialogs.
 *
 * Mirrors the default-agent-skills module: a small cache plus a subscription
 * so every dialog reads the same value, refreshed on mount. Until the first
 * fetch resolves — and if it ever fails — the state stays "unknown", and
 * consumers treat unknown as "show everything" (fail open): a broken probe
 * must never hide a runtime the user actually has.
 */

import { useEffect, useState } from 'react';
import { getAuthToken, getApiBaseUrl } from '../utils/storage';
import type { AgentProvider } from '../../shared/agent-types';
import {
  RUNTIME_PROVIDER_ORDER,
  type RuntimeProviderStatus,
} from '../../shared/runtime-availability';

export interface RuntimeAvailabilityState {
  /** False while this is still the local "unknown" fallback, not a server answer. */
  loaded: boolean;
  /** True when the server flagged the probe as unreliable — show everything. */
  degraded: boolean;
  providers: RuntimeProviderStatus[];
}

const UNKNOWN: RuntimeAvailabilityState = { loaded: false, degraded: false, providers: [] };

let cache: RuntimeAvailabilityState = UNKNOWN;
let inFlight: Promise<RuntimeAvailabilityState> | null = null;

const listeners = new Set<(value: RuntimeAvailabilityState) => void>();

function publish(value: RuntimeAvailabilityState): RuntimeAvailabilityState {
  cache = value;
  for (const listener of listeners) listener(value);
  return value;
}

function normalize(data: any): RuntimeAvailabilityState {
  return {
    loaded: true,
    degraded: Boolean(data?.degraded) || data?.ok === false,
    providers: Array.isArray(data?.providers)
      ? data.providers.filter((p: any) => p && typeof p.provider === 'string')
      : [],
  };
}

function endpoint(refresh: boolean): string {
  return `${getApiBaseUrl()}/api/runtimes${refresh ? '?refresh=1' : ''}`;
}

/** The last known availability. Synchronous, so dialogs can render on open. */
export function getCachedRuntimes(): RuntimeAvailabilityState {
  return cache;
}

/**
 * Fetch from the server, de-duping concurrent callers. On failure the cache
 * is left untouched (unknown/old value keeps every dialog fail-open).
 */
export function fetchRuntimes(refresh = false): Promise<RuntimeAvailabilityState> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetch(endpoint(refresh), {
        headers: { 'Authorization': `Bearer ${getAuthToken()}` },
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch runtime availability: ${response.statusText}`);
      }
      return publish(normalize(await response.json()));
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export interface UseRuntimes {
  value: RuntimeAvailabilityState;
  /** Re-probe the server (bypasses its 60s cache) — the "re-detect" affordance. */
  refresh: () => void;
}

/**
 * Live availability, fetched on mount so a CLI installed since the page load
 * shows up the next time a dialog opens.
 */
export function useRuntimes(): UseRuntimes {
  const [value, setValue] = useState<RuntimeAvailabilityState>(cache);

  useEffect(() => {
    listeners.add(setValue);
    // Keep the cached value on failure — unknown means "show everything".
    fetchRuntimes().catch(() => {});
    return () => {
      listeners.delete(setValue);
    };
  }, []);

  return {
    value,
    refresh: () => {
      fetchRuntimes(true).catch(() => {});
    },
  };
}

/**
 * Providers to offer in a picker. `keep` is a runtime the dialog must not
 * hide even when it was not detected (the one an existing agent runs on).
 */
export function visibleProviders(
  state: RuntimeAvailabilityState,
  keep?: AgentProvider | null
): AgentProvider[] {
  const all = [...RUNTIME_PROVIDER_ORDER];
  if (!state.loaded || state.degraded) return all;
  const available = all.filter(
    (provider) => state.providers.find((p) => p.provider === provider)?.available === true
  );
  // Nothing detected is almost certainly a broken environment, not a machine
  // without CLIs — show everything rather than an empty picker.
  if (available.length === 0) return all;
  if (keep && !available.includes(keep)) available.push(keep);
  return all.filter((provider) => available.includes(provider));
}

/** Providers the picker hides, for the explanatory note. */
export function hiddenProviders(
  state: RuntimeAvailabilityState,
  keep?: AgentProvider | null
): AgentProvider[] {
  const visible = visibleProviders(state, keep);
  return RUNTIME_PROVIDER_ORDER.filter((provider) => !visible.includes(provider));
}

/** True when the picker is actually filtered (worth explaining in the UI). */
export function isFiltering(
  state: RuntimeAvailabilityState,
  keep?: AgentProvider | null
): boolean {
  return hiddenProviders(state, keep).length > 0;
}
