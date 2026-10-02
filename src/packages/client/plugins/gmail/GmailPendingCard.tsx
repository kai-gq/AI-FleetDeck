import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { apiUrl, authFetch } from '../../utils/storage';
import { getLocaleTag } from '../../utils/formatting';
import type { PluginOutputRendererProps } from '../types';

interface GmailPendingItem {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  date: number;
  labels: string[];
  isUnread: boolean;
  hasAttachments: boolean;
  attachmentNames: string[];
  gmailUrl: string;
}

interface GmailPendingListData {
  kind: 'gmail-pending-list';
  title: string;
  account?: string;
  count: number;
  limit: number;
  mode: 'unread' | 'all';
  query: string;
  items: GmailPendingItem[];
  actions: {
    markRead?: string;
    refresh?: string;
    showAll?: string;
    showUnread?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isGmailPendingListData(value: unknown): value is GmailPendingListData {
  return isRecord(value)
    && value.kind === 'gmail-pending-list'
    && typeof value.title === 'string'
    && typeof value.count === 'number'
    && typeof value.limit === 'number'
    && (value.mode === 'unread' || value.mode === 'all')
    && Array.isArray(value.items)
    && isRecord(value.actions);
}

function extractUpdatedData(body: unknown): GmailPendingListData | null {
  if (isGmailPendingListData(body)) return body;
  if (!isRecord(body)) return null;
  if (isGmailPendingListData(body.data)) return body.data;
  if (isRecord(body.output) && isGmailPendingListData(body.output.data)) return body.output.data;
  return null;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(getLocaleTag(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function senderName(from: string, unknownSender: string): string {
  const match = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return match?.[1]?.trim() || from || unknownSender;
}

function renderBodyWithLinks(body: string): React.ReactNode[] {
  const pattern = /(https?:\/\/[^\s<>"']+)/g;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (match.index > cursor) nodes.push(body.slice(cursor, match.index));
    const url = match[1];
    nodes.push(
      <a key={`${match.index}-${url}`} href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    );
    cursor = pattern.lastIndex;
  }
  if (cursor < body.length) nodes.push(body.slice(cursor));
  return nodes;
}

export const GmailPendingCard = memo(function GmailPendingCard({
  output,
  agentId,
}: PluginOutputRendererProps) {
  const { t } = useTranslation(['terminal', 'common']);
  const initial = isGmailPendingListData(output.data) ? output.data : null;
  const [data, setData] = useState<GmailPendingListData | null>(initial);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(initial?.items[0]?.id ? [initial.items[0].id] : []),
  );
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isGmailPendingListData(output.data)) setData(output.data);
  }, [output.data]);

  const invoke = useCallback(async (action: string, item?: GmailPendingItem) => {
    if (!data) return;
    const previous = data;
    setError(null);
    if (item) {
      setBusyIds((current) => new Set(current).add(item.id));
      setData((current) => {
        if (!current) return current;
        if (current.mode === 'unread') {
          return {
            ...current,
            count: Math.max(0, current.count - 1),
            items: current.items.filter((entry) => entry.id !== item.id),
          };
        }
        return {
          ...current,
          items: current.items.map((entry) => entry.id === item.id
            ? { ...entry, isUnread: false, labels: entry.labels.filter((label) => label !== 'UNREAD') }
            : entry),
        };
      });
    } else {
      setRefreshing(true);
    }

    try {
      const response = await authFetch(apiUrl(
        `/api/plugins/${encodeURIComponent(output.pluginId)}/actions/${encodeURIComponent(action)}`,
      ), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          instanceId: output.instanceId,
          rendererId: output.rendererId,
          item,
          itemId: item?.id,
          data,
        }),
      });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const message = isRecord(body) && typeof body.error === 'string'
          ? body.error
          : t('terminal:gmailCard.actionFailed', { defaultValue: 'Gmail action failed ({{status}})', status: response.status });
        throw new Error(message);
      }
      const updated = extractUpdatedData(body);
      if (!updated) throw new Error(t('terminal:gmailCard.invalidResponse', { defaultValue: 'Gmail plugin returned an invalid response' }));
      setData(updated);
    } catch (cause) {
      setData(previous);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (item) {
        setBusyIds((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
      } else {
        setRefreshing(false);
      }
    }
  }, [agentId, data, output.instanceId, output.pluginId, output.rendererId, t]);

  const visibleLabels = useMemo(() => {
    if (!data) return new Map<string, string[]>();
    return new Map(data.items.map((item) => [
      item.id,
      item.labels.filter((label) => label !== 'UNREAD' && label !== 'INBOX').slice(0, 3),
    ]));
  }, [data]);

  if (!data) {
    return <section className="gmail-pending-card gmail-pending-card--invalid">{t('terminal:gmailCard.invalid', { defaultValue: 'Invalid Gmail response' })}</section>;
  }

  const toggleExpanded = (messageId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  };

  return (
    <section className="gmail-pending-card" data-plugin-id={output.pluginId}>
      <header className="gmail-pending-card__header">
        <span className="gmail-pending-card__brand"><Icon name="envelope" size={13} weight="fill" /></span>
        <div className="gmail-pending-card__heading">
          <strong>{data.title}</strong>
          {data.account && <span>{data.account}</span>}
        </div>
        <div className="gmail-pending-card__filters" role="group" aria-label={t('terminal:gmailCard.filterAria', { defaultValue: 'Filter emails' })}>
          {data.actions.showUnread && (
            <button
              type="button"
              className={data.mode === 'unread' ? 'is-active' : undefined}
              disabled={refreshing || data.mode === 'unread'}
              onClick={() => void invoke(data.actions.showUnread!)}
            >
              {t('terminal:gmailCard.unread', { defaultValue: 'Unread' })}
            </button>
          )}
          {data.actions.showAll && (
            <button
              type="button"
              className={data.mode === 'all' ? 'is-active' : undefined}
              disabled={refreshing || data.mode === 'all'}
              onClick={() => void invoke(data.actions.showAll!)}
            >
              {t('common:labels.all')}
            </button>
          )}
        </div>
        <span className="gmail-pending-card__count">{data.count}</span>
        {data.actions.refresh && (
          <button
            type="button"
            className="gmail-pending-card__refresh"
            disabled={refreshing}
            onClick={() => void invoke(data.actions.refresh!)}
            title={t('terminal:gmailCard.refresh', { defaultValue: 'Refresh emails' })}
          >
            <Icon name="arrow-clockwise" size={12} className={refreshing ? 'is-spinning' : undefined} />
          </button>
        )}
      </header>

      {error && <div className="gmail-pending-card__error"><Icon name="warn" size={11} />{error}</div>}

      {data.items.length === 0 ? (
        <div className="gmail-pending-card__empty">
          <Icon name="check" size={16} />
          <strong>{data.mode === 'all'
            ? t('terminal:gmailCard.inboxEmpty', { defaultValue: 'Inbox empty' })
            : t('terminal:gmailCard.inboxUpToDate', { defaultValue: 'Inbox up to date' })}</strong>
          <span>{data.mode === 'all'
            ? t('terminal:gmailCard.noEmails', { defaultValue: 'No emails in Inbox.' })
            : t('terminal:gmailCard.nothingUnread', { defaultValue: 'No emails waiting to be read.' })}</span>
        </div>
      ) : (
        <div className="gmail-pending-card__messages">
          {data.items.map((item) => {
            const expanded = expandedIds.has(item.id);
            const labels = visibleLabels.get(item.id) ?? [];
            return (
              <article className={`gmail-pending-message${expanded ? ' is-expanded' : ''}${item.isUnread ? ' is-unread' : ' is-read'}`} key={item.id}>
                <button
                  type="button"
                  className="gmail-pending-message__summary"
                  onClick={() => toggleExpanded(item.id)}
                  aria-expanded={expanded}
                >
                  <span className="gmail-pending-message__unread" aria-label={item.isUnread
                    ? t('terminal:gmailCard.unread', { defaultValue: 'Unread' })
                    : t('common:status.read')} />
                  <span className="gmail-pending-message__sender" title={item.from}>{senderName(item.from, t('terminal:gmailCard.unknownSender', { defaultValue: '(unknown sender)' }))}</span>
                  <span className="gmail-pending-message__subject">{item.subject || t('terminal:gmailCard.noSubject', { defaultValue: '(no subject)' })}</span>
                  {item.hasAttachments && <Icon name="paperclip" size={10} />}
                  <time dateTime={new Date(item.date).toISOString()}>{formatDate(item.date)}</time>
                  <Icon name={expanded ? 'caret-down' : 'caret-right'} size={10} />
                </button>

                {expanded && (
                  <div className="gmail-pending-message__details">
                    <div className="gmail-pending-message__meta">
                      <span><strong>{t('terminal:gmailCard.from', { defaultValue: 'From:' })}</strong> {item.from}</span>
                      <span><strong>{t('terminal:gmailCard.to', { defaultValue: 'To:' })}</strong> {item.to.join(', ') || '—'}</span>
                      {item.cc && item.cc.length > 0 && <span><strong>CC:</strong> {item.cc.join(', ')}</span>}
                      {labels.length > 0 && (
                        <span className="gmail-pending-message__labels">
                          {labels.map((label) => <em key={label}>{label}</em>)}
                        </span>
                      )}
                    </div>

                    <div className="gmail-pending-message__body">
                      {item.body ? renderBodyWithLinks(item.body) : <em>{t('terminal:gmailCard.noTextBody', { defaultValue: '(email has no text content)' })}</em>}
                    </div>

                    {item.attachmentNames.length > 0 && (
                      <div className="gmail-pending-message__attachments">
                        {item.attachmentNames.map((name) => (
                          <span key={name}><Icon name="paperclip" size={10} />{name}</span>
                        ))}
                      </div>
                    )}

                    <footer className="gmail-pending-message__actions">
                      <a href={item.gmailUrl} target="_blank" rel="noopener noreferrer">
                        <Icon name="open-external" size={11} /> {t('terminal:gmailCard.viewInGmail', { defaultValue: 'View in Gmail' })}
                      </a>
                      {data.actions.markRead && item.isUnread && (
                        <button
                          type="button"
                          disabled={busyIds.has(item.id)}
                          onClick={() => void invoke(data.actions.markRead!, item)}
                        >
                          {busyIds.has(item.id)
                            ? <span className="gmail-pending-message__spinner" />
                            : <Icon name="check" size={11} />}
                          {t('terminal:gmailCard.markRead', { defaultValue: 'Mark as read' })}
                        </button>
                      )}
                    </footer>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {data.count >= data.limit && (
        <footer className="gmail-pending-card__limit">
          {t('terminal:gmailCard.showingUpTo', { defaultValue: 'Showing up to {{limit}}. Use', limit: data.limit })}{' '}
          <code>/gmail {data.mode === 'all' ? 'all ' : ''}{Math.min(50, data.limit + 10)}</code>{' '}
          {t('terminal:gmailCard.toSeeMore', { defaultValue: 'to see more.' })}
        </footer>
      )}
    </section>
  );
});
