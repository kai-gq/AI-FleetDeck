/**
 * The file viewer's answer to "this path is not on disk".
 *
 * Instead of "Tried N candidate locations", it says WHY (deleted from a folder
 * that still exists / the whole folder is gone), offers the obvious next steps
 * (open the folder, similarly named files, same-name files elsewhere in the
 * project) and shows any copy that can still be recovered: the git HEAD
 * version of a tracked file, or the last copy an agent conversation recorded
 * (a Read image, a Write body) — see server/services/file-recovery.ts.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiUrl, authFetch } from '../../utils/storage';
import { getI18nInstance } from '../../utils/formatting';
import { triggerBrowserDownload } from '../../utils/file-download';
import { ZoomableImage } from './ZoomableImage';

export interface MissingFileDiagnosis {
  kind: 'deleted' | 'folder-missing';
  parentDir: string;
  nearestExistingDir: string | null;
  similar: Array<{ name: string; path: string; size: number }>;
  git?: { repoRoot: string; relPath: string; inHead: boolean };
}

export interface MissingFileSuggestion {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

type RecoveredCopy =
  | { source: 'git-head' | 'conversation'; kind: 'text'; content: string; detail: string; timestamp?: string; incomplete?: boolean }
  | { source: 'git-head' | 'conversation'; kind: 'image'; mediaType: string; dataB64: string; detail: string; timestamp?: string };

interface MissingFileViewProps {
  requested: string;
  diagnosis?: MissingFileDiagnosis;
  /** How many fallback locations the server probed (shown only as a footnote). */
  triedCount: number;
  /** Same-name files found elsewhere in the project. */
  suggestions: MissingFileSuggestion[];
  searchRoot?: string;
  onNavigate: (path: string) => void;
  formatFileSize: (bytes: number) => string;
}

const TEXT_PREVIEW_MAX_LINES = 5000;

function formatWhen(timestamp?: string): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Translate a `terminal:` key outside React (module-level helpers). The
 * English default keeps en output byte-identical; before i18n init the
 * `{{vars}}` are interpolated by hand so callers never see raw placeholders. */
