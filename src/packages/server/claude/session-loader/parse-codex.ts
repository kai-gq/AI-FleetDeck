/**
 * Codex 会话解析:parseCodexEntryMessages 与注入消息剥离等。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { type SessionMessage } from './session-types.js';
import { isObject, normalizeTextContent } from './message-utils.js';
import { sanitizeCodexMessageText, parseFunctionCallArguments, extractCodexContentSegments, extractCodexUserMessageFromString, normalizeCodexFunctionToolCall, normalizeCodexWebSearchToolInput, normalizeCodexMcpToolCall, normalizeCodexMcpToolOutput, normalizeCodexEventFallbackText, type CodexPatchFileChange } from './codex-normalize.js';
import * as path from 'path';
import { materializeCodexGeneratedImage } from '../../codex/generated-image.js';

export function extractCodexMessageText(content: unknown): string {
  const segments = extractCodexContentSegments(content);
  return sanitizeCodexMessageText(segments.join('\n'));
}

function isImageOnlyCodexMessage(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;
  return /^(?:\[(?:Image attached|Image:\s*[^\]]+)\]\s*)+$/m.test(normalized);
}

export function stripCodexInjectedUserMessage(content: string): string {
  let normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return normalized;

  // Some Codex session formats prefix role markers inline (e.g. "You# AGENTS...").
  // Remove this marker only when immediately followed by known wrapper starters.
  normalized = normalized.replace(/^You(?=[<#])/gm, '');

  const userRequestHeader = '## User Request';
  const userRequestHeaderIndex = normalized.lastIndexOf(userRequestHeader);
  const hadUserRequestHeader = userRequestHeaderIndex !== -1;

  if (hadUserRequestHeader) {
    normalized = normalized.slice(userRequestHeaderIndex + userRequestHeader.length).trim();
  }

  const wrapperPatterns = [
    /^# AGENTS\.md instructions[^\n]*\n[\s\S]*?<\/INSTRUCTIONS>\s*/i,
    /^<environment_context>\s*[\s\S]*?<\/environment_context>\s*/i,
    /^Follow all instructions below for this task\.\s*/i,
  ];

  let keepStripping = true;
  let didStripWrapper = false;
  while (keepStripping) {
    keepStripping = false;
    for (const pattern of wrapperPatterns) {
      const match = normalized.match(pattern);
      if (match) {
        normalized = normalized.slice(match[0].length).trimStart();
        keepStripping = true;
        didStripWrapper = true;
        break;
      }
    }
  }

  if ((hadUserRequestHeader || didStripWrapper) && /^You\S/.test(normalized)) {
    normalized = normalized.slice(3).trimStart();
  }

  return normalized.trim();
}

