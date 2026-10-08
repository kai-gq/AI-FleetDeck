/**
 * 「声纹门禁」设置块(工具箱 → 语音伙伴 面板末尾)
 *
 * 挂在 ConfigSection.tsx 的 voiceCompanion 节里、VoiceCompanionSection 之后
 * (零触碰 VoiceCompanionSection/settingsSearch 等热词 WIP 文件)。
 * 功能:状态展示 / 开关 / 录 20 秒注册 / 删除(两步确认)。
 * 全部文案走 t('config:voiceCompanion.…', { defaultValue: '中文' }),不新增 locale 文件。
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchVoiceprintStatus,
  setVoiceprintEnabled,
  enrollVoiceprint,
  deleteVoiceprint,
  type VoiceprintStatus,
} from '../../api/voiceprint';
import { useVoiceprintRecorder, VOICEPRINT_RECORD_SECONDS } from '../../hooks/useVoiceprintRecorder';

// 紧凑开关(与 ConfigSection/VoiceCompanionSection 内的私有 Toggle 同款;不复用 = 不动作者文件导出)
function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="config-toggle">
      <input
        type="checkbox"
        className="config-toggle-input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="config-toggle-track">
        <span className="config-toggle-thumb" />
      </span>
    </label>
  );
}

const LEVEL_BARS = '▁▂▃▄▅▆▇█';

/** RMS(约 0..0.4)→ 迷你电平文本条。 */
function levelBar(rms: number): string {
  const idx = Math.max(0, Math.min(LEVEL_BARS.length - 1, Math.round(Math.min(1, rms * 6) * (LEVEL_BARS.length - 1))));
  return LEVEL_BARS[idx]!.repeat(3);
}

function errText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

