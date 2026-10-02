/**
 * KeybindingsHelp - Help overlay for less-style navigation keybindings
 *
 * Displays a comprehensive list of available keybindings for file viewer navigation
 * Toggled with the ? key when file viewer is active
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';

export interface KeybindingsHelpProps {
  onClose: () => void;
}

type CategoryId = 'navigation' | 'wordMotion' | 'visualMode' | 'search' | 'help';

interface KeyBinding {
  id: string;
  keys: string[];
  description: string;
  category: CategoryId;
}

const CATEGORY_LABELS: Record<CategoryId, string> = {
  navigation: 'Navigation',
  wordMotion: 'Word Motion',
  visualMode: 'Visual Mode',
  search: 'Search',
  help: 'Help',
};

const KEYBINDINGS: KeyBinding[] = [
  // Navigation - Vertical
  { id: 'moveDown', keys: ['j', '↓'], description: 'Move cursor down one line', category: 'navigation' },
  { id: 'moveUp', keys: ['k', '↑'], description: 'Move cursor up one line', category: 'navigation' },
  { id: 'moveLeft', keys: ['h', '←'], description: 'Move cursor left', category: 'navigation' },
  { id: 'moveRight', keys: ['l', '→'], description: 'Move cursor right', category: 'navigation' },
  { id: 'jumpToStart', keys: ['0'], description: 'Jump to start of line', category: 'navigation' },
  { id: 'jumpToEnd', keys: ['$'], description: 'Jump to end of line', category: 'navigation' },
  { id: 'firstNonWhitespace', keys: ['^'], description: 'First non-whitespace char', category: 'navigation' },
  { id: 'halfPageDown', keys: ['d', 'Ctrl+D'], description: 'Half page down', category: 'navigation' },
  { id: 'halfPageUp', keys: ['u', 'Ctrl+U'], description: 'Half page up', category: 'navigation' },
  { id: 'fullPageDown', keys: ['f', 'Space'], description: 'Full page down', category: 'navigation' },
  { id: 'fullPageUp', keys: ['b', 'Page Up'], description: 'Full page up', category: 'navigation' },
  { id: 'jumpToTop', keys: ['g', 'Home'], description: 'Jump to top of file', category: 'navigation' },
  { id: 'jumpToBottom', keys: ['G', 'End'], description: 'Jump to bottom of file', category: 'navigation' },

  // Word motions
  { id: 'nextWordStart', keys: ['w'], description: 'Next word start', category: 'wordMotion' },
  { id: 'nextWordEnd', keys: ['e'], description: 'Next word end', category: 'wordMotion' },
  { id: 'previousWordStart', keys: ['b'], description: 'Previous word start', category: 'wordMotion' },

  // Visual mode
  { id: 'charVisualMode', keys: ['v'], description: 'Character visual mode', category: 'visualMode' },
  { id: 'lineVisualMode', keys: ['V'], description: 'Line visual mode', category: 'visualMode' },
  { id: 'yank', keys: ['y'], description: 'Yank (copy) selection', category: 'visualMode' },
  { id: 'exitVisualMode', keys: ['Escape'], description: 'Exit visual mode', category: 'visualMode' },

  // Search
  { id: 'openSearch', keys: ['/'], description: 'Open search bar', category: 'search' },
  { id: 'nextMatch', keys: ['n'], description: 'Next match', category: 'search' },
  { id: 'previousMatch', keys: ['N'], description: 'Previous match', category: 'search' },

  // Help
  { id: 'toggleHelp', keys: ['?'], description: 'Toggle this help overlay', category: 'help' },
  { id: 'exitCursorMode', keys: ['Escape'], description: 'Exit cursor mode (or visual/search)', category: 'help' },
  { id: 'closeViewerAlt', keys: ['Alt+E'], description: 'Close file viewer', category: 'help' },
  { id: 'closeViewer', keys: ['q'], description: 'Close file viewer', category: 'help' },
];

export const KeybindingsHelp: React.FC<KeybindingsHelpProps> = ({ onClose }) => {
  const { t } = useTranslation(['terminal']);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      // Close only if clicking the overlay itself, not the content
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    },
    [onClose]
  );

  const categorized = KEYBINDINGS.reduce(
    (acc, binding) => {
      if (!acc[binding.category]) {
        acc[binding.category] = [];
      }
      acc[binding.category].push(binding);
      return acc;
    },
    {} as Record<string, KeyBinding[]>
  );

  return (
    <div className="keybindings-help-overlay" onClick={handleOverlayClick} onKeyDown={handleKeyDown} tabIndex={0} role="dialog" aria-label={t('terminal:fileExplorer.keybindingsHelp')}>
      <div className="keybindings-help-content">
        <button className="keybindings-help-close" onClick={onClose} aria-label={t('terminal:fileExplorer.closeHelp')} title={t('terminal:fileExplorer.pressEscapeToClose')}>
          <Icon name="close" size={14} />
        </button>

        <h2 className="keybindings-help-title">{t('terminal:fileExplorer.keybindingsHelp')}</h2>
        <p className="keybindings-help-subtitle">{t('terminal:fileExplorer.keybindingsSubtitle')}</p>

        <div className="keybindings-help-categories">
          {Object.entries(categorized).map(([category, bindings]) => (
            <div key={category} className="keybindings-help-category">
              <h3 className="keybindings-help-category-title">{t(`terminal:fileExplorer.helpCategory.${category}`, { defaultValue: CATEGORY_LABELS[category as CategoryId] })}</h3>
              <div className="keybindings-help-list">
                {bindings.map((binding, idx) => (
                  <div key={idx} className="keybindings-help-item">
                    <div className="keybindings-help-keys">
                      {binding.keys.map((key, keyIdx) => (
                        <kbd key={keyIdx} className="keybindings-help-key">
                          {key}
                        </kbd>
                      ))}
                    </div>
                    <div className="keybindings-help-description">{t(`terminal:fileExplorer.help.${binding.id}`, { defaultValue: binding.description })}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="keybindings-help-footer">{t('terminal:fileExplorer.keybindingsFooter')}</p>
      </div>
    </div>
  );
};

KeybindingsHelp.displayName = 'KeybindingsHelp';
