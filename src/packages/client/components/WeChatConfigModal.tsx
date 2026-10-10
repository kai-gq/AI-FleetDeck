/**
 * WeChatConfigModal — Custom settings panel for the WeChat (ClawBot) integration.
 *
 * Rendered INLINE inside IntegrationsPanel via the getCustomSettingsComponent()
 * extension point (contract: {integration, onSave, onCancel}), not as its own
 * modal portal. Flow: status card → enable/rate draft + save → QR binding
 * (server-side login session, 2.5s status polling) → connected actions
 * (logout, test send via recent inbound with server-side context-token backfill).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { IntegrationInfo } from '../../shared/integration-types.js';
import { QrCodeSvg } from './shared/QrCodeSvg';
import { ConfirmModal } from './shared/ConfirmModal';
import { Icon } from './Icon';
import {
  cancelWeChatLogin,
  fetchWeChatConfig,
  fetchWeChatLoginStatus,
  fetchWeChatRecentInbound,
  fetchWeChatStatus,
  logoutWeChat,
  sendWeChatMessage,
  startWeChatLogin,
  type WeChatConnectionState,
  type WeChatLoginSession,
  type WeChatRecentInboundEntry,
  type WeChatStatus,
} from '../api/wechat-settings';
import '../styles/components/wechat-config-modal.scss';

// IntegrationsPanel.tsx keeps CustomSettingsProps unexported; redeclare locally
// (same pattern as SlackMultiInstanceSetup.tsx).
interface CustomSettingsProps {
  integration: IntegrationInfo;
  onSave: (config: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}

const QR_POLL_INTERVAL_MS = 2500;

const STATE_LABELS: Record<WeChatConnectionState, string> = {
  disabled: '已禁用',
  disconnected: '未连接',
  qr_pending: '等待扫码',
  connected: '已连接',
  needs_reauth: '需要重新扫码',
};

function formatTime(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

interface DraftSettings {
  enabled: boolean;
  sendRateLimitPerMinute: number;
}

interface InlineMessage {
  kind: 'success' | 'error';
  text: string;
}

export function WeChatConfigModal({ onSave, onCancel }: CustomSettingsProps) {
  const { t } = useTranslation(['config']);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [status, setStatus] = useState<WeChatStatus | null>(null);
  const [draft, setDraft] = useState<DraftSettings>({ enabled: false, sendRateLimitPerMinute: 20 });
  const [original, setOriginal] = useState<DraftSettings>({ enabled: false, sendRateLimitPerMinute: 20 });

  // QR login session (server-side; survives panel reopen while pending)
  const [login, setLogin] = useState<WeChatLoginSession | null>(null);
  const [loginStarting, setLoginStarting] = useState(false);
  const [loginMessage, setLoginMessage] = useState<InlineMessage | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Countdown clock (1s tick while a QR session is pending)
  const [now, setNow] = useState(() => Date.now());

  // Test send
  const [recentInbound, setRecentInbound] = useState<WeChatRecentInboundEntry[]>([]);
  const [testTo, setTestTo] = useState('');
  const [testText, setTestText] = useState('');
  const [testSending, setTestSending] = useState(false);
  const [testStatus, setTestStatus] = useState<InlineMessage | null>(null);

  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);

  const isDirty = draft.enabled !== original.enabled || draft.sendRateLimitPerMinute !== original.sendRateLimitPerMinute;
  const state: WeChatConnectionState = status?.state ?? 'disconnected';
  const isConnected = state === 'connected';

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const refreshStatus = useCallback(async (): Promise<WeChatStatus | null> => {
    try {
      const next = await fetchWeChatStatus();
      setStatus(next);
      return next;
    } catch {
      return null; // surfaced via the main error banner on load
    }
  }, []);

  const refreshRecentInbound = useCallback(async () => {
    try {
      const items = await fetchWeChatRecentInbound();
      setRecentInbound(items);
      setTestTo((prev) => (prev && items.some((i) => i.userId === prev) ? prev : (items[0]?.userId ?? '')));
    } catch {
      setRecentInbound([]);
    }
  }, []);

  const pollLogin = useCallback(async () => {
    try {
      const result = await fetchWeChatLoginStatus();
      if (!result.login) {
        setLogin(null);
        stopPolling();
        return;
      }
      setLogin(result.login);
      if (result.login.confirmed) {
        stopPolling();
        setLoginMessage({
          kind: 'success',
          text: t('config:wechat.loginConfirmed', { defaultValue: '扫码成功，微信已连接。' }),
        });
        await refreshStatus();
        const cfg = await fetchWeChatConfig().catch(() => null);
        if (cfg) {
          const next = { enabled: cfg.enabled, sendRateLimitPerMinute: cfg.sendRateLimitPerMinute };
          setDraft(next);
          setOriginal(next);
        }
        void refreshRecentInbound();
        return;
      }
      if (result.login.status === 'expired') {
        stopPolling();
        return;
      }
    } catch (err) {
      setLoginMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : t('config:wechat.errors.loginStatusFailed', { defaultValue: '获取扫码状态失败' }),
      });
    }
    pollTimerRef.current = setTimeout(() => {
      void pollLogin();
    }, QR_POLL_INTERVAL_MS);
  }, [refreshRecentInbound, refreshStatus, stopPolling, t]);

  const loadAll = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setSuccess(null);
      const [nextStatus, config, loginStatus] = await Promise.all([
        fetchWeChatStatus(),
        fetchWeChatConfig(),
        fetchWeChatLoginStatus(),
      ]);
      setStatus(nextStatus);
      const nextDraft = { enabled: config.enabled, sendRateLimitPerMinute: config.sendRateLimitPerMinute };
      setDraft(nextDraft);
      setOriginal(nextDraft);
      if (loginStatus.login && !loginStatus.login.confirmed) {
        // An in-flight server-side QR session (e.g. panel was reopened).
        setLogin(loginStatus.login);
        stopPolling();
        pollTimerRef.current = setTimeout(() => {
          void pollLogin();
        }, QR_POLL_INTERVAL_MS);
      } else {
        setLogin(null);
      }
      if (nextStatus.state === 'connected') {
        void refreshRecentInbound();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('config:wechat.errors.loadFailed', { defaultValue: '加载微信集成设置失败' }));
    } finally {
      setLoading(false);
    }
  }, [pollLogin, refreshRecentInbound, stopPolling, t]);

  useEffect(() => {
    void loadAll();
    return () => {
      stopPolling();
    };
    // loadAll is stable enough for mount-only execution here; re-running on
    // every identity change would restart the poll loop mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!login || login.confirmed || login.status === 'expired') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [login]);

  const remainingSec = useMemo(() => {
    if (!login) return 0;
    void now; // re-evaluated on each 1s tick
    return Math.max(0, Math.ceil((login.deadlineAt - Date.now()) / 1000));
  }, [login, now]);

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);
      await onSave({
        enabled: draft.enabled,
        sendRateLimitPerMinute: draft.sendRateLimitPerMinute,
      });
      setOriginal(draft);
      setSuccess(t('config:wechat.saved', { defaultValue: '设置已保存。' }));
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('config:wechat.errors.saveFailed', { defaultValue: '保存失败' }));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setDraft(original);
    setError(null);
    setSuccess(null);
  };

  const handleStartLogin = async () => {
    try {
      setLoginStarting(true);
      setError(null);
      setSuccess(null);
      setLoginMessage(null);
      stopPolling();
      const session = await startWeChatLogin();
      setLogin(session);
      pollTimerRef.current = setTimeout(() => {
        void pollLogin();
      }, QR_POLL_INTERVAL_MS);
    } catch (err) {
      setLoginMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : t('config:wechat.errors.loginStartFailed', { defaultValue: '启动扫码登录失败' }),
      });
    } finally {
      setLoginStarting(false);
    }
  };

  const handleCancelLogin = async () => {
    stopPolling();
    try {
      await cancelWeChatLogin();
    } catch {
      /* best-effort — session also expires server-side */
    }
    setLogin(null);
    setLoginMessage(null);
  };

  const performLogout = async () => {
    try {
      setError(null);
      setSuccess(null);
      await logoutWeChat();
      setLogin(null);
      setLoginMessage(null);
      setRecentInbound([]);
      setTestStatus(null);
      setSuccess(t('config:wechat.loggedOut', { defaultValue: '已断开微信连接。' }));
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('config:wechat.errors.logoutFailed', { defaultValue: '断开连接失败' }));
    } finally {
      setLogoutConfirmOpen(false);
    }
  };

  const handleSendTest = async () => {
    const to = testTo.trim();
    const text = testText.trim();
    if (!to || !text) return;
    try {
      setTestSending(true);
      setTestStatus(null);
      await sendWeChatMessage(to, text);
      setTestText('');
      setTestStatus({ kind: 'success', text: t('config:wechat.testSent', { defaultValue: '测试消息已发送。' }) });
    } catch (err) {
      setTestStatus({
        kind: 'error',
        text: err instanceof Error ? err.message : t('config:wechat.errors.testSendFailed', { defaultValue: '发送测试消息失败' }),
      });
    } finally {
      setTestSending(false);
    }
  };

  if (loading) {
    return (
      <div className="wechat-config-panel">
        <div className="wc-loading">
          <div className="wc-spinner" />
          <p>{t('config:wechat.loading', { defaultValue: '加载中…' })}</p>
        </div>
      </div>
    );
  }

  const showQrPanel = Boolean(login && !login.confirmed);

  return (
    <div className="wechat-config-panel">
      <p className="wc-description">
        {t('config:wechat.description', {
          defaultValue:
            '通过腾讯 ClawBot（iLink）接入个人微信：扫码绑定后，收到的私聊消息可驱动触发器并由 agent 回复。同一微信同时只能绑定一个实例。',
        })}
      </p>

      {error && (
        <div className="wc-alert wc-alert-error">
          <Icon name="warn" size={14} />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="wc-alert wc-alert-success">
          <Icon name="check" size={14} />
          <span>{success}</span>
        </div>
      )}

      {/* ── Status card ── */}
      <section className="wc-section">
        <h3 className="wc-section-title">{t('config:wechat.sections.status', { defaultValue: '连接状态' })}</h3>
        <div className="wc-status-card">
          <span className={`wc-state-badge wc-state-${state}`}>
            <span className="wc-state-dot" />
            {t(`config:wechat.state.${state}`, { defaultValue: STATE_LABELS[state] })}
          </span>
          {status?.needsReauth && (
            <span className="wc-hint wc-hint-warn">
              {t('config:wechat.needsReauthHint', { defaultValue: '登录态已失效，请重新扫码绑定。' })}
            </span>
          )}
        </div>
        <div className="wc-meta-grid">
          <div className="wc-meta-row">
            <span className="wc-meta-label">{t('config:wechat.botUserId', { defaultValue: '机器人账号' })}</span>
            <span className="wc-meta-value">{status?.botUserId || '—'}</span>
          </div>
          <div className="wc-meta-row">
            <span className="wc-meta-label">{t('config:wechat.connectedAt', { defaultValue: '绑定时间' })}</span>
            <span className="wc-meta-value">{formatTime(status?.connectedAt)}</span>
          </div>
          <div className="wc-meta-row">
            <span className="wc-meta-label">{t('config:wechat.lastMessageAt', { defaultValue: '最近来消息' })}</span>
            <span className="wc-meta-value">{formatTime(status?.lastMessageAt)}</span>
          </div>
          {status?.lastError && (
            <div className="wc-meta-row">
              <span className="wc-meta-label">{t('config:wechat.lastError', { defaultValue: '最近错误' })}</span>
              <span className="wc-meta-value wc-meta-error">{status.lastError}</span>
            </div>
          )}
        </div>
      </section>

      {/* ── General settings ── */}
      <section className="wc-section">
        <h3 className="wc-section-title">{t('config:wechat.sections.general', { defaultValue: '常规' })}</h3>
        <div className="wc-field wc-field-row">
          <label htmlFor="wc-enabled" className="wc-label">
            {t('config:wechat.enabled', { defaultValue: '启用微信集成' })}
          </label>
          <label className="wc-toggle">
            <input
              id="wc-enabled"
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => {
                setDraft((prev) => ({ ...prev, enabled: e.target.checked }));
                setError(null);
                setSuccess(null);
              }}
            />
            <span className="wc-toggle-track">
              <span className="wc-toggle-thumb" />
            </span>
          </label>
        </div>
        <div className="wc-field">
          <label htmlFor="wc-rate" className="wc-label">
            {t('config:wechat.sendRateLimit', { defaultValue: '发送频率上限（条/分钟）' })}
          </label>
          <input
            id="wc-rate"
            type="number"
            min={1}
            max={120}
            className="wc-input wc-input-narrow"
            value={draft.sendRateLimitPerMinute}
            onChange={(e) => {
              const parsed = Number(e.target.value);
              setDraft((prev) => ({
                ...prev,
                sendRateLimitPerMinute: Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : prev.sendRateLimitPerMinute,
              }));
              setError(null);
              setSuccess(null);
            }}
          />
        </div>
        <div className="wc-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={handleSave} disabled={!isDirty || saving}>
            {saving ? t('config:wechat.saving', { defaultValue: '保存中…' }) : t('config:wechat.save', { defaultValue: '保存设置' })}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleReset} disabled={!isDirty || saving}>
            {t('config:wechat.reset', { defaultValue: '重置' })}
          </button>
        </div>
      </section>

      {/* ── QR binding ── */}
      <section className="wc-section">
        <h3 className="wc-section-title">{t('config:wechat.sections.binding', { defaultValue: '扫码绑定' })}</h3>

        {loginMessage && (
          <div className={`wc-alert ${loginMessage.kind === 'success' ? 'wc-alert-success' : 'wc-alert-error'}`}>
            <Icon name={loginMessage.kind === 'success' ? 'check' : 'warn'} size={14} />
            <span>{loginMessage.text}</span>
          </div>
        )}

        {showQrPanel && login ? (
          <div className="wc-qr-panel">
            <div className="wc-qr-header">
              <span>
                {login.status === 'expired'
                  ? t('config:wechat.qrExpired', { defaultValue: '二维码已超时，请重新获取。' })
                  : t('config:wechat.qrPrompt', { defaultValue: '请用微信扫描下方二维码完成绑定' })}
                {login.status !== 'expired' && remainingSec > 0 && (
                  <span className="wc-qr-countdown">
                    {t('config:wechat.qrRemaining', { defaultValue: '（剩余 {{sec}} 秒）', sec: remainingSec })}
                  </span>
                )}
              </span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={handleCancelLogin}>
                {login.status === 'expired'
                  ? t('config:wechat.close', { defaultValue: '关闭' })
                  : t('config:wechat.cancelQr', { defaultValue: '取消' })}
              </button>
            </div>
            {login.status === 'expired' ? (
              <div className="wc-qr-expired">
                <Icon name="hourglass" size={18} />
                <p>{login.error || t('config:wechat.qrExpired', { defaultValue: '二维码已超时，请重新获取。' })}</p>
              </div>
            ) : (
              <>
                <div className="wc-qr-image">
                  <QrCodeSvg
                    value={login.imgContent}
                    size={216}
                    label={t('config:wechat.qrImageAlt', { defaultValue: '微信绑定二维码' })}
                  />
                </div>
                <div className="wc-qr-loading-row">
                  <div className="wc-spinner wc-spinner-sm" />
                  <span>{t('config:wechat.waitingScan', { defaultValue: '等待扫码确认…' })}</span>
                </div>
              </>
            )}
          </div>
        ) : isConnected ? (
          <p className="wc-hint">
            {t('config:wechat.alreadyBound', { defaultValue: '当前微信已绑定。如需更换账号，请先断开连接再重新扫码。' })}
          </p>
        ) : (
          <div className="wc-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleStartLogin}
              disabled={loginStarting || state === 'qr_pending'}
            >
              {loginStarting
                ? t('config:wechat.qrStarting', { defaultValue: '正在获取二维码…' })
                : t('config:wechat.startQr', { defaultValue: '扫码绑定' })}
            </button>
          </div>
        )}
      </section>

      {/* ── Connected actions ── */}
      {isConnected && (
        <section className="wc-section">
          <h3 className="wc-section-title">{t('config:wechat.sections.actions', { defaultValue: '连接操作' })}</h3>
          <div className="wc-actions">
            <button type="button" className="btn btn-danger btn-sm" onClick={() => setLogoutConfirmOpen(true)}>
              {t('config:wechat.logout', { defaultValue: '断开连接' })}
            </button>
          </div>
          <span className="wc-hint">
            {t('config:wechat.logoutHint', {
              defaultValue: '断开后将清除本机保存的登录凭据，需要重新扫码才能再次连接。',
            })}
          </span>
        </section>
      )}

      {/* ── Test send ── */}
      {isConnected && (
        <section className="wc-section">
          <h3 className="wc-section-title">{t('config:wechat.sections.testMessage', { defaultValue: '发送测试消息' })}</h3>
          {recentInbound.length === 0 ? (
            <p className="wc-hint">
              {t('config:wechat.noRecentInbound', {
                defaultValue: '暂无可回复的联系人：让对方先给机器人发一条消息，再回到这里。',
              })}
            </p>
          ) : (
            <>
              <div className="wc-field">
                <label htmlFor="wc-test-to" className="wc-label">
                  {t('config:wechat.testTo', { defaultValue: '发送对象' })}
                </label>
                <select
                  id="wc-test-to"
                  className="wc-select"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                >
                  {recentInbound.map((item) => (
                    <option key={item.userId} value={item.userId} disabled={!item.hasContextToken}>
                      {item.displayName || item.userId}
                      {item.hasContextToken ? '' : t('config:wechat.notReplyable', { defaultValue: '（暂不可回复）' })}
                    </option>
                  ))}
                </select>
              </div>
              <div className="wc-field">
                <label htmlFor="wc-test-text" className="wc-label">
                  {t('config:wechat.testMessageBody', { defaultValue: '消息内容' })}
                </label>
                <textarea
                  id="wc-test-text"
                  className="wc-textarea"
                  rows={3}
                  placeholder={t('config:wechat.testMessagePlaceholder', { defaultValue: '输入要发送的测试消息…' })}
                  value={testText}
                  onChange={(e) => setTestText(e.target.value)}
                />
              </div>
              <div className="wc-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handleSendTest}
                  disabled={!testTo.trim() || !testText.trim() || testSending}
                >
                  {testSending
                    ? t('config:wechat.sending', { defaultValue: '发送中…' })
                    : t('config:wechat.sendTest', { defaultValue: '发送' })}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refreshRecentInbound()}>
                  <Icon name="refresh" size={12} />
                  {t('config:wechat.refreshContacts', { defaultValue: '刷新列表' })}
                </button>
              </div>
            </>
          )}
          {testStatus && (
            <div className={`wc-alert ${testStatus.kind === 'success' ? 'wc-alert-success' : 'wc-alert-error'}`}>
              <Icon name={testStatus.kind === 'success' ? 'check' : 'warn'} size={14} />
              <span>{testStatus.text}</span>
            </div>
          )}
        </section>
      )}

      <div className="wc-footer">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
          {t('config:wechat.close', { defaultValue: '关闭' })}
        </button>
      </div>

      <ConfirmModal
        isOpen={logoutConfirmOpen}
        title={t('config:wechat.logout', { defaultValue: '断开连接' })}
        message={t('config:wechat.confirmLogout', {
          defaultValue: '确定断开微信连接吗？本机保存的登录凭据将被清除，需要重新扫码。',
        })}
        confirmLabel={t('config:wechat.logout', { defaultValue: '断开连接' })}
        cancelLabel={t('common:buttons.cancel', { defaultValue: '取消' })}
        variant="danger"
        onConfirm={() => void performLogout()}
        onClose={() => setLogoutConfirmOpen(false)}
      />
    </div>
  );
}
