/**
 * Explains which runtimes a picker hides (with a re-detect button) and warns
 * when detection itself was inconclusive. Renders nothing when every runtime
 * is available — and nothing at all while the probe is still unknown, keeping
 * every dialog fail-open.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { hiddenProviders, useRuntimes } from '../api/runtimes';
import { providerDisplayName } from '../../shared/agent-types';
import type { AgentProvider } from '../../shared/agent-types';

interface RuntimeAvailabilityNoticeProps {
  /** A runtime the dialog must not hide (the one currently in use), if any. */
  keep?: AgentProvider | null;
}

export function RuntimeAvailabilityNotice({ keep }: RuntimeAvailabilityNoticeProps) {
  const { t } = useTranslation(['terminal', 'common']);
  const runtimes = useRuntimes();
  const hidden = hiddenProviders(runtimes.value, keep);
  const degraded = runtimes.value.loaded && runtimes.value.degraded;

  if (hidden.length === 0 && !degraded) return null;

  return (
    <div
      className="model-change-notice"
      style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
    >
      <span>
        {degraded
          ? t('terminal:spawn.runtimeDetectionDegraded', {
              defaultValue: 'Runtime detection was inconclusive — showing all runtimes.',
            })
          : t('terminal:spawn.runtimesFiltered', {
              defaultValue: 'Not installed on this machine, hidden: {{list}}',
              list: hidden.map((provider) => providerDisplayName(provider)).join(', '),
            })}
      </span>
      <button
        type="button"
        className="spawn-select-btn"
        style={{ padding: '2px 10px' }}
        onClick={runtimes.refresh}
        title={t('terminal:spawn.runtimesRefreshTitle', {
          defaultValue: 'Re-check which agent CLIs are installed on this machine',
        })}
      >
        {t('terminal:spawn.runtimesRefresh', { defaultValue: 'Re-detect' })}
      </button>
    </div>
  );
}
