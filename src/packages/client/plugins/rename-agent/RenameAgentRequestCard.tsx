import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import type { RenameAgentRequestInfo } from './renameAgentRequest';

export function RenameAgentRequestCard({ request }: { request: RenameAgentRequestInfo }) {
  const { t } = useTranslation(['terminal', 'common']);
  return (
    <section className="rename-agent-request-card">
      <div className="rename-agent-request-card__glow" aria-hidden="true" />
      <header>
        <span className="rename-agent-request-card__mark">
          <Icon name="signature" size={16} />
          <i aria-hidden="true" />
        </span>
        <div className="rename-agent-request-card__heading">
          <small>{t('terminal:renameAgent.request.subtitle', { defaultValue: 'Rename Agent · AI identity studio' })}</small>
          <strong>{t('terminal:renameAgent.request.creating', { defaultValue: 'Creating three contextual names' })}</strong>
        </div>
        <span className="rename-agent-request-card__live"><i /> {t('terminal:renameAgent.request.analyzing', { defaultValue: 'Analyzing' })}</span>
      </header>

      <div className="rename-agent-request-card__identity">
        <span><small>{t('common:labels.name')}</small><strong>{request.currentName || t('terminal:renameAgent.request.selectedAgent', { defaultValue: 'Selected agent' })}</strong></span>
        <em>{t('terminal:renameAgent.request.or', { defaultValue: 'or' })}</em>
        <span><small>{t('common:labels.class')}</small><strong>{request.agentClass || t('terminal:renameAgent.request.originalIdentity', { defaultValue: 'Original identity' })}</strong></span>
      </div>

      <div className="rename-agent-request-card__pipeline" aria-label={t('terminal:renameAgent.request.pipelineAria', { defaultValue: 'Generation process' })}>
        <span className="is-active"><Icon name="brain" size={11} /> {t('terminal:renameAgent.request.conversation', { defaultValue: 'Conversation' })}</span>
        <i />
        <span><Icon name="dna" size={11} /> {t('terminal:renameAgent.request.identity', { defaultValue: 'Identity' })}</span>
        <i />
        <span><Icon name="sparkle" size={11} /> {t('terminal:renameAgent.request.proposals', { defaultValue: '3 proposals' })}</span>
      </div>

      <footer>
        <Icon name="shield" size={11} />
        {t('terminal:renameAgent.request.footer', { defaultValue: 'The AI will keep the current name or the agent class.' })}
      </footer>
    </section>
  );
}
