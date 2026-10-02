import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLastSelectedAgentId } from '../../store';
import { Icon } from '../../components/Icon';
import { apiUrl, authFetch } from '../../utils/storage';
import { getLocaleTag } from '../../utils/formatting';
import { PluginTaskListCard, isTaskListData } from '../PluginTaskListCard';
import type { PluginOutputEnvelope, PluginTaskItem } from '../types';
import { bolbaT } from './bolbaI18n';
import { adjacentBolbaTask, resolveBolbaTaskDetailsModalData } from './bolbaTaskNavigation';

function extractEnvelope(body: unknown): PluginOutputEnvelope | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const candidate = record.output && typeof record.output === 'object' ? record.output : record;
  if (!candidate || typeof candidate !== 'object') return null;
  const output = candidate as Partial<PluginOutputEnvelope>;
  if (typeof output.pluginId !== 'string' || typeof output.rendererId !== 'string' || !isTaskListData(output.data)) return null;
  return {
    pluginId: output.pluginId,
    rendererId: output.rendererId,
    instanceId: output.instanceId || `bolba-sidebar-${Date.now()}`,
    data: output.data,
    title: output.title,
    command: output.command,
    createdAt: output.createdAt,
  };
}

export function BolbaTasksSidebarView() {
  const { t } = useTranslation(['terminal', 'common']);
  const agentId = useLastSelectedAgentId();
  const [output, setOutput] = useState<PluginOutputEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch(apiUrl('/api/plugins/bolba-tasks/commands/show-pending-tasks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Sidebar refresh is local UI work; omit agentId so the REST command
        // does not also inject a duplicate card into the selected Guake feed.
        body: JSON.stringify({ surface: 'sidebar' }),
      });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const message = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : t('terminal:bolbaView.requestFailed', { defaultValue: 'Bolba request failed ({{status}})', status: response.status });
        throw new Error(message);
      }
      const envelope = extractEnvelope(body);
      if (!envelope) throw new Error(t('terminal:bolbaView.invalidTaskList', { defaultValue: 'Bolba plugin returned an invalid task-list response' }));
      setOutput(envelope);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [agentId, t]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const onUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ pluginId?: string; data?: unknown }>).detail;
      const nextData = detail?.data;
      if (detail?.pluginId !== 'bolba-tasks' || !isTaskListData(nextData)) return;
      setOutput((current) => current ? { ...current, data: nextData } : current);
    };
    window.addEventListener('tide:plugin-data-updated', onUpdate);
    return () => window.removeEventListener('tide:plugin-data-updated', onUpdate);
  }, []);

  return (
    <div className="bolba-plugin-view">
      <div className="bolba-plugin-view__toolbar">
        <div><Icon name="plant" size={14} /><strong>Bolba Tasks</strong></div>
        <button type="button" onClick={() => void refresh()} disabled={loading} title={t('common:buttons.refresh')}>
          <Icon name="arrow-clockwise" size={13} className={loading ? 'is-spinning' : undefined} />
        </button>
      </div>
      {error && (
        <div className="bolba-plugin-view__error">
          <Icon name="warn" size={12} />
          <span>{error}</span>
          <button type="button" onClick={() => void refresh()}>{t('common:buttons.retry')}</button>
        </div>
      )}
      {loading && !output && <div className="bolba-plugin-view__loading">{t('terminal:bolbaView.loading', { defaultValue: 'Loading tasks…' })}</div>}
      {output && (
        <PluginTaskListCard
          output={output}
          agentId={agentId || undefined}
          surface="sidebar"
          onDataChange={(data) => setOutput((current) => current ? { ...current, data } : current)}
        />
      )}
    </div>
  );
}

