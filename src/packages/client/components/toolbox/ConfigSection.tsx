import React, { useState, useEffect, useRef } from 'react'; // settings + scene config panel
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useSettings, store, useCustomAgentClassesArray } from '../../store';
import { getBackendUrls, setBackendUrls, subscribeBackendUrlChange, STORAGE_KEYS, setStorageString, getStorageString, getAuthToken } from '../../utils/storage';
import {
  playNotificationSound,
  playQuestionSound,
  playCompletionSound,
  previewTone,
  refreshCustomSounds,
  setCustomSounds,
  getCustomSounds,
  MAX_NOTIFICATION_SOUND_VOLUME,
} from '../../utils/notificationSounds';
import type { SoundKind } from '../../utils/notificationSounds';
import { NOTIFICATION_TONES, CUSTOM_TONE_ID, DEFAULT_TONES, getTone, isToneSilent } from '../../utils/notificationTones';
import { apiUrl, authFetch } from '../../utils/storage';
import { VOICE_PERSONAS, PERSONA_CUSTOM_ID, PERSONA_CUSTOM_MAX } from '../../../shared/voice-personas';

/** The notification events a user can override with their own audio file. */
const SOUND_EVENT_ROWS: Array<{
  kind: SoundKind;
  label: string;
  /** Exactly when this fires — shown under the name so the UI is self-explanatory. */
  when: string;
  sound: string;
  /** Settings field holding the tone chosen for this event. */
  settingKey: 'toneQuestion' | 'toneNotification' | 'toneCompletion';
  play: (level: number) => void;
}> = [
  {
    kind: 'question',
    settingKey: 'toneQuestion',
    label: 'Agent asks you something',
    when: 'A question, a plan to approve, or a permission request. Repeats twice up front, then every 10s until you answer (stops after 2 min).',
    sound: 'Two taps, then a rising bend',
    play: playQuestionSound,
  },
  {
    kind: 'notification',
    settingKey: 'toneNotification',
    label: 'Agent sends a notification',
    when: 'Any agent notification: task complete, error, or a heads-up.',
    sound: 'Soft two-note chime',
    play: playNotificationSound,
  },
  {
    kind: 'completion',
    settingKey: 'toneCompletion',
    label: 'Agent finishes working',
    when: 'An agent stops working and goes idle.',
    sound: 'Gentle descending arpeggio',
    play: playCompletionSound,
  },
];
import { BUILT_IN_AGENT_CLASSES } from '../../../shared/agent-types';
import { reconnect } from '../../websocket';
import { CollapsibleSection } from './CollapsibleSection';
import { ConfigRelationNote } from './ConfigRelationNote';
import { VoiceCompanionSection } from './VoiceCompanionSection';
import { SecretsSection } from './SecretsSection';
import { DataSection } from './DataSection';
import { DefaultAgentSkillsSection } from './DefaultAgentSkillsSection';
import { AboutSection, ThemeSelector } from './AboutSection';
import { IntegrationStatusPanel } from './IntegrationStatusPanel';
import { ClaudeCredentialsPanel } from '../ClaudeCredentialsPanel';
import { ProviderCredentialsPanel } from '../ProviderCredentialsPanel';
import { SystemPromptModal } from '../SystemPromptModal';
import { AGENT_DOCK_POSITIONS, AGENT_DOCK_POSITION_LABELS, setAgentDockPosition, useAgentDockPosition, setAgentDockRecentSize, useAgentDockRecentSize } from '../ClaudeOutputPanel/agentDockPosition';
import { WhatsAppConfigModal } from '../WhatsAppConfigModal';
import { WhatsAppNotificationsModal } from '../WhatsAppNotificationsModal';
import { WhatsAppHistoryPanel } from '../WhatsAppHistory/WhatsAppHistoryPanel';
import { WhatsAppHubModal } from '../WhatsAppHub/WhatsAppHubModal';
import { fetchEchoPromptSetting, updateEchoPromptSetting, fetchCodexBinaryPath, updateCodexBinaryPath, fetchTmuxModeSetting, updateTmuxModeSetting, fetchInteractiveModeSetting, updateInteractiveModeSetting, fetchCodexAppServerModeSetting, updateCodexAppServerModeSetting, fetchOpencodeServerModeSetting, updateOpencodeServerModeSetting, fetchPiRpcModeSetting, updatePiRpcModeSetting } from '../../api/system-settings';
import { BUILTIN_AGENT_NAMES } from '../../scene/config';
import { DEFAULT_FILE_SEARCH_EXCLUDE_DIRS, isValidExcludeDirName } from '../../../shared/file-search';
import { Icon } from '../Icon';
import { searchSettingsSections } from './settingsSearch';
import { loadWhisperCloudConfig, saveWhisperCloudConfig, DEFAULT_WHISPER_CLOUD_CONFIG } from '../../api/whisperCloud';
import type { WhisperCloudConfig, SttEngineMode } from '../../api/whisperCloud';
import { loadTtsVoices, saveTtsVoices, sanitizeTuning, DEFAULT_TTS_VOICES, TTS_VOICE_OPTIONS, TTS_AUDITION_SAMPLES, TTS_LANG_LABELS } from '../../api/ttsVoice';
import type { TtsVoiceConfig, TtsLang } from '../../api/ttsVoice';
import type {
  SceneConfig,
  TerrainConfig,
  ModelStyleConfig,
  AnimationConfig,
  TimeMode,
  FloorStyle,
  AnimationType,
  ColorMode,
} from './types';
// LastPrompt and ClaudeOutput types are used elsewhere in the codebase

interface ConfigSectionProps {
  config: SceneConfig;
  onChange: (config: SceneConfig) => void;
  searchQuery?: string;
  onOpenIntegrationsModal?: (integrationId?: string) => void;
  onOpenPluginsModal?: () => void;
  onOpenMonitoringModal?: () => void;
  onOpenStatisticsModal?: () => void;
  onOpenWorkflowEditor?: () => void;
  onOpenTriggerManager?: () => void;
  /** 节间互跳时用于清空搜索(目标节可能被过滤掉;未传则只展开不滚动清搜索)。 */
  onSearchQueryChange?: (query: string) => void;
}

const TIME_MODE_OPTIONS: { value: TimeMode; label: string; icon: string }[] = [
  { value: 'auto', label: 'Auto', icon: '🕐' },
  { value: 'dawn', label: 'Dawn', icon: '🌅' },
  { value: 'day', label: 'Day', icon: '☀️' },
  { value: 'dusk', label: 'Dusk', icon: '🌇' },
  { value: 'night', label: 'Night', icon: '🌙' },
];

const FLOOR_STYLE_OPTIONS: { value: FloorStyle; label: string; icon: string }[] = [
  { value: 'none', label: 'Grass', icon: '🌱' },
  { value: 'concrete', label: 'Concrete', icon: '🏗️' },
  { value: 'galactic', label: 'Galactic', icon: '🌌' },
  { value: 'metal', label: 'Metal', icon: '⚙️' },
  { value: 'hex', label: 'Hex', icon: '⬡' },
  { value: 'circuit', label: 'Circuit', icon: '🔌' },
  { value: 'pokemon-stadium', label: 'Pokemon', icon: '🔴' },
];

const ANIMATION_OPTIONS: { value: AnimationType; label: string; icon: string }[] = [
  { value: 'static', label: 'Static', icon: '🧍' },
  { value: 'idle', label: 'Idle', icon: '🚶' },
  { value: 'walk', label: 'Walk', icon: '🚶‍♂️' },
  { value: 'sprint', label: 'Sprint', icon: '🏃' },
  { value: 'jump', label: 'Jump', icon: '⬆️' },
  { value: 'fall', label: 'Fall', icon: '⬇️' },
  { value: 'crouch', label: 'Crouch', icon: '🧎' },
  { value: 'sit', label: 'Sit', icon: '🪑' },
  { value: 'die', label: 'Die', icon: '💀' },
  { value: 'emote-yes', label: 'Yes', icon: '👍' },
  { value: 'emote-no', label: 'No', icon: '👎' },
];

// Color mode options for agent models
const COLOR_MODE_OPTIONS: { value: ColorMode; label: string; icon: string }[] = [
  { value: 'normal', label: 'Normal', icon: '🎨' },
  { value: 'bw', label: 'B&W', icon: '⬛' },
  { value: 'sepia', label: 'Sepia', icon: '🟤' },
  { value: 'cool', label: 'Cool', icon: '❄️' },
  { value: 'warm', label: 'Warm', icon: '🔥' },
  { value: 'neon', label: 'Neon', icon: '💜' },
];

// Terrain toggle options for icon-only display
const TERRAIN_OPTIONS: { key: keyof TerrainConfig; icon: string; label: string }[] = [
  { key: 'showTrees', icon: '🌳', label: 'Trees' },
  { key: 'showBushes', icon: '🌿', label: 'Bushes' },
  { key: 'showHouse', icon: '🏠', label: 'House' },
  { key: 'showLamps', icon: '💡', label: 'Lamps' },
  { key: 'showGrass', icon: '🟩', label: 'Grass' },
  { key: 'showClouds', icon: '☁️', label: 'Clouds' },
];

// Sky color presets
const SKY_COLOR_OPTIONS: { value: string | null; label: string; color: string }[] = [
  { value: null, label: 'Auto', color: 'linear-gradient(135deg, #4a90d9 0%, #0a1a2a 100%)' },
  { value: '#4a90d9', label: 'Day Blue', color: '#4a90d9' },
  { value: '#0a1a2a', label: 'Night', color: '#0a1a2a' },
  { value: '#ff6b35', label: 'Sunset', color: '#ff6b35' },
  { value: '#1a0a2e', label: 'Purple', color: '#1a0a2e' },
  { value: '#2d5a27', label: 'Matrix', color: '#2d5a27' },
  { value: '#8b0000', label: 'Blood', color: '#8b0000' },
  { value: '#000000', label: 'Void', color: '#000000' },
];

// Maps for translating option values to locale keys
const TERRAIN_KEY_MAP: Record<string, string> = {
  showTrees: 'trees', showBushes: 'bushes', showHouse: 'house',
  showLamps: 'lamps', showGrass: 'grass', showClouds: 'clouds',
};
const FLOOR_KEY_MAP: Record<string, string> = { none: 'grass', 'pokemon-stadium': 'pokemon' };
const ANIM_KEY_MAP: Record<string, string> = { 'emote-yes': 'yes', 'emote-no': 'no' };
const SKY_KEY_MAP: Record<string, string> = {
  '': 'auto', '#4a90d9': 'dayBlue', '#0a1a2a': 'night', '#ff6b35': 'sunset',
  '#1a0a2e': 'purple', '#2d5a27': 'matrix', '#8b0000': 'blood', '#000000': 'void',
};
// Built-in agent class id -> existing display-name key (tools:skills.class*)
const AGENT_CLASS_KEY_MAP: Record<string, string> = {
  scout: 'classScout', builder: 'classBuilder', debugger: 'classDebugger',
  architect: 'classArchitect', warrior: 'classWarrior', support: 'classSupport', boss: 'classBoss',
};

