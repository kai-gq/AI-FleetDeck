/**
 * 语音伙伴服务 — Claude headless 调用层(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * hop1/hop2 一次性 spawn(--print --output-format stream-json)+ 常驻通道切换 + 热词管家一次性档;
 * 进程句柄本模块独有(claudeBackend),错误口径/中止语义与拆分前逐字一致。
 */
import { spawn, type ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { sanitizeUnicode } from '../../utils/index.js';
import { ClaudeBackend } from '../../claude/index.js';
import { resolveCompanionCliProfile } from '../../voice/companion-cli-profile.js';
import { resolveCuratorCwd } from '../../voice/hotword-curator.js';
import {
  isCompanionResidentEnabled,
  runCompanionTurn,
  type CompanionContextUsage,
} from '../../voice/companion-runner.js';
import { loadServerConfig } from './config.js';
import { VoiceCompanionAbortedError } from './types.js';

const claudeBackend = new ClaudeBackend();

interface ClaudeCallResult {
  text: string;
  sessionId: string | null;
  stderr: string;
}

export function callClaudeOnce(
  systemPrompt: string,
  userContent: string,
  opts: {
    model: string;
    resumeId?: string | null;
    timeoutMs: number;
    reminder?: boolean;
    /** 增量文本(累计值):分句流式播报用它边生成边切句。 */
    onTextDelta?: (fullText: string) => void;
    /** 中止信号:abort 时 kill 子进程并以 VoiceCompanionAbortedError 拒绝。 */
    signal?: AbortSignal;
    /**
     * 「零工具」一次性生成(当前=垫话):跳过 MCP/外部设置加载,实测冷启动
     * 4.87s→2.23s(2026-10-05 本机同参数对拍)。具体参数由档案模块按档位决定 ——
     * default 档 = 今日的 --strict-mcp-config;allowlist/nomcp/none 档额外
     * `--tools ""` 禁用全部内置工具。主链路(hop1 回退/hop2)不传。
     */
    skipMcp?: boolean;
    /** 覆盖档案的中立 cwd(热词管家用它隔离会话目录,避免落进大脑的 voice-cwd)。 */
    cwd?: string;
  },
): Promise<ClaudeCallResult> {
  if (opts.signal?.aborted) return Promise.reject(new VoiceCompanionAbortedError());
  return new Promise((resolve, reject) => {
    const executable = claudeBackend.getExecutablePath();
    const args = [
      '--print',
      '--verbose',
      '--model', opts.model,
      '--output-format', 'stream-json',
      // 增量事件(text_delta)——分句流水线的前提。
      '--include-partial-messages',
      '--input-format', 'stream-json',
    ];

    const systemPromptFile = path.join(os.tmpdir(), `voice-companion-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(systemPromptFile, systemPrompt);
    args.push('--system-prompt-file', systemPromptFile);
    // 关提示词快照(与常驻链路同口径):resume 回退路径也按当回合提示词即时生效。
    args.push('--system-prompt-snapshot', 'off');
    if (opts.resumeId) args.push('--resume', opts.resumeId);
    // 任务19:工具白名单/中立 cwd/effort 统一经档案模块(垫话传 zeroTools=零工具)。
    // 档案参数恒在尾部(--tools 是变参,必须在最后)。
    const profile = resolveCompanionCliProfile({ zeroTools: !!opts.skipMcp });
    args.push(...profile.args);

    let child: ChildProcess;
    try {
      const spawnCwd = opts.cwd ?? profile.cwd;
      child = spawn(executable, args, {
        env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
        // 主运行器在 Windows 用 shell:true 启动(cmd.exe 才能执行 .cmd 安装的 claude);
        // 参数均无空格/特殊字符,无需转义。
        shell: process.platform === 'win32',
        windowsHide: true,
        // 中立 cwd(隔断仓库 CLAUDE.md/项目记忆注入);null = 继承进程 cwd(回退档)。
        ...(spawnCwd ? { cwd: spawnCwd } : {}),
      });
    } catch (err) {
      reject(err);
      return;
    }

    const cleanup = () => {
      try {
        if (fs.existsSync(systemPromptFile)) fs.unlinkSync(systemPromptFile);
      } catch { /* ignore */ }
    };

    const decoder = new StringDecoder('utf8');
    let buffer = '';
    // 开 --include-partial-messages 后,同一段文本先以 text_delta 增量到达,
    // 随后又随完整 assistant 事件全量再来一遍。三个来源必须分开累加,否则
    // 文本翻倍、JSON 解析必炸;close 时按优先级取其一。
    let assistantText = '';
    let deltaText = '';
    let resultText = '';
    let newSessionId: string | null = null;
    let stderrBuf = '';
    let settled = false;

    const settleCleanup = () => {
      clearTimeout(timeout);
      cleanup();
      opts.signal?.removeEventListener('abort', onAbort);
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 5_000);
      killTimer.unref?.();
      settleCleanup();
      const err = new Error(`Claude timed out after ${opts.timeoutMs}ms`);
      err.name = 'VoiceCompanionTimeout';
      reject(err);
    }, opts.timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 5_000);
      killTimer.unref?.();
      settleCleanup();
      reject(new VoiceCompanionAbortedError());
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (data: Buffer) => {
      buffer += decoder.write(data);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'system' && event.session_id) newSessionId = event.session_id;
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) assistantText += block.text;
            }
          }
          if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
            if (event.event.delta?.type === 'text_delta' && event.event.delta.text) {
              deltaText += event.event.delta.text;
              opts.onTextDelta?.(deltaText);
            }
          }
          if (event.type === 'result' && typeof event.result === 'string') {
            resultText = event.result;
          }
        } catch { /* ignore non-JSON */ }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderrBuf += decoder.write(data);
      if (stderrBuf.length > 4_000) stderrBuf = stderrBuf.slice(-4_000);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      settleCleanup();
      const remaining = buffer + decoder.end();
      if (remaining.trim()) {
        try {
          const event = JSON.parse(remaining);
          if (event.type === 'system' && event.session_id) newSessionId = event.session_id;
        } catch { /* ignore */ }
      }
      const textOutput = assistantText || deltaText || resultText;
      if (code !== 0 && !textOutput) {
        const err = new Error(`Claude exited with code ${code}`) as Error & { stderr?: string };
        err.stderr = stderrBuf;
        reject(err);
      } else if (!textOutput) {
        const err = new Error('No response from Claude') as Error & { stderr?: string };
        err.stderr = stderrBuf;
        reject(err);
      } else {
        resolve({ text: textOutput, sessionId: newSessionId, stderr: stderrBuf });
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      settleCleanup();
      reject(err);
    });

    child.on('spawn', () => {
      const reminder = opts.reminder ? '\n\n【格式】只回那个 JSON 对象,不要任何解释。' : '';
      const stdinMessage = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: sanitizeUnicode(userContent) + reminder },
      });
      child.stdin?.write(stdinMessage + '\n');
      child.stdin?.end();
    });
  });
}

/**
 * 热词管家专用:一次性轻量调用(零工具档,与垫话同档;不走常驻通道、不占对话互斥队列)。
 * 供 /api/voice-companion/hotwords/refresh 使用 —— 只读历史 + 按提示词输出 JSON。
 * cwd 走管家专用中立目录:它的会话文件(含对话副本的大段提示词)不落进 voice-cwd。
 */
export async function callClaudeForHotwordCurator(systemPrompt: string, userContent: string): Promise<string> {
  const cfg = loadServerConfig();
  const result = await callClaudeOnce(systemPrompt, userContent, {
    model: cfg.model,
    timeoutMs: 120_000,
    skipMcp: true,
    cwd: resolveCuratorCwd() ?? undefined,
  });
  return result.text;
}

/**
 * 任务18:hop1 收发经「常驻通道」——进程跨回合存活 + stdin 复用(省去每回合冷启动);
 * 除收发环外与 callClaudeOnce 完全同构(同 args/同 stream-json 协议/同错误口径)。
 * 回退开关 TC_JARVIS_COMPANION_RESIDENT=0 → 逐字走原一次性 spawn(等价路径钉住)。
 */
export interface ClaudeHop1Result extends ClaudeCallResult {
  /** 任务18:result 事件里的上下文占用(回退路径为 null = 不做压缩判定)。 */
  context: CompanionContextUsage | null;
  /** W6 观测:本回合复用常驻进程(true)/新建(false);回退路径恒 false。 */
  reused: boolean;
}

export function callClaudeHop1(
  systemPrompt: string,
  userContent: string,
  opts: {
    model: string;
    resumeId?: string | null;
    timeoutMs: number;
    reminder?: boolean;
    onTextDelta?: (fullText: string) => void;
    signal?: AbortSignal;
  },
): Promise<ClaudeHop1Result> {
  if (!isCompanionResidentEnabled()) {
    return callClaudeOnce(systemPrompt, userContent, opts).then((r) => ({ ...r, context: null, reused: false }));
  }
  return runCompanionTurn({
    systemPrompt,
    userContent,
    model: opts.model,
    resumeId: opts.resumeId ?? null,
    timeoutMs: opts.timeoutMs,
    reminder: opts.reminder,
    onTextDelta: opts.onTextDelta,
    signal: opts.signal,
    // abort 错误类型保持与一次性路径一致(voice/companion-runner 经工厂注入)。
    makeAbortError: () => new VoiceCompanionAbortedError(),
  });
}

/** --resume 指向的会话不存在时,claude CLI 的报错特征。 */
export function isResumeRejection(err: unknown): boolean {
  const e = err as { message?: string; stderr?: string };
  const text = `${e?.message ?? ''}\n${e?.stderr ?? ''}`;
  return /No conversation found with session ID/i.test(text)
    || (/session/i.test(text) && /not found|invalid/i.test(text));
}
