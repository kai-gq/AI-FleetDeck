import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import type { PluginOutputRendererProps } from '../types';

interface SudoCommandRequestedData {
  kind: 'sudo-command-requested';
  invocation: string;
  status: 'awaiting-user-authorization';
}

function readData(value: unknown): SudoCommandRequestedData | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Partial<SudoCommandRequestedData>;
  return data.kind === 'sudo-command-requested'
    && typeof data.invocation === 'string'
    && data.status === 'awaiting-user-authorization'
    ? data as SudoCommandRequestedData
    : null;
}

export function ExecuteSudoCommandStatusCard({ output }: PluginOutputRendererProps) {
  const { t } = useTranslation('terminal');
  const data = readData(output.data);
  if (!data) return <div className="execute-sudo-command-status is-error">{t('terminal:sudoCard.invalid', { defaultValue: 'Invalid sudo request.' })}</div>;
  return (
    <section className="execute-sudo-command-status">
      <span className="execute-sudo-command-status__icon"><Icon name="lock" size={15} /></span>
      <div>
        <small>{t('terminal:sudoCard.header', { defaultValue: 'Execute Sudo Command' })}</small>
        <strong>{t('terminal:sudoCard.waiting', { defaultValue: 'Waiting for your authorization' })}</strong>
        <code>{data.invocation}</code>
        <span>{t('terminal:sudoCard.privateCardHint', { defaultValue: 'The private password card is open in the agent conversation.' })}</span>
      </div>
    </section>
  );
}
