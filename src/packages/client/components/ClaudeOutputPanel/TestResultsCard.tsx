/**
 * TestResultsCard — compact card rendered in the terminal when an agent's output
 * contains a Tide Commander test-run result (see testResultsParser). Shows status,
 * pass/fail/skip counts, the command, and the first few failing tests.
 */

import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../Icon';
import type { TestRunCardData } from './testResultsParser';

const STATUS_META: Record<TestRunCardData['status'], { icon: IconName; color: string; label: string }> = {
  passed: { icon: 'success', color: '#5cb88a', label: 'Passed' },
  failed: { icon: 'failure', color: '#d45a5a', label: 'Failed' },
  error: { icon: 'warning-circle', color: '#d4a05a', label: 'Error' },
};

function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export function TestResultsCard({ data }: { data: TestRunCardData }) {
  const { t } = useTranslation(['terminal']);
  const meta = STATUS_META[data.status];
  const totals = data.totals;
  const failedCount = totals.failures + totals.errors;
  const extraFailing = failedCount - data.failing.length;

  return (
    <div className={`test-results-card status-${data.status}`}>
      <div className="trc-header">
        <span className="trc-status" style={{ color: meta.color }}>
          <Icon name={meta.icon} size={13} /> {t(`terminal:testResults.status.${data.status}`, { defaultValue: meta.label })}
        </span>
        <span className="trc-counts">
          <span className="trc-count passed">{t('terminal:testResults.passed', { defaultValue: '{{n}} passed', n: totals.passed })}</span>
          {totals.failures > 0 && <span className="trc-count failed">{t('terminal:testResults.failed', { defaultValue: '{{n}} failed', n: totals.failures })}</span>}
          {totals.errors > 0 && <span className="trc-count error">{t('terminal:testResults.errors', { defaultValue: '{{n}} errors', n: totals.errors })}</span>}
          {totals.skipped > 0 && <span className="trc-count skipped">{t('terminal:testResults.skipped', { defaultValue: '{{n}} skipped', n: totals.skipped })}</span>}
          <span className="trc-count total">/ {totals.tests}</span>
        </span>
        {fmtTime(totals.time) && <span className="trc-time">{fmtTime(totals.time)}</span>}
      </div>

      {data.command && <div className="trc-command">{data.command}</div>}

      {data.failing.length > 0 && (
        <div className="trc-failing">
          {data.failing.map((f) => (
            <div key={f} className="trc-failing-row">
              <Icon name="failure" size={11} /> {f}
            </div>
          ))}
          {extraFailing > 0 && <div className="trc-failing-more">{t('terminal:testResults.more', { defaultValue: '+{{n}} more', n: extraFailing })}</div>}
        </div>
      )}
    </div>
  );
}