export function parseCodexEntryMessages(
  entry: any,
  messages: SessionMessage[],
  toolUseIdToName: Map<string, string>,
  patchDiffsByCallId?: Map<string, CodexPatchFileChange[]>
): void {
  if (entry.type === 'event_msg' && isObject(entry.payload)) {
    const payload = entry.payload as Record<string, unknown>;
    if (payload.type === 'user_message' && typeof payload.message === 'string') {
      const normalizedMessage = stripCodexInjectedUserMessage(
        extractCodexUserMessageFromString(payload.message)
      );
      if (!normalizedMessage) {
        return;
      }
      messages.push({
        type: 'user',
        content: normalizedMessage,
        timestamp: entry.timestamp,
        uuid: `${entry.timestamp}-user`,
      });
      return;
    }
    // agent_message: Skip. Handled by response_item with role=assistant.
    // (Matches live parser behavior in json-event-parser.ts)
    if (payload.type === 'agent_message') {
      return;
    }

    // token_count: Skip in history (token accounting shown via turn.completed)
    if (payload.type === 'token_count') {
      return;
    }

    if (payload.type === 'mcp_tool_call_begin' || payload.type === 'mcp_tool_call_end') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : `${entry.timestamp}-mcp`;
      const normalized = normalizeCodexMcpToolCall(payload);
      const priorToolName = toolUseIdToName.get(callId);
      if (!normalized && !priorToolName) return;
      const toolName = normalized?.toolName ?? priorToolName!;
      const alreadyStarted = toolUseIdToName.has(callId);
      if (!alreadyStarted && normalized) {
        toolUseIdToName.set(callId, toolName);
        messages.push({
          type: 'tool_use',
          content: JSON.stringify(normalized.toolInput, null, 2),
          timestamp: entry.timestamp,
          uuid: `${entry.timestamp}-tool-use-mcp`,
          toolName,
          toolInput: normalized.toolInput,
          toolUseId: callId,
        });
      }
      if (payload.type === 'mcp_tool_call_end') {
        messages.push({
          type: 'tool_result',
          content: normalizeCodexMcpToolOutput(payload.result),
          timestamp: entry.timestamp,
          uuid: `${entry.timestamp}-tool-result-mcp`,
          toolName,
          toolUseId: callId,
        });
      }
      return;
    }

    if (payload.type === 'web_search_begin' || payload.type === 'web_search_end') {
      const toolName = 'web_search';
      const toolInput = normalizeCodexWebSearchToolInput(payload);
      const callId = typeof payload.call_id === 'string' ? payload.call_id : `${entry.timestamp}-web-search`;
      const alreadyStarted = toolUseIdToName.has(callId);
      if (!alreadyStarted) {
        toolUseIdToName.set(callId, toolName);
        messages.push({
          type: 'tool_use',
          content: JSON.stringify(toolInput, null, 2),
          timestamp: entry.timestamp,
          uuid: `${entry.timestamp}-tool-use-web-search`,
          toolName,
          toolInput,
          toolUseId: callId,
        });
      }
      if (payload.type === 'web_search_end') {
        messages.push({
          type: 'tool_result',
          content: JSON.stringify(toolInput, null, 2),
          timestamp: entry.timestamp,
          uuid: `${entry.timestamp}-tool-result-web-search`,
          toolName,
          toolUseId: callId,
        });
      }
      return;
    }

    if (payload.type === 'image_generation_begin') {
      return;
    }
    if (payload.type === 'image_generation_end') {
      const imagePath = materializeCodexGeneratedImage(payload.result);
      messages.push({
        type: 'assistant',
        content: imagePath
          ? `[Image: ${imagePath}]`
          : '[codex-event] Image generation completed, but the PNG result was invalid.',
        timestamp: entry.timestamp,
        uuid: typeof payload.call_id === 'string'
          ? payload.call_id
          : `${entry.timestamp}-assistant-generated-image`,
      });
      return;
    }

    // agent_reasoning: Skip in history (consistent with Claude thinking behavior)
    if (payload.type === 'agent_reasoning') {
      return;
    }

    // turn_aborted: Skip in history (interruption is visible from agent stopping)
    if (payload.type === 'turn_aborted') {
      return;
    }

    // task_complete: Skip. Final agent message is already present via
    // response_item with role=assistant (or item.completed agent_message).
    if (payload.type === 'task_complete') {
      return;
    }

    // task_started: Skip. Envelope event with no user-facing content.
    if (payload.type === 'task_started') {
      return;
    }

    // patch_apply_begin / patch_apply_end: Skip. Each apply_patch is also stored
    // as a custom_tool_call (+ custom_tool_call_output) with the same call_id,
    // which already renders the Edit/diff row. Rendering these too would
    // duplicate it (or dump raw JSON through the fallback below).
    if (payload.type === 'patch_apply_begin' || payload.type === 'patch_apply_end') {
      return;
    }

    // Unknown event_msg types: keep fallback
    const payloadType = typeof payload.type === 'string' ? payload.type : 'unknown';
    messages.push({
      type: 'assistant',
      content: normalizeCodexEventFallbackText(`event_msg.${payloadType}`, payload),
      timestamp: entry.timestamp,
      uuid: `${entry.timestamp}-assistant-codex-event`,
    });
    return;
  }

  if (entry.type !== 'response_item' || !isObject(entry.payload)) {
    return;
  }

  const payload = entry.payload as Record<string, unknown>;
  const payloadType = payload.type;

  if (payloadType === 'message') {
    const role = payload.role;
    if (role !== 'user' && role !== 'assistant') {
      return;
    }

    const rawContent = extractCodexMessageText(payload.content);
    if (role === 'user' && isImageOnlyCodexMessage(rawContent)) {
      // Codex often emits a second user response_item containing only input_image
      // blocks (data URL content) after the primary event_msg user_message.
      // Skip this synthetic duplicate to keep history clean and clickable.
      return;
    }
    const content = role === 'user' ? stripCodexInjectedUserMessage(rawContent) : rawContent;
    if (!content.trim()) {
      return;
    }

    messages.push({
      type: role,
      content,
      timestamp: entry.timestamp,
      uuid: `${entry.timestamp}-${role}`,
    });
    return;
  }

  if (payloadType === 'function_call') {
    const rawToolName = typeof payload.name === 'string' ? payload.name : 'unknown';
    const toolUseId = typeof payload.call_id === 'string' ? payload.call_id : undefined;

    // write_stdin feeds keystrokes to (or just polls) an interactive exec
    // session — the call itself is noise (chars is usually empty), producing
    // rows of bare "write_stdin". Skip the tool_use row, but attribute its
    // output to Bash so any interactive output still renders as terminal output.
    if (rawToolName === 'write_stdin') {
      if (toolUseId) {
        toolUseIdToName.set(toolUseId, 'Bash');
      }
      return;
    }

    const rawToolInput = parseFunctionCallArguments(payload.arguments);
    const { toolName, toolInput } = normalizeCodexFunctionToolCall(rawToolName, rawToolInput);
    if (toolUseId) {
      toolUseIdToName.set(toolUseId, toolName);
    }
    messages.push({
      type: 'tool_use',
      content: JSON.stringify(toolInput, null, 2),
      timestamp: entry.timestamp,
      uuid: `${entry.timestamp}-tool-use`,
      toolName,
      toolInput,
      toolUseId,
    });
    return;
  }

  if (payloadType === 'web_search_call') {
    const toolName = 'web_search';
    const toolInput = normalizeCodexWebSearchToolInput(payload);
    const status = typeof payload.status === 'string' ? payload.status : undefined;
    const toolUseId = typeof payload.call_id === 'string' ? payload.call_id : `${entry.timestamp}-web-search`;

    messages.push({
      type: 'tool_use',
      content: JSON.stringify(toolInput, null, 2),
      timestamp: entry.timestamp,
      uuid: `${entry.timestamp}-tool-use-web-search`,
      toolName,
      toolInput,
      toolUseId,
    });

    if (status === 'completed') {
      messages.push({
        type: 'tool_result',
        content: JSON.stringify(toolInput, null, 2),
        timestamp: entry.timestamp,
        uuid: `${entry.timestamp}-tool-result-web-search`,
        toolName,
        toolUseId,
      });
    }
    return;
  }

  if (payloadType === 'function_call_output') {
    const toolUseId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
    const toolName = toolUseId ? (toolUseIdToName.get(toolUseId) || 'unknown') : 'unknown';
    const content = normalizeTextContent(payload.output);
    messages.push({
      type: 'tool_result',
      content,
      timestamp: entry.timestamp,
      uuid: `${entry.timestamp}-tool-result`,
      toolName,
      toolUseId,
    });
    return;
  }

  // reasoning: Skip in history (consistent with Claude thinking behavior)
  if (payloadType === 'reasoning') {
    return;
  }

  // custom_tool_call: Map to tool_use (normalize apply_patch -> Edit)
  if (payloadType === 'custom_tool_call') {
    const rawToolName = typeof payload.name === 'string' ? payload.name : 'unknown';
    const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
    const rawInput = typeof payload.input === 'string' ? payload.input : '';

    // Normalize: apply_patch -> Edit for consistent UI rendering
    const toolName = rawToolName === 'apply_patch' ? 'Edit' : rawToolName;

    // Preferred path: the matching patch_apply_end gave us a clean unified diff
    // per file. Emit one Edit row per changed file so clicking opens the
    // file-viewer modal with a real side-by-side / unified diff.
    const patchFiles = rawToolName === 'apply_patch' && callId
      ? patchDiffsByCallId?.get(callId)
      : undefined;
    if (patchFiles && patchFiles.length > 0) {
      if (callId) {
        toolUseIdToName.set(callId, 'Edit');
      }
      patchFiles.forEach((file, idx) => {
        const toolInput: Record<string, unknown> = { file_path: file.path };
        if (file.unifiedDiff) toolInput.unified_diff = file.unifiedDiff;
        if (file.kind === 'add') toolInput.operation = 'create';
        else if (file.kind === 'delete') toolInput.operation = 'delete';
        messages.push({
          type: 'tool_use',
          content: JSON.stringify(toolInput, null, 2),
          timestamp: entry.timestamp,
          uuid: `${entry.timestamp}-tool-use-custom-${idx}`,
          toolName: 'Edit',
          toolInput,
          toolUseId: callId,
        });
      });
      return;
    }

    // Fallback (older sessions without patch_apply_end): keep the raw patch text
    // so the modal can at least show the change and resolve the file path.
    const toolInput: Record<string, unknown> = {};
    if (rawToolName === 'apply_patch' && rawInput) {
      // Extract file path from patch for clickable display
      const fileMatch = rawInput.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/);
      if (fileMatch) {
        toolInput.file_path = fileMatch[1].trim();
      }
      toolInput.old_string = '';
      toolInput.new_string = rawInput;
    } else {
      toolInput.input = rawInput;
    }

    if (callId) {
      toolUseIdToName.set(callId, toolName);
    }

    messages.push({
      type: 'tool_use',
      content: JSON.stringify(toolInput, null, 2),
      timestamp: entry.timestamp,
      uuid: `${entry.timestamp}-tool-use-custom`,
      toolName,
      toolInput,
      toolUseId: callId,
    });
    return;
  }

  // custom_tool_call_output: Map to tool_result
  if (payloadType === 'custom_tool_call_output') {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
    const toolName = callId ? (toolUseIdToName.get(callId) || 'unknown') : 'unknown';
    let content = normalizeTextContent(payload.output);

    // Parse apply_patch JSON output wrapper to extract meaningful text
    if (content) {
      try {
        const parsed = JSON.parse(content);
        if (isObject(parsed) && typeof parsed.output === 'string') {
          content = parsed.output as string;
        }
      } catch {
        // Use raw content as-is
      }
    }

    messages.push({
      type: 'tool_result',
      content,
      timestamp: entry.timestamp,
      uuid: `${entry.timestamp}-tool-result-custom`,
      toolName,
      toolUseId: callId,
    });
    return;
  }

  const unknownPayloadType = typeof payloadType === 'string' ? payloadType : 'unknown';
  messages.push({
    type: 'assistant',
    content: normalizeCodexEventFallbackText(`response_item.${unknownPayloadType}`, payload),
    timestamp: entry.timestamp,
    uuid: `${entry.timestamp}-assistant-codex-response-item`,
  });
}
