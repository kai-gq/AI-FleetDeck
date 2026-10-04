/**
 * Claude CLI 一次性调用垫片（⑮ P1）
 *
 * 复用说明：本仓库现有的一次性调用实现都是模块私有且所在文件为并发写者持有 ——
 * voice-companion-service.ts:724 callClaudeOnce、boss-service.ts:378
 * callClaudeForDelegation，均无法在不改禁改文件的前提下导出复用。因此这里抽出
 * 与两者同款的最小模式：claude --print 单次子进程 + 临时 system prompt 文件 +
 * stdin 注入 user 内容 + 超时 kill；可执行文件解析复用现有 ClaudeBackend
 * （getExecutablePath，含 claude.exe 原生安装路径候选）。
 *
 * 与"agent runner"的区别：不建 tmux 会话、不接 stream-json 事件流、不进 UI，
 * 只取最终 result 文本；调用方通过 LLMInvoker 注入，测试可整体替换为 stub。
 *
 * 只读硬化：--tools "" 在 CLI 层禁用全部工具（与提示词红线双重保障）；
 * 若某版本 CLI 不支持该参数，调用会失败并在 service 层降级为 llm-error，
 * 不会静默执行工具。
 */

import { spawn, type ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LLMInvoker, LLMInvokerResult } from './types.js';

export interface ClaudeCliInvokerOptions {
  /** 覆盖可执行文件路径（测试用）；缺省走 ClaudeBackend.getExecutablePath() */
  executablePath?: string;
  /** 缺省 'haiku'（分类/摘要类低成本任务，对齐 llm-matcher-service 选型） */
  model?: string;
  /** 缺省 240s（实测 400 行 server.log 摘录 + 长报告约 115s，留足余量） */
  timeoutMs?: number;
  cwd?: string;
}

let cachedExecutable: string | undefined;

/** 解析 claude 可执行文件（懒加载 ClaudeBackend，避免单测为 stub 时引入重依赖图）。 */
async function resolveClaudeExecutable(): Promise<string> {
  if (cachedExecutable) return cachedExecutable;
  const mod = await import('../claude/backend.js');
  cachedExecutable = new mod.ClaudeBackend().getExecutablePath();
  return cachedExecutable;
}

export interface ParsedClaudeOutput {
  text: string;
  isError?: boolean;
  errorMessage?: string;
  sessionId?: string;
  costUsd?: number;
}

/**
 * 解析 --output-format json 的单次输出。
 * 容错：CLI 可能在 stdout 夹杂非 JSON 前导行（版本警告），逐行找含 result/type 的对象；
 * 都找不到时按纯文本返回（不吞内容）。
 */
export function parseClaudeJsonOutput(stdout: string): ParsedClaudeOutput {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: '' };

  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(trimmed));
  } catch {
    for (const line of trimmed.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        candidates.push(JSON.parse(t));
      } catch {
        // 忽略非 JSON 行
      }
    }
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const obj = candidate as Record<string, unknown>;
    if (obj.type !== 'result' && typeof obj.result !== 'string') continue;
    if (obj.is_error === true) {
      return {
        text: '',
        isError: true,
        errorMessage: typeof obj.result === 'string' ? obj.result : String(obj.subtype ?? 'unknown'),
        sessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined,
      };
    }
    if (typeof obj.result === 'string') {
      return {
        text: obj.result,
        sessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined,
        costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
      };
    }
  }
  return { text: trimmed };
}

function killTree(child: ChildProcess): void {
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 5_000);
  timer.unref?.();
}

/**
 * 创建默认 LLMInvoker：单次 claude --print 调用。
 * 不注册任何常驻进程；每次调用写完临时 prompt 文件后删除。
 */
export function createClaudeCliInvoker(defaults: ClaudeCliInvokerOptions = {}): LLMInvoker {
  return async (req): Promise<LLMInvokerResult> => {
    if (req.signal?.aborted) {
      const err = new Error('log-analysis LLM call aborted');
      err.name = 'AbortError';
      throw err;
    }
    const startedAt = Date.now();
    const executable = defaults.executablePath ?? (await resolveClaudeExecutable());
    const model = req.model ?? defaults.model ?? 'haiku';
    const timeoutMs = req.timeoutMs ?? defaults.timeoutMs ?? 240_000;

    const promptFile = path.join(
      os.tmpdir(),
      `log-analysis-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
    );
    fs.writeFileSync(promptFile, req.systemPrompt, 'utf8');

    // .cmd 安装（npm 全局）需要 cmd.exe 转一层；.exe 直启则原样传参（含空字符串参数）。
    // 经 cmd 传空参数必须写成 '""'（实测：'' 会被 cmd 吞掉，'""' 保留为空参数）。
    const useShell = process.platform === 'win32' && !/\.exe$/i.test(executable);
    const args = [
      '--print',
      '--output-format', 'json',
      '--model', model,
      '--system-prompt-file', promptFile,
      // 只读红线在 CLI 层的硬保障：不使用任何工具
      '--tools', useShell ? '""' : '',
    ];

    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        let child: ChildProcess;
        try {
          child = spawn(executable, args, {
            cwd: defaults.cwd,
            env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
            shell: useShell,
            windowsHide: true,
          });
        } catch (err) {
          reject(err);
          return;
        }

        const decoder = new StringDecoder('utf8');
        let out = '';
        let errOut = '';
        let settled = false;

        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          req.signal?.removeEventListener('abort', onAbort);
          fn();
        };

        const timeout = setTimeout(() => {
          settle(() => {
            killTree(child);
            const err = new Error(`Claude 一次性调用超时（${timeoutMs}ms）`);
            err.name = 'LogAnalysisTimeout';
            reject(err);
          });
        }, timeoutMs);

        const onAbort = () => {
          settle(() => {
            killTree(child);
            const err = new Error('log-analysis LLM call aborted');
            err.name = 'AbortError';
            reject(err);
          });
        };
        req.signal?.addEventListener('abort', onAbort, { once: true });

        child.stdout?.on('data', (buf: Buffer) => {
          out += decoder.write(buf);
        });
        child.stderr?.on('data', (buf: Buffer) => {
          errOut += decoder.write(buf);
          if (errOut.length > 4_000) errOut = errOut.slice(-4_000);
        });
        child.on('error', (err) => settle(() => reject(err)));
        child.on('close', (code) => {
          out += decoder.end();
          settle(() => {
            if (code !== 0 && !out.trim()) {
              const err = new Error(`Claude 退出码 ${code}：${errOut.slice(0, 500)}`);
              reject(err);
            } else {
              resolve(out);
            }
          });
        });

        if (req.signal?.aborted) {
          onAbort();
          return;
        }
        try {
          child.stdin?.write(req.userContent);
          child.stdin?.end();
        } catch (err) {
          settle(() => reject(err));
        }
      });

      const parsed = parseClaudeJsonOutput(stdout);
      if (parsed.isError) {
        throw new Error(`Claude 返回错误：${parsed.errorMessage ?? 'unknown'}`);
      }
      if (!parsed.text.trim()) {
        throw new Error('Claude 未返回文本结果');
      }
      return { text: parsed.text, durationMs: Date.now() - startedAt, model };
    } finally {
      try {
        if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
      } catch {
        /* 临时文件清理失败不影响结果 */
      }
    }
  };
}
