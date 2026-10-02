import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchSystemPrompt, updateSystemPrompt, clearSystemPrompt } from '../../api/system-settings';
import '../styles/system-prompt-section.scss';
import { Icon } from '../Icon';
import { ConfirmModal } from '../shared/ConfirmModal';

interface SystemPromptSectionProps {
  searchQuery?: string;
}

export const SystemPromptSection: React.FC<SystemPromptSectionProps> = ({ searchQuery = '' }) => {
  const { t } = useTranslation(['config', 'common']);
  const [prompt, setPrompt] = useState('');
  const [originalPrompt, setOriginalPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  // Load system prompt on mount
  useEffect(() => {
    loadSystemPrompt();
  }, []);

  const loadSystemPrompt = async () => {
    try {
      setLoading(true);
      setError(null);
      const content = await fetchSystemPrompt();
      setPrompt(content);
      setOriginalPrompt(content);
      setIsDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('config:systemPromptSection.loadFailed', { defaultValue: 'Failed to load system prompt' }));
    } finally {
      setLoading(false);
    }
  };

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newPrompt = e.target.value;
    setPrompt(newPrompt);
    setIsDirty(newPrompt !== originalPrompt);
    setError(null);
    setSuccess(null);
  };

  const handleSave = async () => {
    try {
      setError(null);
      setSuccess(null);
      await updateSystemPrompt(prompt);
      setOriginalPrompt(prompt);
      setIsDirty(false);
      setSuccess(t('config:systemPromptSection.saved', { defaultValue: 'System prompt saved successfully. It will apply to all new agent sessions.' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('config:systemPromptSection.saveFailed', { defaultValue: 'Failed to save system prompt' }));
    }
  };

  const handleClear = () => {
    setClearConfirmOpen(true);
  };

  const performClear = async () => {
    try {
      setError(null);
      setSuccess(null);
      await clearSystemPrompt();
      setPrompt('');
      setOriginalPrompt('');
      setIsDirty(false);
      setSuccess(t('config:systemPromptSection.cleared', { defaultValue: 'System prompt cleared successfully.' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('config:systemPromptSection.clearFailed', { defaultValue: 'Failed to clear system prompt' }));
    }
  };

  const handleReset = () => {
    setPrompt(originalPrompt);
    setIsDirty(false);
    setError(null);
    setSuccess(null);
  };

  // Filter based on search query
  if (searchQuery && !'system prompt'.includes(searchQuery.toLowerCase())) {
    return null;
  }

  return (
    <div className="system-prompt-section">
      <div className="section-header">
        <h3>{t('config:systemPrompt.title')}</h3>
        <p className="section-description">
          {t('config:systemPromptSection.description', { defaultValue: 'Add global instructions that will apply to all agents. This appears after Tide Commander base rules but before agent-specific instructions.' })}
        </p>
      </div>

      {loading ? (
        <div className="loading">{t('config:systemPromptSection.loading', { defaultValue: 'Loading system prompt...' })}</div>
      ) : (
        <div className="section-content">
          {error && (
            <div className="alert alert-error">
              <span className="alert-icon"><Icon name="warn" size={14} /></span>
              {error}
            </div>
          )}

          {success && (
            <div className="alert alert-success">
              <span className="alert-icon"><Icon name="check" size={14} /></span>
              {success}
            </div>
          )}

          <div className="editor-wrapper">
            <div className="editor-info">
              <span className="char-count">
                {prompt.length} {t('config:systemPrompt.characters')}
              </span>
            </div>

            <textarea
              className="prompt-editor"
              value={prompt}
              onChange={handlePromptChange}
              placeholder={t('config:systemPromptSection.placeholder', { defaultValue: 'Enter your global system prompt here...\n\nExamples:\n- Coding style guidelines\n- Team communication rules\n- Project-wide conventions\n- Security best practices' })}
              rows={12}
            />

            <div className="editor-hint">
              {t('config:systemPromptSection.hint', { defaultValue: 'This prompt will be inserted into the system instructions for all agents.' })}
            </div>
          </div>

          <div className="button-group">
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={!isDirty || loading}
            >
              {t('config:systemPrompt.save')}
            </button>

            <button
              className="btn btn-secondary"
              onClick={handleReset}
              disabled={!isDirty || loading}
            >
              {t('config:systemPrompt.reset')}
            </button>

            <button
              className="btn btn-danger"
              onClick={handleClear}
              disabled={!prompt || loading}
            >
              {t('config:systemPrompt.clear')}
            </button>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={clearConfirmOpen}
        title={t('config:systemPromptSection.clearTitle', { defaultValue: 'Clear System Prompt' })}
        message={t('config:systemPromptSection.clearConfirm', { defaultValue: 'Are you sure you want to clear the system prompt?' })}
        confirmLabel={t('common:buttons.clear')}
        cancelLabel={t('common:buttons.cancel')}
        variant="danger"
        onConfirm={() => { void performClear(); }}
        onClose={() => setClearConfirmOpen(false)}
      />
    </div>
  );
};