interface BolbaTaskDetailsData {
  kind: 'bolba-task-details';
  task: PluginTaskItem;
  events: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractDetails(body: unknown): BolbaTaskDetailsData | null {
  if (!isRecord(body)) return null;
  const output = isRecord(body.output) ? body.output : body;
  const payload = isRecord(output.data) ? output.data : output;
  if (payload.kind !== 'bolba-task-details' || !isRecord(payload.task) || !Array.isArray(payload.events)) return null;
  const task = payload.task as unknown as PluginTaskItem;
  if ((typeof task.id !== 'string' && typeof task.id !== 'number') || typeof task.title !== 'string') return null;
  return {
    kind: 'bolba-task-details',
    task,
    events: payload.events.filter((event): event is string => typeof event === 'string'),
  };
}

function textField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function formatBolbaDate(value?: string): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value);
  if (!match) return value;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] || 0), Number(match[5] || 0));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(getLocaleTag(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(match[4] ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(date);
}

function cleanPerson(value?: string): string | undefined {
  if (!value) return undefined;
  const unwrapped = value.replace(/^\[\[/, '').replace(/\]\]$/, '');
  const label = unwrapped.includes('|') ? unwrapped.split('|').pop()! : unwrapped.split('/').pop()!;
  return label.replace(/-/g, ' ').trim() || undefined;
}

function taskAge(value?: string): { label: string; tone: 'fresh' | 'aging' | 'old' | 'stale' } | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const created = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = new Date();
  created.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  const days = Math.max(0, Math.floor((today.getTime() - created.getTime()) / 86_400_000));
  return {
    label: days === 0
      ? bolbaT('bolbaView.ageToday', 'Today')
      : days === 1
        ? bolbaT('bolbaView.ageOneDay', '1 day ago')
        : bolbaT('bolbaView.ageDays', '{{n}} days ago', { n: days }),
    tone: days <= 3 ? 'fresh' : days <= 14 ? 'aging' : days <= 30 ? 'old' : 'stale',
  };
}

function eventParts(event: string): { timestamp?: string; body: string; tone: string } {
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+(.*)$/s.exec(event.trim());
  const body = match?.[2] || event.trim();
  const eventLabel = body.toLowerCase().slice(0, 220);
  const tone = /reabiert|reopen|↩/.test(eventLabel)
    ? 'reopened'
    : /descartad|eliminad|🗑/.test(eventLabel)
      ? 'discarded'
      : /\b(?:cerrada|completada|terminada)\b|✅/.test(eventLabel)
        ? 'completed'
        : 'update';
  return { timestamp: formatBolbaDate(match?.[1]), body, tone };
}

function renderEventText(text: string): React.ReactNode {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|https?:\/\/[^\s]+)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (/^https?:\/\//.test(part)) return <a key={index} href={part} target="_blank" rel="noreferrer">{bolbaT('bolbaView.openLink', 'Open link')}</a>;
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

export function BolbaTaskDetailsModal({ data }: { pluginId: string; data?: unknown; onClose: () => void }) {
  const { t } = useTranslation(['terminal', 'common']);
  const modalData = resolveBolbaTaskDetailsModalData(data);
  const [selectedTask, setSelectedTask] = useState<PluginTaskItem | null>(modalData?.task ?? null);
  const [details, setDetails] = useState<BolbaTaskDetailsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [completedTaskIds, setCompletedTaskIds] = useState<Set<string>>(new Set());
  const [completionError, setCompletionError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const navigationTasks = modalData?.tasks ?? (selectedTask ? [selectedTask] : []);
  const completion = modalData?.completion;

  const loadDetails = useCallback(async (signal?: AbortSignal) => {
    if (!selectedTask) return;
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch(apiUrl('/api/plugins/bolba-tasks/actions/details'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: selectedTask.id }),
        signal,
      });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const message = isRecord(body) && typeof body.error === 'string'
          ? body.error
          : t('terminal:bolbaView.loadFailed', { defaultValue: 'Failed to load the task ({{status}})', status: response.status });
        throw new Error(message);
      }
      const next = extractDetails(body);
      if (!next) throw new Error(t('terminal:bolbaView.invalidDetails', { defaultValue: 'Bolba returned an invalid task detail' }));
      if (!signal?.aborted) setDetails(next);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [selectedTask?.id, t]);

  useEffect(() => {
    const controller = new AbortController();
    setDetails(null);
    void loadDetails(controller.signal);
    const scrollContainer = rootRef.current?.closest('.plugin-modal__body');
    if (scrollContainer instanceof HTMLElement) scrollContainer.scrollTo({ top: 0 });
    return () => controller.abort();
  }, [loadDetails]);

  const task = details?.task || selectedTask;
  if (!task) return <div className="bolba-task-details bolba-task-details--empty">{t('terminal:bolbaView.noTask', { defaultValue: 'No task selected.' })}</div>;
  const metadata = task.metadata || {};
  const registeredAt = task.registeredAt || textField(metadata, 'reg') || textField(metadata, 'created_at');
  const age = taskAge(registeredAt);
  const fields = [
    ...(age ? [{ label: t('terminal:bolbaView.age', { defaultValue: 'Age' }), value: age.label, tone: age.tone }] : []),
    { label: t('terminal:bolbaView.project', { defaultValue: 'Project' }), value: task.project },
    { label: t('terminal:bolbaView.type', { defaultValue: 'Type' }), value: textField(metadata, 'type') },
    { label: t('terminal:bolbaView.status', { defaultValue: 'Status' }), value: task.status },
    { label: t('terminal:bolbaView.registered', { defaultValue: 'Registered' }), value: formatBolbaDate(registeredAt) },
    { label: t('terminal:bolbaView.due', { defaultValue: 'Due date' }), value: formatBolbaDate(task.due) },
    { label: t('terminal:bolbaView.completed', { defaultValue: 'Completed' }), value: formatBolbaDate(textField(metadata, 'done')) },
    { label: t('terminal:bolbaView.origin', { defaultValue: 'Origin' }), value: textField(metadata, 'origen') },
    { label: t('terminal:bolbaView.requestedBy', { defaultValue: 'Requested by' }), value: cleanPerson(textField(metadata, 'from_person')) },
    { label: t('terminal:bolbaView.section', { defaultValue: 'Section' }), value: textField(metadata, 'section') },
  ].filter((field): field is { label: string; value: string; tone?: 'fresh' | 'aging' | 'old' | 'stale' } => !!field.value);
  const gmail = textField(metadata, 'gmail');
  const coti = textField(metadata, 'coti');
  const events = details?.events || [];
  const navigationIndex = navigationTasks.findIndex((candidate) => String(candidate.id) === String(task.id));
  const previousTask = adjacentBolbaTask(navigationTasks, task.id, -1);
  const nextTask = adjacentBolbaTask(navigationTasks, task.id, 1);
  const navigate = (next: PluginTaskItem | null) => {
    if (!next) return;
    setSelectedTask(next);
    setDetails(null);
    setCompletionError(null);
  };

  const completeSelectedTask = async () => {
    if (!completion || !task || completing || completedTaskIds.has(String(task.id))) return;
    setCompleting(true);
    setCompletionError(null);
    try {
      const response = await authFetch(apiUrl(
        `/api/plugins/bolba-tasks/actions/${encodeURIComponent(completion.action)}`,
      ), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: completion.agentId,
          instanceId: completion.instanceId,
          rendererId: completion.rendererId,
          item: task,
          itemId: task.id,
          data: completion.data,
        }),
      });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const message = isRecord(body) && typeof body.error === 'string'
          ? body.error
          : t('terminal:bolbaView.completeFailed', { defaultValue: 'Failed to complete the task ({{status}})', status: response.status });
        throw new Error(message);
      }
      setCompletedTaskIds((current) => new Set(current).add(String(task.id)));
      setSelectedTask((current) => current ? { ...current, status: 'done' } : current);
      setDetails((current) => current ? { ...current, task: { ...current.task, status: 'done' } } : current);
    } catch (cause) {
      setCompletionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCompleting(false);
    }
  };

  return (
    <div className="bolba-task-details" ref={rootRef}>
      <header className="bolba-task-details__hero">
        <div className="bolba-task-details__hero-top">
          <div className="bolba-task-details__eyebrow">
            <span>#{task.id}</span>
            {task.project && <span>{task.project}</span>}
            {task.status && <span className={`is-${task.status}`}>{task.status}</span>}
          </div>
          {navigationTasks.length > 1 && (
            <nav className="bolba-task-details__navigation" aria-label={t('terminal:bolbaView.navAria', { defaultValue: 'Navigate between tasks' })}>
              <button type="button" disabled={!previousTask || loading} onClick={() => navigate(previousTask)} title={t('terminal:bolbaView.previousTask', { defaultValue: 'Previous task' })}>
                <Icon name="arrow-left" size={11} /> {t('terminal:bolbaView.previous', { defaultValue: 'Previous' })}
              </button>
              <span>{navigationIndex + 1} / {navigationTasks.length}</span>
              <button type="button" disabled={!nextTask || loading} onClick={() => navigate(nextTask)} title={t('terminal:bolbaView.nextTask', { defaultValue: 'Next task' })}>
                {t('terminal:bolbaView.next', { defaultValue: 'Next' })} <Icon name="arrow-right" size={11} />
              </button>
            </nav>
          )}
        </div>
        <h2>{renderEventText(task.title)}</h2>
        {task.description && <p>{renderEventText(task.description)}</p>}
        {completion && (
          <div className="bolba-task-details__actions">
            <button
              type="button"
              className={completedTaskIds.has(String(task.id)) ? 'is-completed' : undefined}
              disabled={completing || completedTaskIds.has(String(task.id))}
              onClick={() => void completeSelectedTask()}
            >
              {completing
                ? <span className="plugin-task-row__spinner" />
                : <Icon name="check" size={12} />}
              {completedTaskIds.has(String(task.id))
                ? t('terminal:bolbaView.taskCompleted', { defaultValue: 'Task completed' })
                : t('terminal:bolbaView.markCompleted', { defaultValue: 'Mark as completed' })}
            </button>
            <span>{t('terminal:bolbaView.completeHint', { defaultValue: 'Completing it will make the AI recalculate the recommendations.' })}</span>
          </div>
        )}
        {completionError && <div className="bolba-task-details__completion-error"><Icon name="warn" size={11} />{completionError}</div>}
      </header>

      {loading && (
        <div className="bolba-task-details__loading">
          <span className="spotlight-loading-spinner" /> {t('terminal:bolbaView.loadingDetails', { defaultValue: 'Loading details and full history…' })}
        </div>
      )}
      {error && (
        <div className="bolba-task-details__error">
          <Icon name="warn" size={13} />
          <span>{error}</span>
          <button type="button" onClick={() => void loadDetails()}>{t('common:buttons.retry')}</button>
        </div>
      )}

      <section className="bolba-task-details__section">
        <div className="bolba-task-details__section-title"><Icon name="info" size={14} /><h3>{t('terminal:bolbaView.info', { defaultValue: 'Information' })}</h3></div>
        <div className="bolba-task-details__facts">
          {fields.map((field) => (
            <div className={field.tone ? `is-age-${field.tone}` : undefined} key={field.label}>
              <span>{field.label}</span><strong>{field.value}</strong>
            </div>
          ))}
        </div>
        {(coti || gmail) && (
          <div className="bolba-task-details__links">
            {coti && <span><Icon name="link" size={12} /> {t('terminal:bolbaView.quote', { defaultValue: 'Quote' })} <strong>{coti}</strong></span>}
            {gmail && <a href={gmail} target="_blank" rel="noreferrer"><Icon name="envelope" size={12} /> {t('terminal:bolbaView.openEmail', { defaultValue: 'Open related email' })}</a>}
          </div>
        )}
      </section>

      <section className="bolba-task-details__section bolba-task-details__timeline">
        <div className="bolba-task-details__section-title">
          <Icon name="history" size={14} />
          <h3>{t('terminal:bolbaView.fullHistory', { defaultValue: 'Full history' })}</h3>
          <span>{events.length === 1
            ? t('terminal:bolbaView.eventOne', { defaultValue: '1 event' })
            : t('terminal:bolbaView.eventMany', { defaultValue: '{{n}} events', n: events.length })}</span>
        </div>
        {!loading && events.length === 0 ? (
          <div className="bolba-task-details__no-events">{t('terminal:bolbaView.noEvents', { defaultValue: 'This task has no events yet.' })}</div>
        ) : (
          <ol>
            {events.map((event, index) => {
              const parsed = eventParts(event);
              return (
                <li className={`is-${parsed.tone}`} key={`${index}:${event}`}>
                  <span className="bolba-task-details__event-dot">
                    <Icon name={parsed.tone === 'reopened' ? 'revert' : parsed.tone === 'discarded' ? 'delete' : parsed.tone === 'completed' ? 'check' : 'history'} size={12} />
                  </span>
                  <div>
                    {parsed.timestamp && <time>{parsed.timestamp}</time>}
                    <p>{renderEventText(parsed.body)}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