// Compact toggle switch for config rows
function Toggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="config-toggle">
      <input
        type="checkbox"
        className="config-toggle-input"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="config-toggle-track">
        <span className="config-toggle-thumb" />
      </span>
    </label>
  );
}

// Compact chip selector for options
function ChipSelector<T extends string>({
  options,
  value,
  onChange,
  iconOnly = false,
}: {
  options: { value: T; label: string; icon: string }[];
  value: T;
  onChange: (value: T) => void;
  iconOnly?: boolean;
}) {
  return (
    <div className="chip-selector">
      {options.map((opt) => (
        <button
          key={opt.value}
          className={`chip ${value === opt.value ? 'active' : ''}`}
          onClick={() => onChange(opt.value)}
          title={opt.label}
        >
          <span className="chip-icon">{opt.icon}</span>
          {!iconOnly && <span className="chip-label">{opt.label}</span>}
        </button>
      ))}
    </div>
  );
}

// Highlight matching text in labels
function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);

  if (index === -1) return <>{text}</>;

  const before = text.slice(0, index);
  const match = text.slice(index, index + query.length);
  const after = text.slice(index + query.length);

  return (
    <>
      {before}
      <mark className="search-highlight">{match}</mark>
      {after}
    </>
  );
}

const LANGUAGE_OPTIONS: { value: string; label: string; icon: string }[] = [
  { value: 'auto', label: 'Auto', icon: '🌐' },
  { value: 'en', label: 'English', icon: '🇺🇸' },
  { value: 'zh-CN', label: '中文', icon: '🇨🇳' },
  { value: 'es', label: 'Español', icon: '🇪🇸' },
  { value: 'hi', label: 'हिन्दी', icon: '🇮🇳' },
  { value: 'pt', label: 'Português', icon: '🇧🇷' },
  { value: 'ru', label: 'Русский', icon: '🇷🇺' },
  { value: 'ja', label: '日本語', icon: '🇯🇵' },
  { value: 'de', label: 'Deutsch', icon: '🇩🇪' },
  { value: 'fr', label: 'Français', icon: '🇫🇷' },
  { value: 'it', label: 'Italiano', icon: '🇮🇹' },
];

