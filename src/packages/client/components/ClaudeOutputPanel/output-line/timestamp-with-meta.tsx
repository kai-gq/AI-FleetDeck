/**
 * 时间戳+元信息弹层(MessageMetadataTooltip 随行;仅本模块内使用)。
 *
 * 自 OutputLine.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ClaudeOutput, store } from '../../../store';
import { type Subagent } from '../../../../shared/types';

// Metadata tooltip that appears on timestamp click
function MessageMetadataTooltip({ output, debugHash, agentId, onClose }: { output: ClaudeOutput; debugHash: string; agentId: string | null; onClose: () => void }) {
  const { t } = useTranslation(['tools', 'common']);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const copyField = (value: string) => {
    navigator.clipboard.writeText(value);
  };

  const date = new Date(output.timestamp);
  const fullTime = date.toISOString();

  // Determine message type
  let msgType = 'assistant';
  if (output.isUserPrompt) msgType = 'user';
  else if (output.text.startsWith('Using tool:')) msgType = 'tool_use';
  else if (output.text.startsWith('Tool input:')) msgType = 'tool_input';
  else if (output.text.startsWith('Tool result:')) msgType = 'tool_result';
  else if (output.text.startsWith('Bash output:')) msgType = 'bash_output';
  else if (output.text.startsWith('Tokens:') || output.text.startsWith('Cost:')) msgType = 'stats';
  else if (output.text.startsWith('[thinking]')) msgType = 'thinking';
  else if (output.skillUpdate) msgType = 'skill_update';

  // Determine source - helps debug where duplicates originate
  const source = output.uuid ? 'server' : output.isUserPrompt ? 'client (user)' : 'client/system';

  // Copy all metadata as JSON for pasting into bug reports
  const copyAll = () => {
    const data: Record<string, unknown> = {
      uuid: output.uuid || null,
      hash: debugHash,
      type: msgType,
      timestamp: output.timestamp,
      iso: fullTime,
      agentId: agentId || null,
      isStreaming: output.isStreaming,
      source,
      textLen: output.text.length,
      textPreview: output.text.slice(0, 120),
    };
    if (output.isDelegation) data.isDelegation = true;
    if (output.toolName) data.toolName = output.toolName;
    if (output.toolInput) data.toolInput = output.toolInput;
    if (output.toolOutput) data.toolOutputLen = output.toolOutput.length;
    if (output.subagentName) data.subagentName = output.subagentName;
    if (output.isUserPrompt) data.isUserPrompt = true;
    if (output.skillUpdate) data.skillUpdate = output.skillUpdate;
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
  };

  // Find this output's index in the store for positional debugging
  const allOutputs = agentId ? store.getState().agentOutputs.get(agentId) : null;
  const outputIndex = allOutputs ? allOutputs.indexOf(output) : -1;
  const totalOutputs = allOutputs ? allOutputs.length : 0;

  // Row labels are UI chrome (translated); values stay raw for bug-report
  // fidelity — the JSON copy button exports the machine fields verbatim.
  const rows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: t('tools:metadata.uuid', { defaultValue: 'UUID' }), value: output.uuid || t('tools:metadata.none', { defaultValue: '(none)' }), mono: true },
    { label: t('tools:metadata.hash', { defaultValue: 'Hash' }), value: debugHash, mono: true },
    { label: t('tools:metadata.type'), value: msgType },
    { label: t('tools:metadata.source'), value: source },
    { label: t('tools:metadata.agent', { defaultValue: 'Agent' }), value: agentId || t('tools:metadata.none', { defaultValue: '(none)' }), mono: true },
    { label: t('tools:metadata.time', { defaultValue: 'Time' }), value: fullTime, mono: true },
    { label: t('tools:metadata.epoch', { defaultValue: 'Epoch' }), value: String(output.timestamp), mono: true },
    { label: t('tools:metadata.index', { defaultValue: 'Index' }), value: outputIndex >= 0 ? `${outputIndex} / ${totalOutputs}` : t('tools:metadata.unknown', { defaultValue: '(unknown)' }), mono: true },
    { label: t('tools:metadata.text', { defaultValue: 'Text' }), value: `[${t('tools:metadata.chars', { defaultValue: '{{n}} chars', n: output.text.length })}] ${output.text.slice(0, 120)}`, mono: true },
  ];

  if (output.isStreaming) rows.push({ label: t('tools:metadata.state', { defaultValue: 'State' }), value: 'streaming' });
  if (output.isDelegation) rows.push({ label: t('tools:metadata.flag', { defaultValue: 'Flag' }), value: 'delegation' });
  if (output.toolName) rows.push({ label: t('tools:metadata.tool', { defaultValue: 'Tool' }), value: output.toolName });
  if (output.toolInput) rows.push({ label: t('tools:metadata.toolIn', { defaultValue: 'ToolIn' }), value: JSON.stringify(output.toolInput).slice(0, 200), mono: true });
  if (output.toolOutput) rows.push({ label: t('tools:metadata.toolOut', { defaultValue: 'ToolOut' }), value: `[${t('tools:metadata.chars', { defaultValue: '{{n}} chars', n: output.toolOutput.length })}] ${output.toolOutput.slice(0, 120)}`, mono: true });
  if (output.subagentName) rows.push({ label: t('tools:metadata.subagent', { defaultValue: 'Subagent' }), value: output.subagentName });

  return (
    <div className="msg-meta-tooltip" ref={tooltipRef}>
      <div className="msg-meta-tooltip__header">
        <span>{t('tools:metadata.messageInfo')}</span>
        <div className="msg-meta-tooltip__actions">
          <button className="msg-meta-tooltip__copy-all" onClick={copyAll} title={t('tools:metadata.copyAllAsJSON')}>JSON</button>
          <button className="msg-meta-tooltip__close" onClick={onClose}>&times;</button>
        </div>
      </div>
      <div className="msg-meta-tooltip__body">
        {rows.map(({ label, value, mono }) => (
          <div key={label} className="msg-meta-tooltip__row">
            <span className="msg-meta-tooltip__label">{label}</span>
            <span
              className={`msg-meta-tooltip__value ${mono ? 'mono' : ''}`}
              onClick={() => copyField(value)}
              title={t('tools:metadata.clickToCopy')}
            >
              {value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Timestamp that opens metadata tooltip on click
export function TimestampWithMeta({ output, timeStr, debugHash, agentId }: { output: ClaudeOutput; timeStr: string; debugHash: string; agentId?: string | null }) {
  const { t } = useTranslation(['tools']);
  const [showMeta, setShowMeta] = useState(false);
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowMeta(prev => !prev);
  }, []);
  const handleClose = useCallback(() => setShowMeta(false), []);

  return (
    <span className="output-timestamp-wrapper">
      <span
        className="output-timestamp output-timestamp--clickable"
        onClick={handleClick}
        title={t('tools:metadata.clickForMessageInfo')}
      >
        {timeStr}
      </span>
      {showMeta && <MessageMetadataTooltip output={output} debugHash={debugHash} agentId={agentId || null} onClose={handleClose} />}
    </span>
  );
}
