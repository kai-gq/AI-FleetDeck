/**
 * ASR 热词管理弹窗(火山流式识别的内联热词池)
 *
 * 自包含弹窗(与「控制」弹窗同款外壳),由 FAB / 移动端菜单的麦克风按钮打开;
 * 原「语音伙伴」设置面板里的内联热词区块已整体迁移至此;「记忆」Tab 同源 ——
 * 语音伙伴大脑记忆的管理面(原设置面板「记忆」区块迁来:查看 / 删单条 / 清空)。
 *
 * 标签页:热词(默认)/ 记忆。
 * 热词两个分组(服务端 hotwordsSnapshot 的镜像):
 *   Agent 名  实时来自 agent-service;新增/改名/删除自动同步,不可删改;必进注入窗口
 *   动态池    manual/agent 词;可删(删除 = 拉黑,智能更新不再收录)
 * 「智能更新」= 服务端增量读大脑对话 → AI 筛选 → 硬校验合并(同步等待 10~30s);
 * 「上次分析」时间可选 = 分析起点覆写(refresh 传 since,可改选更早重看/更晚跳过)。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useModalClose } from '../hooks';
import { Icon } from './Icon';
import { ModalPortal } from './shared/ModalPortal';
import {
  addVoiceHotword,
  fetchVoiceHotwords,
  getVoiceCompanionMemory,
  refreshVoiceHotwords,
  removeVoiceHotword,
  updateVoiceCompanionMemory,
  type CompanionMemory,
  type VoiceHotwordEntry,
  type VoiceHotwordsSnapshot,
} from '../api/voiceCompanion';

/** ISO → datetime-local 值(本地时区、分钟精度);null/非法 → ''。 */
function toLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const local = new Date(t - new Date(t).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

interface AsrHotwordsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AsrHotwordsModal({ isOpen, onClose }: AsrHotwordsModalProps) {
  const { t } = useTranslation(['config', 'common']);
  const tx = (key: string, fallback: string) => t(`config:voiceCompanion.${key}`, { defaultValue: fallback });

  const [hotwords, setHotwords] = useState<VoiceHotwordsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [input, setInput] = useState('');
  /** 「上次分析」时间(可选,datetime-local 值);'' = 默认(节点/首次回看 7 天)。 */
  const [sinceInput, setSinceInput] = useState('');

  /** 当前 Tab:热词(默认)/ 记忆 */
  const [tab, setTab] = useState<'hotwords' | 'memory'>('hotwords');
  /** 记忆 Tab(懒加载:切到该 Tab 才拉取;刷新按钮可重拉) */
  const [memory, setMemory] = useState<CompanionMemory | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const { handleMouseDown: handleBackdropMouseDown, handleClick: handleBackdropClick } = useModalClose(onClose);

  // Escape 关闭(捕获阶段,与 ControlsModal 同款)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose]);

  // 打开时拉快照(agent 名实时,窗口随池变化)
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    setMsg(null);
    setError(null);
    setTab('hotwords'); // 每次打开回到默认 Tab
    setMemory(null); // 记忆每次打开重拉(切到记忆 Tab 时)
    setMemoryError(null);
    setConfirmClear(false);
    void fetchVoiceHotwords()
      .then((snap) => {
        if (!alive) return;
        setHotwords(snap);
        setSinceInput(toLocalInputValue(snap.lastAnalyzedAt)); // 预填当前节点;可改选
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [isOpen]);

  // 智能更新:服务端增量读对话 + 筛选(同步等待 10~30s,期间按钮转圈)
  // sinceInput 非空 → 以它为分析起点(可改选更早重看/更晚跳过);空 = 服务端默认
  const refreshPool = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const since = sinceInput ? new Date(sinceInput).toISOString() : undefined;
      const { result, hotwords: snap } = await refreshVoiceHotwords(since);
      setHotwords(snap);
      setSinceInput(toLocalInputValue(snap.lastAnalyzedAt)); // 更新后回到新节点
      setMsg(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [sinceInput]);

  const addWord = useCallback(async () => {
    const word = input.trim();
    if (!word) return;
    setError(null);
    try {
      const { added, locked, hotwords: snap } = await addVoiceHotword(word);
      setHotwords(snap);
      setInput('');
      setMsg(
        locked
          ? `「${word}」${tx('hotwordsLocked', '已在锁定词中(agent 名,无需添加)')}`
          : added
            ? `${tx('hotwordsAdded', '已添加')}「${word}」`
            : `「${word}」${tx('hotwordsExists', '已在表中')}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [input, tx]);

  const removeWord = useCallback(async (word: string) => {
    setError(null);
    try {
      const { hotwords: snap } = await removeVoiceHotword(word);
      setHotwords(snap);
      setMsg(`${tx('hotwordsRemoved', '已删除(不再自动收录)')}「${word}」`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tx]);

  // ---- 记忆 Tab(懒加载 + 删单条/清空) ----

  const loadMemory = useCallback(async () => {
    setMemoryLoading(true);
    setMemoryError(null);
    try {
      const next = await getVoiceCompanionMemory();
      if (next) setMemory(next);
      else setMemoryError(tx('memoryUnavailable', '记忆服务不可用(需服务端运行)'));
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setMemoryLoading(false);
    }
  }, [tx]);

  const selectTab = useCallback((next: 'hotwords' | 'memory') => {
    setTab(next);
    setConfirmClear(false);
    if (next === 'memory' && !memory && !memoryLoading) void loadMemory();
  }, [memory, memoryLoading, loadMemory]);

  const deleteNote = useCallback(async (id: string) => {
    setMemoryError(null);
    try {
      const next = await updateVoiceCompanionMemory({ ops: [{ op: 'remove', id }] });
      if (next) setMemory(next);
      else setMemoryError(tx('memoryUnavailable', '记忆服务不可用(需服务端运行)'));
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : String(err));
    }
  }, [tx]);

  const clearMemory = useCallback(async () => {
    setMemoryError(null);
    try {
      const next = await updateVoiceCompanionMemory({ clear: true });
      setConfirmClear(false);
      if (next) setMemory(next);
      else setMemoryError(tx('memoryUnavailable', '记忆服务不可用(需服务端运行)'));
    } catch (err) {
      setConfirmClear(false);
      setMemoryError(err instanceof Error ? err.message : String(err));
    }
  }, [tx]);

  if (!isOpen) return null;

  return (
    <ModalPortal>
    {/* portal 到 body:弹窗若留在 .fab-rail(z:150 堆叠上下文)内,会被 .commander-overlay(z:900)的 agent 面板盖住(视觉+点击) */}
    <div className="shortcuts-modal-overlay" onMouseDown={handleBackdropMouseDown} onClick={handleBackdropClick}>
      <div className="shortcuts-modal controls-modal asr-hotwords-modal">
        {/* Header */}
        <div className="shortcuts-modal-header">
          <div className="shortcuts-modal-title">
            <Icon name="microphone" size={20} />
            <span>{tx('hotwords', 'ASR 热词')}</span>
          </div>
          <button className="shortcuts-modal-close" onClick={onClose}>
            &times;
          </button>
        </div>

        {/* Tabs:热词(默认)/ 记忆 */}
        <div className="hotwords-tabs">
          <button
            type="button"
            className={`hotwords-tab${tab === 'hotwords' ? ' is-active' : ''}`}
            onClick={() => selectTab('hotwords')}
          >
            {tx('tabHotwords', '热词')}
          </button>
          <button
            type="button"
            className={`hotwords-tab${tab === 'memory' ? ' is-active' : ''}`}
            onClick={() => selectTab('memory')}
          >
            {tx('tabMemory', '记忆')}
          </button>
        </div>

        {tab === 'hotwords' ? (
          <>
        {/* ---- 热词 Tab ---- */}
        {/* Toolbar:智能更新 + 上次分析(可选,= 分析起点) + 注入窗口 */}
        <div className="hotwords-toolbar">
          <button
            type="button"
            className="config-btn config-btn-sm"
            onClick={() => void refreshPool()}
            disabled={busy}
            title={tx('hotwordsRefreshTitle', '读你与大脑最近的对话,自动筛选出容易被听错的专有名词(约 10~30 秒)')}
          >
            {busy ? tx('hotwordsRefreshing', '更新中…(10~30 秒)') : tx('hotwordsRefresh', '智能更新')}
          </button>
          <label
            className="hotwords-since"
            title={tx('hotwordsSinceTitle', '分析起点:智能更新从这个时间之后读对话。可改选更早(重看)或更晚(跳过);清除 = 默认(上次分析时间,首次回看 7 天)')}
          >
            <span className="shortcuts-modal-hint">{tx('hotwordsLastAnalyzed', '上次分析')}</span>
            <input
              type="datetime-local"
              className="config-input hotwords-since-input"
              value={sinceInput}
              placeholder={tx('hotwordsNever', '尚未分析(首次会回看最近 7 天对话)')}
              disabled={busy}
              onChange={(e) => setSinceInput(e.target.value)}
            />
            {sinceInput && (
              <button
                type="button"
                className="hotwords-since-clear"
                title={tx('hotwordsSinceClear', '清除(回到默认:按上次分析时间增量)')}
                onClick={() => setSinceInput('')}
              >
                ×
              </button>
            )}
          </label>
          <span className="hotwords-window-badge" title={tx('hotwordsWindowTitle', '注入窗口:超过上限的词不注入识别(超限会污染基础识别,故硬锁)')}>
            {tx('hotwordsWindow', '注入窗口')} {hotwords ? hotwords.injectTopN : '–'}
          </span>
        </div>

        <div className="shortcuts-modal-content">
          {msg && <div className="hotwords-msg">{msg}</div>}
          {error && (
            <div className="hotwords-msg hotwords-msg--error">
              {tx('hotwordsUnavailable', '热词服务不可用')}: {error}
            </div>
          )}

          {hotwords && (
            <>
              <HotwordGroup
                title={tx('hotwordsAgentTitle', 'Agent 名')}
                badge={tx('hotwordsLockedBadge', '锁定')}
                hint={tx('hotwordsAgentHint', '必进注入窗口;新增/改名/删除 agent 自动同步,不可删改')}
                entries={hotwords.agentNames}
                emptyHint={tx('hotwordsAgentEmpty', '还没有 agent')}
              />

              <div className="hotwords-group">
                <div className="hotwords-group-head">
                  <span className="hotwords-group-title">
                    {tx('hotwordsPoolTitle', '动态池')}
                    <em className="hotwords-group-count">{hotwords.words.length}</em>
                  </span>
                  <span className="hotwords-group-hint">
                    {tx('hotwordsPoolHint', '点 × 删除 = 不再自动收录(加入屏蔽名单)')}
                  </span>
                </div>
                {hotwords.words.length === 0 ? (
                  <span className="config-hint">
                    {tx('hotwordsEmpty', '还没有热词——点「智能更新」从最近的对话里筛,或在下方手动添加')}
                  </span>
                ) : (
                  <div className="hotwords-chips">
                    {hotwords.words.map((w) => (
                      <HotwordChip key={w.word} entry={w} onRemove={() => void removeWord(w.word)} removeTitle={tx('hotwordsRemove', '删除(加入屏蔽名单,智能更新不再收录)')} />
                    ))}
                  </div>
                )}
                {hotwords.blockedCount > 0 && (
                  <span className="hotwords-group-hint">
                    {tx('hotwordsBlocked', '已屏蔽')} {hotwords.blockedCount} {tx('hotwordsBlockedUnit', '个词(删除过的不会自动加回)')}
                  </span>
                )}
              </div>

              <div className="hotwords-add-row">
                <input
                  className="config-input"
                  value={input}
                  placeholder={tx('hotwordsAddPlaceholder', '手动添加热词(不含空格)…')}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addWord();
                  }}
                />
                <button type="button" className="config-btn config-btn-sm" onClick={() => void addWord()} disabled={!input.trim()}>
                  {tx('hotwordsAdd', '添加')}
                </button>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="shortcuts-modal-footer">
          <span className="shortcuts-modal-hint">
            {tx('hotwordsLegend', '● 已在当前注入窗口　○ 窗口外不注入。窗口内按优先级取词(agent 名/手动词必进,其余按权重),改词下一句生效。')}
          </span>
        </div>
          </>
        ) : (
          <>
            {/* ---- 记忆 Tab(语音伙伴大脑记忆:查看 / 删单条 / 清空) ---- */}
            <div className="hotwords-toolbar">
              <button
                type="button"
                className="config-btn config-btn-sm"
                onClick={() => void loadMemory()}
                disabled={memoryLoading}
                title={tx('memoryRefreshTitle', '重新读取大脑记忆(新条目来自对话自动沉淀)')}
              >
                {memoryLoading ? tx('memoryLoading', '读取中…') : tx('memoryRefresh', '查看 / 刷新')}
              </button>
              <span className="hotwords-window-badge" title={tx('memoryCountTitle', '记忆条目数(超出上限自动裁掉最旧)')}>
                {tx('memoryCount', '条数')} {memory ? memory.notes.length : '–'}
              </span>
            </div>

            <div className="shortcuts-modal-content">
              {memoryError && <div className="hotwords-msg hotwords-msg--error">{memoryError}</div>}
              {!memory && !memoryError && memoryLoading && (
                <span className="config-hint">{tx('memoryLoading', '读取中…')}</span>
              )}
              {memory && (
                <>
                  {memory.summary && (
                    <div className="hotwords-msg">{tx('memorySummary', '摘要')}: {memory.summary}</div>
                  )}
                  {memory.notes.length === 0 ? (
                    <span className="config-hint">{tx('memoryEmpty', '还没有记忆条目——聊几次就攒起来了')}</span>
                  ) : (
                    <div className="hotwords-notes">
                      {memory.notes.map((note) => (
                        <div className="hotwords-note" key={note.id}>
                          <span className="hotwords-note-text">{note.text}</span>
                          <em className="hotwords-note-source">
                            {note.source === 'auto' ? tx('memoryAuto', '自动') : tx('memoryUser', '手动')}
                          </em>
                          <button
                            type="button"
                            className="hotwords-chip-remove"
                            title={tx('memoryDelete', '删除这条')}
                            onClick={() => void deleteNote(note.id)}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {memory.notes.length > 0 && (
                    <div className="hotwords-note-actions">
                      {confirmClear ? (
                        <>
                          <span className="config-hint">{tx('memoryClearConfirm', '确定清空全部记忆?')}</span>
                          <button type="button" className="config-btn config-btn-sm" onClick={() => void clearMemory()}>
                            {tx('memoryClearYes', '清空')}
                          </button>
                          <button
                            type="button"
                            className="config-btn config-btn-sm"
                            onClick={() => setConfirmClear(false)}
                          >
                            {t('common:buttons.cancel', { defaultValue: '取消' })}
                          </button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="config-btn config-btn-sm" onClick={() => setConfirmClear(true)}>
                            {tx('memoryClear', '清空记忆')}
                          </button>
                          {memory.droppedCount > 0 && (
                            <em className="hotwords-group-hint">
                              {tx('memoryDropped', '已裁掉')} {memory.droppedCount}
                            </em>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="shortcuts-modal-footer">
              <span className="shortcuts-modal-hint">
                {tx('memoryLegend', '记忆由你与大脑的对话自动沉淀(「自动」= 模型自己记的,「手动」= 对话里明确要求记的);× 删单条,清空不可撤销;会话与记忆互不影响。')}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
    </ModalPortal>
  );
}

// ============================================================================
// 分组与词条
// ============================================================================

interface HotwordGroupProps {
  title: string;
  /** 锁定徽章文本(为空 = 非锁定组)。 */
  badge: string;
  hint: string;
  entries: VoiceHotwordEntry[];
  emptyHint: string;
}

function HotwordGroup({ title, badge, hint, entries, emptyHint }: HotwordGroupProps) {
  const { t } = useTranslation(['config']);
  const tx = (key: string, fallback: string) => t(`config:voiceCompanion.${key}`, { defaultValue: fallback });
  return (
    <div className="hotwords-group">
      <div className="hotwords-group-head">
        <span className="hotwords-group-title">
          {title}
          {badge && <em className="hotwords-lock-badge">{badge}</em>}
          <em className="hotwords-group-count">{entries.length}</em>
        </span>
        <span className="hotwords-group-hint">{hint}</span>
      </div>
      {entries.length === 0 ? (
        <span className="config-hint">{emptyHint}</span>
      ) : (
        <div className="hotwords-chips">
          {entries.map((w) => (
            <HotwordChip key={w.word} entry={w} />
          ))}
        </div>
      )}
    </div>
  );
}

interface HotwordChipProps {
  entry: VoiceHotwordEntry;
  /** 提供则渲染删除按钮(仅动态池)。 */
  onRemove?: () => void;
  removeTitle?: string;
}

function HotwordChip({ entry, onRemove, removeTitle }: HotwordChipProps) {
  const { t } = useTranslation(['config']);
  const tx = (key: string, fallback: string) => t(`config:voiceCompanion.${key}`, { defaultValue: fallback });
  const title = `${entry.injected ? tx('hotwordsInWindow', '已在注入窗口') : tx('hotwordsOutWindow', '窗口外(不注入)')} · ${tx('hotwordsWeight', '权重')} ${entry.weight}${entry.count > 0 ? ` · ${tx('hotwordsCount', '提及')} ${entry.count}` : ''}${entry.source === 'manual' ? ` · ${tx('hotwordsManual', '手动')}` : ''}`;
  return (
    <span className={`hotwords-chip${entry.injected ? ' is-injected' : ''}`} title={title}>
      <span className="hotwords-chip-dot">{entry.injected ? '●' : '○'}</span>
      <strong>{entry.word}</strong>
      <em className="hotwords-chip-meta">{entry.weight}</em>
      {onRemove && (
        <button type="button" className="hotwords-chip-remove" title={removeTitle} onClick={onRemove}>
          ×
        </button>
      )}
    </span>
  );
}