export function VoiceprintSettings() {
  const { t } = useTranslation(['config', 'common']);
  const tx = (key: string, fallback: string, opts?: Record<string, unknown>) =>
    t(`config:voiceCompanion.${key}`, { defaultValue: fallback, ...(opts ?? {}) });

  const [status, setStatus] = useState<VoiceprintStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState('主人');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const recorder = useVoiceprintRecorder();

  useEffect(() => {
    let alive = true;
    void fetchVoiceprintStatus()
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        if (s.registered && s.speakerName) setName(s.speakerName);
        setLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        setError(errText(err));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await fetchVoiceprintStatus());
    } catch (err) {
      setError(errText(err));
    }
  };

  const handleToggle = async (checked: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setStatus(await setVoiceprintEnabled(checked));
      setNotice(checked ? tx('voiceprintOnNotice', '声纹门禁已打开:下一段话起,只有你本人的声音会进大脑') : tx('voiceprintOffNotice', '声纹门禁已关闭(识别恢复原样)'));
    } catch (err) {
      setError(errText(err));
      await refresh(); // 失败后拉回真实状态
    } finally {
      setBusy(false);
    }
  };

  const handleRecord = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    const rec = await recorder.start(VOICEPRINT_RECORD_SECONDS);
    if (!rec) return; // 太短/取消/出错:原因在 recorder.error
    setBusy(true);
    try {
      const r = await enrollVoiceprint({
        audioBase64: rec.wavBase64,
        speakerName: name.trim() || '主人',
      });
      setStatus(r.status);
      setNotice(
        tx('voiceprintEnrollOk', '注册成功(SpeakId {{id}}…),门禁已打开', { id: r.speakId.slice(0, 8) }),
      );
    } catch (err) {
      setError(errText(err));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    setConfirmingDelete(false);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await deleteVoiceprint();
      setStatus(r.status);
      if (r.cloudDeleted || !r.cloudError) {
        setNotice(tx('voiceprintDeleteOk', '已删除声纹(本地配置已清除)'));
      } else {
        setNotice(tx('voiceprintDeletePartial', '本地配置已清除;云端条目删除未完成({{err}}),不影响使用', { err: r.cloudError }));
      }
    } catch (err) {
      setError(errText(err));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const registered = status?.registered === true;
  const canRecord = status !== null && status.hasCredentials && status.endpointSupported && !busy && !recorder.recording;
  const shownError = error ?? recorder.error;

  const statusLine = ((): string => {
    if (loading) return tx('voiceprintLoading', '正在读取声纹状态…');
    if (!status) return tx('voiceprintUnavailable', '声纹状态读取失败');
    if (status.corrupt) return tx('voiceprintCorrupt', '配置文件损坏 —— 重新注册或删除即可修复');
    if (!status.registered) return tx('voiceprintUnregistered', '未注册 —— 录制约 20 秒完成注册后打开门禁,只有你本人的声音会进大脑');
    if (status.enabled) return tx('voiceprintOn', '已开启 · {{name}}', { name: status.speakerName });
    return tx('voiceprintOff', '已关闭(已注册「{{name}}」)', { name: status.speakerName });
  })();

  return (
    <>
      <div className="config-group-heading">{tx('voiceprintHeading', '声纹门禁(只认主人)')}</div>
      <div className="config-row">
        <span className="config-label">{tx('voiceprintToggle', '启用声纹门禁')}</span>
        <Toggle
          checked={status?.enabled === true}
          disabled={!registered || busy}
          onChange={(checked) => void handleToggle(checked)}
        />
      </div>
      <div className="config-row config-row-stacked">
        <span className="config-hint">{statusLine}</span>
        {registered && status?.createdAt && (
          <span className="config-hint">
            {tx('voiceprintCreatedAt', '注册于 {{at}}', { at: new Date(status.createdAt).toLocaleString() })}
          </span>
        )}
        {registered && status && !status.endpointSupported && !status.corrupt && (
          <span className="config-hint">
            {tx('voiceprintEndpointWarn', '注意:当前转写端点 {{endpoint}} 不支持声纹(需 bigmodel_async 二遍链路)—— 请将上方端点切为 bigmodel_async', { endpoint: status.endpoint })}
          </span>
        )}
      </div>

      {/* 注册块 */}
      <div className="config-row">
        <span className="config-label">{tx('voiceprintName', '称呼(注册名)')}</span>
        <input
          type="text"
          className="config-input config-input-sm"
          value={name}
          maxLength={40}
          disabled={busy || recorder.recording}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="config-row config-row-stacked">
        <span className="config-hint">
          {tx('voiceprintPrivacy', '注册采样约 20 秒:请用平时对电脑说话的同一支麦克风,自然说满全程。样例会临时上传到公共文件床(1 小时后自动删除)。录制前建议先关掉语音聆听,避免被自己的播报干扰。')}
        </span>
        {status && !status.hasCredentials && (
          <span className="config-hint">
            {tx('voiceprintNeedKey', '注册需要新版 ApiKey(声纹管理接口不支持旧版 appId/accessToken)—— 请先在本节上方把火山凭据配好。')}
          </span>
        )}
      </div>
      <div className="config-row">
        {recorder.recording ? (
          <>
            <span className="config-label">
              {tx('voiceprintRecording', '录音中…还剩 {{s}} 秒', { s: recorder.secondsLeft })}
            </span>
            <span className="config-hint">{levelBar(recorder.level)}</span>
            <button className="config-btn config-btn-sm" onClick={() => recorder.stop()}>
              {tx('voiceprintStop', '提前结束')}
            </button>
          </>
        ) : (
          <button className="config-btn config-btn-sm" disabled={!canRecord} onClick={() => void handleRecord()}>
            {busy
              ? tx('voiceprintUploading', '上传注册中…')
              : registered
                ? tx('voiceprintRerecord', '重新录制 20 秒')
                : tx('voiceprintRecord', '录制 20 秒')}
          </button>
        )}
      </div>

      {(shownError || notice) && (
        <div className="config-row config-row-stacked">
          {shownError && <span className="config-hint">{shownError}</span>}
          {notice && <span className="config-hint">{notice}</span>}
        </div>
      )}

      {/* 删除块(两步确认;抄 AboutSection 的 confirming 模式) */}
      {registered && (
        <div className="config-row">
          {confirmingDelete ? (
            <>
              <span className="config-hint">
                {tx('voiceprintDeleteConfirm', '确认删除声纹?删除后门禁失效(可随时重新录制注册);云端条目将一并软删除。')}
              </span>
              <button className="config-btn config-btn-sm" disabled={busy} onClick={() => void handleDelete()}>
                {tx('voiceprintDeleteYes', '确认删除')}
              </button>
              <button className="config-btn config-btn-sm" onClick={() => setConfirmingDelete(false)}>
                {tx('voiceprintCancel', '取消')}
              </button>
            </>
          ) : (
            <button className="config-btn config-btn-sm" disabled={busy || recorder.recording} onClick={() => setConfirmingDelete(true)}>
              {tx('voiceprintDelete', '删除声纹…')}
            </button>
          )}
        </div>
      )}
    </>
  );
}
