/**
 * TriggerManagerPanel 的常量(触发类型 / 类型页签 / Bitbucket 事件 / 匹配与抽取模式)。
 *
 * 自 TriggerManagerPanel.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { type TypeFilter } from './types';
import { type TriggerType, type MatchMode, type ExtractionMode } from '../../../shared/trigger-types';

export const TRIGGER_TYPES: { value: TriggerType; label: string }[] = [
  { value: 'webhook', label: 'Webhook' },
  { value: 'bitbucket', label: 'Bitbucket' },
  { value: 'cron', label: 'Cron' },
  { value: 'slack', label: 'Slack' },
  { value: 'email', label: 'Email' },
  { value: 'jira', label: 'Jira' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'wechat', label: 'WeChat' },
];

// `key` values are looked up with the English `label` as defaultValue, so
// the en output stays byte-identical while zh-CN gets a translation.
export const TYPE_TAB_DEFS: { value: TypeFilter; label: string; icon: string; key: string }[] = [
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

export const BITBUCKET_EVENT_OPTIONS: { value: string; label: string; key: string }[] = [
  { value: 'pullrequest:created', label: 'PR created', key: 'config:triggerPanel.bitbucketEvent.created' },
  { value: 'pullrequest:updated', label: 'PR updated', key: 'config:triggerPanel.bitbucketEvent.updated' },
  { value: 'pullrequest:approved', label: 'PR approved', key: 'config:triggerPanel.bitbucketEvent.approved' },
  { value: 'pullrequest:unapproved', label: 'PR unapproved', key: 'config:triggerPanel.bitbucketEvent.unapproved' },
  { value: 'pullrequest:fulfilled', label: 'PR merged', key: 'config:triggerPanel.bitbucketEvent.merged' },
  { value: 'pullrequest:rejected', label: 'PR declined', key: 'config:triggerPanel.bitbucketEvent.declined' },
  { value: 'pullrequest:comment_created', label: 'PR comment created', key: 'config:triggerPanel.bitbucketEvent.commentCreated' },
];

export const MATCH_MODES: { value: MatchMode; label: string; labelKey: string; desc: string; descKey: string }[] = [
  { value: 'structural', label: 'Structural', labelKey: 'config:triggerPanel.matchMode.structural.label', desc: 'Field-based matching (fast, free)', descKey: 'config:triggerPanel.matchMode.structural.desc' },
  { value: 'llm', label: 'LLM', labelKey: 'config:triggerPanel.matchMode.llm.label', desc: 'Semantic matching via LLM (flexible, costs tokens)', descKey: 'config:triggerPanel.matchMode.llm.desc' },
  { value: 'hybrid', label: 'Hybrid', labelKey: 'config:triggerPanel.matchMode.hybrid.label', desc: 'Structural pre-filter + LLM (recommended)', descKey: 'config:triggerPanel.matchMode.hybrid.desc' },
];

export const EXTRACTION_MODES: { value: ExtractionMode; label: string; key: string }[] = [
  { value: 'structural', label: 'Structural', key: 'config:triggerPanel.extractionMode.structural' },
  { value: 'llm', label: 'LLM', key: 'config:triggerPanel.extractionMode.llm' },
];
