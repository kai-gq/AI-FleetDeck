/**
 * TriggerManagerPanel
 * UI for managing triggers: list, create/edit, match mode selector,
 * test match button, and fire history log.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgents } from '../store';
import { apiUrl, authFetch } from '../utils/storage';
import type {
  Trigger, TriggerType, MatchMode, ExtractionMode,
  LLMMatchResult, TestMatchResult, TriggerFireRow,
} from '../../shared/trigger-types';

interface TriggerManagerPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

type PanelView = 'list' | 'edit';

const TRIGGER_TYPES: { value: TriggerType; label: string }[] = [
  { value: 'webhook', label: 'Webhook' },
  { value: 'bitbucket', label: 'Bitbucket' },
  { value: 'cron', label: 'Cron' },
  { value: 'slack', label: 'Slack' },
  { value: 'email', label: 'Email' },
  { value: 'jira', label: 'Jira' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'wechat', label: 'WeChat' },
];

type TypeFilter = 'all' | TriggerType;

// `key` values are looked up with the English `label` as defaultValue, so
// the en output stays byte-identical while zh-CN gets a translation.
const TYPE_TAB_DEFS: { value: TypeFilter; label: string; icon: string; key: string }[] = [
  { value: 'all',       label: 'All',       icon: '◎', key: 'config:triggerPanel.type.all' },
  { value: 'webhook',   label: 'Webhook',   icon: '🪝', key: 'config:triggerPanel.type.webhook' },
  { value: 'bitbucket', label: 'Bitbucket', icon: '🪣', key: 'config:triggerPanel.type.bitbucket' },
  { value: 'cron',      label: 'Cron',      icon: '⏰', key: 'config:triggerPanel.type.cron' },
  { value: 'slack',     label: 'Slack',     icon: '💬', key: 'config:triggerPanel.type.slack' },
  { value: 'email',     label: 'Email',     icon: '✉️', key: 'config:triggerPanel.type.email' },
  { value: 'jira',      label: 'Jira',      icon: '🎫', key: 'config:triggerPanel.type.jira' },
  { value: 'whatsapp',  label: 'WhatsApp',  icon: '📱', key: 'config:triggerPanel.type.whatsapp' },
  { value: 'wechat',    label: 'WeChat',    icon: '💚', key: 'config:triggerPanel.type.wechat' },
];

const BITBUCKET_EVENT_OPTIONS: { value: string; label: string; key: string }[] = [
  { value: 'pullrequest:created', label: 'PR created', key: 'config:triggerPanel.bitbucketEvent.created' },
  { value: 'pullrequest:updated', label: 'PR updated', key: 'config:triggerPanel.bitbucketEvent.updated' },
  { value: 'pullrequest:approved', label: 'PR approved', key: 'config:triggerPanel.bitbucketEvent.approved' },
  { value: 'pullrequest:unapproved', label: 'PR unapproved', key: 'config:triggerPanel.bitbucketEvent.unapproved' },
  { value: 'pullrequest:fulfilled', label: 'PR merged', key: 'config:triggerPanel.bitbucketEvent.merged' },
  { value: 'pullrequest:rejected', label: 'PR declined', key: 'config:triggerPanel.bitbucketEvent.declined' },
  { value: 'pullrequest:comment_created', label: 'PR comment created', key: 'config:triggerPanel.bitbucketEvent.commentCreated' },
];

const MATCH_MODES: { value: MatchMode; label: string; labelKey: string; desc: string; descKey: string }[] = [
  { value: 'structural', label: 'Structural', labelKey: 'config:triggerPanel.matchMode.structural.label', desc: 'Field-based matching (fast, free)', descKey: 'config:triggerPanel.matchMode.structural.desc' },
  { value: 'llm', label: 'LLM', labelKey: 'config:triggerPanel.matchMode.llm.label', desc: 'Semantic matching via LLM (flexible, costs tokens)', descKey: 'config:triggerPanel.matchMode.llm.desc' },
  { value: 'hybrid', label: 'Hybrid', labelKey: 'config:triggerPanel.matchMode.hybrid.label', desc: 'Structural pre-filter + LLM (recommended)', descKey: 'config:triggerPanel.matchMode.hybrid.desc' },
];

const EXTRACTION_MODES: { value: ExtractionMode; label: string; key: string }[] = [
  { value: 'structural', label: 'Structural', key: 'config:triggerPanel.extractionMode.structural' },
  { value: 'llm', label: 'LLM', key: 'config:triggerPanel.extractionMode.llm' },
];

// Convert an ISO datetime string (UTC) to the value format expected by
// <input type="datetime-local"> (YYYY-MM-DDTHH:mm in local time). Returns
// empty string for invalid / missing input.
function toDatetimeLocal(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const emptyTrigger = (): Partial<Trigger> => ({
  name: '',
  description: '',
  type: 'webhook',
  agentId: '',
  promptTemplate: '',
  enabled: true,
  matchMode: 'structural',
  extractionMode: 'structural',
  config: { method: 'POST' } as any,
});

export function TriggerManagerPanel({ isOpen, onClose }: TriggerManagerPanelProps) {
  const { t } = useTranslation(['config', 'common']);
  const agents = useAgents();

  // Localized label for a trigger-type tab/value (labels live in TYPE_TAB_DEFS).
  const typeLabel = (value: TypeFilter) => {
    const def = TYPE_TAB_DEFS.find(d => d.value === value);
    return def ? t(def.key, { defaultValue: def.label }) : value;
  };
  // Localized label for a match mode (e.g. the badge on a trigger card).
  const matchModeLabel = (value: MatchMode) => {
    const def = MATCH_MODES.find(m => m.value === value);
    return def ? t(def.labelKey, { defaultValue: def.label }) : value;
  };

  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [view, setView] = useState<PanelView>('list');
  const [editingTrigger, setEditingTrigger] = useState<Partial<Trigger>>(emptyTrigger());
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fire history
  const [fireHistory, setFireHistory] = useState<TriggerFireRow[]>([]);
  const [selectedTriggerId, setSelectedTriggerId] = useState<string | null>(null);

  // Test match
  const [testPayload, setTestPayload] = useState('{\n  \n}');
  const [testResult, setTestResult] = useState<TestMatchResult | null>(null);
  const [testing, setTesting] = useState(false);

  // Cron validation
  const [cronNextFires, setCronNextFires] = useState<string[]>([]);

  // Type-filter tab selection (persisted across the session)
  const [selectedType, setSelectedType] = useState<TypeFilter>('all');

  // Slack instances (for the instanceId selector in the edit form)
  const [slackInstances, setSlackInstances] = useState<{ id: string; label: string }[]>([]);

  // ─── Data Loading ───

  const loadTriggers = useCallback(async () => {
    try {
      const res = await authFetch(apiUrl('/api/triggers'));
      if (res.ok) {
        const data = await res.json();
        setTriggers(data);
      }
    } catch (err) {
      console.error('Failed to load triggers:', err);
    }
  }, []);

  const loadHistory = useCallback(async (triggerId: string) => {
    try {
      const res = await authFetch(apiUrl(`/api/triggers/${triggerId}/events?limit=20`));
      if (res.ok) {
        const data = await res.json();
        setFireHistory(data);
      }
    } catch (err) {
      console.error('Failed to load trigger history:', err);
    }
  }, []);

  const loadSlackInstances = useCallback(async () => {
    try {
      const res = await authFetch(apiUrl('/api/slack/instances'));
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data?.instances) ? data.instances : [];
        setSlackInstances(list.map((i: { id: string; label?: string }) => ({ id: i.id, label: i.label || i.id })));
      }
    } catch (err) {
      console.error('Failed to load Slack instances:', err);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadTriggers();
      loadSlackInstances();
    }
  }, [isOpen, loadTriggers, loadSlackInstances]);

  useEffect(() => {
    if (selectedTriggerId) {
      loadHistory(selectedTriggerId);
    }
  }, [selectedTriggerId, loadHistory]);

  // ─── CRUD Actions ───

  const handleSave = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const url = isEditing
        ? apiUrl(`/api/triggers/${editingTrigger.id}`)
        : apiUrl('/api/triggers');
      const method = isEditing ? 'PATCH' : 'POST';

      const body = isEditing ? editingTrigger : editingTrigger;

      const res = await authFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('config:triggerPanel.saveFailed', { defaultValue: 'Failed to save trigger' }));
      }

      await loadTriggers();
      setView('list');
      setEditingTrigger(emptyTrigger());
      setIsEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('config:triggerPanel.saveError', { defaultValue: 'Save failed' }));
    } finally {
      setLoading(false);
    }
  }, [editingTrigger, isEditing, loadTriggers, t]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await authFetch(apiUrl(`/api/triggers/${id}`), { method: 'DELETE' });
      await loadTriggers();
    } catch (err) {
      console.error('Failed to delete trigger:', err);
    }
  }, [loadTriggers]);

  const handleToggleEnabled = useCallback(async (trigger: Trigger) => {
    try {
      await authFetch(apiUrl(`/api/triggers/${trigger.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !trigger.enabled }),
      });
      await loadTriggers();
    } catch (err) {
      console.error('Failed to toggle trigger:', err);
    }
  }, [loadTriggers]);

  // ─── Test Actions ───

  const handleTestFire = useCallback(async (triggerId: string) => {
    try {
      await authFetch(apiUrl(`/api/triggers/${triggerId}/fire`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variables: {} }),
      });
      if (selectedTriggerId === triggerId) {
        await loadHistory(triggerId);
      }
    } catch (err) {
      console.error('Failed to test fire trigger:', err);
    }
  }, [selectedTriggerId, loadHistory]);

  const handleTestMatch = useCallback(async () => {
    if (!editingTrigger.id) return;
    setTesting(true);
    setTestResult(null);

    try {
      let payload: unknown;
      try {
        payload = JSON.parse(testPayload);
      } catch {
        setTestResult({ structuralMatch: undefined, extractedVariables: {}, wouldFire: false });
        setError(t('config:triggerPanel.invalidJsonPayload', { defaultValue: 'Invalid JSON payload' }));
        return;
      }

      const res = await authFetch(apiUrl(`/api/triggers/${editingTrigger.id}/test-match`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload }),
      });

      if (res.ok) {
        const result = await res.json();
        setTestResult(result);
        setError(null);
      } else {
        const data = await res.json();
        setError(data.error || t('config:triggerPanel.testMatchFailed', { defaultValue: 'Test match failed' }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('config:triggerPanel.testMatchFailed', { defaultValue: 'Test match failed' }));
    } finally {
      setTesting(false);
    }
  }, [editingTrigger.id, testPayload, t]);

  const handleValidateCron = useCallback(async (expression: string) => {
    try {
      const res = await authFetch(apiUrl('/api/triggers/validate-cron'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expression,
          timezone: (editingTrigger as any).config?.timezone || 'UTC',
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setCronNextFires(data.valid ? data.nextFires : []);
      }
    } catch {
      setCronNextFires([]);
    }
  }, [editingTrigger]);

  // ─── Edit Helpers ───

  const openEditor = useCallback((trigger?: Trigger) => {
    if (trigger) {
      setEditingTrigger({ ...trigger });
      setIsEditing(true);
    } else {
      setEditingTrigger(emptyTrigger());
      setIsEditing(false);
    }
    setTestResult(null);
    setError(null);
    setView('edit');
  }, []);

  const updateField = useCallback((field: string, value: unknown) => {
    setEditingTrigger(prev => ({ ...prev, [field]: value }));
  }, []);

  const updateConfig = useCallback((field: string, value: unknown) => {
    setEditingTrigger(prev => ({
      ...prev,
      config: { ...(prev as any).config, [field]: value },
    }));
  }, []);

  const updateLlmMatch = useCallback((field: string, value: unknown) => {
    setEditingTrigger(prev => ({
      ...prev,
      llmMatch: { ...(prev.llmMatch || { prompt: '' }), [field]: value },
    }));
  }, []);

  const updateLlmExtract = useCallback((field: string, value: unknown) => {
    setEditingTrigger(prev => ({
      ...prev,
      llmExtract: { ...(prev.llmExtract || { prompt: '', variables: [] }), [field]: value },
    }));
  }, []);

  // ─── Agents list for dropdown ───
  const agentsList = useMemo(() => {
    return Array.from(agents.values()).map(a => ({ id: a.id, name: a.name, class: a.class }));
  }, [agents]);

  // ─── Per-type counts for the tab bar ───
  const typeCounts = useMemo(() => {
    const counts: Record<TypeFilter, number> = {
      all: triggers.length,
      webhook: 0, bitbucket: 0, cron: 0, slack: 0, email: 0, jira: 0, whatsapp: 0, wechat: 0,
    };
    for (const t of triggers) {
      if (t.type in counts) counts[t.type as TriggerType] += 1;
    }
    return counts;
  }, [triggers]);

  const filteredTriggers = useMemo(() => {
    if (selectedType === 'all') return triggers;
    return triggers.filter(t => t.type === selectedType);
  }, [triggers, selectedType]);

  // ─── Copy-to-clipboard with brief "Copied!" feedback ───
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyToClipboard = useCallback((value: string, key: string) => {
    if (!value) return;
    navigator.clipboard.writeText(value).then(
      () => {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(prev => (prev === key ? null : prev)), 1500);
      },
      () => setError(t('config:triggerPanel.copyFailed', { defaultValue: 'Failed to copy to clipboard' })),
    );
  }, [t]);

  if (!isOpen) return null;

  // ─── Render ───

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>
            {view === 'list'
              ? t('config:triggerPanel.title', { defaultValue: 'Triggers' })
              : isEditing
                ? t('config:triggerPanel.editTrigger', { defaultValue: 'Edit Trigger' })
                : t('config:triggerPanel.newTrigger', { defaultValue: 'New Trigger' })}
          </h2>
          <div style={styles.headerActions}>
            {view === 'list' && (
              <button style={styles.addBtn} onClick={() => openEditor()}>{t('config:triggerPanel.addTrigger', { defaultValue: '+ New Trigger' })}</button>
            )}
            {view === 'edit' && (
              <button style={styles.backBtn} onClick={() => { setView('list'); setTestResult(null); setError(null); }}>
                {t('common:buttons.back')}
              </button>
            )}
            <button style={styles.closeBtn} onClick={onClose}>X</button>
          </div>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        {/* List View */}
        {view === 'list' && (
          <div style={styles.content}>
            <div style={styles.tabBar} role="tablist" aria-label={t('config:triggerPanel.filterAria', { defaultValue: 'Filter triggers by type' })}>
              {TYPE_TAB_DEFS.map(tab => {
                const count = typeCounts[tab.value];
                const active = selectedType === tab.value;
                const label = typeLabel(tab.value);
                return (
                  <button
                    key={tab.value}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSelectedType(tab.value)}
                    style={{ ...styles.tab, ...(active ? styles.tabActive : {}) }}
                    title={`${label} (${count})`}
                  >
                    <span style={styles.tabIcon}>{tab.icon}</span>
                    <span style={styles.tabLabel}>{label}</span>
                    <span style={{ ...styles.tabBadge, ...(active ? styles.tabBadgeActive : {}) }}>{count}</span>
                  </button>
                );
              })}
            </div>
            {triggers.length === 0 ? (
              <div style={styles.empty}>{t('config:triggerPanel.emptyList', { defaultValue: 'No triggers configured. Create one to get started.' })}</div>
            ) : filteredTriggers.length === 0 ? (
              <div style={styles.empty}>
                {t('config:triggerPanel.emptyFiltered', { defaultValue: 'No {{type}} triggers configured yet.', type: typeLabel(selectedType) })}
              </div>
            ) : (
              filteredTriggers.map(trigger => (
                <div
                  key={trigger.id}
                  style={{
                    ...styles.triggerCard,
                    borderLeftColor: trigger.status === 'error' ? '#e74c3c' : trigger.enabled ? '#2ecc71' : '#95a5a6',
                  }}
                  onClick={() => { setSelectedTriggerId(trigger.id); openEditor(trigger); }}
                >
                  <div style={styles.cardHeader}>
                    <div style={styles.cardTitle}>
                      <span style={styles.typeTag}>{typeLabel(trigger.type)}</span>
                      <span>{trigger.name}</span>
                      {trigger.type === 'cron' && (() => {
                        const cfg = (trigger as any).config || {};
                        if (!cfg.runOnce) {
                          return <span style={styles.matchTag}>{t('config:triggerPanel.badge.recurring', { defaultValue: 'Recurring' })}</span>;
                        }
                        if (cfg.completedAt) {
                          return <span style={{ ...styles.matchTag, color: '#a6e3a1' }}>{t('config:triggerPanel.badge.onceCompleted', { defaultValue: 'Once · completed' })}</span>;
                        }
                        if (cfg.missedAt) {
                          return <span style={{ ...styles.matchTag, color: '#f38ba8' }}>{t('config:triggerPanel.badge.onceMissed', { defaultValue: 'Once · missed' })}</span>;
                        }
                        return <span style={{ ...styles.matchTag, color: '#f9e2af' }}>{t('config:triggerPanel.badge.oncePending', { defaultValue: 'Once · pending' })}</span>;
                      })()}
                      {trigger.matchMode !== 'structural' && (
                        <span style={styles.matchTag}>{matchModeLabel(trigger.matchMode)}</span>
                      )}
                    </div>
                    <div style={styles.cardActions}>
                      <button
                        style={styles.smallBtn}
                        onClick={e => { e.stopPropagation(); handleToggleEnabled(trigger); }}
                      >
                        {trigger.enabled
                          ? t('config:triggerPanel.disable', { defaultValue: 'Disable' })
                          : t('config:triggerPanel.enable', { defaultValue: 'Enable' })}
                      </button>
                      <button
                        style={styles.smallBtn}
                        onClick={e => { e.stopPropagation(); handleTestFire(trigger.id); }}
                      >
                        {t('config:triggerPanel.testFire', { defaultValue: 'Test Fire' })}
                      </button>
                      <button
                        style={{ ...styles.smallBtn, color: '#e74c3c' }}
                        onClick={e => { e.stopPropagation(); handleDelete(trigger.id); }}
                      >
                        {t('common:buttons.delete')}
                      </button>
                    </div>
                  </div>
                  <div style={styles.cardMeta}>
                    <span>{t('config:triggerPanel.meta.agent', { defaultValue: 'Agent: {{name}}', name: agents.get(trigger.agentId)?.name || trigger.agentId })}</span>
                    <span>{t('config:triggerPanel.meta.fires', { defaultValue: 'Fires: {{num}}', num: trigger.fireCount })}</span>
                    {trigger.lastFiredAt && (
                      <span>{t('config:triggerPanel.meta.last', { defaultValue: 'Last: {{time}}', time: new Date(trigger.lastFiredAt).toLocaleString() })}</span>
                    )}
                    {trigger.status === 'error' && trigger.lastError && (
                      <span style={{ color: '#e74c3c' }}>{t('config:triggerPanel.meta.error', { defaultValue: 'Error: {{msg}}', msg: trigger.lastError })}</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Edit View */}
        {view === 'edit' && (
          <div style={styles.content}>
            <div style={styles.form}>
              {/* Basic Fields */}
              <div style={styles.field}>
                <label style={styles.label}>{t('common:labels.name')}</label>
                <input
                  style={styles.input}
                  value={editingTrigger.name || ''}
                  onChange={e => updateField('name', e.target.value)}
                  placeholder={t('config:triggerPanel.namePlaceholder', { defaultValue: 'My Trigger' })}
                />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>{t('common:labels.description')}</label>
                <input
                  style={styles.input}
                  value={editingTrigger.description || ''}
                  onChange={e => updateField('description', e.target.value)}
                  placeholder={t('config:triggerPanel.descriptionPlaceholder', { defaultValue: 'Optional description' })}
                />
              </div>

              <div style={styles.row}>
                <div style={styles.field}>
                  <label style={styles.label}>{t('common:labels.type')}</label>
                  <select
                    style={styles.select}
                    value={editingTrigger.type || 'webhook'}
                    onChange={e => {
                      const type = e.target.value as TriggerType;
                      updateField('type', type);
                      // Reset config for new type
                      if (type === 'webhook') updateField('config', { method: 'POST' });
                      else if (type === 'cron') updateField('config', { expression: '0 9 * * MON-FRI', timezone: 'UTC' });
                      else if (type === 'bitbucket') updateField('config', { workspace: '', repoSlug: '', events: ['pullrequest:created', 'pullrequest:updated'] });
                      else updateField('config', {});
                      // Seed a sensible default promptTemplate for source types
                      // that surface attachments — but ONLY when the user
                      // hasn't typed anything yet, so we don't clobber custom
                      // templates on type-toggle.
                      const currentPrompt = (editingTrigger.promptTemplate ?? '').trim();
                      if (!currentPrompt) {
                        if (type === 'slack') {
                          updateField('promptTemplate', 'Slack message from {{slack.user}} in {{slack.channelName}}:\n{{slack.message}}\n\n{{slack.attachmentsBlock}}');
                        } else if (type === 'whatsapp') {
                          updateField('promptTemplate', 'WhatsApp message from {{whatsapp.fromName}} ({{whatsapp.from}}):\n{{whatsapp.body}}\n\n{{whatsapp.attachmentsBlock}}');
                        } else if (type === 'wechat') {
                          updateField('promptTemplate', 'WeChat message from {{wechat.fromName}} ({{wechat.from}}):\n{{wechat.body}}\n\nTo reply, use the wechat-messaging skill and ALWAYS pass {{wechat.contextToken}} as context_token.');
                        }
                      }
                    }}
                  >
                    {TRIGGER_TYPES.map(def => (
                      <option key={def.value} value={def.value}>{typeLabel(def.value)}</option>
                    ))}
                  </select>
                </div>

                <div style={styles.field}>
                  <label style={styles.label}>{t('common:labels.agent')}</label>
                  <select
                    style={styles.select}
                    value={editingTrigger.agentId || ''}
                    onChange={e => updateField('agentId', e.target.value)}
                  >
                    <option value="">{t('config:triggerPanel.selectAgent', { defaultValue: 'Select agent...' })}</option>
                    {agentsList.map(a => (
                      <option key={a.id} value={a.id}>{a.name} ({a.class})</option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={styles.field}>
                <label style={styles.label}>{t('config:triggerPanel.promptTemplate', { defaultValue: 'Prompt Template' })}</label>
                <textarea
                  style={styles.textarea}
                  value={editingTrigger.promptTemplate || ''}
                  onChange={e => updateField('promptTemplate', e.target.value)}
                  placeholder={t('config:triggerPanel.promptPlaceholder', { defaultValue: 'Message sent to agent. Use {{variable}} for interpolation.', variable: '{{variable}}' })}
                  rows={4}
                />
              </div>

              {/* Type-Specific Config */}
              {editingTrigger.type === 'webhook' && (
                <div style={styles.section}>
                  <h4 style={styles.sectionTitle}>{t('config:triggerPanel.webhook.section', { defaultValue: 'Webhook Config' })}</h4>
                  <div style={styles.row}>
                    <div style={styles.field}>
                      <label style={styles.label}>{t('config:triggerPanel.webhook.method', { defaultValue: 'Method' })}</label>
                      <select
                        style={styles.select}
                        value={(editingTrigger as any).config?.method || 'POST'}
                        onChange={e => updateConfig('method', e.target.value)}
                      >
                        <option value="POST">POST</option>
                        <option value="PUT">PUT</option>
                      </select>
                    </div>
                    <div style={styles.field}>
                      <label style={styles.label}>{t('config:triggerPanel.webhook.secret', { defaultValue: 'Secret (HMAC)' })}</label>
                      <input
                        style={styles.input}
                        type="password"
                        value={(editingTrigger as any).config?.secret || ''}
                        onChange={e => updateConfig('secret', e.target.value || undefined)}
                        placeholder={t('config:triggerPanel.webhook.secretPlaceholder', { defaultValue: 'Optional HMAC secret' })}
                      />
                    </div>
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>{t('config:triggerPanel.webhook.extractFields', { defaultValue: 'Extract Fields (comma-separated JSON paths)' })}</label>
                    <input
                      style={styles.input}
                      value={(editingTrigger as any).config?.extractFields?.join(', ') || ''}
                      onChange={e => updateConfig('extractFields', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
                      placeholder="body.release_name, body.version"
                    />
                  </div>
                  {isEditing && editingTrigger.id && (
                    <div style={styles.webhookUrl}>
                      <label style={styles.label}>{t('config:triggerPanel.webhook.url', { defaultValue: 'Webhook URL' })}</label>
                      <code style={styles.code}>
                        {`${window.location.origin}/api/triggers/webhook/${editingTrigger.id}`}
                      </code>
                    </div>
                  )}
                </div>
              )}

              {editingTrigger.type === 'bitbucket' && (() => {
                const cfg = (editingTrigger as any).config || {};
                const selectedEvents: string[] = Array.isArray(cfg.events) ? cfg.events : [];
                const webhookUrl = isEditing && editingTrigger.id
                  ? `${window.location.origin}/api/triggers/webhook/${editingTrigger.id}`
                  : '';
                const toggleEvent = (eventKey: string) => {
                  const next = selectedEvents.includes(eventKey)
                    ? selectedEvents.filter(e => e !== eventKey)
                    : [...selectedEvents, eventKey];
                  updateConfig('events', next);
                };
                return (
                  <div style={styles.section}>
                    <h4 style={styles.sectionTitle}>{t('config:triggerPanel.bitbucket.section', { defaultValue: 'Bitbucket Config' })}</h4>
                    <div style={styles.row}>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.bitbucket.workspace', { defaultValue: 'Workspace' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.workspace || ''}
                          onChange={e => updateConfig('workspace', e.target.value)}
                          placeholder="tide"
                        />
                      </div>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.bitbucket.repoSlug', { defaultValue: 'Repository slug' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.repoSlug || ''}
                          onChange={e => updateConfig('repoSlug', e.target.value)}
                          placeholder="wind"
                        />
                      </div>
                    </div>

                    <div style={styles.field}>
                      <label style={styles.label}>{t('config:triggerPanel.bitbucket.events', { defaultValue: 'Events' })}</label>
                      <div style={styles.checkboxGrid}>
                        {BITBUCKET_EVENT_OPTIONS.map(opt => {
                          const checked = selectedEvents.includes(opt.value);
                          return (
                            <label key={opt.value} style={styles.checkboxLabel}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleEvent(opt.value)}
                              />
                              <span>{t(opt.key, { defaultValue: opt.label })}</span>
                              <code style={styles.checkboxCode}>{opt.value}</code>
                            </label>
                          );
                        })}
                      </div>
                    </div>

                    <div style={styles.field}>
                      <label style={styles.label}>{t('config:triggerPanel.bitbucket.secret', { defaultValue: 'HMAC secret' })}</label>
                      <div style={styles.inlineRow}>
                        <input
                          style={{ ...styles.input, flex: 1 }}
                          type="password"
                          value={cfg.secret || ''}
                          onChange={e => updateConfig('secret', e.target.value || undefined)}
                          placeholder={t('config:triggerPanel.bitbucket.secretPlaceholder', { defaultValue: 'Shared secret used to validate Bitbucket signature' })}
                        />
                        <button
                          type="button"
                          style={styles.smallBtn}
                          onClick={() => copyToClipboard(cfg.secret || '', 'bitbucket-secret')}
                          disabled={!cfg.secret}
                        >
                          {copiedKey === 'bitbucket-secret' ? t('common:status.copied') : t('common:buttons.copy')}
                        </button>
                      </div>
                      <span style={styles.llmMeta}>
                        {t('config:triggerPanel.bitbucket.secretHint', { defaultValue: "Paste the same secret into Bitbucket's webhook configuration." })}
                      </span>
                    </div>

                    {webhookUrl && (
                      <div style={styles.webhookUrl}>
                        <label style={styles.label}>{t('config:triggerPanel.webhook.url', { defaultValue: 'Webhook URL' })}</label>
                        <div style={styles.inlineRow}>
                          <code style={{ ...styles.code, flex: 1 }}>{webhookUrl}</code>
                          <button
                            type="button"
                            style={styles.smallBtn}
                            onClick={() => copyToClipboard(webhookUrl, 'bitbucket-url')}
                          >
                            {copiedKey === 'bitbucket-url' ? t('common:status.copied') : t('common:buttons.copy')}
                          </button>
                        </div>
                        <span style={styles.llmMeta}>
                          {t('config:triggerPanel.bitbucket.urlHint', { defaultValue: 'In Bitbucket: Repository settings → Webhooks → Add webhook, then paste this URL and the secret above.' })}
                        </span>
                      </div>
                    )}
                    {!webhookUrl && (
                      <span style={styles.llmMeta}>
                        {t('config:triggerPanel.saveToRevealUrl', { defaultValue: 'Save the trigger to reveal its webhook URL.' })}
                      </span>
                    )}
                  </div>
                );
              })()}

              {editingTrigger.type === 'cron' && (() => {
                const cronConfig = (editingTrigger as any).config || {};
                const runOnce = !!cronConfig.runOnce;
                const completedAt = cronConfig.completedAt as number | undefined;
                const missedAt = cronConfig.missedAt as number | undefined;
                const isCompleted = !!completedAt;

                return (
                  <div style={styles.section}>
                    <h4 style={styles.sectionTitle}>{t('config:triggerPanel.cron.section', { defaultValue: 'Cron Config' })}</h4>

                    {/* Kind selector: Repeats vs Run once */}
                    <div style={styles.modeSelector}>
                      <button
                        type="button"
                        style={{
                          ...styles.modeBtn,
                          ...(!runOnce ? styles.modeBtnActive : {}),
                        }}
                        onClick={() => updateConfig('runOnce', false)}
                        disabled={isCompleted}
                      >
                        <strong>{t('config:triggerPanel.cron.repeats', { defaultValue: 'Repeats' })}</strong>
                        <span style={styles.modeDesc}>{t('config:triggerPanel.cron.repeatsDesc', { defaultValue: 'Fires on a cron schedule' })}</span>
                      </button>
                      <button
                        type="button"
                        style={{
                          ...styles.modeBtn,
                          ...(runOnce ? styles.modeBtnActive : {}),
                        }}
                        onClick={() => updateConfig('runOnce', true)}
                        disabled={isCompleted}
                      >
                        <strong>{t('config:triggerPanel.cron.runOnce', { defaultValue: 'Run once' })}</strong>
                        <span style={styles.modeDesc}>{t('config:triggerPanel.cron.runOnceDesc', { defaultValue: 'Fires exactly once at a specific time' })}</span>
                      </button>
                    </div>

                    {/* Status banner for completed / missed one-shots */}
                    {isCompleted && (
                      <div style={{ ...styles.testResult, borderLeft: '3px solid #a6e3a1' }}>
                        <strong style={{ color: '#a6e3a1' }}>{t('config:triggerPanel.cron.completed', { defaultValue: 'Completed' })}</strong>
                        <span style={styles.llmMeta}>
                          {t('config:triggerPanel.cron.firedAt', { defaultValue: 'Fired at {{time}}', time: new Date(completedAt).toLocaleString() })}
                        </span>
                      </div>
                    )}
                    {!isCompleted && missedAt && (
                      <div style={{ ...styles.testResult, borderLeft: '3px solid #f38ba8' }}>
                        <strong style={{ color: '#f38ba8' }}>{t('config:triggerPanel.cron.missed', { defaultValue: 'Missed' })}</strong>
                        <span style={styles.llmMeta}>
                          {t('config:triggerPanel.cron.missedAt', { defaultValue: 'Marked missed at {{time}} (server was down at runAt)', time: new Date(missedAt).toLocaleString() })}
                        </span>
                      </div>
                    )}

                    {runOnce ? (
                      <div style={styles.row}>
                        <div style={styles.field}>
                          <label style={styles.label}>{t('config:triggerPanel.cron.runAt', { defaultValue: 'Run at' })}</label>
                          <input
                            style={styles.input}
                            type="datetime-local"
                            value={toDatetimeLocal(cronConfig.runAt)}
                            onChange={e => {
                              const local = e.target.value;
                              if (!local) {
                                updateConfig('runAt', undefined);
                                return;
                              }
                              // datetime-local is interpreted as local time; convert to absolute UTC ISO.
                              const iso = new Date(local).toISOString();
                              updateConfig('runAt', iso);
                            }}
                            disabled={isCompleted}
                          />
                          <span style={styles.llmMeta}>{t('config:triggerPanel.cron.runAtHint', { defaultValue: "Interpreted in your browser's local timezone" })}</span>
                        </div>
                      </div>
                    ) : (
                      <div style={styles.row}>
                        <div style={styles.field}>
                          <label style={styles.label}>{t('config:triggerPanel.cron.expression', { defaultValue: 'Expression' })}</label>
                          <input
                            style={styles.input}
                            value={cronConfig.expression || ''}
                            onChange={e => {
                              updateConfig('expression', e.target.value);
                              if (e.target.value) handleValidateCron(e.target.value);
                            }}
                            placeholder="0 9 * * MON-FRI"
                          />
                        </div>
                        <div style={styles.field}>
                          <label style={styles.label}>{t('config:triggerPanel.cron.timezone', { defaultValue: 'Timezone' })}</label>
                          <input
                            style={styles.input}
                            value={cronConfig.timezone || 'UTC'}
                            onChange={e => updateConfig('timezone', e.target.value)}
                            placeholder="America/Mexico_City"
                          />
                        </div>
                      </div>
                    )}
                    {!runOnce && cronNextFires.length > 0 && (
                      <div style={styles.nextFires}>
                        <label style={styles.label}>{t('config:triggerPanel.cron.nextFires', { defaultValue: 'Next fires:' })}</label>
                        {cronNextFires.map((d, i) => (
                          <div key={i} style={styles.nextFireItem}>{new Date(d).toLocaleString()}</div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {editingTrigger.type === 'slack' && (() => {
                const cfg = (editingTrigger as any).config || {};
                return (
                  <div style={styles.section}>
                    <h4 style={styles.sectionTitle}>{t('config:triggerPanel.slack.section', { defaultValue: 'Slack Config' })}</h4>
                    <div style={styles.row}>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.slack.instance', { defaultValue: 'Instance' })}</label>
                        <select
                          style={styles.select}
                          value={cfg.instanceId || ''}
                          onChange={e => updateConfig('instanceId', e.target.value || undefined)}
                        >
                          <option value="">{t('config:triggerPanel.slack.anyInstance', { defaultValue: 'Any instance' })}</option>
                          {slackInstances.map(inst => (
                            <option key={inst.id} value={inst.id}>{inst.label} ({inst.id})</option>
                          ))}
                          {cfg.instanceId && !slackInstances.some(i => i.id === cfg.instanceId) && (
                            <option value={cfg.instanceId}>{cfg.instanceId}{t('config:triggerPanel.slack.instanceNotFound', { defaultValue: ' (not found)' })}</option>
                          )}
                        </select>
                      </div>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.slack.threadTs', { defaultValue: 'Thread timestamp' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.threadTs || ''}
                          onChange={e => updateConfig('threadTs', e.target.value || undefined)}
                          placeholder={t('config:triggerPanel.slack.threadTsPlaceholder', { defaultValue: 'Only replies in this thread' })}
                        />
                      </div>
                    </div>
                    <div style={styles.field}>
                      <label style={styles.label}>{t('config:triggerPanel.slack.channelId', { defaultValue: 'Channel ID (legacy single channel)' })}</label>
                      <input
                        style={styles.input}
                        value={cfg.channelId || ''}
                        onChange={e => updateConfig('channelId', e.target.value || undefined)}
                        placeholder={t('config:triggerPanel.slack.channelIdPlaceholder', { defaultValue: 'C0123ABCD (blank = any)' })}
                      />
                    </div>
                    <div style={styles.row}>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.slack.allowlist', { defaultValue: 'Channel allowlist (comma-separated IDs)' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.channelIdAllowlist?.join(', ') || ''}
                          onChange={e => updateConfig('channelIdAllowlist', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
                          placeholder="C06UCC5FFST, C0789..."
                        />
                      </div>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.slack.excludeChannels', { defaultValue: 'Exclude channel IDs (comma-separated)' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.excludeChannelIds?.join(', ') || ''}
                          onChange={e => updateConfig('excludeChannelIds', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
                          placeholder="D0AMP833LDQ"
                        />
                      </div>
                    </div>
                    <div style={styles.field}>
                      <label style={styles.label}>{t('config:triggerPanel.slack.messagePattern', { defaultValue: 'Message pattern (regex)' })}</label>
                      <input
                        style={styles.input}
                        value={cfg.messagePattern || ''}
                        onChange={e => updateConfig('messagePattern', e.target.value || undefined)}
                        placeholder="deploy|release"
                      />
                    </div>
                    <div style={styles.row}>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.slack.userFilter', { defaultValue: 'User filter (comma-separated IDs)' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.userFilter?.join(', ') || ''}
                          onChange={e => updateConfig('userFilter', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
                          placeholder="U0123ABCD, U0456EFGH"
                        />
                      </div>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.slack.excludeUsers', { defaultValue: 'Exclude user IDs (comma-separated)' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.excludeUserIds?.join(', ') || ''}
                          onChange={e => updateConfig('excludeUserIds', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
                          placeholder="U0789IJKL"
                        />
                      </div>
                    </div>
                    <div style={styles.checkboxGrid}>
                      <label style={styles.checkboxLabel}>
                        <input type="checkbox" checked={!!cfg.dmOnly} onChange={e => updateConfig('dmOnly', e.target.checked || undefined)} />
                        <span>{t('config:triggerPanel.slack.dmOnly', { defaultValue: 'DMs only' })}</span>
                      </label>
                      <label style={styles.checkboxLabel}>
                        <input type="checkbox" checked={!!cfg.excludeDms} onChange={e => updateConfig('excludeDms', e.target.checked || undefined)} />
                        <span>{t('config:triggerPanel.slack.excludeDms', { defaultValue: 'Exclude DMs' })}</span>
                      </label>
                      <label style={styles.checkboxLabel}>
                        <input type="checkbox" checked={!!cfg.includeOwnMessages} onChange={e => updateConfig('includeOwnMessages', e.target.checked || undefined)} />
                        <span>{t('config:triggerPanel.slack.includeOwn', { defaultValue: 'Include own messages' })}</span>
                      </label>
                    </div>
                  </div>
                );
              })()}

              {editingTrigger.type === 'email' && (() => {
                const cfg = (editingTrigger as any).config || {};
                const approvals = cfg.requiredApprovals;
                const setApprovals = (patch: Record<string, unknown>) =>
                  updateConfig('requiredApprovals', { count: 1, approvers: [], approvalKeywords: [], ...approvals, ...patch });
                return (
                  <div style={styles.section}>
                    <h4 style={styles.sectionTitle}>{t('config:triggerPanel.email.section', { defaultValue: 'Email Config' })}</h4>
                    <div style={styles.field}>
                      <label style={styles.label}>{t('config:triggerPanel.email.fromFilter', { defaultValue: 'From filter (comma-separated addresses)' })}</label>
                      <input
                        style={styles.input}
                        value={cfg.fromFilter?.join(', ') || ''}
                        onChange={e => updateConfig('fromFilter', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
                        placeholder="alerts@example.com, ops@example.com"
                      />
                    </div>
                    <div style={styles.row}>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.email.subjectPattern', { defaultValue: 'Subject pattern (regex)' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.subjectPattern || ''}
                          onChange={e => updateConfig('subjectPattern', e.target.value || undefined)}
                          placeholder="^\\[Deploy\\]"
                        />
                      </div>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.email.threadId', { defaultValue: 'Thread ID' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.threadId || ''}
                          onChange={e => updateConfig('threadId', e.target.value || undefined)}
                          placeholder={t('config:triggerPanel.email.threadIdPlaceholder', { defaultValue: 'Only watch a specific thread' })}
                        />
                      </div>
                    </div>
                    <div style={styles.field}>
                      <label style={styles.checkboxLabel}>
                        <input
                          type="checkbox"
                          checked={!!approvals}
                          onChange={e => updateConfig('requiredApprovals', e.target.checked ? { count: 1, approvers: [], approvalKeywords: [] } : undefined)}
                        />
                        <span>{t('config:triggerPanel.email.requireApprovals', { defaultValue: 'Require approvals before firing' })}</span>
                      </label>
                    </div>
                    {approvals && (
                      <>
                        <div style={styles.row}>
                          <div style={styles.field}>
                            <label style={styles.label}>{t('config:triggerPanel.email.approvalsNeeded', { defaultValue: 'Approvals needed' })}</label>
                            <input
                              style={styles.input}
                              type="number"
                              min="1"
                              value={approvals.count ?? 1}
                              onChange={e => setApprovals({ count: parseInt(e.target.value, 10) || 1 })}
                            />
                          </div>
                          <div style={styles.field}>
                            <label style={styles.label}>{t('config:triggerPanel.email.approvers', { defaultValue: 'Approvers (comma-separated)' })}</label>
                            <input
                              style={styles.input}
                              value={approvals.approvers?.join(', ') || ''}
                              onChange={e => setApprovals({ approvers: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) })}
                              placeholder="lead@example.com"
                            />
                          </div>
                        </div>
                        <div style={styles.field}>
                          <label style={styles.label}>{t('config:triggerPanel.email.approvalKeywords', { defaultValue: 'Approval keywords (comma-separated)' })}</label>
                          <input
                            style={styles.input}
                            value={approvals.approvalKeywords?.join(', ') || ''}
                            onChange={e => setApprovals({ approvalKeywords: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) })}
                            placeholder="approved, lgtm, ship it"
                          />
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}

              {editingTrigger.type === 'jira' && (() => {
                const cfg = (editingTrigger as any).config || {};
                return (
                  <div style={styles.section}>
                    <h4 style={styles.sectionTitle}>{t('config:triggerPanel.jira.section', { defaultValue: 'Jira Config' })}</h4>
                    <div style={styles.row}>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.jira.projectKey', { defaultValue: 'Project key' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.projectKey || ''}
                          onChange={e => updateConfig('projectKey', e.target.value || undefined)}
                          placeholder="OPS"
                        />
                      </div>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.jira.issueType', { defaultValue: 'Issue type' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.issueType || ''}
                          onChange={e => updateConfig('issueType', e.target.value || undefined)}
                          placeholder="Service Request"
                        />
                      </div>
                    </div>
                    <div style={styles.field}>
                      <label style={styles.label}>{t('config:triggerPanel.jira.events', { defaultValue: 'Events (comma-separated)' })}</label>
                      <input
                        style={styles.input}
                        value={cfg.events?.join(', ') || ''}
                        onChange={e => updateConfig('events', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
                        placeholder="jira:issue_created, jira:issue_updated"
                      />
                    </div>
                    <div style={styles.field}>
                      <label style={styles.label}>{t('config:triggerPanel.jira.jqlFilter', { defaultValue: 'JQL filter' })}</label>
                      <textarea
                        style={styles.textarea}
                        value={cfg.jqlFilter || ''}
                        onChange={e => updateConfig('jqlFilter', e.target.value || undefined)}
                        placeholder='priority = High AND status = Open'
                        rows={2}
                      />
                    </div>
                    <div style={styles.field}>
                      <label style={styles.label}>{t('config:triggerPanel.jira.secret', { defaultValue: 'HMAC / shared secret' })}</label>
                      <input
                        style={styles.input}
                        type="password"
                        value={cfg.secret || ''}
                        onChange={e => updateConfig('secret', e.target.value || undefined)}
                        placeholder={t('config:triggerPanel.jira.secretPlaceholder', { defaultValue: 'Required — unsigned deliveries are rejected' })}
                      />
                    </div>
                  </div>
                );
              })()}

              {editingTrigger.type === 'whatsapp' && (() => {
                const cfg = (editingTrigger as any).config || {};
                return (
                  <div style={styles.section}>
                    <h4 style={styles.sectionTitle}>{t('config:triggerPanel.whatsapp.section', { defaultValue: 'WhatsApp Config' })}</h4>
                    <div style={styles.row}>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.whatsapp.fromFilter', { defaultValue: 'From filter (comma-separated JID substrings)' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.fromFilter?.join(', ') || ''}
                          onChange={e => updateConfig('fromFilter', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
                          placeholder="5215512345678, @g.us"
                        />
                      </div>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.whatsapp.direction', { defaultValue: 'Direction' })}</label>
                        <select
                          style={styles.select}
                          value={cfg.direction || 'any'}
                          onChange={e => updateConfig('direction', e.target.value === 'any' ? undefined : e.target.value)}
                        >
                          <option value="any">{t('config:triggerPanel.whatsapp.any', { defaultValue: 'Any' })}</option>
                          <option value="inbound">{t('config:triggerPanel.whatsapp.inbound', { defaultValue: 'Inbound' })}</option>
                          <option value="outbound">{t('config:triggerPanel.whatsapp.outbound', { defaultValue: 'Outbound' })}</option>
                        </select>
                      </div>
                    </div>
                    <div style={styles.row}>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.whatsapp.bodyPattern', { defaultValue: 'Body pattern (regex)' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.bodyPattern || ''}
                          onChange={e => updateConfig('bodyPattern', e.target.value || undefined)}
                          placeholder="urgente|deploy"
                        />
                      </div>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.whatsapp.sessionId', { defaultValue: 'Session ID' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.sessionId || ''}
                          onChange={e => updateConfig('sessionId', e.target.value || undefined)}
                          placeholder={t('config:triggerPanel.whatsapp.sessionIdPlaceholder', { defaultValue: 'Restrict to a Baileys session' })}
                        />
                      </div>
                    </div>
                    <div style={styles.checkboxGrid}>
                      <label style={styles.checkboxLabel}>
                        <input type="checkbox" checked={!!cfg.groupOnly} onChange={e => updateConfig('groupOnly', e.target.checked || undefined)} />
                        <span>{t('config:triggerPanel.whatsapp.groupOnly', { defaultValue: 'Groups only' })}</span>
                      </label>
                      <label style={styles.checkboxLabel}>
                        <input type="checkbox" checked={!!cfg.dmOnly} onChange={e => updateConfig('dmOnly', e.target.checked || undefined)} />
                        <span>{t('config:triggerPanel.slack.dmOnly', { defaultValue: 'DMs only' })}</span>
                      </label>
                      <label style={styles.checkboxLabel}>
                        <input type="checkbox" checked={!!cfg.includeStatuses} onChange={e => updateConfig('includeStatuses', e.target.checked || undefined)} />
                        <span>{t('config:triggerPanel.whatsapp.includeStatuses', { defaultValue: 'Include statuses' })}</span>
                      </label>
                    </div>
                  </div>
                );
              })()}

              {editingTrigger.type === 'wechat' && (() => {
                const cfg = (editingTrigger as any).config || {};
                return (
                  <div style={styles.section}>
                    <h4 style={styles.sectionTitle}>{t('config:triggerPanel.wechat.section', { defaultValue: 'WeChat Config' })}</h4>
                    <div style={styles.row}>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.wechat.fromFilter', { defaultValue: 'From filter (comma-separated sender id substrings)' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.fromFilter?.join(', ') || ''}
                          onChange={e => updateConfig('fromFilter', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
                          placeholder="wxid_xxx, @im.wechat"
                        />
                      </div>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.wechat.excludeFrom', { defaultValue: 'Exclude senders (takes precedence)' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.excludeFrom?.join(', ') || ''}
                          onChange={e => updateConfig('excludeFrom', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
                          placeholder="bot_mirror"
                        />
                      </div>
                    </div>
                    <div style={styles.row}>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.wechat.bodyPattern', { defaultValue: 'Body pattern (regex, matches text or voice transcription)' })}</label>
                        <input
                          style={styles.input}
                          value={cfg.bodyPattern || ''}
                          onChange={e => updateConfig('bodyPattern', e.target.value || undefined)}
                          placeholder="部署|deploy"
                        />
                      </div>
                    </div>
                    <div style={styles.checkboxGrid}>
                      <label style={styles.checkboxLabel}>
                        <input type="checkbox" checked={!!cfg.onlyWithContextToken} onChange={e => updateConfig('onlyWithContextToken', e.target.checked || undefined)} />
                        <span>{t('config:triggerPanel.wechat.onlyWithContextToken', { defaultValue: 'Reply-capable messages only' })}</span>
                      </label>
                      <label style={styles.checkboxLabel}>
                        <input type="checkbox" checked={!!cfg.dmOnly} onChange={e => updateConfig('dmOnly', e.target.checked || undefined)} />
                        <span>{t('config:triggerPanel.slack.dmOnly', { defaultValue: 'DMs only' })}</span>
                      </label>
                    </div>
                    <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      {t('config:triggerPanel.wechat.variablesHint', {
                        defaultValue: 'Variables: {{wechat.from}}, {{wechat.fromName}}, {{wechat.body}}, {{wechat.contextToken}} — pass contextToken to the wechat-messaging skill to reply.',
                      })}
                    </p>
                  </div>
                );
              })()}

              {/* Match Mode Selector */}
              <div style={styles.section}>
                <h4 style={styles.sectionTitle}>{t('config:triggerPanel.matchMode.section', { defaultValue: 'Match Mode' })}</h4>
                <div style={styles.modeSelector}>
                  {MATCH_MODES.map(mode => (
                    <button
                      key={mode.value}
                      style={{
                        ...styles.modeBtn,
                        ...(editingTrigger.matchMode === mode.value ? styles.modeBtnActive : {}),
                      }}
                      onClick={() => updateField('matchMode', mode.value)}
                    >
                      <strong>{t(mode.labelKey, { defaultValue: mode.label })}</strong>
                      <span style={styles.modeDesc}>{t(mode.descKey, { defaultValue: mode.desc })}</span>
                    </button>
                  ))}
                </div>

                {(editingTrigger.matchMode === 'llm' || editingTrigger.matchMode === 'hybrid') && (
                  <div style={styles.llmConfig}>
                    <div style={styles.field}>
                      <label style={styles.label}>{t('config:triggerPanel.llm.matchPrompt', { defaultValue: 'LLM Match Prompt' })}</label>
                      <textarea
                        style={styles.textarea}
                        value={editingTrigger.llmMatch?.prompt || ''}
                        onChange={e => updateLlmMatch('prompt', e.target.value)}
                        placeholder={t('config:triggerPanel.llm.matchPromptPlaceholder', { defaultValue: 'Does this message request a release deployment?' })}
                        rows={3}
                      />
                    </div>
                    <div style={styles.row}>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('common:labels.model')}</label>
                        <select
                          style={styles.select}
                          value={editingTrigger.llmMatch?.model || 'haiku'}
                          onChange={e => updateLlmMatch('model', e.target.value)}
                        >
                          <option value="haiku">{t('config:triggerPanel.llm.modelHaiku', { defaultValue: 'Haiku (fast, cheap)' })}</option>
                          <option value="sonnet">{t('config:triggerPanel.llm.modelSonnet', { defaultValue: 'Sonnet (balanced)' })}</option>
                          <option value="opus">{t('config:triggerPanel.llm.modelOpus', { defaultValue: 'Opus (powerful)' })}</option>
                        </select>
                      </div>
                      <div style={styles.field}>
                        <label style={styles.label}>{t('config:triggerPanel.llm.minConfidence', { defaultValue: 'Min Confidence' })}</label>
                        <input
                          style={styles.input}
                          type="number"
                          min="0"
                          max="1"
                          step="0.1"
                          value={editingTrigger.llmMatch?.minConfidence ?? 0}
                          onChange={e => updateLlmMatch('minConfidence', parseFloat(e.target.value))}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Extraction Mode */}
              <div style={styles.section}>
                <h4 style={styles.sectionTitle}>{t('config:triggerPanel.extractionMode.section', { defaultValue: 'Extraction Mode' })}</h4>
                <div style={styles.row}>
                  {EXTRACTION_MODES.map(mode => (
                    <button
                      key={mode.value}
                      style={{
                        ...styles.modeBtn,
                        ...(editingTrigger.extractionMode === mode.value ? styles.modeBtnActive : {}),
                      }}
                      onClick={() => updateField('extractionMode', mode.value)}
                    >
                      {t(mode.key, { defaultValue: mode.label })}
                    </button>
                  ))}
                </div>

                {editingTrigger.extractionMode === 'llm' && (
                  <div style={styles.llmConfig}>
                    <div style={styles.field}>
                      <label style={styles.label}>{t('config:triggerPanel.extractionMode.instructions', { defaultValue: 'Extraction Instructions' })}</label>
                      <textarea
                        style={styles.textarea}
                        value={editingTrigger.llmExtract?.prompt || ''}
                        onChange={e => updateLlmExtract('prompt', e.target.value)}
                        placeholder={t('config:triggerPanel.extractionMode.instructionsPlaceholder', { defaultValue: 'Extract: release version, affected systems, urgency' })}
                        rows={3}
                      />
                    </div>
                    <div style={styles.field}>
                      <label style={styles.label}>{t('config:triggerPanel.extractionMode.variableNames', { defaultValue: 'Variable Names (comma-separated)' })}</label>
                      <input
                        style={styles.input}
                        value={editingTrigger.llmExtract?.variables?.join(', ') || ''}
                        onChange={e => updateLlmExtract('variables', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
                        placeholder="release_name, affected_systems, urgency"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Test Match */}
              {isEditing && (
                <div style={styles.section}>
                  <h4 style={styles.sectionTitle}>{t('config:triggerPanel.test.section', { defaultValue: 'Test Match' })}</h4>
                  <div style={styles.field}>
                    <label style={styles.label}>{t('config:triggerPanel.test.samplePayload', { defaultValue: 'Sample Event Payload (JSON)' })}</label>
                    <textarea
                      style={styles.textarea}
                      value={testPayload}
                      onChange={e => setTestPayload(e.target.value)}
                      rows={4}
                    />
                  </div>
                  <button
                    style={styles.testBtn}
                    onClick={handleTestMatch}
                    disabled={testing}
                  >
                    {testing
                      ? t('config:triggerPanel.test.testing', { defaultValue: 'Testing...' })
                      : t('config:triggerPanel.test.testMatch', { defaultValue: 'Test Match' })}
                  </button>

                  {testResult && (
                    <div style={styles.testResult}>
                      <div style={{
                        ...styles.testResultHeader,
                        color: testResult.wouldFire ? '#2ecc71' : '#e74c3c',
                      }}>
                        {testResult.wouldFire
                          ? t('config:triggerPanel.test.wouldFire', { defaultValue: 'WOULD FIRE' })
                          : t('config:triggerPanel.test.wouldNotFire', { defaultValue: 'WOULD NOT FIRE' })}
                      </div>
                      {testResult.structuralMatch !== undefined && (
                        <div>{t('config:triggerPanel.test.structural', { defaultValue: 'Structural: {{result}}', result: testResult.structuralMatch ? t('config:triggerPanel.test.match', { defaultValue: 'Match' }) : t('config:triggerPanel.test.noMatch', { defaultValue: 'No match' }) })}</div>
                      )}
                      {testResult.llmMatch && (
                        <div style={styles.llmResult}>
                          <div>{t('config:triggerPanel.test.llm', { defaultValue: 'LLM: {{result}}', result: testResult.llmMatch.match ? t('config:triggerPanel.test.match', { defaultValue: 'Match' }) : t('config:triggerPanel.test.noMatch', { defaultValue: 'No match' }) })}</div>
                          <div>{t('config:triggerPanel.test.confidence', { defaultValue: 'Confidence: {{value}}%', value: (testResult.llmMatch.confidence * 100).toFixed(0) })}</div>
                          <div>{t('config:triggerPanel.test.reason', { defaultValue: 'Reason: {{reason}}', reason: testResult.llmMatch.reason })}</div>
                          <div style={styles.llmMeta}>
                            {t('config:triggerPanel.test.llmMeta', {
                              defaultValue: 'Model: {{model}} | Tokens: {{num}} | Latency: {{ms}}ms',
                              model: testResult.llmMatch.model,
                              num: testResult.llmMatch.tokensUsed,
                              ms: testResult.llmMatch.durationMs,
                            })}
                          </div>
                        </div>
                      )}
                      {Object.keys(testResult.extractedVariables).length > 0 && (
                        <div>
                          <div style={styles.label}>{t('config:triggerPanel.test.extractedVariables', { defaultValue: 'Extracted Variables:' })}</div>
                          {Object.entries(testResult.extractedVariables).map(([k, v]) => (
                            <div key={k} style={styles.varRow}>
                              <code>{k}</code>: {v}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Fire History */}
              {isEditing && fireHistory.length > 0 && (
                <div style={styles.section}>
                  <h4 style={styles.sectionTitle}>{t('config:triggerPanel.history.section', { defaultValue: 'Recent Fires' })}</h4>
                  <div style={styles.historyList}>
                    {fireHistory.map((event, i) => {
                      const llmResult = event.llm_match_result
                        ? JSON.parse(event.llm_match_result) as LLMMatchResult
                        : null;
                      return (
                        <div key={event.id || i} style={styles.historyItem}>
                          <div style={styles.historyHeader}>
                            <span style={{
                              color: event.status === 'delivered' ? '#2ecc71' : event.status === 'failed' ? '#e74c3c' : '#f39c12',
                            }}>
                              {event.status}
                            </span>
                            <span>{new Date(event.fired_at).toLocaleString()}</span>
                            {event.duration_ms && <span>{event.duration_ms}ms</span>}
                          </div>
                          {event.error && (
                            <div style={{ color: '#e74c3c', fontSize: '12px' }}>{event.error}</div>
                          )}
                          {llmResult && (
                            <div style={styles.llmMeta}>
                              {t('config:triggerPanel.history.llmEntry', {
                                defaultValue: 'LLM: {{result}} ({{value}}%) - {{reason}}',
                                result: llmResult.match ? t('config:triggerPanel.history.match', { defaultValue: 'match' }) : t('config:triggerPanel.history.noMatch', { defaultValue: 'no match' }),
                                value: (llmResult.confidence * 100).toFixed(0),
                                reason: llmResult.reason,
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Save / Cancel */}
              <div style={styles.actions}>
                <button style={styles.cancelBtn} onClick={() => { setView('list'); setError(null); }}>
                  {t('common:buttons.cancel')}
                </button>
                <button
                  style={styles.saveBtn}
                  onClick={handleSave}
                  disabled={
                    loading
                    || !editingTrigger.name
                    || !editingTrigger.agentId
                    || (editingTrigger.type === 'cron'
                      && !!(editingTrigger as any).config?.runOnce
                      && !(editingTrigger as any).config?.runAt)
                    || (editingTrigger.type === 'bitbucket'
                      && (!(editingTrigger as any).config?.workspace
                        || !(editingTrigger as any).config?.repoSlug
                        || !((editingTrigger as any).config?.events?.length)))
                  }
                >
                  {loading
                    ? t('common:status.saving', { defaultValue: 'Saving...' })
                    : isEditing
                      ? t('config:triggerPanel.update', { defaultValue: 'Update' })
                      : t('common:buttons.create')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Styles ───

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  panel: {
    background: '#1e1e2e',
    borderRadius: '12px',
    width: '680px',
    maxHeight: '85vh',
    display: 'flex',
    flexDirection: 'column',
    color: '#cdd6f4',
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px',
    borderBottom: '1px solid #313244',
  },
  title: {
    margin: 0,
    fontSize: '18px',
    fontWeight: 600,
  },
  headerActions: {
    display: 'flex',
    gap: '8px',
  },
  content: {
    overflow: 'auto',
    padding: '16px 20px',
    flex: 1,
  },
  empty: {
    textAlign: 'center',
    padding: '40px',
    color: '#6c7086',
  },
  error: {
    background: '#45252a',
    color: '#f38ba8',
    padding: '8px 20px',
    fontSize: '13px',
  },
  tabBar: {
    display: 'flex',
    gap: '4px',
    marginBottom: '12px',
    paddingBottom: '8px',
    borderBottom: '1px solid #313244',
    flexWrap: 'wrap',
  },
  tab: {
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: '6px',
    padding: '6px 10px',
    color: '#a6adc8',
    cursor: 'pointer',
    fontSize: '12px',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    transition: 'background 0.12s, color 0.12s, border-color 0.12s',
  },
  tabActive: {
    background: '#1e3a5f',
    borderColor: '#89b4fa',
    color: '#cdd6f4',
  },
  tabIcon: {
    fontSize: '13px',
    lineHeight: 1,
  },
  tabLabel: {
    fontWeight: 500,
  },
  tabBadge: {
    background: '#313244',
    color: '#a6adc8',
    borderRadius: '10px',
    padding: '1px 7px',
    fontSize: '10px',
    fontWeight: 600,
    minWidth: '16px',
    textAlign: 'center' as const,
    lineHeight: '14px',
  },
  tabBadgeActive: {
    background: '#89b4fa',
    color: '#1e1e2e',
  },
  triggerCard: {
    background: '#181825',
    borderRadius: '8px',
    padding: '12px 16px',
    marginBottom: '8px',
    borderLeft: '3px solid',
    cursor: 'pointer',
    transition: 'background 0.15s',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontWeight: 500,
  },
  typeTag: {
    background: '#313244',
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: '11px',
    textTransform: 'uppercase' as const,
  },
  matchTag: {
    background: '#45475a',
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: '10px',
    color: '#a6e3a1',
  },
  cardActions: {
    display: 'flex',
    gap: '6px',
  },
  cardMeta: {
    display: 'flex',
    gap: '16px',
    marginTop: '8px',
    fontSize: '12px',
    color: '#6c7086',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    flex: 1,
  },
  row: {
    display: 'flex',
    gap: '12px',
  },
  label: {
    fontSize: '12px',
    color: '#a6adc8',
    fontWeight: 500,
  },
  input: {
    background: '#313244',
    border: '1px solid #45475a',
    borderRadius: '6px',
    padding: '8px 10px',
    color: '#cdd6f4',
    fontSize: '13px',
    outline: 'none',
  },
  select: {
    background: '#313244',
    border: '1px solid #45475a',
    borderRadius: '6px',
    padding: '8px 10px',
    color: '#cdd6f4',
    fontSize: '13px',
    outline: 'none',
  },
  textarea: {
    background: '#313244',
    border: '1px solid #45475a',
    borderRadius: '6px',
    padding: '8px 10px',
    color: '#cdd6f4',
    fontSize: '13px',
    outline: 'none',
    fontFamily: 'monospace',
    resize: 'vertical' as const,
  },
  section: {
    borderTop: '1px solid #313244',
    paddingTop: '12px',
  },
  sectionTitle: {
    margin: '0 0 8px',
    fontSize: '14px',
    fontWeight: 600,
    color: '#a6adc8',
  },
  modeSelector: {
    display: 'flex',
    gap: '8px',
    marginBottom: '8px',
  },
  modeBtn: {
    flex: 1,
    background: '#313244',
    border: '1px solid #45475a',
    borderRadius: '6px',
    padding: '8px',
    color: '#cdd6f4',
    cursor: 'pointer',
    textAlign: 'left' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
    fontSize: '12px',
  },
  modeBtnActive: {
    borderColor: '#89b4fa',
    background: '#1e3a5f',
  },
  modeDesc: {
    fontSize: '10px',
    color: '#6c7086',
  },
  llmConfig: {
    background: '#181825',
    borderRadius: '6px',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  webhookUrl: {
    marginTop: '8px',
  },
  inlineRow: {
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
  },
  checkboxGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '6px 12px',
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    color: '#cdd6f4',
    cursor: 'pointer',
  },
  checkboxCode: {
    fontSize: '10px',
    color: '#6c7086',
    background: 'transparent',
    padding: 0,
  },
  code: {
    background: '#313244',
    padding: '6px 10px',
    borderRadius: '4px',
    fontSize: '12px',
    display: 'block',
    wordBreak: 'break-all' as const,
    color: '#89b4fa',
  },
  nextFires: {
    marginTop: '8px',
  },
  nextFireItem: {
    fontSize: '12px',
    color: '#a6e3a1',
    padding: '2px 0',
  },
  testBtn: {
    background: '#89b4fa',
    border: 'none',
    borderRadius: '6px',
    padding: '8px 16px',
    color: '#1e1e2e',
    fontWeight: 600,
    cursor: 'pointer',
    fontSize: '13px',
  },
  testResult: {
    background: '#181825',
    borderRadius: '6px',
    padding: '12px',
    marginTop: '8px',
    fontSize: '13px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
  },
  testResultHeader: {
    fontWeight: 700,
    fontSize: '14px',
  },
  llmResult: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
  },
  llmMeta: {
    fontSize: '11px',
    color: '#6c7086',
    marginTop: '2px',
  },
  varRow: {
    fontSize: '12px',
    padding: '2px 0',
  },
  historyList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
    maxHeight: '200px',
    overflow: 'auto',
  },
  historyItem: {
    background: '#181825',
    borderRadius: '4px',
    padding: '8px 10px',
    fontSize: '12px',
  },
  historyHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    marginTop: '16px',
    paddingTop: '12px',
    borderTop: '1px solid #313244',
  },
  addBtn: {
    background: '#89b4fa',
    border: 'none',
    borderRadius: '6px',
    padding: '6px 14px',
    color: '#1e1e2e',
    fontWeight: 600,
    cursor: 'pointer',
    fontSize: '13px',
  },
  backBtn: {
    background: 'transparent',
    border: '1px solid #45475a',
    borderRadius: '6px',
    padding: '6px 14px',
    color: '#cdd6f4',
    cursor: 'pointer',
    fontSize: '13px',
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: '#6c7086',
    cursor: 'pointer',
    fontSize: '16px',
    padding: '4px 8px',
  },
  smallBtn: {
    background: 'transparent',
    border: '1px solid #45475a',
    borderRadius: '4px',
    padding: '3px 8px',
    color: '#cdd6f4',
    cursor: 'pointer',
    fontSize: '11px',
  },
  saveBtn: {
    background: '#a6e3a1',
    border: 'none',
    borderRadius: '6px',
    padding: '8px 20px',
    color: '#1e1e2e',
    fontWeight: 600,
    cursor: 'pointer',
    fontSize: '13px',
  },
  cancelBtn: {
    background: 'transparent',
    border: '1px solid #45475a',
    borderRadius: '6px',
    padding: '8px 20px',
    color: '#cdd6f4',
    cursor: 'pointer',
    fontSize: '13px',
  },
};

export default TriggerManagerPanel;
