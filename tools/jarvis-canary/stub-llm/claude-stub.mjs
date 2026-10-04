#!/usr/bin/env node
/**
 * claude-stub.mjs —— 金丝雀 L2「接线层」mock LLM（2026-10-04 交付）
 *
 * 用途：让**真服务器**以为在跑 claude CLI，实则以固定规则产出回复——把
 * 「契约→Boss→回执→system_log」的**接线**与「模型说了什么」**分离定位**：
 * L2 失败 = 接线 bug；L3（真 LLM）失败 = 模型/prompt 问题。
 *
 * 协议 ground truth：2026-10-04 用本机真 CLI（2.1.287）以
 *   claude --print --verbose --output-format stream-json --input-format stream-json
 *          --include-partial-messages ...
 * 探测捕获的最小事件序列（每条一行 JSON）：
 *   system/init → [stream_event* 可选] → assistant(全文) → result
 * 本 stub 默认只发 init → assistant → result（不含 stream_event 增量；
 * 服务器对无增量路径有完整分支——见 backend.ts parseAssistantEvent 注释）。
 *
 * 服务器接入点：`TC_CLAUDE_EXECUTABLE` 环境变量（backend.ts getExecutablePath
 * 优先读取）→ Windows 经 claude-stub.cmd 垫片启动（runner 在 Windows 上以
 * shell:true spawn，.cmd 可直接执行）。
 *
 * 配置（全部经环境变量，零依赖、零网络）：
 *   TC_STUB_RULES   规则文件路径（JSON：见下）。缺省 → 全部走 TC_STUB_FALLBACK。
 *   TC_STUB_FALLBACK 缺省回复文本（缺省「收到。」）。
 *   TC_STUB_MODEL   无 --model 参数时的 init 模型名（缺省 claude-opus-4-5）。
 *   TC_STUB_COST    每轮 result.total_cost_usd（缺省 0.0001，供成本类埋点冒烟）。
 *   TC_STUB_STREAM  =1 时额外发最小 stream_event 增量（message_start/text_delta/
 *                   message_delta/message_stop）。缺省关（L2 只看接线）。
 *   TC_STUB_TRACE   追加写入的文件路径（每行发出的原始 JSON，调试用）。
 *
 * 规则文件格式：
 *   {
 *     "rules": [
 *       { "match": "子串",  "reply": "回复文本" },          // 子串匹配（先到先得）
 *       { "regex": "正则",  "reply": "回复文本" }           // 或正则匹配
 *     ],
 *     "defaultReply": "（可选）本文件缺省回复，优先于 TC_STUB_FALLBACK"
 *   }
 *
 * 自测：node tools/jarvis-canary/stub-llm/claude-stub.mjs --self-test
 */

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const VERSION = 'stub-0.1';
const SELF_PATH = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// 参数与环境
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { resume: null, forkSession: false, model: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume') opts.resume = argv[++i] ?? null;
    else if (a === '--fork-session') opts.forkSession = true;
    else if (a === '--model') opts.model = argv[++i] ?? null;
    // 其余 flag（--print/--verbose/--output-format.../--append-system-prompt-file 等）一律忽略
  }
  return opts;
}

function loadRules() {
  const path = process.env.TC_STUB_RULES;
  const fallback = process.env.TC_STUB_FALLBACK ?? '收到。';
  if (!path) return { rules: [], defaultReply: fallback };
  try {
    const doc = JSON.parse(fs.readFileSync(path, 'utf-8'));
    return { rules: doc.rules ?? [], defaultReply: doc.defaultReply ?? fallback };
  } catch (error) {
    process.stderr.write(`[claude-stub] 规则文件读取失败（降级为缺省回复）: ${error.message}\n`);
    return { rules: [], defaultReply: fallback };
  }
}

function pickReply(content, ruleset) {
  for (const rule of ruleset.rules) {
    if (typeof rule.match === 'string' && content.includes(rule.match)) return rule.reply ?? '';
    if (typeof rule.regex === 'string') {
      try {
        if (new RegExp(rule.regex).test(content)) return rule.reply ?? '';
      } catch {
        /* 坏正则跳过 */
      }
    }
  }
  return ruleset.defaultReply;
}

// ---------------------------------------------------------------------------
// 事件发射（最小集，形状对齐真 CLI 探测结果）
// ---------------------------------------------------------------------------

function makeEmitter(sessionId, model, out) {
  const emit = (event) => {
    const line = JSON.stringify(event);
    out.write(line + '\n');
    const trace = process.env.TC_STUB_TRACE;
    if (trace) {
      try { fs.appendFileSync(trace, line + '\n'); } catch { /* 忽略 */ }
    }
  };

  const emitInit = () => {
    emit({
      type: 'system', subtype: 'init',
      cwd: process.cwd(),
      session_id: sessionId,
      tools: [],
      model,
      permissionMode: 'bypassPermissions',
      uuid: randomUUID(),
    });
  };

  const emitTurn = (reply) => {
    const text = reply ?? '';
    const inputTokens = 100;
    const outputTokens = Math.max(1, Math.ceil(text.length / 4));
    const messageId = `msg_${randomUUID()}`;
    const cost = Number(process.env.TC_STUB_COST ?? '0.0001');

    if (process.env.TC_STUB_STREAM === '1') {
      emit({ type: 'stream_event', event: { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } }, session_id: sessionId, uuid: randomUUID() });
      emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, session_id: sessionId, uuid: randomUUID() });
      emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, session_id: sessionId, uuid: randomUUID() });
      emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: sessionId, uuid: randomUUID() });
      emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } }, session_id: sessionId, uuid: randomUUID() });
      emit({ type: 'stream_event', event: { type: 'message_stop' }, session_id: sessionId, uuid: randomUUID() });
    }

    emit({
      type: 'assistant',
      message: {
        id: messageId, type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
      session_id: sessionId,
      uuid: randomUUID(),
    });

    emit({
      type: 'result', subtype: 'success', is_error: false,
      result: text,
      duration_ms: 123, duration_api_ms: 100, num_turns: 1,
      total_cost_usd: cost,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      modelUsage: {
        [model]: {
          inputTokens, outputTokens,
          cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0,
          costUSD: cost, contextWindow: 200000, maxOutputTokens: 32000,
        },
      },
      permission_denials: [],
      session_id: sessionId,
      uuid: randomUUID(),
    });
  };

  return { emitInit, emitTurn };
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

