/**
 * 「语音伙伴」设置节(工具箱)
 *
 * 读写 tools/voice-companion/config.json(客户端 API 在 api/voiceCompanion.ts),
 * 保存后通过模块级订阅让运行中的悬浮组件即时生效。服务端大脑与流式通道同读此文件。
 *
 * 全部文案走 t('config:voiceCompanion.…', { defaultValue: '中文' }),不新增 locale 文件。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import {
  loadVoiceCompanionConfig,
  saveVoiceCompanionConfig,
  getVoiceCompanionMemory,
  getVoiceCompanionStatus,
  resetVoiceCompanionSession,
  updateVoiceCompanionMemory,
  type CompanionMemory,
  type CompanionStatus,
  type VoiceCompanionConfig,
} from '../../api/voiceCompanion';

// 紧凑开关(与 ConfigSection 内的私有 Toggle 同款;不复用 = 不动作者文件导出)
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

// 与 ConfigSection 的 HighlightText 同款(节内标签也参与搜索高亮)
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="search-highlight">{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}

interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

function NumberField({ value, min, max, onChange }: NumberFieldProps) {
  return (
    <input
      type="number"
      className="config-input config-input-number"
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        const next = Number(e.target.value);
        if (Number.isFinite(next)) onChange(Math.round(next));
      }}
    />
  );
}

export function VoiceCompanionSection({ searchQuery = '' }: { searchQuery?: string }) {
  const { t } = useTranslation(['config', 'common']);
  const tx = (key: string, fallback: string) => t(`config:voiceCompanion.${key}`, { defaultValue: fallback });

  const [config, setConfig] = useState<VoiceCompanionConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showAccessToken, setShowAccessToken] = useState(false);

  // 结束词用原始字符串编辑(数组双向绑定会让逗号输入被吞)
  const [endWordsText, setEndWordsText] = useState('');

  const [memory, setMemory] = useState<CompanionMemory | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadVoiceCompanionConfig()
      .then(({ config: loaded }) => {
        if (!alive) return;
        setConfig(loaded);
        setEndWordsText(loaded.listening.endWords.join(', '));
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    void getVoiceCompanionStatus().then((s) => {
      if (!alive) return;
      setStatus(s);
      setStatusLoaded(true);
      // 状态里就带着记忆:直接预填,点「查看/刷新」再拉最新
      if (s?.memory) setMemory(s.memory);
    });
    return () => {
      alive = false;
    };
  }, []);

  const patch = useCallback((fn: (cfg: VoiceCompanionConfig) => VoiceCompanionConfig) => {
    setConfig((prev) => (prev ? fn(prev) : prev));
    setDirty(true);
    setSaved(false);
    setError(null);
  }, []);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!config) return false;
    setSaving(true);
    setError(null);
    try {
      const toSave: VoiceCompanionConfig = {
        ...config,
        listening: { ...config.listening, endWords: parseEndWords(endWordsText) },
      };
      await saveVoiceCompanionConfig(toSave);
      setConfig(toSave);
      setDirty(false);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 3000);
      void getVoiceCompanionStatus().then(setStatus);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [config, endWordsText]);

  const refreshMemory = useCallback(async () => {
    setMemoryLoading(true);
    setMemoryError(null);
    const next = await getVoiceCompanionMemory();
    if (next) setMemory(next);
    else setMemoryError(tx('memoryUnavailable', '记忆服务不可用(需服务端运行)'));
    setMemoryLoading(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteNote = useCallback(async (id: string) => {
    const next = await updateVoiceCompanionMemory({ ops: [{ op: 'remove', id }] });
    if (next) setMemory(next);
  }, []);

  const clearMemory = useCallback(async () => {
    const next = await updateVoiceCompanionMemory({ clear: true });
    setConfirmClear(false);
    if (next) {
      setMemory(next);
      void getVoiceCompanionStatus().then(setStatus);
    }
  }, []);

  const resetSession = useCallback(async () => {
    const ok = await resetVoiceCompanionSession(true);
    if (ok) {
      setStatus(await getVoiceCompanionStatus());
    }
  }, []);

  if (!config) {
    return <div className="config-row"><span className="config-hint">{tx('loading', '正在读取配置…')}</span></div>;
  }

  const volc = config.stt.volcengine;
  const volcConfigured = !!volc.apiKey || (!!volc.appId && !!volc.accessToken);

  return (
    <>
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('enabled', '启用语音伙伴(持续聆听)')} query={searchQuery} /></span>
        <Toggle checked={config.enabled} onChange={(checked) => patch((c) => ({ ...c, enabled: checked }))} />
      </div>
      <div className="config-row config-row-stacked">
        <span className="config-hint">{tx('enabledHint', '左侧浮出麦克风圆钮:常开聆听、静音自动断句、语音播报回复;关闭时按钮隐藏。')}</span>
      </div>

      <div className="config-row">
        <span className="config-label"><Highlight text={tx('model', '大脑模型')} query={searchQuery} /></span>
        <select
          className="config-select"
          value={config.model}
          onChange={(e) => patch((c) => ({ ...c, model: e.target.value === 'sonnet' ? 'sonnet' : 'haiku' }))}
        >
          <option value="haiku">{tx('modelHaiku', 'Haiku(快,默认)')}</option>
          <option value="sonnet">{tx('modelSonnet', 'Sonnet(更聪明,更慢)')}</option>
        </select>
      </div>

      <div className="config-row">
        <span className="config-label"><Highlight text={tx('sttMode', '转写引擎')} query={searchQuery} /></span>
        <select
          className="config-select"
          value={config.stt.mode}
          onChange={(e) => patch((c) => ({ ...c, stt: { ...c.stt, mode: e.target.value as VoiceCompanionConfig['stt']['mode'] } }))}
        >
          <option value="auto">{tx('sttModeAuto', '自动(流式优先,凭据缺失自动回退)')}</option>
          <option value="stream">{tx('sttModeStream', '仅流式(火山引擎,实时上屏)')}</option>
          <option value="segment">{tx('sttModeSegment', '仅分段(本地批量转写)')}</option>
        </select>
      </div>

      {/* ---- 火山引擎 ---- */}
      <div className="config-row config-row-stacked">
        <span className="config-hint">{tx('volcHint', '火山引擎「大模型流式语音识别」:控制台开通后填 APP ID + Access Token(或新版 ApiKey)。留空 = 自动走本地批量转写,功能不受影响。')}</span>
      </div>
      <div className="config-row config-row-stacked">
        <span className="config-label"><Highlight text={tx('volcApiKey', 'ApiKey(新版控制台,可选)')} query={searchQuery} /></span>
        <div className="config-input-group">
          <input
            type={showApiKey ? 'text' : 'password'}
            className="config-input config-input-full"
            value={volc.apiKey}
            placeholder="…"
            onChange={(e) => patch((c) => ({ ...c, stt: { ...c.stt, volcengine: { ...c.stt.volcengine, apiKey: e.target.value } } }))}
          />
          <button type="button" className="config-btn config-btn-sm" onClick={() => setShowApiKey(!showApiKey)} title={showApiKey ? tx('hide', '隐藏') : tx('show', '显示')}>
            <Icon name={showApiKey ? 'eye-closed' : 'eye'} size={14} />
          </button>
        </div>
      </div>
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('volcAppId', 'APP ID(旧版控制台)')} query={searchQuery} /></span>
        <input
          type="text"
          className="config-input"
          value={volc.appId}
          onChange={(e) => patch((c) => ({ ...c, stt: { ...c.stt, volcengine: { ...c.stt.volcengine, appId: e.target.value } } }))}
        />
      </div>
      <div className="config-row config-row-stacked">
        <span className="config-label"><Highlight text={tx('volcAccessToken', 'Access Token(旧版控制台)')} query={searchQuery} /></span>
        <div className="config-input-group">
          <input
            type={showAccessToken ? 'text' : 'password'}
            className="config-input config-input-full"
            value={volc.accessToken}
            onChange={(e) => patch((c) => ({ ...c, stt: { ...c.stt, volcengine: { ...c.stt.volcengine, accessToken: e.target.value } } }))}
          />
          <button type="button" className="config-btn config-btn-sm" onClick={() => setShowAccessToken(!showAccessToken)} title={showAccessToken ? tx('hide', '隐藏') : tx('show', '显示')}>
            <Icon name={showAccessToken ? 'eye-closed' : 'eye'} size={14} />
          </button>
        </div>
        <span className="config-hint">{tx('volcCredHint', '凭据只写本机 tools/voice-companion/config.json(已加入 .gitignore),不会上传仓库。')}</span>
      </div>
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('volcResourceId', '资源 ID')} query={searchQuery} /></span>
        <input
          type="text"
          className="config-input"
          value={volc.resourceId}
          placeholder="volc.bigasr.sauc.duration"
          onChange={(e) => patch((c) => ({ ...c, stt: { ...c.stt, volcengine: { ...c.stt.volcengine, resourceId: e.target.value } } }))}
        />
      </div>
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('volcEndpoint', '流式端点')} query={searchQuery} /></span>
        <select
          className="config-select"
          value={volc.endpoint}
          onChange={(e) => patch((c) => ({ ...c, stt: { ...c.stt, volcengine: { ...c.stt.volcengine, endpoint: e.target.value as typeof volc.endpoint } } }))}
        >
          <option value="bigmodel_async">bigmodel_async(推荐)</option>
          <option value="bigmodel">bigmodel</option>
          <option value="bigmodel_nostream">bigmodel_nostream</option>
        </select>
      </div>
      <div className="config-row config-row-stacked">
        <span className="config-hint">
          {config.stt.mode === 'stream' && !volcConfigured
            ? tx('volcStatusStreamMissing', '⚠ 仅流式模式未配凭据,转写将不可用')
            : volcConfigured
              ? tx('volcStatusConfigured', '已配置火山凭据,流式转写可用')
              : tx('volcStatusMissing', '未配置火山凭据(自动模式 = 本地批量转写)')}
        </span>
      </div>

      {/* ---- 聆听 ---- */}
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('silenceMs', '静音判停(ms)')} query={searchQuery} /></span>
        <NumberField
          value={config.listening.silenceMs}
          min={200}
          max={10000}
          onChange={(v) => patch((c) => ({ ...c, listening: { ...c.listening, silenceMs: v } }))}
        />
        <span className="config-hint">{tx('silenceMsHint', '说停后多久算一句话(默认 800)')}</span>
      </div>
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('minSpeechMs', '最短语音段(ms)')} query={searchQuery} /></span>
        <NumberField
          value={config.listening.minSpeechMs}
          min={100}
          max={10000}
          onChange={(v) => patch((c) => ({ ...c, listening: { ...c.listening, minSpeechMs: v } }))}
        />
        <span className="config-hint">{tx('minSpeechMsHint', '短于此的声响直接丢弃(默认 400)')}</span>
      </div>
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('wakeWord', '唤醒词(可空)')} query={searchQuery} /></span>
        <input
          type="text"
          className="config-input"
          value={config.listening.wakeWord}
          placeholder={tx('wakeWordPlaceholder', '如:伙伴')}
          onChange={(e) => patch((c) => ({ ...c, listening: { ...c.listening, wakeWord: e.target.value } }))}
        />
        <span className="config-hint">{tx('wakeWordHint', '非空时,一句话必须包含它才会被提交')}</span>
      </div>
      <div className="config-row config-row-stacked">
        <span className="config-label"><Highlight text={tx('endWords', '结束词(逗号分隔)')} query={searchQuery} /></span>
        <input
          type="text"
          className="config-input config-input-full"
          value={endWordsText}
          placeholder={tx('endWordsPlaceholder', '发送, 完事了, 就这些')}
          onChange={(e) => {
            setEndWordsText(e.target.value);
            setDirty(true);
            setSaved(false);
          }}
        />
        <span className="config-hint">{tx('endWordsHint', '句子末尾命中则剥离并立即提交,不等静音判停')}</span>
      </div>
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('autoSubmit', '判停后自动提交')} query={searchQuery} /></span>
        <Toggle checked={config.listening.autoSubmit} onChange={(checked) => patch((c) => ({ ...c, listening: { ...c.listening, autoSubmit: checked } }))} />
      </div>
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('bargeIn', '播报中允许抢话')} query={searchQuery} /></span>
        <Toggle checked={config.listening.bargeIn} onChange={(checked) => patch((c) => ({ ...c, listening: { ...c.listening, bargeIn: checked } }))} />
      </div>
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('pauseWhenHidden', '切后台时暂停聆听')} query={searchQuery} /></span>
        <Toggle checked={config.listening.pauseWhenHidden} onChange={(checked) => patch((c) => ({ ...c, listening: { ...c.listening, pauseWhenHidden: checked } }))} />
      </div>

      {/* ---- 主动汇报 ---- */}
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('proactiveEnabled', '主动汇报')} query={searchQuery} /></span>
        <Toggle checked={config.proactive.enabled} onChange={(checked) => patch((c) => ({ ...c, proactive: { ...c.proactive, enabled: checked } }))} />
      </div>
      <div className="config-row config-row-stacked">
        <span className="config-hint">{tx('proactiveHint', 'agent 完成/出错/等待确认时开口播报;安静时不打扰。')}</span>
      </div>
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('proactiveInterval', '巡查间隔(分钟)')} query={searchQuery} /></span>
        <NumberField
          value={config.proactive.intervalMinutes}
          min={5}
          max={240}
          onChange={(v) => patch((c) => ({ ...c, proactive: { ...c.proactive, intervalMinutes: v } }))}
        />
        <span className="config-hint">{tx('proactiveIntervalHint', '静默巡查:有事才开口')}</span>
      </div>
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('proactiveScope', '汇报范围')} query={searchQuery} /></span>
        <select
          className="config-select"
          value={config.proactive.scope}
          onChange={(e) => patch((c) => ({ ...c, proactive: { ...c.proactive, scope: e.target.value === 'all' ? 'all' : 'important' } }))}
        >
          <option value="important">{tx('proactiveScopeImportant', '重要事件(完成/出错/等待)')}</option>
          <option value="all">{tx('proactiveScopeAll', '全部(额外报换任务)')}</option>
        </select>
      </div>
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('proactiveQuiet', '静默窗口(ms)')} query={searchQuery} /></span>
        <NumberField
          value={config.proactive.quietWindowMs}
          min={5000}
          max={300000}
          onChange={(v) => patch((c) => ({ ...c, proactive: { ...c.proactive, quietWindowMs: v } }))}
        />
        <span className="config-hint">{tx('proactiveQuietHint', '窗口内的事件合并成一条播报(默认 45000)')}</span>
      </div>

      {/* ---- 高级(大脑) ---- */}
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('brainTimeout', '大脑超时(ms)')} query={searchQuery} /></span>
        <NumberField
          value={config.brain.hop1TimeoutMs}
          min={5000}
          max={180000}
          onChange={(v) => patch((c) => ({ ...c, brain: { ...c.brain, hop1TimeoutMs: v } }))}
        />
      </div>
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('brainMaxTurns', '会话最大轮数')} query={searchQuery} /></span>
        <NumberField
          value={config.brain.maxTurns}
          min={10}
          max={2000}
          onChange={(v) => patch((c) => ({ ...c, brain: { ...c.brain, maxTurns: v } }))}
        />
        <span className="config-hint">{tx('brainMaxTurnsHint', '超出自动轮换会话(记忆保留)')}</span>
      </div>
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('brainSessionAge', '会话最长闲置(天)')} query={searchQuery} /></span>
        <NumberField
          value={config.brain.sessionMaxAgeDays}
          min={1}
          max={365}
          onChange={(v) => patch((c) => ({ ...c, brain: { ...c.brain, sessionMaxAgeDays: v } }))}
        />
      </div>

      {/* ---- 记忆与会话 ---- */}
      <div className="config-row">
        <span className="config-label"><Highlight text={tx('memory', '记忆')} query={searchQuery} /></span>
        <button type="button" className="config-btn config-btn-sm" onClick={() => void refreshMemory()} disabled={memoryLoading}>
          {memoryLoading ? tx('memoryLoading', '读取中…') : tx('memoryRefresh', '查看 / 刷新')}
        </button>
      </div>
      {memory && (
        <div className="config-row config-row-stacked">
          {memory.summary && <span className="config-hint">{tx('memorySummary', '摘要')}: {memory.summary}</span>}
          {memory.notes.length === 0 && <span className="config-hint">{tx('memoryEmpty', '还没有记忆条目——聊几次就攒起来了')}</span>}
          {memory.notes.map((note) => (
            <span className="config-hint" key={note.id}>
              <button
                type="button"
                className="config-btn config-btn-sm"
                title={tx('memoryDelete', '删除这条')}
                onClick={() => void deleteNote(note.id)}
              >
                ×
              </button>
              {' '}
              {note.text}
              <em> ({note.source === 'auto' ? tx('memoryAuto', '自动') : tx('memoryUser', '手动')})</em>
            </span>
          ))}
          {memory.notes.length > 0 && (
            confirmClear ? (
              <span className="config-hint">
                {tx('memoryClearConfirm', '确定清空全部记忆?')}
                <button type="button" className="config-btn config-btn-sm" onClick={() => void clearMemory()}>{tx('memoryClearYes', '清空')}</button>
                <button type="button" className="config-btn config-btn-sm" onClick={() => setConfirmClear(false)}>{t('common:buttons.cancel', { defaultValue: '取消' })}</button>
              </span>
            ) : (
              <span className="config-hint">
                <button type="button" className="config-btn config-btn-sm" onClick={() => setConfirmClear(true)}>{tx('memoryClear', '清空记忆')}</button>
                {memory.droppedCount > 0 && <em> ({tx('memoryDropped', '已裁掉')} {memory.droppedCount})</em>}
              </span>
            )
          )}
        </div>
      )}
      {memoryError && <div className="config-row config-row-stacked"><span className="config-hint">{memoryError}</span></div>}

      <div className="config-row">
        <span className="config-label"><Highlight text={tx('session', '会话')} query={searchQuery} /></span>
        <span className="config-hint">
          {status?.hasSession
            ? `${status.turns} ${tx('sessionTurns', '轮')} · ${status.model}`
            : tx('sessionNone', '尚无会话(说句话就开始)')}
        </span>
        <button type="button" className="config-btn config-btn-sm" onClick={() => void resetSession()} disabled={!status?.hasSession}>
          {tx('sessionReset', '重置会话')}
        </button>
        <span className="config-hint">{tx('sessionResetHint', '保留记忆,只清上下文')}</span>
      </div>
      {statusLoaded && !status?.available && (
        <div className="config-row config-row-stacked">
          <span className="config-hint">{tx('serverUnavailable', '服务端语音伙伴接口不可用(需重启 Tide Commander 加载新路由)')}</span>
        </div>
      )}

      <div className="config-row config-row-stacked">
        {error && <span className="config-hint">{tx('saveFailed', '保存失败')}: {error}</span>}
        <button
          type="button"
          className="config-btn"
          onClick={() => void handleSave()}
          disabled={saving || (!dirty && !saved)}
        >
          {saving ? tx('saving', '保存中…') : saved ? tx('saved', '已保存') : tx('save', '保存语音伙伴设置')}
        </button>
      </div>
    </>
  );
}

/** 逗号(中英文)分隔的结束词文本 → 数组(去空、去重、限 10 个)。 */
function parseEndWords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[,，]/)) {
    const word = part.trim();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= 10) break;
  }
  return out;
}
