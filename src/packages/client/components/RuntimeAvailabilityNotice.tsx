/**
 * Explains which runtimes a picker hides (with a re-detect button) and warns
 * when detection itself was inconclusive. Renders nothing when every runtime
 * is available — and nothing at all while the probe is still unknown, keeping
 * every dialog fail-open.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hiddenProviders, useRuntimes } from '../api/runtimes';
import { providerDisplayName } from '../../shared/agent-types';
import type { AgentProvider } from '../../shared/agent-types';

interface RuntimeAvailabilityNoticeProps {
  /** A runtime the dialog must not hide (the one currently in use), if any. */
  keep?: AgentProvider | null;
}

const FEEDBACK_MS = 3000;

export function RuntimeAvailabilityNotice({ keep }: RuntimeAvailabilityNoticeProps) {
  const { t } = useTranslation(['terminal', 'common']);
  const runtimes = useRuntimes();
  const hidden = hiddenProviders(runtimes.value, keep);
  const degraded = runtimes.value.loaded && runtimes.value.degraded;

  // Re-detect feedback: "checking…" while the probe runs, then a short-lived
  // "re-detected" / "re-detect failed" so the click visibly does something
  // even when the result is unchanged.
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<'ok' | 'fail' | null>(null);
  const feedbackTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
  }, []);

  const handleRefresh = async () => {
    if (busy) return;
    if (feedbackTimer.current !== null) {
      window.clearTimeout(feedbackTimer.current);
      feedbackTimer.current = null;
    }
    setBusy(true);
    setFeedback(null);
    let ok = true;
    try {
      await runtimes.refresh();
    } catch {
      ok = false;
    }
    setBusy(false);
    setFeedback(ok ? 'ok' : 'fail');
    feedbackTimer.current = window.setTimeout(() => {
      feedbackTimer.current = null;
      setFeedback(null);
    }, FEEDBACK_MS);
  };

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
        onClick={handleRefresh}
        disabled={busy}
        title={t('terminal:spawn.runtimesRefreshTitle', {
          defaultValue: 'Re-check which agent CLIs are installed on this machine',
        })}
      >
        {busy
          ? t('terminal:spawn.runtimesRefreshing', { defaultValue: 'Checking…' })
          : t('terminal:spawn.runtimesRefresh', { defaultValue: 'Re-detect' })}
      </button>
      {feedback === 'ok' && (
        <span style={{ opacity: 0.75 }}>
          {t('terminal:spawn.runtimesRefreshed', { defaultValue: 'Re-detected' })}
        </span>
      )}
      {feedback === 'fail' && (
        <span style={{ opacity: 0.75 }}>
          {t('terminal:spawn.runtimesRefreshFailed', { defaultValue: 'Re-detect failed' })}
        </span>
      )}
    </div>
  );
}
