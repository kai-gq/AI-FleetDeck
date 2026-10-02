import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import type { ShellCommandResultInfo } from './shellCommandResult';

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

export function ShellCommandResultCard({ result }: { result: ShellCommandResultInfo }) {
  const { t } = useTranslation('terminal');
  const [expanded, setExpanded] = useState(false);
  const succeeded = result.exitCode === 0;
  const outputLines = result.output ? result.output.split('\n') : [];
  const hasMore = outputLines.length > 6 || result.output.length > 900;
  const displayedOutput = expanded || !hasMore
    ? result.output
    : `${outputLines.slice(0, 6).join('\n').slice(0, 900)}\n…`;

  return (
    <section className={`shell-command-result-card ${succeeded ? 'is-success' : 'is-failure'}`}>
      <header>
        <span className="shell-command-result-card__mark">
          <Icon name={succeeded ? 'check' : 'cross'} size={16} />
        </span>
        <div>
          <small>{t('terminal:shellResult.header', { defaultValue: 'Execute Sudo Command · Result' })}</small>
          <strong>{succeeded
            ? t('terminal:shellResult.completed', { defaultValue: 'Command completed' })
            : t('terminal:shellResult.finishedWithErrors', { defaultValue: 'The command finished with errors' })}</strong>
        </div>
        <span className="shell-command-result-card__status">{succeeded
          ? t('terminal:shellResult.success', { defaultValue: 'Success' })
          : `${t('terminal:shellResult.exit', { defaultValue: 'Exit' })} ${result.exitCode ?? '—'}`}</span>
      </header>

      <div className="shell-command-result-card__command">
        <span aria-hidden="true">$</span>
        <code>{result.command}</code>
      </div>

      <div className="shell-command-result-card__metrics">
        <span><small>{t('terminal:shellResult.exitCode', { defaultValue: 'Exit code' })}</small><strong>{result.exitCode ?? t('terminal:shellResult.terminated', { defaultValue: 'terminated' })}</strong></span>
        <span><small>{t('terminal:shellResult.duration', { defaultValue: 'Duration' })}</small><strong>{formatDuration(result.durationMs)}</strong></span>
        <span><small>{t('terminal:shellResult.output', { defaultValue: 'Output' })}</small><strong>{result.output
          ? `${outputLines.length} ${outputLines.length === 1
            ? t('terminal:shellResult.line', { defaultValue: 'line' })
            : t('terminal:shellResult.lines', { defaultValue: 'lines' })}`
          : t('terminal:shellResult.empty', { defaultValue: 'Empty' })}</strong></span>
      </div>

      {result.output ? (
        <div className="shell-command-result-card__output">
          <div><span>{t('terminal:shellResult.commandOutput', { defaultValue: 'Command output' })}</span>{result.outputTruncated && <em>{t('terminal:shellResult.tailOnly', { defaultValue: 'tail only' })}</em>}</div>
          <pre>{displayedOutput}</pre>
          {hasMore && (
            <button type="button" onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }}>
              {expanded
                ? t('terminal:shellResult.showLess', { defaultValue: 'Show less' })
                : t('terminal:shellResult.showFull', { defaultValue: 'Show full output' })} <Icon name={expanded ? 'caret-up' : 'caret-down'} size={9} />
            </button>
          )}
        </div>
      ) : (
        <div className="shell-command-result-card__empty">
          <Icon name="check" size={11} /> {t('terminal:shellResult.noOutput', { defaultValue: 'The command produced no output.' })}
        </div>
      )}

      <footer><Icon name="shield" size={10} /> {t('terminal:shellResult.delivered', { defaultValue: 'Result delivered automatically to the requesting agent.' })}</footer>
    </section>
  );
}
