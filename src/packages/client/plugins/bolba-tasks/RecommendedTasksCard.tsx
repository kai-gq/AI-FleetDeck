import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { apiUrl, authFetch } from '../../utils/storage';
import { getLocaleTag } from '../../utils/formatting';
import { openPluginModal } from '../registry';
import { bolbaT } from './bolbaI18n';
import type {
  PluginOutputRendererProps,
  PluginRecommendedTask,
  PluginRecommendedTasksData,
} from '../types';

export function isRecommendedTasksData(value: unknown): value is PluginRecommendedTasksData {
  return !!value
    && typeof value === 'object'
    && (value as { kind?: unknown }).kind === 'bolba-recommended-tasks'
    && ['generating', 'ready', 'error'].includes(String((value as { status?: unknown }).status))
    && typeof (value as { agentId?: unknown }).agentId === 'string'
    && typeof (value as { requestId?: unknown }).requestId === 'string'
    && Array.isArray((value as { items?: unknown }).items);
}

function extractRecommendedData(body: unknown): PluginRecommendedTasksData | null {
  if (isRecommendedTasksData(body)) return body;
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (isRecommendedTasksData(record.data)) return record.data;
  if (record.output && typeof record.output === 'object') {
    const output = record.output as Record<string, unknown>;
    if (isRecommendedTasksData(output.data)) return output.data;
  }
  return null;
}

