import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { store } from '../../store';
import { apiUrl, authFetch } from '../../utils/storage';
import type {
  PluginOutputRendererProps,
  PluginShellCommandPrepareResult,
  PluginShellCommandSudoRequestData,
} from '../types';
import { startStreamedExec, usesInsecureRemoteTransport } from './execution';

function isSudoRequestData(value: unknown): value is PluginShellCommandSudoRequestData {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<PluginShellCommandSudoRequestData>;
  return data.kind === 'shell-command-sudo-request'
    && typeof data.commandId === 'string'
    && typeof data.invocation === 'string'
    && Array.isArray(data.args)
    && data.args.every((argument) => typeof argument === 'string')
    && typeof data.challengeId === 'string'
    && typeof data.expiresAt === 'number'
    && (data.tail === undefined || typeof data.tail === 'number')
    && (data.grep === undefined || typeof data.grep === 'string');
}

function responseError(body: unknown, fallback: string): string {
  return body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : fallback;
}

function argsTextFromInvocation(invocation: string): string {
  const trimmed = invocation.trim();
  const command = trimmed.split(/\s+/, 1)[0] ?? '';
  return trimmed.slice(command.length).trim();
}

export function ShellCommandSudoRequestCard({ output, agentId }: PluginOutputRendererProps) {
  const { t } = useTranslation(['terminal', 'tools']);
  const data = isSudoRequestData(output.data) ? output.data : null;
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const insecureTransport = useMemo(usesInsecureRemoteTransport, []);

  if (!data) return <div className="shell-command-exec-missing">{t('terminal:shellSudo.invalidRequest', { defaultValue: 'Invalid sudo request' })}</div>;
  const dismiss = () => {
    if (agentId) store.dismissPluginOutput(agentId, output.instanceId);
  };

  const authorize = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!agentId) {
      setError(t('terminal:shellSudo.agentUnavailable', { defaultValue: 'The requesting agent is no longer available' }));
      return;
    }
    if (!password) {
      setError(t('terminal:shellSudo.enterPassword', { defaultValue: 'Enter your sudo password' }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let prepared: PluginShellCommandPrepareResult = {
        commandId: data.commandId,
        invocation: data.invocation,
        args: data.args,
        requiresSudo: true,
        challengeId: data.challengeId,
        expiresAt: data.expiresAt,
      };

      const authorizeChallenge = async (challengeId: string) => {
        const response = await authFetch(apiUrl('/api/plugins/shell-commands/sudo/authorize'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challengeId, password }),
        });
        const body = await response.json().catch(() => null) as { authorizationId?: string } | null;
        return { response, body };
      };

      let authorization = await authorizeChallenge(data.challengeId);
      if (authorization.response.status === 410) {
        // Pending approval contains no credential, so keeping the card alive is
        // safe. If its ephemeral server challenge aged out (or a dev hot reload
        // cleared memory), recreate the same visible invocation transparently
        // and apply the password only to that fresh challenge.
        const refreshResponse = await authFetch(apiUrl(
          `/api/plugins/shell-commands/${encodeURIComponent(data.commandId)}/prepare`,
        ), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, argsText: argsTextFromInvocation(data.invocation) }),
        });
        const refreshBody = await refreshResponse.json().catch(() => null) as {
          prepared?: PluginShellCommandPrepareResult;
        } | null;
        const refreshed = refreshBody?.prepared;
        if (!refreshResponse.ok || !refreshed?.challengeId) {
          throw new Error(responseError(refreshBody, t('terminal:shellSudo.authFailed', { defaultValue: 'Sudo authorization failed ({{status}})', status: refreshResponse.status })));
        }
        prepared = refreshed;
        authorization = await authorizeChallenge(refreshed.challengeId);
      }

      if (!authorization.response.ok || !authorization.body?.authorizationId) {
        throw new Error(responseError(authorization.body, t('terminal:shellSudo.authFailed', { defaultValue: 'Sudo authorization failed ({{status}})', status: authorization.response.status })));
      }
      startStreamedExec(prepared, agentId, authorization.body.authorizationId, {
        ...(data.tail ? { tail: data.tail } : {}),
        ...(data.grep ? { grep: data.grep } : {}),
      });
      setStarted(true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <section className={`shell-command-sudo-request${started ? ' is-started' : ''}`}>
      <header>
        <span className="shell-command-sudo-request__icon"><Icon name={started ? 'check' : 'lock'} size={15} /></span>
        <div>
          <strong>{started ? t('terminal:shellSudo.executionStarted', { defaultValue: 'Execution started' }) : t('terminal:shellSudo.sudoRequested', { defaultValue: 'Sudo authorization requested' })}</strong>
          <span>{started ? t('terminal:shellSudo.outputStreaming', { defaultValue: 'Output is streaming in a new command card.' }) : t('terminal:shellSudo.agentRequested', { defaultValue: 'An agent requested this trusted slash command.' })}</span>
        </div>
        <button type="button" onClick={dismiss} aria-label={t('terminal:shellSudo.dismissRequest', { defaultValue: 'Dismiss sudo request' })}><Icon name="close" size={11} /></button>
      </header>
      <code>{data.invocation}</code>
      {(data.grep || data.tail) && (
        <div className="shell-command-sudo-request__filters">
          <Icon name="search" size={10} /> {t('terminal:shellSudo.resultOnly', { defaultValue: 'Result only:' })}
          {data.grep && <code>grep {JSON.stringify(data.grep)}</code>}
          {data.tail && <code>tail -{data.tail}</code>}
        </div>
      )}
      {!started && (
        <form onSubmit={authorize}>
          {insecureTransport && (
            <div className="shell-command-sudo-request__warning" role="alert">
              <Icon name="warn" size={12} />
              <span><strong>{t('terminal:shellSudo.httpConnection', { defaultValue: 'HTTP connection' })}</strong>{t('terminal:shellSudo.insecureWarning', { defaultValue: 'Your password will be sent without HTTPS transport encryption. Continue only if you trust this network or VPN.' })}</span>
            </div>
          )}
          <label htmlFor={`shell-command-sudo-${data.challengeId}`}>{t('terminal:building.dbPassword')}</label>
          <input
            id={`shell-command-sudo-${data.challengeId}`}
            type="password"
            value={password}
            disabled={busy}
            autoComplete="current-password"
            enterKeyHint="go"
            spellCheck={false}
            onPointerDown={(event) => {
              // Some Android WebViews do not summon the IME when a nested
              // interactive card receives touch focus indirectly. Focus during
              // the actual touch gesture so the native keyboard is allowed.
              if (event.pointerType === 'touch' && document.activeElement !== event.currentTarget) {
                event.currentTarget.focus({ preventScroll: true });
              }
            }}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error && <div className="shell-command-sudo-request__error"><Icon name="warn" size={11} /> {error}</div>}
          <div className="shell-command-sudo-request__security">
            <Icon name="shield" size={10} /> {t('terminal:shellSudo.securityNote', { defaultValue: 'The password is handled only by Commander and is never exposed to the agent.' })}
          </div>
          <footer>
            <button type="button" onClick={dismiss} disabled={busy}>{t('tools:exec.dismiss')}</button>
            <button type="submit" className="is-primary" disabled={busy || !password}>
              {busy ? t('terminal:shellSudo.authorizing', { defaultValue: 'Authorizing…' }) : t('terminal:shellSudo.authorizeAndRun', { defaultValue: 'Authorize and run' })}
            </button>
          </footer>
        </form>
      )}
    </section>
  );
}
