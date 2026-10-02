import { getI18nInstance } from '../../utils/formatting';

export const RENAME_AGENT_REQUEST_MARKER = '[RENAME_AGENT_PROPOSALS_REQUEST]';

export interface RenameAgentRequestInfo {
  currentName?: string;
  agentClass?: string;
}

function readJsonValue(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^\\s*-\\s*${escaped}:\\s*(.+?)\\s*$`, 'mi'));
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return match[1].replace(/^['"]|['"]$/g, '').trim() || undefined;
  }
}

export function parseRenameAgentRequest(text: string | null | undefined): RenameAgentRequestInfo | null {
  const trimmed = text?.trim() ?? '';
  if (!trimmed.startsWith(RENAME_AGENT_REQUEST_MARKER)) return null;
  return {
    currentName: readJsonValue(trimmed, 'Nombre actual'),
    agentClass: readJsonValue(trimmed, 'Clase'),
  };
}

export function renameAgentRequestPreview(text: string | null | undefined): string | null {
  if (!parseRenameAgentRequest(text)) return null;
  const i18n = getI18nInstance();
  const t = i18n?.t?.bind(i18n);
  return t
    ? t('terminal:renameAgent.preview', { defaultValue: 'Rename Agent · Generating 3 AI name proposals…' })
    : 'Rename Agent · Generating 3 AI name proposals…';
}
