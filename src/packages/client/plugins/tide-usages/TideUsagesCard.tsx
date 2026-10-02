import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { ProviderIcon } from '../../components/ProviderIcon';
import { formatResetTime, getUsedPercentColor } from '../../utils/claude-usage-format';
import { getI18nInstance } from '../../utils/formatting';
import type {
  PluginOutputRendererProps,
  PluginProviderUsageAccount,
  PluginProviderUsagesData,
  PluginProviderUsageWindow,
} from '../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isProviderUsagesData(value: unknown): value is PluginProviderUsagesData {
  if (!isRecord(value) || value.kind !== 'provider-usages' || !Array.isArray(value.providers)) return false;
  return value.providers.every((provider) => (
    isRecord(provider)
    && typeof provider.id === 'string'
    && typeof provider.label === 'string'
    && Array.isArray(provider.accounts)
  ));
}

/** Compact relative reset indicator, e.g. "2d 6h" or "4h 18m". */
export function formatResetCountdown(isoTimestamp: string, now = Date.now()): string {
  const resetAt = Date.parse(isoTimestamp);
  if (!Number.isFinite(resetAt)) return '—';
  const remainingMinutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
  const days = Math.floor(remainingMinutes / (24 * 60));
  const hours = Math.floor((remainingMinutes % (24 * 60)) / 60);
  const minutes = remainingMinutes % 60;
  if (remainingMinutes === 0) {
    const i18n = getI18nInstance();
    const t = i18n?.t?.bind(i18n);
    return t ? t('terminal:usagesCard.now', { defaultValue: 'Now' }) : 'Now';
  }
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function UsageGauge({
  window,
  fallbackLabel,
}: {
  window: PluginProviderUsageWindow | null;
  fallbackLabel: string;
}) {
  const { t } = useTranslation(['terminal', 'common']);
  if (!window) {
    return (
      <div className="tide-usages-gauge is-unavailable">
        <div className="tide-usages-gauge__heading">
          <strong>{fallbackLabel}</strong>
          <span>{t('terminal:usagesCard.notPublished', { defaultValue: '— Not published' })}</span>
        </div>
        <div className="tide-usages-gauge__track" aria-hidden="true" />
      </div>
    );
  }

  const utilization = Math.max(0, Math.min(100, window.utilization));
  const remaining = Math.max(0, 100 - utilization);
  const color = getUsedPercentColor(utilization);
  return (
    <div className="tide-usages-gauge" title={t('terminal:usagesCard.percentAvailable', { defaultValue: '{{percent}}% available', percent: remaining.toFixed(1) })}>
      <div className="tide-usages-gauge__heading">
        <strong>{window.label}</strong>
        <span><b style={{ color }}>{Math.round(utilization)}%</b> {t('terminal:usagesCard.used', { defaultValue: 'used' })} · {Math.round(remaining)}% {t('terminal:usagesCard.free', { defaultValue: 'free' })}</span>
      </div>
      <div
        className="tide-usages-gauge__track"
        role="progressbar"
        aria-label={t('terminal:usagesCard.percentUsedAria', { defaultValue: '{{label}}: {{percent}}% used', label: window.label, percent: utilization })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={utilization}
      >
        <span style={{ width: `${utilization}%`, backgroundColor: color }} />
      </div>
      {window.resetsAt && (
        <div className="tide-usages-gauge__reset" title={t('terminal:usagesCard.resetsAt', { defaultValue: 'Resets {{time}}', time: formatResetTime(window.resetsAt) })}>
          <strong>{formatResetCountdown(window.resetsAt)}</strong>
          <span>{formatResetTime(window.resetsAt)}</span>
        </div>
      )}
    </div>
  );
}

function AccountIdentity({ account }: { account: PluginProviderUsageAccount }) {
  const { t } = useTranslation(['terminal', 'common']);
  return (
    <div className="tide-usages-account-identity">
      <div>
        <strong>{account.label}</strong>
        {account.active && <span className="is-active">{t('common:labels.active')}</span>}
        {account.status === 'free' && <span>{t('terminal:usagesCard.dynamic', { defaultValue: 'Dynamic' })}</span>}
      </div>
      {account.error && (
        <small className="is-error" title={account.error}>
          <Icon name="warning-circle" size={10} /> {account.error}
        </small>
      )}
      {!account.error && account.status === 'free' && account.note && <small>{account.note}</small>}
    </div>
  );
}

function ProviderAccountRow({
  provider,
  account,
}: {
  provider: PluginProviderUsagesData['providers'][number];
  account: PluginProviderUsageAccount;
}) {
  const { t } = useTranslation('terminal');
  return (
    <div className={`tide-usages-row is-${account.status ?? 'unavailable'}${account.expired ? ' is-expired' : ''}`} role="row">
      <div className="tide-usages-row__provider" role="cell">
        <ProviderIcon provider={provider.id} alt="" />
        <strong>{provider.label}</strong>
      </div>
      <div role="cell"><AccountIdentity account={account} /></div>
      <div className="tide-usages-row__limits" role="cell">
        <UsageGauge window={account.daily} fallbackLabel={t('terminal:usagesCard.daily', { defaultValue: 'Daily' })} />
        <UsageGauge window={account.weekly} fallbackLabel={t('terminal:usagesCard.weekly', { defaultValue: 'Weekly' })} />
      </div>
    </div>
  );
}

export function TideUsagesCard({ output }: PluginOutputRendererProps) {
  const { t } = useTranslation('terminal');
  const [showExpired, setShowExpired] = useState(false);
  if (!isProviderUsagesData(output.data)) {
    return (
      <section className="plugin-output-card tide-usages-card">
        <div className="tide-usages-card__invalid">{t('terminal:usagesCard.invalid', { defaultValue: 'Tide Commander received an invalid limits response.' })}</div>
      </section>
    );
  }

  const data = output.data;
  const fetched = new Date(data.fetchedAt);
  const rows = data.providers.flatMap((provider) => (
    provider.accounts.map((account) => ({ provider, account }))
  ));
  const currentRows = rows.filter(({ account }) => !account.expired);
  const expiredRows = rows.filter(({ account }) => account.expired);
  return (
    <section className="plugin-output-card tide-usages-card" data-plugin-id={output.pluginId}>
      <header className="plugin-output-card__header tide-usages-card__header">
        <Icon name="chart-line" size={13} />
        <div>
          <strong>{data.title}</strong>
          <span>{t('terminal:usagesCard.subtitle', { defaultValue: 'Consumed percentage and next reset' })}</span>
        </div>
        {!Number.isNaN(fetched.getTime()) && (
          <time dateTime={fetched.toISOString()}>
            {fetched.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </time>
        )}
      </header>
      <div className="tide-usages-table" role="table" aria-label={t('terminal:usagesCard.limitsAria', { defaultValue: 'LLM provider limits' })}>
        <div className="tide-usages-table__head" role="row">
          <span>{t('terminal:usagesCard.provider', { defaultValue: 'Provider' })}</span>
          <span>{t('terminal:usagesCard.account', { defaultValue: 'Account' })}</span>
          <span>{t('terminal:usagesCard.limits', { defaultValue: 'Limits' })}</span>
        </div>
        {currentRows.map(({ provider, account }) => (
          <ProviderAccountRow provider={provider} account={account} key={`${provider.id}:${account.id}`} />
        ))}
        {expiredRows.length > 0 && (
          <div className="tide-usages-expired-toggle">
            <button type="button" onClick={() => setShowExpired((visible) => !visible)}>
              <Icon name={showExpired ? 'caret-up' : 'caret-down'} size={11} />
              {showExpired
                ? t('terminal:usagesCard.hideExpired', { defaultValue: 'Hide expired' })
                : t('terminal:usagesCard.showExpired', { defaultValue: 'Show expired' })}
              <span>{expiredRows.length}</span>
            </button>
          </div>
        )}
        {showExpired && expiredRows.map(({ provider, account }) => (
          <ProviderAccountRow provider={provider} account={account} key={`expired:${provider.id}:${account.id}`} />
        ))}
      </div>
    </section>
  );
}