function tr(key: string, defaultValue: string, vars?: Record<string, unknown>): string {
  const i18n = getI18nInstance();
  const t = i18n?.t?.bind(i18n);
  if (t) return t(`terminal:${key}`, { defaultValue, ...vars });
  if (!vars) return defaultValue;
  return defaultValue.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

function copyLabel(copy: RecoveredCopy): string {
  if (copy.source === 'git-head') return tr('missingFile.gitHead', 'Git HEAD');
  const when = formatWhen(copy.timestamp);
  return when
    ? tr('missingFile.conversationLabelWithWhen', 'Conversation · {{detail}} · {{when}}', { detail: copy.detail, when })
    : tr('missingFile.conversationLabel', 'Conversation · {{detail}}', { detail: copy.detail });
}

function copyExplanation(copy: RecoveredCopy): string {
  if (copy.source === 'git-head') return tr('missingFile.explainGitHead', 'The version committed at HEAD. Uncommitted changes made before the deletion are not included.');
  if (copy.kind === 'image') {
    return tr('missingFile.explainImage', 'The image as the agent saw it when it read the file. It may have been resized or re-encoded, so it is not always byte-identical to the original.');
  }
  if (copy.incomplete) {
    return tr('missingFile.explainIncomplete', 'Rebuilt from what the agent wrote, but some later edits could not be replayed, so the file may have changed after this.');
  }
  return copy.detail.startsWith('Write')
    ? tr('missingFile.explainFromWrite', 'Rebuilt from the content the agent wrote (plus its later edits). Changes made outside the conversation are not included.')
    : tr('missingFile.explainFromRead', 'The full file as the agent read it. Later changes made outside the conversation are not included.');
}

export function MissingFileView({
  requested,
  diagnosis,
  triedCount,
  suggestions,
  searchRoot,
  onNavigate,
  formatFileSize,
}: MissingFileViewProps) {
  const { t } = useTranslation(['terminal']);
  const [recovery, setRecovery] = useState<{ status: 'loading' | 'done' | 'error'; copies: RecoveredCopy[] }>({ status: 'loading', copies: [] });
  const [selected, setSelected] = useState(0);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  useEffect(() => {
    let cancelled = false;
    setRecovery({ status: 'loading', copies: [] });
    setSelected(0);
    const baseDir = searchRoot ? `&baseDir=${encodeURIComponent(searchRoot)}` : '';
    authFetch(apiUrl(`/api/files/recover?path=${encodeURIComponent(requested)}${baseDir}`))
      .then(async (res) => {
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        setRecovery({ status: 'done', copies: Array.isArray(data.copies) ? data.copies : [] });
      })
      .catch(() => {
        if (!cancelled) setRecovery({ status: 'error', copies: [] });
      });
    return () => { cancelled = true; };
  }, [requested, searchRoot]);

  const copy = recovery.copies[selected] ?? null;
  const filename = requested.split('/').pop() || requested;
  const folderTarget = diagnosis?.nearestExistingDir ?? null;

  const textLines = useMemo(() => {
    if (!copy || copy.kind !== 'text') return null;
    const lines = copy.content.split('\n');
    return { shown: lines.slice(0, TEXT_PREVIEW_MAX_LINES).join('\n'), total: lines.length };
  }, [copy]);

  const imageSrc = copy && copy.kind === 'image' ? `data:${copy.mediaType};base64,${copy.dataB64}` : null;

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(requested);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    } finally {
      window.setTimeout(() => setCopyStatus('idle'), 1500);
    }
  };

  const handleDownloadCopy = () => {
    if (!copy) return;
    const blob = copy.kind === 'image'
      ? new Blob([Uint8Array.from(atob(copy.dataB64), (ch) => ch.charCodeAt(0))], { type: copy.mediaType })
      : new Blob([copy.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    // A conversation image may have been re-encoded (png → jpeg): name it by what it is.
    let name = filename;
    if (copy.kind === 'image') {
      const ext = copy.mediaType === 'image/jpeg' ? '.jpg' : `.${copy.mediaType.split('/')[1] || 'png'}`;
      if (!name.toLowerCase().endsWith(ext)) name = `${name.replace(/\.[^.]+$/, '')}${ext}`;
    }
    triggerBrowserDownload(url, name, true);
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const headline = !diagnosis
    ? t('terminal:missingFile.headlineNotFound', { defaultValue: 'File not found' })
    : diagnosis.kind === 'deleted'
      ? t('terminal:missingFile.headlineDeleted', { defaultValue: 'This file no longer exists' })
      : t('terminal:missingFile.headlineFolderGone', { defaultValue: 'This file’s folder no longer exists' });
  const explanation = !diagnosis
    ? t('terminal:missingFile.explanationNothingMatched', { defaultValue: 'Nothing matched this path.' })
    : diagnosis.kind === 'deleted'
      ? t('terminal:missingFile.explanationDeleted', { defaultValue: 'It was deleted or renamed after it was referenced. Its folder is still there.' })
      : t('terminal:missingFile.explanationFolderGone', { defaultValue: 'The folder {{dir}} was removed, moved or renamed.', dir: diagnosis.parentDir });

  const similar = diagnosis?.similar ?? [];
  const similarPaths = new Set(similar.map((entry) => entry.path));
  const elsewhere = suggestions.filter((entry) => entry.path !== requested && !similarPaths.has(entry.path));

  return (
    <div className="file-viewer-missing">
      <div className="file-viewer-missing-summary">
        <div className="file-viewer-missing-headline">{headline}</div>
        <div className="file-viewer-missing-path">{requested}</div>
        <div className="file-viewer-missing-explanation">
          {explanation}
          {diagnosis?.git && (
            <span className="file-viewer-missing-git">
              {diagnosis.git.inHead
                ? ' ' + t('terminal:missingFile.gitTracked', { defaultValue: 'It is tracked in git ({{path}}), so the committed version is recoverable.', path: diagnosis.git.relPath })
                : ' ' + t('terminal:missingFile.gitUntracked', { defaultValue: 'It is inside a git repository but was never committed.' })}
            </span>
          )}
        </div>
        <div className="file-viewer-missing-actions">
          {folderTarget && (
            <button type="button" className="file-viewer-copy-html-btn" onClick={() => onNavigate(folderTarget)}>
              {folderTarget === diagnosis?.parentDir
                ? t('terminal:missingFile.openFolder', { defaultValue: 'Open folder' })
                : t('terminal:missingFile.openClosestFolder', { defaultValue: 'Open closest existing folder' })}
            </button>
          )}
          <button type="button" className={`file-viewer-copy-html-btn ${copyStatus}`} onClick={handleCopyPath}>
            {copyStatus === 'copied'
              ? t('terminal:missingFile.copied', { defaultValue: 'Copied' })
              : copyStatus === 'error'
                ? t('terminal:missingFile.copyFailed', { defaultValue: 'Copy failed' })
                : t('terminal:missingFile.copyPath', { defaultValue: 'Copy path' })}
          </button>
          {copy && (
            <button type="button" className="file-viewer-copy-html-btn" onClick={handleDownloadCopy}>
              {t('terminal:missingFile.downloadRecoveredCopy', { defaultValue: 'Download recovered copy' })}
            </button>
          )}
        </div>
      </div>

      <div className="file-viewer-missing-recovery">
        {recovery.status === 'loading' && (
          <div className="file-viewer-missing-note">{t('terminal:missingFile.searching', { defaultValue: 'Looking for a saved copy in git and the agent conversations…' })}</div>
        )}
        {recovery.status === 'error' && (
          <div className="file-viewer-missing-note">{t('terminal:missingFile.searchFailed', { defaultValue: 'Couldn’t search for a saved copy.' })}</div>
        )}
        {recovery.status === 'done' && recovery.copies.length === 0 && (
          <div className="file-viewer-missing-note">{t('terminal:missingFile.noSavedCopy', { defaultValue: 'No saved copy found in git or in the agent conversations.' })}</div>
        )}
        {copy && (
          <>
            <div className="file-viewer-missing-recovery-header">
              <span className="file-viewer-missing-recovery-badge">{t('terminal:missingFile.recoveredCopy', { defaultValue: 'Recovered copy' })}</span>
              {recovery.copies.length > 1 ? (
                <span className="file-viewer-missing-tabs" role="tablist">
                  {recovery.copies.map((entry, index) => (
                    <button
                      key={`${entry.source}-${index}`}
                      type="button"
                      role="tab"
                      aria-selected={index === selected}
                      className={`file-viewer-missing-tab${index === selected ? ' is-active' : ''}`}
                      onClick={() => setSelected(index)}
                    >
                      {copyLabel(entry)}
                    </button>
                  ))}
                </span>
              ) : (
                <span className="file-viewer-missing-recovery-source">{copyLabel(copy)}</span>
              )}
            </div>
            <div className="file-viewer-missing-note">{copyExplanation(copy)}</div>
            {imageSrc && (
              <div className="file-viewer-image-wrapper zoomable file-viewer-missing-image">
                <ZoomableImage src={imageSrc} alt={t('terminal:missingFile.recoveredAlt', { defaultValue: 'Recovered {{filename}}', filename })} />
              </div>
            )}
            {textLines && (
              <pre className="file-viewer-missing-text">
                <code>{textLines.shown}</code>
                {textLines.total > TEXT_PREVIEW_MAX_LINES && (
                  <div className="file-viewer-missing-note">
                    {t('terminal:missingFile.firstLines', { defaultValue: 'Showing the first {{shown}} of {{total}} lines. Download the copy for the rest.', shown: TEXT_PREVIEW_MAX_LINES, total: textLines.total })}
                  </div>
                )}
              </pre>
            )}
          </>
        )}
      </div>

      {(similar.length > 0 || elsewhere.length > 0) && (
        <div className="file-viewer-resolve-results file-viewer-missing-suggestions">
          {similar.length > 0 && (
            <>
              <div className="file-viewer-resolve-header">{t('terminal:missingFile.similarHeader', { defaultValue: 'Similar files in the same folder:' })}</div>
              <div className="file-viewer-resolve-list">
                {similar.map((entry) => (
                  <button key={entry.path} type="button" className="file-viewer-resolve-item" onClick={() => onNavigate(entry.path)}>
                    <span className="file-viewer-resolve-icon">{'📄'}</span>
                    <span className="file-viewer-resolve-info">
                      <span className="file-viewer-resolve-name">{entry.name}</span>
                      <span className="file-viewer-resolve-path">{entry.path}</span>
                    </span>
                    {entry.size > 0 && <span className="file-viewer-resolve-size">{formatFileSize(entry.size)}</span>}
                  </button>
                ))}
              </div>
            </>
          )}
          {elsewhere.length > 0 && (
            <>
              <div className="file-viewer-resolve-header">{t('terminal:missingFile.elsewhereHeader', { defaultValue: 'Files named {{filename}} elsewhere in the project:', filename })}</div>
              <div className="file-viewer-resolve-list">
                {elsewhere.map((entry) => (
                  <button key={entry.path} type="button" className="file-viewer-resolve-item" onClick={() => onNavigate(entry.path)}>
                    <span className="file-viewer-resolve-icon">{entry.isDirectory ? '📁' : '📄'}</span>
                    <span className="file-viewer-resolve-info">
                      <span className="file-viewer-resolve-name">{entry.name}</span>
                      <span className="file-viewer-resolve-path">{entry.path}</span>
                    </span>
                    {!entry.isDirectory && entry.size > 0 && <span className="file-viewer-resolve-size">{formatFileSize(entry.size)}</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {triedCount > 0 && (
        <div className="file-viewer-missing-footnote">
          {triedCount === 1
            ? t('terminal:missingFile.alsoSearchedOne', { defaultValue: 'Also searched {{n}} other location in case it had moved.', n: triedCount })
            : t('terminal:missingFile.alsoSearchedMany', { defaultValue: 'Also searched {{n}} other locations in case it had moved.', n: triedCount })}
        </div>
      )}
    </div>
  );
}