function runMain() {
  const opts = parseArgs(process.argv.slice(2));
  const ruleset = loadRules();
  const model = opts.model ?? process.env.TC_STUB_MODEL ?? 'claude-opus-4-5';
  // --resume <id>：沿用会话 id（对齐服务器 session 记账）；--fork-session：另开新 id
  const sessionId = opts.resume && !opts.forkSession ? opts.resume : randomUUID();
  const { emitInit, emitTurn } = makeEmitter(sessionId, model, process.stdout);

  process.stderr.write(`[claude-stub ${VERSION}] session=${sessionId.slice(0, 8)} model=${model} resume=${opts.resume ? 'yes' : 'no'} rules=${ruleset.rules.length}\n`);
  emitInit();

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stderr.write('[claude-stub] 非 JSON 输入行（忽略）\n');
      return;
    }
    if (msg?.type === 'user') {
      const content = typeof msg.message?.content === 'string'
        ? msg.message.content
        : JSON.stringify(msg.message?.content ?? '');
      emitTurn(pickReply(content, ruleset));
    } else if (msg?.type === 'control_request') {
      // 形状未对真 CLI 验证（仅 set_model 类请求；L2 场景暂不触发）——乐观应答
      const requestId = msg.request_id ?? randomUUID();
      process.stdout.write(JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId },
      }) + '\n');
    }
    // 其余类型忽略
  });
  rl.on('close', () => process.exit(0));
}

// ---------------------------------------------------------------------------
// 自测（--self-test）：不依赖服务器，直接校验协议形状
// ---------------------------------------------------------------------------

function runSelfTest() {
  const results = [];
  const check = (name, ok) => results.push({ name, ok });

  // 1) 参数解析
  const args = parseArgs(['--print', '--resume', 'abc-123', '--model', 'haiku', '--verbose']);
  check('parseArgs: --resume/--model 提取，其余忽略', args.resume === 'abc-123' && args.model === 'haiku' && args.forkSession === false);

  // 2) 规则匹配（子串 + 正则 + 缺省）
  const ruleset = { rules: [{ match: '契约', reply: 'CONTRACT' }, { regex: '^/status', reply: 'STATUS' }], defaultReply: 'D' };
  check('pickReply: 子串优先', pickReply('请输出契约 JSON', ruleset) === 'CONTRACT');
  check('pickReply: 正则', pickReply('/status now', ruleset) === 'STATUS');
  check('pickReply: 缺省', pickReply('闲聊', ruleset) === 'D');

  // 3) 端到端：以子进程方式跑本文件，灌一条 user 消息，校验事件序列
  try {
    const child = spawnSync(process.execPath, [SELF_PATH], {
      input: JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n',
      encoding: 'utf-8',
      env: { ...process.env, TC_STUB_FALLBACK: 'STUB-REPLY' },
      timeout: 10000,
    });
    const lines = (child.stdout ?? '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const types = lines.map((e) => (e.type === 'system' ? `system/${e.subtype}` : e.type));
    check('端到端: 序列 = system/init → assistant → result', types.join(',') === 'system/init,assistant,result');
    const init = lines[0];
    check('端到端: init 含 session_id/cwd/model', Boolean(init.session_id) && Boolean(init.cwd) && Boolean(init.model));
    const assistant = lines[1];
    check('端到端: assistant text = 规则回复', assistant.message?.content?.[0]?.text === 'STUB-REPLY');
    const result = lines[2];
    check('端到端: result 含 cost/usage/result 文本', result.result === 'STUB-REPLY' && typeof result.total_cost_usd === 'number' && Boolean(result.usage));
    check('端到端: 同会话 session_id 一致', init.session_id === assistant.session_id && init.session_id === result.session_id);
  } catch (error) {
    check(`端到端: 子进程自测异常 ${error.message}`, false);
  }

  // 4) --resume 会话 id 沿用
  try {
    const child = spawnSync(process.execPath, [SELF_PATH, '--resume', 'sess-keep-1'], {
      input: JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
      encoding: 'utf-8',
      timeout: 10000,
    });
    const first = JSON.parse((child.stdout ?? '').trim().split('\n')[0]);
    check('--resume: init.session_id 沿用被恢复会话', first.session_id === 'sess-keep-1');
  } catch (error) {
    check(`--resume 自测异常 ${error.message}`, false);
  }

  const pass = results.filter((r) => r.ok).length;
  for (const r of results) process.stdout.write(`  ${r.ok ? '✅' : '❌'} ${r.name}\n`);
  process.stdout.write(`\n自测结果: ${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

// ---------------------------------------------------------------------------

const selfTest = process.argv.includes('--self-test');
if (selfTest) {
  runSelfTest();
} else {
  runMain();
}