export function ConfigSection({ config, onChange, searchQuery = '', onOpenIntegrationsModal, onOpenPluginsModal, onOpenMonitoringModal, onOpenStatisticsModal, onOpenWorkflowEditor, onOpenTriggerManager, onSearchQueryChange }: ConfigSectionProps) {
  const { t } = useTranslation(['config', 'common', 'tools']);
  const settings = useSettings();
  const customClasses = useCustomAgentClassesArray();
  const [defaultSpawnClass, setDefaultSpawnClassState] = useState(() => getStorageString(STORAGE_KEYS.DEFAULT_AGENT_CLASS) || 'scout');
  const agentDockPosition = useAgentDockPosition();
  const agentDockRecentSize = useAgentDockRecentSize();
  const [customSounds, setCustomSoundsState] = useState<Partial<Record<SoundKind, string | null>>>(() => getCustomSounds());
  const [uploadingSound, setUploadingSound] = useState<SoundKind | null>(null);
  const [soundUploadError, setSoundUploadError] = useState<string | null>(null);
  const [newExcludeDir, setNewExcludeDir] = useState('');

  // Custom sounds live server-side, so pull the current map when settings open.
  useEffect(() => {
    void refreshCustomSounds().then(setCustomSoundsState);
  }, []);

  const handleSoundUpload = async (kind: SoundKind, file: File) => {
    setSoundUploadError(null);
    setUploadingSound(kind);
    try {
      const res = await authFetch(apiUrl(`/api/custom-sounds/${kind}`), {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'audio/mpeg' },
        body: file,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: t('config:soundUpload.uploadFailed', { defaultValue: 'Upload failed ({{status}})', status: res.status }) }));
        throw new Error(data.error || t('config:soundUpload.uploadFailed', { defaultValue: 'Upload failed ({{status}})', status: res.status }));
      }
      const map = await refreshCustomSounds();
      setCustomSoundsState({ ...map });
      // Uploading is also a choice: point this event at the file, so the tone
      // dropdown and what you actually hear never disagree.
      const uploaded = SOUND_EVENT_ROWS.find(r => r.kind === kind);
      if (uploaded) store.updateSettings({ [uploaded.settingKey]: CUSTOM_TONE_ID });
      // Play it back straight away so the choice is confirmed by ear.
      void previewTone(CUSTOM_TONE_ID, settings.notificationSoundVolume, kind);
    } catch (err) {
      setSoundUploadError(err instanceof Error ? err.message : t('config:soundUpload.uploadFailedGeneric', { defaultValue: 'Upload failed' }));
    } finally {
      setUploadingSound(null);
    }
  };

  const handleSoundReset = async (kind: SoundKind) => {
    setSoundUploadError(null);
    try {
      await authFetch(apiUrl(`/api/custom-sounds/${kind}`), { method: 'DELETE' });
      setCustomSounds({ [kind]: null });
      const map = await refreshCustomSounds();
      setCustomSoundsState({ ...map });
      // The file is gone — send the event back to its built-in cue unless the
      // user had already picked a bundled tone for it.
      const cleared = SOUND_EVENT_ROWS.find(r => r.kind === kind);
      if (cleared && store.getSettings()[cleared.settingKey] === CUSTOM_TONE_ID) {
        store.updateSettings({ [cleared.settingKey]: DEFAULT_TONES[kind] });
      }
    } catch (err) {
      setSoundUploadError(err instanceof Error ? err.message : t('config:soundUpload.resetFailed', { defaultValue: 'Failed to reset sound' }));
    }
  };

  const [historyLimit, setHistoryLimit] = useState(settings.historyLimit);
  const [backendUrls, setBackendUrlsState] = useState<string[]>(() => getBackendUrls());
  const [backendUrlsDirty, setBackendUrlsDirty] = useState(false);
  const [newBackendUrl, setNewBackendUrl] = useState('');
  const [authToken, setAuthToken] = useState(() => getAuthToken());
  const [authTokenDirty, setAuthTokenDirty] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [isSystemPromptModalOpen, setIsSystemPromptModalOpen] = useState(false);
  const [isWhatsAppModalOpen, setIsWhatsAppModalOpen] = useState(false);
  const [isWhatsAppNotificationsModalOpen, setIsWhatsAppNotificationsModalOpen] = useState(false);
  const [isWhatsAppHistoryOpen, setIsWhatsAppHistoryOpen] = useState(false);
  const [isWhatsAppHubOpen, setIsWhatsAppHubOpen] = useState(false);
  const [codexBinaryPath, setCodexBinaryPathState] = useState('');
  const [codexBinaryPathDirty, setCodexBinaryPathDirty] = useState(false);
  const [sttConfig, setSttConfig] = useState<WhisperCloudConfig>(DEFAULT_WHISPER_CLOUD_CONFIG);
  const [sttDirty, setSttDirty] = useState(false);
  const [sttLoaded, setSttLoaded] = useState(false);
  const [sttSaving, setSttSaving] = useState(false);
  const [sttSaved, setSttSaved] = useState(false);
  const [sttError, setSttError] = useState<string | null>(null);
  const [showSttKey, setShowSttKey] = useState(false);
  const [ttsVoices, setTtsVoices] = useState<TtsVoiceConfig>(DEFAULT_TTS_VOICES);
  const [ttsVoicesExist, setTtsVoicesExist] = useState(false);
  const [ttsDirty, setTtsDirty] = useState(false);
  // 语速/音量输入框的原始文本(允许编辑中的 "-"/"+" 等中间态,保存时归一化)
  const [ttsRateInput, setTtsRateInput] = useState('0');
  const [ttsVolumeInput, setTtsVolumeInput] = useState('0');
  const [ttsLoaded, setTtsLoaded] = useState(false);
  const [ttsSaving, setTtsSaving] = useState(false);
  const [ttsSaved, setTtsSaved] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [ttsAuditioning, setTtsAuditioning] = useState<TtsLang | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // Load codex binary path from server on mount
  useEffect(() => {
    fetchCodexBinaryPath().then(setCodexBinaryPathState).catch(() => {});
  }, []);

  // Load STT cloud-channel config (tools/whisper/cloud.json) on mount
  useEffect(() => {
    loadWhisperCloudConfig()
      .then(({ config }) => {
        setSttConfig(config);
        setSttDirty(false);
      })
      .catch((err) => {
        setSttError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSttLoaded(true));
  }, []);

  // Load TTS voice config (tools/edge-tts/voices.local.json) on mount
  useEffect(() => {
    loadTtsVoices()
      .then(({ config, exists }) => {
        setTtsVoices(config);
        setTtsRateInput(String(config.rate));
        setTtsVolumeInput(String(config.volume));
        setTtsVoicesExist(exists);
        setTtsDirty(false);
      })
      .catch((err) => {
        setTtsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setTtsLoaded(true));
  }, []);

  // Sync echo prompt setting from server on mount
  useEffect(() => {
    fetchEchoPromptSetting().then((enabled) => {
      if (enabled !== settings.experimentalEchoPrompt) {
        store.updateSettings({ experimentalEchoPrompt: enabled });
      }
    }).catch(() => { /* ignore fetch errors on mount */ });
  }, []);

  // Sync tmux mode setting from server on mount
  useEffect(() => {
    fetchTmuxModeSetting().then((enabled) => {
      if (enabled !== settings.tmuxMode) {
        store.updateSettings({ tmuxMode: enabled });
      }
    }).catch(() => { /* ignore fetch errors on mount */ });
  }, []);

  // Sync experimental interactive-TUI mode setting from server on mount
  useEffect(() => {
    fetchInteractiveModeSetting().then((enabled) => {
      if (enabled !== settings.interactiveMode) {
        store.updateSettings({ interactiveMode: enabled });
      }
    }).catch(() => { /* ignore fetch errors on mount */ });
  }, []);

  // Sync experimental Codex app-server (streaming) mode setting from server on mount
  useEffect(() => {
    fetchCodexAppServerModeSetting().then((enabled) => {
      if (enabled !== settings.codexAppServerMode) {
        store.updateSettings({ codexAppServerMode: enabled });
      }
    }).catch(() => { /* ignore fetch errors on mount */ });
  }, []);

  // Sync experimental OpenCode server (streaming) mode setting from server on mount
  useEffect(() => {
    fetchOpencodeServerModeSetting().then((enabled) => {
      if (enabled !== settings.opencodeServerMode) {
        store.updateSettings({ opencodeServerMode: enabled });
      }
    }).catch(() => { /* ignore fetch errors on mount */ });
  }, []);

  // Sync Pi RPC (mid-turn steering) mode setting from server on mount
  useEffect(() => {
    fetchPiRpcModeSetting().then((enabled) => {
      if (enabled !== settings.piRpcMode) {
        store.updateSettings({ piRpcMode: enabled });
      }
    }).catch(() => { /* ignore fetch errors on mount */ });
  }, []);

  useEffect(() => {
    return subscribeBackendUrlChange((nextUrls) => {
      setBackendUrlsState(nextUrls);
      setBackendUrlsDirty(false);
    });
  }, []);

  // Translate option arrays at render time
  const tTimeOpts = TIME_MODE_OPTIONS.map(opt => ({ ...opt, label: t(`config:time.${opt.value}`) }));
  const tFloorOpts = FLOOR_STYLE_OPTIONS.map(opt => ({ ...opt, label: t(`config:floor.${FLOOR_KEY_MAP[opt.value] || opt.value}`) }));
  const tAnimOpts = ANIMATION_OPTIONS.map(opt => ({ ...opt, label: t(`config:animation.${ANIM_KEY_MAP[opt.value] || opt.value}`) }));
  const tColorModeOpts = COLOR_MODE_OPTIONS.map(opt => ({ ...opt, label: t(`config:colorMode.${opt.value}`) }));
  const tTerrainOpts = TERRAIN_OPTIONS.map(opt => ({ ...opt, label: t(`config:terrain.${TERRAIN_KEY_MAP[opt.key]}`) }));
  const tSkyOpts = SKY_COLOR_OPTIONS.map(opt => ({ ...opt, label: t(`config:sky.${SKY_KEY_MAP[opt.value ?? '']}`) }));

  // Filter through the shared Settings/Spotlight index.
  const matchingSections = searchQuery.trim()
    ? searchSettingsSections(searchQuery).map((section) => section.id)
    : null; // null means show all

  const shouldShowSection = (sectionId: string) => {
    if (!matchingSections) return true;
    return matchingSections.includes(sectionId);
  };


  const customAgentNames = settings.customAgentNames || [];
  const effectiveNames = customAgentNames.length > 0 ? customAgentNames : BUILTIN_AGENT_NAMES;

  const handleAddAgentName = () => {
    const trimmedName = newAgentName.trim();
    if (trimmedName && !customAgentNames.includes(trimmedName)) {
      store.updateSettings({ customAgentNames: [...customAgentNames, trimmedName] });
      setNewAgentName('');
    }
  };

  const handleRemoveAgentName = (name: string) => {
    store.updateSettings({ customAgentNames: customAgentNames.filter(n => n !== name) });
  };

  const handleResetToDefaults = () => {
    store.updateSettings({ customAgentNames: [] });
  };

  const fileSearchExcludeDirs = settings.fileSearchExcludeDirs ?? [...DEFAULT_FILE_SEARCH_EXCLUDE_DIRS];

  const handleAddExcludeDir = () => {
    const name = newExcludeDir.trim();
    if (!isValidExcludeDirName(name)) return;
    if (fileSearchExcludeDirs.includes(name)) {
      setNewExcludeDir('');
      return;
    }
    store.updateSettings({ fileSearchExcludeDirs: [...fileSearchExcludeDirs, name] });
    setNewExcludeDir('');
  };

  const handleRemoveExcludeDir = (name: string) => {
    store.updateSettings({ fileSearchExcludeDirs: fileSearchExcludeDirs.filter((d) => d !== name) });
  };

  const handleResetExcludeDirs = () => {
    store.updateSettings({ fileSearchExcludeDirs: [...DEFAULT_FILE_SEARCH_EXCLUDE_DIRS] });
  };

  const handleAddBackendUrl = () => {
    const trimmed = newBackendUrl.trim();
    if (!trimmed) return;
    if (backendUrls.includes(trimmed)) {
      setNewBackendUrl('');
      return;
    }
    setBackendUrlsState([...backendUrls, trimmed]);
    setBackendUrlsDirty(true);
    setNewBackendUrl('');
  };

  const handleRemoveBackendUrl = (index: number) => {
    setBackendUrlsState(backendUrls.filter((_, i) => i !== index));
    setBackendUrlsDirty(true);
  };

  const handleMoveBackendUrl = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= backendUrls.length) return;
    const next = backendUrls.slice();
    [next[index], next[target]] = [next[target], next[index]];
    setBackendUrlsState(next);
    setBackendUrlsDirty(true);
  };

  const handleBackendUrlsSave = () => {
    setBackendUrls(backendUrls);
    setBackendUrlsDirty(false);
    reconnect();
  };

  const handleAuthTokenChange = (value: string) => {
    setAuthToken(value);
    setAuthTokenDirty(true);
  };

  const handleAuthTokenSave = () => {
    setStorageString(STORAGE_KEYS.AUTH_TOKEN, authToken);
    setAuthTokenDirty(false);
    reconnect();
  };

  const handleCodexBinaryPathChange = (value: string) => {
    setCodexBinaryPathState(value);
    setCodexBinaryPathDirty(true);
  };

  const handleCodexBinaryPathSave = () => {
    updateCodexBinaryPath(codexBinaryPath).catch(() => {});
    setCodexBinaryPathDirty(false);
  };

  const handleSttModeChange = (mode: SttEngineMode) => {
    setSttConfig((c) => ({ ...c, mode }));
    setSttDirty(true);
    setSttError(null);
  };

  const handleSttApiKeyChange = (value: string) => {
    setSttConfig((c) => ({ ...c, apiKey: value }));
    setSttDirty(true);
    setSttError(null);
  };

  const handleSttSave = () => {
    setSttSaving(true);
    setSttError(null);
    saveWhisperCloudConfig(sttConfig)
      .then(() => {
        setSttDirty(false);
        setSttSaved(true);
        window.setTimeout(() => setSttSaved(false), 3000);
      })
      .catch((err) => setSttError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSttSaving(false));
  };

  const handleTtsVoiceChange = (lang: TtsLang, value: string) => {
    setTtsVoices((c) => ({ ...c, [lang]: value }));
    setTtsDirty(true);
    setTtsError(null);
  };

  // 语速/音量(-100..100 百分数,0 = 默认):与音色同一份配置一起保存/试听。
  // 输入框保留原始文本(便于输入负号),配置里存解析后的数值(非法/空 → 0)。
  const handleTtsTuningChange = (field: 'rate' | 'volume', raw: string) => {
    if (field === 'rate') setTtsRateInput(raw); else setTtsVolumeInput(raw);
    setTtsVoices((c) => ({ ...c, [field]: sanitizeTuning(raw, 0) }));
    setTtsDirty(true);
    setTtsError(null);
  };

  // 返回是否保存成功(试听前先保存,失败则中止)
  const handleTtsSave = async (): Promise<boolean> => {
    setTtsSaving(true);
    setTtsError(null);
    try {
      await saveTtsVoices(ttsVoices);
      // 保存后把输入框归一化为实际落盘值(非法中间态如 "-" 会显示为 0)
      setTtsRateInput(String(ttsVoices.rate));
      setTtsVolumeInput(String(ttsVoices.volume));
      setTtsDirty(false);
      setTtsVoicesExist(true);
      setTtsSaved(true);
      window.setTimeout(() => setTtsSaved(false), 3000);
      return true;
    } catch (err) {
      setTtsError(`${t('config:tts.saveFailed', { defaultValue: '保存失败' })}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      setTtsSaving(false);
    }
  };

  const handleTtsAudition = async (lang: TtsLang) => {
    if (ttsDirty && !(await handleTtsSave())) return;
    // 停掉上一段试听
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }
    setTtsAuditioning(lang);
    setTtsError(null);
    try {
      const res = await authFetch(apiUrl('/api/tts/speak'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: TTS_AUDITION_SAMPLES[lang], lang, rate: ttsVoices.rate, volume: ttsVoices.volume }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      ttsAudioRef.current = audio;
      const finish = () => {
        if (ttsAudioRef.current === audio) ttsAudioRef.current = null;
        URL.revokeObjectURL(url);
        setTtsAuditioning((cur) => (cur === lang ? null : cur));
      };
      audio.onended = finish;
      audio.onerror = finish;
      await audio.play();
    } catch (err) {
      ttsAudioRef.current = null;
      setTtsAuditioning(null);
      setTtsError(`${t('config:tts.auditionFailed', { defaultValue: '试听失败' })}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const updateTerrain = (updates: Partial<TerrainConfig>) => {
    onChange({ ...config, terrain: { ...config.terrain, ...updates } });
  };

  const updateModelStyle = (updates: Partial<ModelStyleConfig>) => {
    onChange({ ...config, modelStyle: { ...config.modelStyle, ...updates } });
  };

  const updateAnimations = (updates: Partial<AnimationConfig>) => {
    onChange({ ...config, animations: { ...config.animations, ...updates } });
  };

  const handleHistoryLimitChange = (value: number) => {
    setHistoryLimit(value);
    store.updateSettings({ historyLimit: value });
  };

  const toggleTerrain = (key: keyof TerrainConfig) => {
    const currentValue = config.terrain[key];
    if (typeof currentValue === 'boolean') {
      updateTerrain({ [key]: !currentValue });
    }
  };

  const isSearching = searchQuery.trim().length > 0;

  // ---- 节间互跳(关系说明条的「去 XX」):展开目标节 + 滚动定位 ----
  const [expandSignals, setExpandSignals] = useState<Record<string, number>>({});
  const pendingScrollRef = useRef<string | null>(null);

  const requestSectionJump = (target: string) => {
    if (isSearching) onSearchQueryChange?.(''); // 目标可能被搜索过滤掉,先清搜索
    pendingScrollRef.current = target;
    setExpandSignals((prev) => ({ ...prev, [target]: (prev[target] ?? 0) + 1 }));
  };

  useEffect(() => {
    const target = pendingScrollRef.current;
    if (!target) return;
    pendingScrollRef.current = null;
    // 等展开/清搜索后的 DOM 落地再滚动
    const raf = window.requestAnimationFrame(() => {
      document.getElementById(`config-section-${target}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [expandSignals]);

  return (
    <>
    <div className="config-section">
      {matchingSections && matchingSections.length === 0 && (
        <div className="config-no-results">
          {t('config:noResults', { query: searchQuery })}
        </div>
      )}

      {shouldShowSection('plugins') && (
      <CollapsibleSection title={t('config:sections.plugins', { defaultValue: 'Plugins' })} storageKey="plugins" defaultOpen={true} forceOpen={isSearching && shouldShowSection('plugins')}>
        <div className="config-row config-row--plugins">
          <span className="config-label"><HighlightText text={t('config:plugins.description', { defaultValue: 'Install, enable, and disable trusted local UI plugins' })} query={searchQuery} /></span>
          <button className="config-button" onClick={() => onOpenPluginsModal?.()}>
            {t('config:plugins.manage', { defaultValue: 'Manage Plugins' })}
          </button>
        </div>
      </CollapsibleSection>
      )}

      {shouldShowSection('general') && (
      <CollapsibleSection title={t('config:sections.general')} storageKey="general" defaultOpen={true} forceOpen={isSearching && shouldShowSection('general')}>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:general.history')} query={searchQuery} /></span>
          <input type="number" className="config-input config-input-sm" value={historyLimit} onChange={(e) => handleHistoryLimitChange(parseInt(e.target.value) || 100)} min={50} max={2000} step={50} />
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:general.hideCosts')} query={searchQuery} /></span>
          <Toggle checked={settings.hideCost} onChange={(checked) => store.updateSettings({ hideCost: checked })} />
        </div>
        <div className="config-row">
          <span
            className="config-label"
            title={t('config:general.streamTextLiveTitle')}
          >
            <HighlightText text={t('config:general.streamTextLive')} query={searchQuery} />
          </span>
          <Toggle
            checked={settings.streamTextLive !== false}
            onChange={(checked) => store.updateSettings({ streamTextLive: checked })}
          />
        </div>
        <div className="config-row">
          <span
            className="config-label"
            title={t('config:general.toolHoverPreviewTitle')}
          >
            <HighlightText text={t('config:general.toolHoverPreview')} query={searchQuery} />
          </span>
          <Toggle
            checked={settings.toolHoverPreview === true}
            onChange={(checked) => store.updateSettings({ toolHoverPreview: checked })}
          />
        </div>
        <div className="config-row">
          <span className="config-label" title={t('config:general.agentDockTitle', { defaultValue: 'Where the strip of recently-active and currently-working agent thumbnails sits.' })}><HighlightText text={t('config:general.agentDock', { defaultValue: 'Agent activity dock' })} query={searchQuery} /></span>
          <select
            className="config-select"
            value={agentDockPosition}
            onChange={(e) => setAgentDockPosition(e.target.value as typeof agentDockPosition)}
          >
            {AGENT_DOCK_POSITIONS.map((position) => (
              <option key={position} value={position}>{t(`config:agentDock.${position}`, { defaultValue: AGENT_DOCK_POSITION_LABELS[position] })}</option>
            ))}
          </select>
        </div>
        {agentDockPosition !== 'hidden' && (
          <div className="config-row">
            <span className="config-label" title={t('config:general.recentAgentsDockTitle', { defaultValue: 'How many recently-active agents the dock shows alongside the ones working right now. 0 shows only working agents.' })}><HighlightText text={t('config:general.recentAgentsDock', { defaultValue: 'Recent agents in dock' })} query={searchQuery} /></span>
            <input
              type="number"
              className="config-input config-input-sm"
              value={agentDockRecentSize}
              min={0}
              max={20}
              step={1}
              onChange={(e) => setAgentDockRecentSize(parseInt(e.target.value, 10) || 0)}
            />
          </div>
        )}
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:general.grid')} query={searchQuery} /></span>
          <Toggle checked={config.gridVisible} onChange={(checked) => onChange({ ...config, gridVisible: checked })} />
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:general.showFPS')} query={searchQuery} /></span>
          <Toggle checked={settings.showFPS} onChange={(checked) => store.updateSettings({ showFPS: checked })} />
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:general.fpsLimit')} query={searchQuery} /></span>
          <input type="range" className="config-slider" min="0" max="120" step="10" value={config.fpsLimit} onChange={(e) => onChange({ ...config, fpsLimit: parseInt(e.target.value) })} />
          <span className="config-value">{config.fpsLimit === 0 ? '∞' : config.fpsLimit}</span>
        </div>
        <div className="config-row">
          <span className="config-label" title={t('config:general.powerSavingTitle', { defaultValue: 'Experimental: Reduce FPS when idle to save power' })}><HighlightText text={t('config:general.powerSaving')} query={searchQuery} /> <Icon name="bolt" size={12} /></span>
          <Toggle checked={settings.powerSaving} onChange={(checked) => store.updateSettings({ powerSaving: checked })} />
        </div>
        <div className="config-row">
          <span className="config-label" title={t('config:general.lowPowerModeTitle', { defaultValue: 'Battery saver for mobile: caps scene FPS (20 active / 5 idle), freezes decorative animations and disables word-by-word streaming. Off = normal mode.' })}><HighlightText text={t('config:general.lowPowerMode')} query={searchQuery} /> <Icon name="bolt" size={12} /></span>
          <Toggle checked={settings.lowPowerMode === true} onChange={(checked) => store.updateSettings({ lowPowerMode: checked })} />
        </div>
        <div className="config-row">
          <span className="config-label" title={t('config:general.tmuxModeTitle', { defaultValue: 'Wrap agent processes in tmux sessions so they survive server restarts (requires tmux installed)' })}><HighlightText text={t('config:general.tmuxMode')} query={searchQuery} /></span>
          <Toggle checked={settings.tmuxMode} onChange={async (checked) => {
            store.updateSettings({ tmuxMode: checked });
            try {
              await updateTmuxModeSetting(checked);
            } catch (err) {
              console.error('Failed to sync tmux mode setting to server:', err);
            }
          }} />
        </div>
        <div className="config-row">
          <span className="config-label" title={t('config:general.interactiveModeTitle', { defaultValue: 'Experimental: run Claude agents as the real interactive `claude` TUI inside tmux, reconstructing the conversation from the session transcript (requires tmux). Takes effect on server restart.' })}><HighlightText text={t('config:general.interactiveMode')} query={searchQuery} /> <Icon name="bolt" size={12} /></span>
          <Toggle checked={settings.interactiveMode} onChange={async (checked) => {
            store.updateSettings({ interactiveMode: checked });
            try {
              await updateInteractiveModeSetting(checked);
            } catch (err) {
              console.error('Failed to sync interactive mode setting to server:', err);
            }
          }} />
        </div>
        <div className="config-row">
          <span className="config-label" title={t('config:general.codexAppServerModeTitle', { defaultValue: 'Experimental: run Codex agents through a persistent `codex app-server` so replies stream word-by-word (token deltas) instead of appearing as one block. The app-server runs detached and survives commander restarts — in-flight turns keep running and reconnect automatically. Applies to new Codex turns; no server restart needed to toggle.' })}><HighlightText text={t('config:general.codexAppServerMode')} query={searchQuery} /> <Icon name="bolt" size={12} /></span>
          <Toggle checked={settings.codexAppServerMode} onChange={async (checked) => {
            store.updateSettings({ codexAppServerMode: checked });
            try {
              await updateCodexAppServerModeSetting(checked);
            } catch (err) {
              console.error('Failed to sync codex app-server mode setting to server:', err);
            }
          }} />
        </div>
        <div className="config-row">
          <span className="config-label" title={t('config:general.opencodeServerModeTitle', { defaultValue: 'Experimental: run OpenCode agents through a persistent, detached `opencode serve` HTTP server so replies stream word-by-word (token deltas over SSE) instead of appearing as one block. The server survives commander restarts — in-flight turns keep running and reconnect automatically. Applies to new OpenCode turns; no server restart needed to toggle.' })}><HighlightText text={t('config:general.opencodeServerMode')} query={searchQuery} /> <Icon name="bolt" size={12} /></span>
          <Toggle checked={settings.opencodeServerMode} onChange={async (checked) => {
            store.updateSettings({ opencodeServerMode: checked });
            try {
              await updateOpencodeServerModeSetting(checked);
            } catch (err) {
              console.error('Failed to sync opencode server mode setting to server:', err);
            }
          }} />
        </div>
        <div className="config-row">
          <span className="config-label" title={t('config:general.piRpcModeTitle', { defaultValue: 'Run Pi agents through a persistent `pi --mode rpc` process per agent. Messages sent mid-turn STEER the live run (delivered after the current tool round, before the next model call) instead of queueing until the turn ends. With tmux mode enabled, live RPC turns survive Commander restarts and reconnect automatically; otherwise sessions resume on the next message. Applies to new Pi turns; no server restart needed to toggle.' })}><HighlightText text={t('config:general.piRpcMode')} query={searchQuery} /> <Icon name="bolt" size={12} /></span>
          <Toggle checked={settings.piRpcMode} onChange={async (checked) => {
            store.updateSettings({ piRpcMode: checked });
            try {
              await updatePiRpcModeSetting(checked);
            } catch (err) {
              console.error('Failed to sync pi RPC mode setting to server:', err);
            }
          }} />
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:general.vibrationIntensity')} query={searchQuery} /></span>
          <input type="range" className="config-slider" min="0" max="5" step="1" value={settings.vibrationIntensity} onChange={(e) => store.updateSettings({ vibrationIntensity: parseInt(e.target.value) })} />
          <span className="config-value">
            {settings.vibrationIntensity === 0
              ? t('config:vibrationValues.off')
              : settings.vibrationIntensity === 1
                ? t('config:vibrationValues.ultraLight')
                : settings.vibrationIntensity === 2
                  ? t('config:vibrationValues.veryLight')
                  : settings.vibrationIntensity === 3
                    ? t('config:vibrationValues.light')
                    : settings.vibrationIntensity === 4
                      ? t('config:vibrationValues.medium')
                      : t('config:vibrationValues.heavy')}
          </span>
        </div>
        <div className="config-row">
          <span className="config-label" title={t('config:general.notificationSoundsTitle', { defaultValue: 'Play pleasant sounds: a chime for agent notifications, a distinctive rising cue when an agent asks you a question (repeats until answered), and a resolving cue when an agent finishes its work.' })}><HighlightText text={t('config:general.notificationSounds', { defaultValue: 'Notification sounds' })} query={searchQuery} /></span>
          <Toggle checked={settings.notificationSoundEnabled} onChange={(checked) => {
            store.updateSettings({ notificationSoundEnabled: checked });
            if (checked) playNotificationSound(settings.notificationSoundVolume, settings.toneNotification);
          }} />
        </div>
        {settings.notificationSoundEnabled && (
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:general.notificationSoundVolume', { defaultValue: 'Notification sound volume' })} query={searchQuery} /></span>
          <input type="range" className="config-slider" min="0" max={MAX_NOTIFICATION_SOUND_VOLUME} step="1" value={settings.notificationSoundVolume} onChange={(e) => {
            const v = parseInt(e.target.value);
            store.updateSettings({ notificationSoundVolume: v });
            playQuestionSound(v, settings.toneQuestion); // preview the headline cue while tuning
          }} />
          <span className="config-value">{settings.notificationSoundVolume === 0 ? t('config:vibrationValues.off') : `${settings.notificationSoundVolume}/${MAX_NOTIFICATION_SOUND_VOLUME}`}</span>
        </div>
        )}
        {settings.notificationSoundEnabled && settings.notificationSoundVolume > 0 && (
        <div className="config-group">
          <span className="config-label"><HighlightText text={t('config:sounds.perEvent', { defaultValue: 'Sounds per event' })} query={searchQuery} /></span>
          <div className="config-sound-hint">
            {t('config:sounds.perEventHint', { defaultValue: 'Pick a tone for each event — or upload your own file (mp3, wav, ogg, m4a — max 5MB), which is stored on the commander so every device hears it. "None" silences that event.' })}
          </div>
          {SOUND_EVENT_ROWS.map(row => {
            const hasCustom = !!customSounds[row.kind];
            const toneId = settings[row.settingKey];
            const usingCustom = hasCustom && toneId === CUSTOM_TONE_ID;
            return (
            <div className="config-sound-row" key={row.kind}>
              <div className="config-sound-info">
                <div className="config-sound-head">
                  <span className="config-sound-name">{t(`config:sounds.${row.kind}.label`, { defaultValue: row.label })}</span>
                  <span className={`config-sound-badge${usingCustom ? ' custom' : ''}`}>
                    {usingCustom
                      ? t('config:sounds.customBadge', { defaultValue: 'Your file' })
                      : getTone(toneId)
                        ? t(`config:tones.${toneId}`, { defaultValue: getTone(toneId)!.label })
                        : t(`config:sounds.${row.kind}.sound`, { defaultValue: row.sound })}
                  </span>
                </div>
                <div className="config-sound-when">{t(`config:sounds.${row.kind}.when`, { defaultValue: row.when })}</div>
              </div>
              <div className="config-sound-actions">
                <select
                  className="config-select"
                  value={toneId}
                  onChange={(e) => {
                    const nextTone = e.target.value;
                    store.updateSettings({ [row.settingKey]: nextTone });
                    void previewTone(nextTone, settings.notificationSoundVolume, row.kind);
                  }}
                >
                  {hasCustom && <option value={CUSTOM_TONE_ID}>{t('config:sounds.customOption', { defaultValue: 'Your uploaded file' })}</option>}
                  {NOTIFICATION_TONES.map((tone) => (
                    <option key={tone.id} value={tone.id}>{t(`config:tones.${tone.id}`, { defaultValue: tone.label })}</option>
                  ))}
                </select>
                <button
                  className="config-btn config-btn-sm"
                  onClick={() => void previewTone(toneId, settings.notificationSoundVolume, row.kind)}
                  disabled={isToneSilent(toneId)}
                  title={isToneSilent(toneId) ? t('config:sounds.previewSilenced', { defaultValue: 'This event is silenced — pick a tone to hear it' }) : t('config:sounds.previewHint', { defaultValue: 'Hear the sound that plays for this event' })}
                >
                  ▶
                </button>
                <label className="config-btn config-btn-sm config-sound-upload" title={t('config:sounds.uploadTitle', { defaultValue: 'Replace this sound with your own audio file (mp3, wav, ogg, m4a — max 5MB)' })}>
                  {uploadingSound === row.kind ? t('config:sounds.uploading', { defaultValue: 'Uploading…' }) : t('common:buttons.upload', { defaultValue: 'Upload' })}
                  <input
                    type="file"
                    accept="audio/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = ''; // allow re-picking the same file
                      if (file) void handleSoundUpload(row.kind, file);
                    }}
                  />
                </label>
                {hasCustom && (
                  <button
                    className="config-btn config-btn-sm"
                    onClick={() => void handleSoundReset(row.kind)}
                    title={t('config:sounds.resetTitle', { defaultValue: 'Delete your file and go back to a built-in tone' })}
                  >
                    {t('common:buttons.reset', { defaultValue: 'Reset' })}
                  </button>
                )}
              </div>
            </div>
            );
          })}
          {soundUploadError && <div className="config-sound-error">{soundUploadError}</div>}
        </div>
        )}
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:general.externalEditor')} query={searchQuery} /></span>
          <input type="text" className="config-input" placeholder={t('config:general.externalEditorPlaceholder')} value={settings.externalEditorCommand || ''} onChange={(e) => store.updateSettings({ externalEditorCommand: e.target.value })} />
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:general.tabTitle')} query={searchQuery} /></span>
          <input type="text" className="config-input" placeholder={t('config:general.tabTitlePlaceholder')} value={settings.tabTitle || ''} onChange={(e) => store.updateSettings({ tabTitle: e.target.value })} />
        </div>
        <div className="agent-names-section">
          <span className="config-label"><HighlightText text={t('config:general.fileSearchExcludeDirs')} query={searchQuery} /></span>
          <span className="config-hint">{t('config:general.fileSearchExcludeDirsHint')}</span>
          <div className="agent-names-input-row">
            <input
              type="text"
              className="config-input config-input-full"
              placeholder={t('config:general.fileSearchExcludeDirsPlaceholder')}
              value={newExcludeDir}
              onChange={(e) => setNewExcludeDir(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { handleAddExcludeDir(); } }}
            />
            <button className="config-btn config-btn-sm" onClick={handleAddExcludeDir} disabled={!isValidExcludeDirName(newExcludeDir)} title={t('config:general.fileSearchExcludeDirsAdd')}>+</button>
          </div>
          <div className="agent-names-list">
            {fileSearchExcludeDirs.map((name) => (
              <div key={name} className="agent-name-chip">
                <span className="agent-name-text">{name}</span>
                <button className="agent-name-remove" onClick={() => handleRemoveExcludeDir(name)} title={t('common:buttons.remove')}>x</button>
              </div>
            ))}
          </div>
          <button className="config-btn config-btn-link" onClick={handleResetExcludeDirs}>{t('config:general.fileSearchExcludeDirsReset')}</button>
        </div>
        <div className="config-group">
          <span className="config-label"><HighlightText text={t('config:general.language')} query={searchQuery} /></span>
          <ChipSelector options={LANGUAGE_OPTIONS.map(o => o.value === 'auto' ? { ...o, label: t('config:language.auto', { defaultValue: 'Auto' }) } : o)} value={localStorage.getItem('tide-commander-language-mode') === 'manual' ? (LANGUAGE_OPTIONS.find(o => o.value !== 'auto' && i18n.language.startsWith(o.value.split('-')[0]))?.value || 'en') : 'auto'} onChange={(lang) => {
            if (lang === 'auto') {
              localStorage.setItem('tide-commander-language-mode', 'auto');
              const navLang = navigator.language;
              const detected = LANGUAGE_OPTIONS.find(o => o.value !== 'auto' && navLang.startsWith(o.value.split('-')[0]))?.value || 'en';
              i18n.changeLanguage(detected);
            } else {
              localStorage.setItem('tide-commander-language-mode', 'manual');
              i18n.changeLanguage(lang);
            }
          }} />
        </div>
      </CollapsibleSection>
      )}

      {shouldShowSection('agentNames') && (
      <CollapsibleSection title={t('config:sections.agentNames')} storageKey="agentNames" defaultOpen={false} forceOpen={isSearching && shouldShowSection('agentNames')}>
        <div className="agent-names-section">
          <span className="config-hint">
            {customAgentNames.length > 0
              ? t('config:agentNames.customConfigured', { count: customAgentNames.length })
              : t('config:agentNames.usingDefaults')}
          </span>
          <div className="agent-names-input-row">
            <input type="text" className="config-input config-input-full" placeholder={t('config:agentNames.addPlaceholder')} value={newAgentName} onChange={(e) => setNewAgentName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { handleAddAgentName(); } }} />
            <button className="config-btn config-btn-sm" onClick={handleAddAgentName} disabled={!newAgentName.trim()} title={t('config:agentNames.addName')}>+</button>
          </div>
          <div className="agent-names-list">
            {effectiveNames.map((name, index) => (
              <div key={`${name}-${index}`} className="agent-name-chip">
                <span className="agent-name-text">{name}</span>
                {customAgentNames.length > 0 && (
                  <button className="agent-name-remove" onClick={() => handleRemoveAgentName(name)} title={t('common:buttons.remove')}>x</button>
                )}
              </div>
            ))}
          </div>
          {customAgentNames.length > 0 && (
            <button className="config-btn config-btn-link" onClick={handleResetToDefaults}>{t('common:buttons.resetToDefaults')}</button>
          )}
        </div>
      </CollapsibleSection>
      )}

      {shouldShowSection('defaultClass') && (
      <CollapsibleSection title={t('config:sections.defaultClass', { defaultValue: 'Default Spawn Class' })} storageKey="defaultClass" defaultOpen={false} forceOpen={isSearching && shouldShowSection('defaultClass')}>
        <div className="config-row config-row-stacked">
          <span className="config-hint">{t('config:defaultClass.hint', { defaultValue: 'Class pre-selected when the spawn modal opens. "Random" picks a different class each time.' })}</span>
          <div className="agent-names-list" style={{ flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
            <div
              className={`agent-name-chip${defaultSpawnClass === 'random' ? ' agent-name-chip--selected' : ''}`}
              style={{ cursor: 'pointer', userSelect: 'none' }}
              onClick={() => { setDefaultSpawnClassState('random'); setStorageString(STORAGE_KEYS.DEFAULT_AGENT_CLASS, 'random'); }}
            >
              <span className="agent-name-text">🎲 {t('config:defaultClass.random', { defaultValue: 'Random' })}</span>
            </div>
            {Object.entries(BUILT_IN_AGENT_CLASSES).map(([id, cfg]) => (
              <div
                key={id}
                className={`agent-name-chip${defaultSpawnClass === id ? ' agent-name-chip--selected' : ''}`}
                style={{ cursor: 'pointer', userSelect: 'none' }}
                onClick={() => { setDefaultSpawnClassState(id); setStorageString(STORAGE_KEYS.DEFAULT_AGENT_CLASS, id); }}
              >
                <span className="agent-name-text">{cfg.icon} {t(`tools:skills.${AGENT_CLASS_KEY_MAP[id]}`, { defaultValue: id.charAt(0).toUpperCase() + id.slice(1) })}</span>
              </div>
            ))}
            {customClasses.map(cls => (
              <div
                key={cls.id}
                className={`agent-name-chip${defaultSpawnClass === cls.id ? ' agent-name-chip--selected' : ''}`}
                style={{ cursor: 'pointer', userSelect: 'none' }}
                onClick={() => { setDefaultSpawnClassState(cls.id); setStorageString(STORAGE_KEYS.DEFAULT_AGENT_CLASS, cls.id); }}
              >
                <span className="agent-name-text">{cls.icon} {cls.name}</span>
              </div>
            ))}
          </div>
        </div>
      </CollapsibleSection>
      )}

      {shouldShowSection('defaultSkills') && (
      <CollapsibleSection title={t('config:sections.defaultSkills', { defaultValue: 'Default Agent Skills' })} storageKey="defaultSkills" defaultOpen={false} forceOpen={isSearching && shouldShowSection('defaultSkills')}>
        <DefaultAgentSkillsSection />
      </CollapsibleSection>
      )}

      {shouldShowSection('appearance') && (
      <CollapsibleSection title={t('config:sections.appearance')} storageKey="appearance" defaultOpen={false} forceOpen={isSearching && shouldShowSection('appearance')}>
        <ThemeSelector />
      </CollapsibleSection>
      )}

      {shouldShowSection('connection') && (
      <CollapsibleSection title={t('config:sections.connection')} storageKey="connection" defaultOpen={false} forceOpen={isSearching && shouldShowSection('connection')}>
        <div className="config-row config-row-stacked">
          <span className="config-label"><HighlightText text={t('config:connection.backendUrl')} query={searchQuery} /></span>
          <div className="backend-urls-list">
            {backendUrls.map((url, index) => (
              <div key={`${url}-${index}`} className="backend-url-row">
                <span className="backend-url-priority" title={t('config:connection.priorityLabel', { defaultValue: 'Priority' })}>{index + 1}</span>
                <span className="backend-url-text" title={url}>{url}</span>
                <button
                  className="config-btn config-btn-sm"
                  onClick={() => handleMoveBackendUrl(index, -1)}
                  disabled={index === 0}
                  title={t('config:connection.moveUp', { defaultValue: 'Move up' })}
                >↑</button>
                <button
                  className="config-btn config-btn-sm"
                  onClick={() => handleMoveBackendUrl(index, 1)}
                  disabled={index === backendUrls.length - 1}
                  title={t('config:connection.moveDown', { defaultValue: 'Move down' })}
                >↓</button>
                <button
                  className="config-btn config-btn-sm"
                  onClick={() => handleRemoveBackendUrl(index)}
                  title={t('common:buttons.remove')}
                >x</button>
              </div>
            ))}
          </div>
          <div className="config-input-group">
            <input
              type="text"
              className="config-input config-input-full"
              value={newBackendUrl}
              onChange={(e) => setNewBackendUrl(e.target.value)}
              placeholder={t('config:connection.addUrlPlaceholder', { defaultValue: 'http://host:port' })}
              onKeyDown={(e) => { if (e.key === 'Enter') { handleAddBackendUrl(); } }}
            />
            <button
              className="config-btn config-btn-sm"
              onClick={handleAddBackendUrl}
              disabled={!newBackendUrl.trim()}
              title={t('config:connection.addUrl', { defaultValue: 'Add URL' })}
            >+</button>
            {backendUrlsDirty && (
              <button className="config-btn config-btn-sm" onClick={handleBackendUrlsSave} title={t('config:connection.saveAndReconnect')}>{t('common:buttons.apply')}</button>
            )}
          </div>
          <span className="config-hint">{t('config:connection.urlsHint', { defaultValue: 'Tried in order on connect; the first reachable host wins. Leave empty for auto-detect.' })}</span>
        </div>
        <div className="config-row config-row-stacked">
          <span className="config-label"><HighlightText text={t('config:connection.authToken')} query={searchQuery} /></span>
          <div className="config-input-group">
            <input type={showToken ? 'text' : 'password'} className="config-input config-input-full" value={authToken} onChange={(e) => handleAuthTokenChange(e.target.value)} placeholder={t('config:connection.tokenPlaceholder')} onKeyDown={(e) => { if (e.key === 'Enter' && authTokenDirty) { handleAuthTokenSave(); } }} />
            <button className="config-btn config-btn-sm" onClick={() => setShowToken(!showToken)} title={showToken ? t('config:connection.hideToken') : t('config:connection.showToken')}><Icon name={showToken ? 'eye-closed' : 'eye'} size={14} /></button>
            {authTokenDirty && (
              <button className="config-btn config-btn-sm" onClick={handleAuthTokenSave} title={t('config:connection.saveAndReconnect')}>{t('common:buttons.apply')}</button>
            )}
          </div>
          <span className="config-hint">{t('config:connection.tokenRequired')}</span>
        </div>
        <div className="config-row config-row-stacked">
          <span className="config-label"><HighlightText text={t('config:connection.codexBinaryPath')} query={searchQuery} /></span>
          <div className="config-input-group">
            <input type="text" className="config-input config-input-full" value={codexBinaryPath} onChange={(e) => handleCodexBinaryPathChange(e.target.value)} placeholder={t('config:connection.codexBinaryPathPlaceholder')} onKeyDown={(e) => { if (e.key === 'Enter' && codexBinaryPathDirty) { handleCodexBinaryPathSave(); } }} />
            {codexBinaryPathDirty && (
              <button className="config-btn config-btn-sm" onClick={handleCodexBinaryPathSave}>{t('common:buttons.apply')}</button>
            )}
          </div>
          <span className="config-hint">{t('config:connection.codexBinaryPathHint')}</span>
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('common:buttons.reconnect')} query={searchQuery} /></span>
          <button className="config-btn" onClick={() => reconnect()} title={t('config:connection.forceReconnectTitle', { defaultValue: 'Force reconnect to server' })}>{t('common:buttons.reconnect')}</button>
        </div>
      </CollapsibleSection>
      )}

      {shouldShowSection('scene') && (
      <CollapsibleSection title={t('config:sections.scene')} storageKey="scene" defaultOpen={false} forceOpen={isSearching && shouldShowSection('scene')}>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:scene.characterSize')} query={searchQuery} /></span>
          <input type="range" className="config-slider" min="0.3" max="3.0" step="0.1" value={config.characterScale} onChange={(e) => onChange({ ...config, characterScale: parseFloat(e.target.value) })} />
          <span className="config-value">{config.characterScale.toFixed(1)}x</span>
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:scene.scale2d', { defaultValue: '2D Scale' })} query={searchQuery} /></span>
          <input type="range" className="config-slider" min="0.3" max="2.0" step="0.1" value={config.scale2d} onChange={(e) => onChange({ ...config, scale2d: parseFloat(e.target.value) })} />
          <span className="config-value">{config.scale2d.toFixed(1)}x</span>
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:scene.scale3d', { defaultValue: '3D Scale' })} query={searchQuery} /></span>
          <input type="range" className="config-slider" min="0.3" max="2.0" step="0.1" value={config.scale3d} onChange={(e) => onChange({ ...config, scale3d: parseFloat(e.target.value) })} />
          <span className="config-value">{config.scale3d.toFixed(1)}x</span>
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:scene.show2DTaskLabels', { defaultValue: 'Show 2D task labels' })} query={searchQuery} /></span>
          <Toggle checked={config.show2DTaskLabels} onChange={(checked) => onChange({ ...config, show2DTaskLabels: checked })} />
        </div>
        <div className="config-group">
          <span className="config-label"><HighlightText text={t('config:scene.time')} query={searchQuery} /></span>
          <ChipSelector options={tTimeOpts} value={config.timeMode} onChange={(mode) => onChange({ ...config, timeMode: mode })} iconOnly />
        </div>
      </CollapsibleSection>
      )}

      {shouldShowSection('terrain') && (
      <CollapsibleSection title={t('config:sections.terrain')} storageKey="terrain" defaultOpen={false} forceOpen={isSearching && shouldShowSection('terrain')}>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:terrainSettings.simpleMode', { defaultValue: 'Simple Mode' })} query={searchQuery} /></span>
          <Toggle checked={config.terrain.simpleMode ?? false} onChange={(checked) => updateTerrain({ simpleMode: checked })} />
        </div>
        <div className="terrain-icons" style={{ opacity: config.terrain.simpleMode ? 0.4 : 1, pointerEvents: config.terrain.simpleMode ? 'none' : 'auto' }}>
          {tTerrainOpts.map((opt) => (
            <button key={opt.key} className={`terrain-icon-btn ${config.terrain[opt.key] ? 'active' : ''}`} onClick={() => toggleTerrain(opt.key)} title={opt.label}>{opt.icon}</button>
          ))}
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:terrainSettings.fog')} query={searchQuery} /></span>
          <input type="range" className="config-slider" min="0" max="2" step="0.1" value={config.terrain.fogDensity} onChange={(e) => updateTerrain({ fogDensity: parseFloat(e.target.value) })} />
          <span className="config-value">
            {config.terrain.fogDensity === 0 ? t('config:fogValues.off') : config.terrain.fogDensity <= 1 ? t('config:fogValues.low') : t('config:fogValues.high')}
          </span>
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:terrainSettings.brightness')} query={searchQuery} /></span>
          <input type="range" className="config-slider" min="0.2" max="2" step="0.1" value={config.terrain.brightness} onChange={(e) => updateTerrain({ brightness: parseFloat(e.target.value) })} />
          <span className="config-value">
            {config.terrain.brightness <= 0.5 ? t('config:brightnessValues.dark') : config.terrain.brightness <= 1.2 ? t('config:brightnessValues.normal') : t('config:brightnessValues.bright')}
          </span>
        </div>
        <div className="config-group">
          <span className="config-label"><HighlightText text={t('config:terrainSettings.floor')} query={searchQuery} /></span>
          <ChipSelector options={tFloorOpts} value={config.terrain.floorStyle} onChange={(style) => updateTerrain({ floorStyle: style })} iconOnly />
        </div>
        <div className="config-group">
          <span className="config-label"><HighlightText text={t('config:terrainSettings.sky')} query={searchQuery} /></span>
          <div className="sky-color-selector">
            {tSkyOpts.map((opt) => (
              <button key={opt.value ?? 'auto'} className={`sky-color-btn ${config.terrain.skyColor === opt.value ? 'active' : ''}`} onClick={() => updateTerrain({ skyColor: opt.value })} title={opt.label} style={{ background: opt.color }} />
            ))}
          </div>
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:terrainSettings.battlefieldSize')} query={searchQuery} /></span>
          <input type="range" className="config-slider" min="30" max="200" step="10" value={config.terrain.battlefieldSize} onChange={(e) => updateTerrain({ battlefieldSize: parseInt(e.target.value) })} />
          <span className="config-value">{config.terrain.battlefieldSize}</span>
        </div>
      </CollapsibleSection>
      )}

      {shouldShowSection('modelStyle') && (
      <CollapsibleSection title={t('config:sections.modelStyle')} storageKey="modelStyle" defaultOpen={false} forceOpen={isSearching && shouldShowSection('modelStyle')}>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:modelStyleSettings.saturation')} query={searchQuery} /></span>
          <input type="range" className="config-slider" min="0" max="2" step="0.1" value={config.modelStyle.saturation} onChange={(e) => updateModelStyle({ saturation: parseFloat(e.target.value) })} />
          <span className="config-value">{config.modelStyle.saturation <= 0.3 ? t('config:saturationValues.gray') : config.modelStyle.saturation <= 1.2 ? t('config:saturationValues.normal') : t('config:saturationValues.vivid')}</span>
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:modelStyleSettings.roughness')} query={searchQuery} /></span>
          <input type="range" className="config-slider" min="-1" max="1" step="0.1" value={config.modelStyle.roughness} onChange={(e) => updateModelStyle({ roughness: parseFloat(e.target.value) })} />
          <span className="config-value">{config.modelStyle.roughness < 0 ? t('config:roughnessValues.auto') : config.modelStyle.roughness <= 0.3 ? t('config:roughnessValues.glossy') : config.modelStyle.roughness <= 0.7 ? t('config:roughnessValues.normal') : t('config:roughnessValues.matte')}</span>
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:modelStyleSettings.metalness')} query={searchQuery} /></span>
          <input type="range" className="config-slider" min="-1" max="1" step="0.1" value={config.modelStyle.metalness} onChange={(e) => updateModelStyle({ metalness: parseFloat(e.target.value) })} />
          <span className="config-value">{config.modelStyle.metalness < 0 ? t('config:metalnessValues.auto') : config.modelStyle.metalness <= 0.3 ? t('config:metalnessValues.plastic') : config.modelStyle.metalness <= 0.7 ? t('config:metalnessValues.mixed') : t('config:metalnessValues.metal')}</span>
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:modelStyleSettings.glow')} query={searchQuery} /></span>
          <input type="range" className="config-slider" min="0" max="1" step="0.05" value={config.modelStyle.emissiveBoost} onChange={(e) => updateModelStyle({ emissiveBoost: parseFloat(e.target.value) })} />
          <span className="config-value">{config.modelStyle.emissiveBoost <= 0.1 ? t('config:glowValues.off') : config.modelStyle.emissiveBoost <= 0.4 ? t('config:glowValues.low') : config.modelStyle.emissiveBoost <= 0.7 ? t('config:glowValues.med') : t('config:glowValues.high')}</span>
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:modelStyleSettings.reflections')} query={searchQuery} /></span>
          <input type="range" className="config-slider" min="-1" max="2" step="0.1" value={config.modelStyle.envMapIntensity} onChange={(e) => updateModelStyle({ envMapIntensity: parseFloat(e.target.value) })} />
          <span className="config-value">{config.modelStyle.envMapIntensity < 0 ? t('config:reflectionValues.auto') : config.modelStyle.envMapIntensity <= 0.3 ? t('config:reflectionValues.low') : config.modelStyle.envMapIntensity <= 1 ? t('config:reflectionValues.normal') : t('config:reflectionValues.high')}</span>
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:modelStyleSettings.wireframe')} query={searchQuery} /></span>
          <Toggle checked={config.modelStyle.wireframe} onChange={(checked) => updateModelStyle({ wireframe: checked })} />
        </div>
        <div className="config-group">
          <span className="config-label"><HighlightText text={t('config:modelStyleSettings.colorMode')} query={searchQuery} /></span>
          <ChipSelector options={tColorModeOpts} value={config.modelStyle.colorMode} onChange={(mode) => updateModelStyle({ colorMode: mode })} iconOnly />
        </div>
      </CollapsibleSection>
      )}

      {shouldShowSection('animations') && (
      <CollapsibleSection title={t('config:sections.animations')} storageKey="animations" defaultOpen={false} forceOpen={isSearching && shouldShowSection('animations')}>
        <div className="config-group">
          <span className="config-label"><HighlightText text={t('config:animationSettings.idle')} query={searchQuery} /></span>
          <ChipSelector options={tAnimOpts} value={config.animations.idleAnimation} onChange={(anim) => updateAnimations({ idleAnimation: anim })} iconOnly />
        </div>
        <div className="config-group">
          <span className="config-label"><HighlightText text={t('config:animationSettings.working')} query={searchQuery} /></span>
          <ChipSelector options={tAnimOpts} value={config.animations.workingAnimation} onChange={(anim) => updateAnimations({ workingAnimation: anim })} iconOnly />
        </div>
      </CollapsibleSection>
      )}

      {shouldShowSection('secrets') && (
      <CollapsibleSection title={t('config:sections.secrets')} storageKey="secrets" defaultOpen={false} forceOpen={isSearching && shouldShowSection('secrets')}>
        <SecretsSection />
      </CollapsibleSection>
      )}

      {shouldShowSection('claudeAccounts') && (
      <CollapsibleSection title={t('config:sections.claudeAccounts', { defaultValue: 'Claude Accounts' })} storageKey="claudeAccounts" defaultOpen={false} forceOpen={isSearching && shouldShowSection('claudeAccounts')}>
        <ClaudeCredentialsPanel />
      </CollapsibleSection>
      )}

      {shouldShowSection('grokAccounts') && (
      <CollapsibleSection title={t('config:sections.grokAccounts', { defaultValue: 'Grok Accounts' })} storageKey="grokAccounts" defaultOpen={false} forceOpen={isSearching && shouldShowSection('grokAccounts')}>
        <ProviderCredentialsPanel provider="grok" />
      </CollapsibleSection>
      )}

      {shouldShowSection('codexAccounts') && (
      <CollapsibleSection title={t('config:sections.codexAccounts', { defaultValue: 'Codex Accounts' })} storageKey="codexAccounts" defaultOpen={false} forceOpen={isSearching && shouldShowSection('codexAccounts')}>
        <ProviderCredentialsPanel provider="codex" />
      </CollapsibleSection>
      )}

      {shouldShowSection('systemPrompt') && (
      <CollapsibleSection title={t('config:sections.systemPrompt')} storageKey="systemPrompt" defaultOpen={false} forceOpen={isSearching && shouldShowSection('systemPrompt')}>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:systemPrompt.title')} query={searchQuery} /></span>
          <button
            className="config-button"
            onClick={() => setIsSystemPromptModalOpen(true)}
          >
            {t('config:systemPrompt.editPrompt')}
          </button>
        </div>
      </CollapsibleSection>
      )}

      {shouldShowSection('data') && (
      <CollapsibleSection title={t('config:sections.data')} storageKey="data" defaultOpen={false} forceOpen={isSearching && shouldShowSection('data')}>
        <DataSection />
      </CollapsibleSection>
      )}

      {shouldShowSection('integrations') && (
      <CollapsibleSection title={t('config:sections.integrations')} storageKey="integrations" defaultOpen={false} forceOpen={isSearching && shouldShowSection('integrations')}>
        <IntegrationStatusPanel
          onOpenModal={(id) => {
            if (id === 'whatsapp') {
              setIsWhatsAppHubOpen(true);
            } else {
              onOpenIntegrationsModal?.(id);
            }
          }}
        />
      </CollapsibleSection>
      )}

      {shouldShowSection('workflows') && (
      <CollapsibleSection title={t('config:sections.workflows', { defaultValue: 'Workflows' })} storageKey="workflows" defaultOpen={false} forceOpen={isSearching && shouldShowSection('workflows')}>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:workflows.description', { defaultValue: 'Create and manage automated workflow pipelines with visual state machine editor' })} query={searchQuery} /></span>
        </div>
        <div className="config-row">
          <button
            className="config-button"
            onClick={() => onOpenWorkflowEditor?.()}
          >
            {t('config:workflows.openEditor', { defaultValue: 'Open Workflow Editor' })}
          </button>
        </div>
      </CollapsibleSection>
      )}

      {shouldShowSection('triggers') && (
      <CollapsibleSection title={t('config:sections.triggers', { defaultValue: 'Triggers' })} storageKey="triggers" defaultOpen={false} forceOpen={isSearching && shouldShowSection('triggers')}>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:triggers.description', { defaultValue: 'Create and manage event-driven triggers that fire agents with templates' })} query={searchQuery} /></span>
        </div>
        <div className="config-row">
          <button
            className="config-button"
            onClick={() => onOpenTriggerManager?.()}
          >
            {t('config:triggers.openManager', { defaultValue: 'Open Trigger Manager' })}
          </button>
        </div>
      </CollapsibleSection>
      )}

      {shouldShowSection('monitoring') && (
      <CollapsibleSection title={t('config:sections.monitoring', { defaultValue: 'Monitoring' })} storageKey="monitoring" defaultOpen={false} forceOpen={isSearching && shouldShowSection('monitoring')}>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:monitoring.description', { defaultValue: 'View event logs, trigger history, workflow traces, and system stats' })} query={searchQuery} /></span>
        </div>
        <div className="config-row">
          <button
            className="config-button"
            onClick={() => onOpenMonitoringModal?.()}
          >
            {t('config:monitoring.openLogs', { defaultValue: 'Open Monitoring & Logs' })}
          </button>
        </div>
      </CollapsibleSection>
      )}

      {shouldShowSection('statistics') && (
      <CollapsibleSection title={t('config:sections.statistics', { defaultValue: 'Statistics' })} storageKey="statistics" defaultOpen={false} forceOpen={isSearching && shouldShowSection('statistics')}>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:statistics.description', { defaultValue: 'View token usage charts and system-wide agent statistics' })} query={searchQuery} /></span>
        </div>
        <div className="config-row">
          <button
            className="config-button"
            onClick={() => onOpenStatisticsModal?.()}
          >
            {t('config:statistics.open', { defaultValue: 'Open Statistics' })}
          </button>
        </div>
      </CollapsibleSection>
      )}

      {/* ---- 「语音」分组:四节互为上下游,用组标题 + 关系条讲清 ---- */}
      {(shouldShowSection('stt') || shouldShowSection('tts') || shouldShowSection('voiceCompanion') || shouldShowSection('voiceAssistant')) && (
      <div className="config-group-heading">{t('config:sections.voice', { defaultValue: '语音' })}</div>
      )}

      {shouldShowSection('stt') && (
      <CollapsibleSection id="config-section-stt" expandSignal={expandSignals.stt} title={t('config:general.stt')} storageKey="stt" defaultOpen={false} forceOpen={isSearching && shouldShowSection('stt')}>
        <ConfigRelationNote
          items={[{
            text: t('config:voiceRelations.stt', { defaultValue: '本页引擎/密钥同时被:语音助手、终端语音输入、语音伙伴(批量回退)、WhatsApp 转写 使用。' }),
            links: [{ label: t('config:voiceRelations.goCompanion', { defaultValue: '去语音伙伴' }), target: 'voiceCompanion' }],
          }]}
          onJump={requestSectionJump}
        />
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:stt.engineMode', { defaultValue: '引擎模式' })} query={searchQuery} /></span>
          <select className="config-select" value={sttConfig.mode} onChange={(e) => handleSttModeChange(e.target.value as SttEngineMode)}>
            <option value="auto">{t('config:stt.modeAuto', { defaultValue: '自动(云优先,失败回退本地)' })}</option>
            <option value="local">{t('config:stt.modeLocal', { defaultValue: '仅本地(离线)' })}</option>
            <option value="cloud">{t('config:stt.modeCloud', { defaultValue: '仅云端(失败不回退)' })}</option>
          </select>
        </div>
        <div className="config-row config-row-stacked">
          <span className="config-label"><HighlightText text={t('config:stt.apiKey', { defaultValue: 'API 密钥' })} query={searchQuery} /></span>
          <div className="config-input-group">
            <input type={showSttKey ? 'text' : 'password'} className="config-input config-input-full" value={sttConfig.apiKey} onChange={(e) => handleSttApiKeyChange(e.target.value)} placeholder="sk-…" onKeyDown={(e) => { if (e.key === 'Enter' && sttDirty && !sttSaving) { handleSttSave(); } }} />
            <button className="config-btn config-btn-sm" onClick={() => setShowSttKey(!showSttKey)} title={showSttKey ? t('config:stt.hideKey', { defaultValue: '隐藏密钥' }) : t('config:stt.showKey', { defaultValue: '显示密钥' })}><Icon name={showSttKey ? 'eye-closed' : 'eye'} size={14} /></button>
            {(sttDirty || sttSaved) && (
              <button className="config-btn config-btn-sm" onClick={handleSttSave} disabled={sttSaving}>{sttSaved ? t('config:stt.saved', { defaultValue: '已保存' }) : t('common:buttons.apply')}</button>
            )}
          </div>
          <span className="config-hint">{t('config:stt.apiKeyHint', { defaultValue: '在 siliconflow.cn 免费注册获取(不绑卡);云端模式会把语音上传至服务商。' })}</span>
          {sttLoaded && (
            <span className="config-hint">{sttConfig.mode === 'cloud' && !sttConfig.apiKey ? t('config:stt.cloudNeedsKey', { defaultValue: '⚠ 仅云端模式未填密钥,语音识别将不可用' }) : sttConfig.apiKey ? t('config:stt.statusConfigured', { defaultValue: '已配置密钥' }) : sttConfig.mode === 'local' ? t('config:stt.statusLocal', { defaultValue: '未配置密钥(仅本地模式 = 离线识别)' }) : t('config:stt.statusMissing', { defaultValue: '未配置密钥(自动模式 = 纯本地识别)' })}</span>
          )}
          {sttError && (
            <span className="config-hint">{t('config:stt.saveFailed', { defaultValue: '保存失败' })}: {sttError}</span>
          )}
        </div>
      </CollapsibleSection>
      )}

      {shouldShowSection('tts') && (
      <CollapsibleSection id="config-section-tts" expandSignal={expandSignals.tts} title={t('config:general.tts')} storageKey="tts" defaultOpen={false} forceOpen={isSearching && shouldShowSection('tts')}>
        <ConfigRelationNote
          items={[{
            text: t('config:voiceRelations.tts', { defaultValue: '本页音色同时被:语音伙伴播报、语音助手应答、终端逐行朗读 使用。' }),
            links: [{ label: t('config:voiceRelations.goCompanion', { defaultValue: '去语音伙伴' }), target: 'voiceCompanion' }],
          }]}
          onJump={requestSectionJump}
        />
        {(['zh', 'en', 'es'] as const).map((lang) => (
          <div className="config-row" key={lang}>
            <span className="config-label"><HighlightText text={TTS_LANG_LABELS[lang]} query={searchQuery} /></span>
            <select className="config-select" value={ttsVoices[lang]} onChange={(e) => handleTtsVoiceChange(lang, e.target.value)}>
              {TTS_VOICE_OPTIONS[lang].map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <button className="config-btn config-btn-sm" onClick={() => handleTtsAudition(lang)} disabled={ttsAuditioning !== null || ttsSaving}>
              {ttsAuditioning === lang ? t('config:tts.auditioning', { defaultValue: '播放中…' }) : t('config:tts.audition', { defaultValue: '试听' })}
            </button>
          </div>
        ))}
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:tts.rate', { defaultValue: '语速(%)' })} query={searchQuery} /></span>
          <input
            type="text"
            inputMode="numeric"
            className="config-input config-input-sm"
            value={ttsRateInput}
            placeholder="0"
            onChange={(e) => handleTtsTuningChange('rate', e.target.value)}
          />
          <span className="config-hint">{t('config:tts.rateHint', { defaultValue: '负值更慢,正值更快;0 = 原速' })}</span>
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:tts.volume', { defaultValue: '音量(%)' })} query={searchQuery} /></span>
          <input
            type="text"
            inputMode="numeric"
            className="config-input config-input-sm"
            value={ttsVolumeInput}
            placeholder="0"
            onChange={(e) => handleTtsTuningChange('volume', e.target.value)}
          />
          <span className="config-hint">{t('config:tts.volumeHint', { defaultValue: '负值更轻,正值更响;0 = 原音量' })}</span>
        </div>
        <div className="config-row config-row-stacked">
          <span className="config-hint">{t('config:tts.hint', { defaultValue: '音色由微软在线语音合成(免费);语速/音量取值 -100..100(百分数);试听会先保存再播放,保存后下一句播报立即生效。' })}</span>
          {ttsLoaded && (
            <span className="config-hint">{ttsVoicesExist ? t('config:tts.statusCustom', { defaultValue: '已自定义音色' }) : t('config:tts.statusDefault', { defaultValue: '当前为默认音色(尚未自定义)' })}</span>
          )}
          {ttsError && (
            <span className="config-hint">{ttsError}</span>
          )}
          {(ttsDirty || ttsSaved) && (
            <button className="config-btn config-btn-sm" onClick={handleTtsSave} disabled={ttsSaving}>{ttsSaved ? t('config:tts.saved', { defaultValue: '已保存' }) : t('common:buttons.apply')}</button>
          )}
        </div>
      </CollapsibleSection>
      )}

      {shouldShowSection('voiceCompanion') && (
      <CollapsibleSection id="config-section-voiceCompanion" expandSignal={expandSignals.voiceCompanion} title={t('config:voiceCompanion.sectionTitle', { defaultValue: '语音伙伴' })} storageKey="voiceCompanion" defaultOpen={false} forceOpen={isSearching && shouldShowSection('voiceCompanion')}>
        <ConfigRelationNote
          items={[{
            text: t('config:voiceRelations.companion', { defaultValue: '实时转写=本页火山配置;批量回退→语音转文字;播报音色→文字转语音。' }),
            links: [
              { label: t('config:voiceRelations.goStt', { defaultValue: '转写设置' }), target: 'stt' },
              { label: t('config:voiceRelations.goTts', { defaultValue: '音色设置' }), target: 'tts' },
            ],
          }]}
          onJump={requestSectionJump}
        />
        <VoiceCompanionSection searchQuery={searchQuery} />
      </CollapsibleSection>
      )}

      {shouldShowSection('voiceAssistant') && (
      <CollapsibleSection id="config-section-voiceAssistant" expandSignal={expandSignals.voiceAssistant} title={t('config:experimental.voiceAssistant')} storageKey="voiceAssistant" defaultOpen={false} forceOpen={isSearching && shouldShowSection('voiceAssistant')}>
        <ConfigRelationNote
          items={[{
            text: t('config:voiceRelations.assistant', { defaultValue: '按住说话·一次性指令(右下角悬浮麦克风);常开对话请用语音伙伴。' }),
            links: [{ label: t('config:voiceRelations.goCompanion', { defaultValue: '去语音伙伴' }), target: 'voiceCompanion' }],
          }]}
          onJump={requestSectionJump}
        />
        <div className="config-row">
          <span className="config-label" title={t('config:experimental.voiceAssistantTitle', { defaultValue: 'Voice assistant for hands-free agent control' })}><HighlightText text={t('config:experimental.voiceAssistant')} query={searchQuery} /> <Icon name="microphone" size={12} /></span>
          <Toggle checked={settings.experimentalVoiceAssistant} onChange={(checked) => store.updateSettings({ experimentalVoiceAssistant: checked })} />
        </div>
        <div className="config-row">
          <span className="config-label"><HighlightText text={t('config:voicePersona.label', { defaultValue: '人设' })} query={searchQuery} /></span>
          <select
            className="config-select"
            value={settings.voiceAssistantPersonaPreset}
            onChange={(e) => store.updateSettings({ voiceAssistantPersonaPreset: e.target.value })}
          >
            {VOICE_PERSONAS.map((p) => (
              <option key={p.id} value={p.id}>
                {t(`config:voicePersona.${p.id}.name`, { defaultValue: p.name })}
              </option>
            ))}
            <option value={PERSONA_CUSTOM_ID}>{t('config:voicePersona.custom', { defaultValue: '自定义…' })}</option>
          </select>
        </div>
        {settings.voiceAssistantPersonaPreset === PERSONA_CUSTOM_ID ? (
          <div className="config-row config-row-stacked">
            <textarea
              className="config-input config-input-full"
              rows={3}
              maxLength={PERSONA_CUSTOM_MAX}
              value={settings.voiceAssistantPersonaCustom}
              placeholder={t('config:voicePersona.customPlaceholder', { defaultValue: '描述你想要的人设,例如:你是一位经验丰富的老船长,说话豪爽……' })}
              onChange={(e) => store.updateSettings({ voiceAssistantPersonaCustom: e.target.value })}
            />
            <span className="config-hint">{t('config:voicePersona.customHint', { defaultValue: '填写后完全替代预设;留空则用默认「豆包风」。' })}</span>
          </div>
        ) : (
          <div className="config-row config-row-stacked">
            <span className="config-hint">
              {t(`config:voicePersona.${settings.voiceAssistantPersonaPreset}.tagline`, {
                defaultValue: VOICE_PERSONAS.find((p) => p.id === settings.voiceAssistantPersonaPreset)?.tagline ?? '',
              })}
            </span>
          </div>
        )}
        <div className="config-row config-row-stacked">
          <span className="config-hint">{t('config:voiceAssistant.hint', { defaultValue: '开启后终端右下角出现悬浮麦克风钮;录音转写走上面的语音转文字设置。' })}</span>
        </div>
      </CollapsibleSection>
      )}

      {shouldShowSection('experimental') && (
      <CollapsibleSection title={t('config:sections.experimental')} storageKey="experimental" defaultOpen={false} forceOpen={isSearching && shouldShowSection('experimental')}>
        <div className="config-row">
          <span className="config-label" title={t('config:experimental.2dViewTitle', { defaultValue: 'Lightweight 2D top-down view for better performance' })}><HighlightText text={t('config:experimental.2dView')} query={searchQuery} /> <Icon name="map" size={12} /></span>
          <Toggle checked={settings.experimental2DView} onChange={(checked) => store.updateSettings({ experimental2DView: checked })} />
        </div>
        <div className="config-row">
          <span className="config-label" title={t('config:experimental.ttsTitle', { defaultValue: 'Text-to-speech for reading agent responses' })}><HighlightText text={t('config:experimental.tts')} query={searchQuery} /> <Icon name="speaker-on" size={12} /></span>
          <Toggle checked={settings.experimentalTTS} onChange={(checked) => store.updateSettings({ experimentalTTS: checked })} />
        </div>
        <div className="config-row">
          <span className="config-label" title={t('config:experimental.echoPromptTitle', { defaultValue: 'Duplicate system prompt for improved LLM attention coverage. Increases input token usage.' })}><HighlightText text={t('config:experimental.echoPrompt')} query={searchQuery} /></span>
          <Toggle checked={settings.experimentalEchoPrompt} onChange={async (checked) => {
            store.updateSettings({ experimentalEchoPrompt: checked });
            try {
              await updateEchoPromptSetting(checked);
            } catch (err) {
              console.error('Failed to sync echo prompt setting to server:', err);
            }
          }} />
        </div>
        <span className="config-hint">{t('config:experimental.hint')}</span>
      </CollapsibleSection>
      )}

      {shouldShowSection('about') && (
      <CollapsibleSection title={t('config:sections.about')} storageKey="about" defaultOpen={false} forceOpen={isSearching && shouldShowSection('about')}>
        <AboutSection />
      </CollapsibleSection>
      )}
    </div>

    <SystemPromptModal
      isOpen={isSystemPromptModalOpen}
      onClose={() => setIsSystemPromptModalOpen(false)}
    />

    <WhatsAppConfigModal
      isOpen={isWhatsAppModalOpen}
      onClose={() => setIsWhatsAppModalOpen(false)}
    />

    <WhatsAppNotificationsModal
      isOpen={isWhatsAppNotificationsModalOpen}
      onClose={() => setIsWhatsAppNotificationsModalOpen(false)}
    />

    <WhatsAppHistoryPanel
      isOpen={isWhatsAppHistoryOpen}
      onClose={() => setIsWhatsAppHistoryOpen(false)}
    />

    <WhatsAppHubModal
      isOpen={isWhatsAppHubOpen}
      onClose={() => setIsWhatsAppHubOpen(false)}
      onOpenConfig={() => setIsWhatsAppModalOpen(true)}
      onOpenNotifications={() => setIsWhatsAppNotificationsModalOpen(true)}
      onOpenHistory={() => setIsWhatsAppHistoryOpen(true)}
    />
    </>
  );
}