function formatGeneratedAt(value: number | undefined): string {
  if (!value) return bolbaT('bolbaRecommended.pending', 'pending');
  return new Intl.DateTimeFormat(getLocaleTag(), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function localDay(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function dueLabel(value?: string): { label: string; tone: 'overdue' | 'today' | 'soon' | 'future' } | null {
  if (!value) return null;
  const due = value.slice(0, 10);
  const today = localDay();
  if (due < today) {
    const parsed = new Date(`${due}T12:00:00`);
    const current = new Date(`${today}T12:00:00`);
    const days = Math.max(1, Math.round((current.getTime() - parsed.getTime()) / 86_400_000));
    return { label: bolbaT('bolbaRecommended.overdue', '{{n}}d overdue', { n: days }), tone: 'overdue' };
  }
  if (due === today) return { label: bolbaT('bolbaRecommended.today', 'Today'), tone: 'today' };
  const parsed = new Date(`${due}T12:00:00`);
  const current = new Date(`${today}T12:00:00`);
  const days = Math.max(1, Math.round((parsed.getTime() - current.getTime()) / 86_400_000));
  return {
    label: days === 1
      ? bolbaT('bolbaRecommended.tomorrow', 'Tomorrow')
      : bolbaT('bolbaRecommended.inDays', 'In {{n}}d', { n: days }),
    tone: days <= 7 ? 'soon' : 'future',
  };
}

function displayTaskTitle(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .trim();
}

function urgencyLabel(item: PluginRecommendedTask): string {
  switch (item.urgency) {
    case 'critical': return bolbaT('bolbaRecommended.urgencyCritical', 'Critical');
    case 'high': return bolbaT('bolbaRecommended.urgencyHigh', 'High');
    case 'medium': return bolbaT('bolbaRecommended.urgencyMedium', 'Medium');
    default: return bolbaT('bolbaRecommended.urgencyLow', 'Suggested');
  }
}

export const RecommendedTasksCard = memo(function RecommendedTasksCard({
  output,
  agentId,
}: PluginOutputRendererProps) {
  const { t } = useTranslation('terminal');
  const initial = isRecommendedTasksData(output.data) ? output.data : null;
  const [data, setData] = useState<PluginRecommendedTasksData | null>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isRecommendedTasksData(output.data)) setData(output.data);
  }, [output.data]);

  useEffect(() => {
    const onUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ pluginId?: string; instanceId?: string; data?: unknown }>).detail;
      if (detail?.pluginId !== output.pluginId || detail.instanceId !== output.instanceId) return;
      if (isRecommendedTasksData(detail.data)) setData(detail.data);
    };
    window.addEventListener('tide:plugin-data-updated', onUpdate);
    return () => window.removeEventListener('tide:plugin-data-updated', onUpdate);
  }, [output.instanceId, output.pluginId]);

  const invoke = useCallback(async (action: string, item?: PluginRecommendedTask) => {
    if (!data) return;
    if (item) setBusyTaskId(String(item.task.id));
    else setRefreshing(true);
    setError(null);
    try {
      const response = await authFetch(apiUrl(
        `/api/plugins/${encodeURIComponent(output.pluginId)}/actions/${encodeURIComponent(action)}`,
      ), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: agentId || data.agentId,
          instanceId: output.instanceId,
          rendererId: output.rendererId,
          item: item?.task,
          itemId: item?.task.id,
          data,
        }),
      });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const message = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : t('terminal:bolbaRecommended.requestFailed', { defaultValue: 'Bolba request failed ({{status}})', status: response.status });
        throw new Error(message);
      }
      const next = extractRecommendedData(body);
      if (!next) throw new Error(t('terminal:bolbaRecommended.invalidRecommendations', { defaultValue: 'Bolba returned invalid recommendations' }));
      setData(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
      setBusyTaskId(null);
    }
  }, [agentId, data, output.instanceId, output.pluginId, output.rendererId, t]);

  const navigationTasks = useMemo(() => data?.items.map((item) => item.task) ?? [], [data]);

  if (!data) {
    return (
      <section className="bolba-recommended-card bolba-recommended-card--invalid">
        <Icon name="warn" size={13} /> {t('terminal:bolbaRecommended.unreadable', { defaultValue: 'Could not interpret the recommendations.' })}
      </section>
    );
  }

  return (
    <section className="bolba-recommended-card" data-plugin-id={output.pluginId} data-renderer-id={output.rendererId} data-status={data.status}>
      <header className="bolba-recommended-card__header">
        <span className="bolba-recommended-card__brand"><Icon name="plant" size={15} /></span>
        <div className="bolba-recommended-card__heading">
          <span className="bolba-recommended-card__eyebrow"><Icon name="sparkle" size={9} /> {t('terminal:bolbaRecommended.eyebrow', { defaultValue: 'Bolba recommends' })}</span>
          <strong>{data.title}</strong>
          <small>{data.subtitle}</small>
        </div>
        <div className="bolba-recommended-card__summary" title={t('terminal:bolbaRecommended.summaryTitle', { defaultValue: '{{n}} of {{total}} open tasks', n: data.count, total: data.totalCandidates })}>
          <strong>{data.status === 'generating' ? t('terminal:bolbaRecommended.aiBadge', { defaultValue: 'AI' }) : data.count}</strong>
          <span>{data.status === 'generating' ? t('terminal:bolbaRecommended.analyzingBadge', { defaultValue: 'analyzing' }) : t('terminal:bolbaRecommended.summaryOf', { defaultValue: 'of {{total}}', total: data.totalCandidates })}</span>
        </div>
        <button
          type="button"
          className="bolba-recommended-card__refresh"
          disabled={refreshing || data.status === 'generating'}
          onClick={() => void invoke(data.actions.refresh)}
          title={t('terminal:bolbaRecommended.recalculate', { defaultValue: 'Recalculate recommendations' })}
        >
          <Icon name="arrow-clockwise" size={12} className={refreshing ? 'is-spinning' : undefined} />
        </button>
      </header>

      {(error || data.error) && <div className="bolba-recommended-card__error"><Icon name="warn" size={11} />{error || data.error}</div>}

      {data.status === 'generating' ? (
        <div className="bolba-recommended-card__generating">
          <span className="spotlight-loading-spinner" />
          <div><strong>{t('terminal:bolbaRecommended.generatingTitle', { defaultValue: 'The AI is analyzing all the tasks…' })}</strong><span>{t('terminal:bolbaRecommended.generatingHint', { defaultValue: 'Comparing urgency, impact, safety, effort and dependencies.' })}</span></div>
        </div>
      ) : data.status === 'error' ? (
        <div className="bolba-recommended-card__generation-error">
          <Icon name="brain" size={17} />
          <strong>{t('terminal:bolbaRecommended.notReadyTitle', { defaultValue: 'The analysis is not ready yet' })}</strong>
          <span>{t('terminal:bolbaRecommended.notReadyHint', { defaultValue: 'You can recalculate it with the refresh button.' })}</span>
        </div>
      ) : <>
      {data.analysisSummary && (
        <div className="bolba-recommended-card__analysis"><Icon name="brain" size={11} /><span><small>{t('terminal:bolbaRecommended.criteria', { defaultValue: 'AI criteria' })}</small>{data.analysisSummary}</span></div>
      )}
      <div className="bolba-recommended-card__items">
        {data.items.length === 0 ? (
          <div className="bolba-recommended-card__empty">
            <Icon name="check" size={16} />
            <strong>{t('terminal:bolbaRecommended.allClear', { defaultValue: 'All under control' })}</strong>
            <span>{t('terminal:bolbaRecommended.noOpenTasks', { defaultValue: 'No open tasks to recommend.' })}</span>
          </div>
        ) : data.items.map((item) => {
          const due = dueLabel(item.task.due);
          const id = String(item.task.id);
          const busy = busyTaskId === id;
          const title = displayTaskTitle(item.task.title);
          return (
            <article className={`bolba-recommended-task is-${item.urgency}`} key={id}>
              <span className="bolba-recommended-task__rank">{item.rank}</span>
              <button
                type="button"
                className="bolba-recommended-task__content"
                onClick={() => openPluginModal(output.pluginId, data.actions.openDetails, {
                  task: item.task,
                  tasks: navigationTasks,
                  completion: {
                    agentId: agentId || data.agentId,
                    instanceId: output.instanceId,
                    rendererId: output.rendererId,
                    action: data.actions.complete,
                    data,
                  },
                })}
                title={t('terminal:bolbaRecommended.openDetails', { defaultValue: 'Open details for #{{id}}', id: item.task.id })}
              >
                <span className="bolba-recommended-task__meta">
                  <span className={`bolba-recommended-task__urgency is-${item.urgency}`}>
                    {urgencyLabel(item)}
                  </span>
                  <span className="bolba-recommended-task__id">#{item.task.id}</span>
                  {item.task.project && <span className="bolba-recommended-task__project">{item.task.project}</span>}
                  {due && <span className={`bolba-recommended-task__due is-${due.tone}`}>{due.label}</span>}
                </span>
                <strong className="bolba-recommended-task__title">{title}</strong>
                <span className="bolba-recommended-task__reason">
                  <Icon name="target" size={10} />{item.reason}
                </span>
              </button>
              <button
                type="button"
                className="bolba-recommended-task__complete"
                disabled={busy}
                onClick={() => void invoke(data.actions.complete, item)}
                aria-label={t('terminal:bolbaRecommended.completeAria', { defaultValue: 'Complete {{title}}', title })}
                title={t('terminal:bolbaRecommended.markCompleted', { defaultValue: 'Mark as completed' })}
              >
                {busy ? <span className="plugin-task-row__spinner" /> : <Icon name="check" size={12} />}
                <span>{t('terminal:bolbaRecommended.complete', { defaultValue: 'Complete' })}</span>
              </button>
            </article>
          );
        })}
      </div>
      </>}

      <footer className="bolba-recommended-card__footer">
        <span><Icon name="history" size={10} /> {data.status === 'ready'
          ? t('terminal:bolbaRecommended.analyzed', { defaultValue: 'Analyzed {{time}}', time: formatGeneratedAt(data.generatedAt) })
          : t('terminal:bolbaRecommended.inProgress', { defaultValue: 'AI analysis in progress' })}</span>
        <span>{t('terminal:bolbaRecommended.prioritizedByAi', { defaultValue: 'Prioritized by AI' })}</span>
      </footer>
    </section>
  );
});
