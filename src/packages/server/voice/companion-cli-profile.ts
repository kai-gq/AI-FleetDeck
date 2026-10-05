/**
 * 语音伙伴 · CLI spawn 档案(任务19 · 秘书「防过度思考」机制层,提示词之外的硬杠杆)
 *
 * 背景(实证,2026-10-05):
 * - 秘书子进程 cwd=仓库根 → 每回合被注入本仓库开发约定(CLAUDE.md)与项目自动记忆;
 * - 工具 schema 82k→163k 字符(23→99 个,含全部用户 MCP 会话中途异步涌入),
 *   而 12 个秘书会话 11 个零工具调用 → 纯稀释;
 * - user settings 的 CLAUDE_CODE_EFFORT_LEVEL=max 全档拉满(deepseek-v4-flash)。
 *
 * 本模块是「工具白名单 / 中立 cwd / effort 透传」三类 spawn 参数的唯一解析点
 * (callClaudeOnce 与常驻通道 spawnResidentProcess 共用)。预检实测(CLI v2.1.287):
 * - `--tools ""`(win32 + shell:true 须写字面量 `""`)实测禁用全部内置工具;`--tools`
 *   是变参,**必须置于 args 末尾**,以免吞掉后续 flag;
 * - `--strict-mcp-config` + `--mcp-config <file>` 只加载文件内服务(白名单利器);
 * - `--effort low` 会被 user settings 的 env 压过 → 改用 `--settings <临时 JSON>`
 *   覆盖 `CLAUDE_CODE_EFFORT_LEVEL`(实测生效;user 设置源本身绝不可去,deepseek
 *   中转凭据在彼)。
 *
 * 开关(缺省即新行为;回退逐字回今日):
 * - TC_VOICE_HOP_TOOLS=default|allowlist|nomcp|none(缺省 allowlist;非法值 warn 后回退)
 * - TC_VOICE_EFFORT=low|medium|high|xhigh|max(未设 = 不传,维持 user settings 现档)
 * - TC_VOICE_CWD=<path>|inherit(缺省 <data dir>/voice-cwd/;mkdir 失败降级 inherit)
 * - TC_VOICE_MCP_SOURCE=<path>(缺省 ~/.claude.json;测试与易位用)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../utils/index.js';

const log = logger.server;

// ============================================================================
// 开关与环境
// ============================================================================

export const HOP_TOOLS_ENV = 'TC_VOICE_HOP_TOOLS';
export const HOP_EFFORT_ENV = 'TC_VOICE_EFFORT';
export const VOICE_CWD_ENV = 'TC_VOICE_CWD';
export const MCP_SOURCE_ENV = 'TC_VOICE_MCP_SOURCE';

export type HopToolsMode = 'default' | 'allowlist' | 'nomcp' | 'none';
export const HOP_TOOLS_MODES: readonly HopToolsMode[] = ['default', 'allowlist', 'nomcp', 'none'];

export const HOP_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type HopEffort = (typeof HOP_EFFORTS)[number];

/** 允许保留的内置工具(逗号分隔,喂给 --tools)。 */
export const HOP_BUILTIN_ALLOWLIST = 'WebSearch,WebFetch,Read,Glob,Grep';

/** 允许保留的全局 MCP 服务名(键名取自 ~/.claude.json 的 mcpServers)。 */
export const COMPANION_MCP_KEEP: readonly string[] = ['mcp-server-mysql', 'obsidian', 'obsidian-boshi'];

/** 过滤后 MCP 配置的落盘文件名(数据目录内,内容随源配置变化才重写)。 */
export const ALLOWLIST_MCP_FILENAME = 'voice-companion-mcp-allowlist.json';
/** 中立 cwd 缺省子目录名(数据目录内)。 */
export const VOICE_CWD_DIRNAME = 'voice-cwd';

// ============================================================================
// 单项解析
// ============================================================================

const warnedKeys = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  log.warn(`[VoiceCompanion] ${message}`);
}

/** 秘书数据目录(XDG_DATA_HOME 可重定向,与 voice-companion.json / PID 台账同规)。 */
export function resolveVoiceDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(home, 'tide-commander');
}

/** 工具档:缺省 allowlist;非法值 warn 一次后回退缺省(绝不抛错)。 */
export function resolveHopToolsMode(env: NodeJS.ProcessEnv = process.env): HopToolsMode {
  const raw = (env[HOP_TOOLS_ENV] ?? '').trim().toLowerCase();
  if (!raw) return 'allowlist';
  if ((HOP_TOOLS_MODES as readonly string[]).includes(raw)) return raw as HopToolsMode;
  warnOnce(`tools-mode-invalid:${raw}`, `TC_VOICE_HOP_TOOLS 非法值「${raw}」,按缺省 allowlist 执行`);
  return 'allowlist';
}

/** effort 档:未设 = null(不追加 --settings,维持 user settings 现档)。 */
export function resolveHopEffort(env: NodeJS.ProcessEnv = process.env): HopEffort | null {
  const raw = (env[HOP_EFFORT_ENV] ?? '').trim().toLowerCase();
  if (!raw) return null;
  if ((HOP_EFFORTS as readonly string[]).includes(raw)) return raw as HopEffort;
  warnOnce(`effort-invalid:${raw}`, `TC_VOICE_EFFORT 非法值「${raw}」(可选 ${HOP_EFFORTS.join('/')}),忽略`);
  return null;
}

/**
 * 子进程 cwd:缺省 <data dir>/voice-cwd/(中立目录,隔断仓库 CLAUDE.md / 项目记忆注入);
 * `inherit` 或 mkdir 失败 → null(spawn 继承服务进程 cwd = 今日行为)。
 */
export function resolveVoiceCwd(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env[VOICE_CWD_ENV] ?? '').trim();
  if (raw.toLowerCase() === 'inherit') return null;
  const dir = raw || path.join(resolveVoiceDataDir(env), VOICE_CWD_DIRNAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    warnOnce(`cwd-mkdir-fail:${dir}`, `中立 cwd 目录不可用(${dir}:${(err as Error).message}),回退继承进程 cwd`);
    return null;
  }
}

// ============================================================================
// 临时/派生文件(内容变化才重写;失败静默降级)
// ============================================================================

/** 从全局配置挑出保留的 MCP 服务,写过滤文件;源不可用/无命中 → null(按无 MCP 降级)。 */
function ensureAllowlistMcpConfig(env: NodeJS.ProcessEnv, dataDir: string): string | null {
  const source = (env[MCP_SOURCE_ENV] ?? '').trim() || path.join(os.homedir(), '.claude.json');
  const outPath = path.join(dataDir, ALLOWLIST_MCP_FILENAME);
  try {
    const all = (JSON.parse(fs.readFileSync(source, 'utf-8')) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {};
    const picked: Record<string, unknown> = {};
    for (const key of COMPANION_MCP_KEEP) {
      const def = all[key];
      if (def && typeof def === 'object') picked[key] = def;
    }
    if (!Object.keys(picked).length) {
      warnOnce(`mcp-none:${source}`, `未在 ${source} 找到保留名单内的 MCP 服务(${COMPANION_MCP_KEEP.join('/')}),按「无 MCP」执行`);
      return null;
    }
    const json = JSON.stringify({ mcpServers: picked }, null, 2);
    if (!(fs.existsSync(outPath) && fs.readFileSync(outPath, 'utf-8') === json)) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const tmp = `${outPath}.tmp`;
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, outPath);
    }
    return outPath;
  } catch (err) {
    warnOnce(`mcp-read-fail:${source}`, `读取 MCP 源配置失败(${source}:${(err as Error).message}),按「无 MCP」执行`);
    return null;
  }
}

/** effort 覆盖用 settings 文件(--effort 会被 user settings 压过,只能走 env 覆盖)。 */
function ensureEffortSettingsFile(effort: HopEffort, dataDir: string): string | null {
  const outPath = path.join(dataDir, `voice-companion-effort-${effort}.json`);
  const json = JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: effort } });
  try {
    if (!(fs.existsSync(outPath) && fs.readFileSync(outPath, 'utf-8') === json)) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const tmp = `${outPath}.tmp`;
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, outPath);
    }
    return outPath;
  } catch (err) {
    warnOnce(`effort-file-fail:${outPath}`, `effort 覆盖文件写入失败(${(err as Error).message}),该项忽略`);
    return null;
  }
}

// ============================================================================
// args 组装(纯函数;--tools 恒在末尾——变参,防止吞掉后续 flag)
// ============================================================================

/** win32 + shell:true 下空 --tools 值必须写字面量 `""`(cmd 会吞真空串);其它平台用真空串。 */
export function noToolsArgValue(platform: NodeJS.Platform): string {
  return platform === 'win32' ? '""' : '';
}

export function buildHopProfileArgs(o: {
  toolsMode: HopToolsMode;
  /** 垫话等「零工具」一次性生成:任何档位下都不给工具。 */
  zeroTools: boolean;
  platform: NodeJS.Platform;
  /** allowlist 档的过滤后 MCP 配置路径;null = 源不可用,按无 MCP 执行。 */
  mcpConfigPath: string | null;
}): string[] {
  const none = noToolsArgValue(o.platform);
  switch (o.toolsMode) {
    case 'default':
      // 回退档:逐字回今日行为(垫话仍只有 --strict-mcp-config)。
      return o.zeroTools ? ['--strict-mcp-config'] : [];
    case 'nomcp':
      return o.zeroTools ? ['--strict-mcp-config', '--tools', none] : ['--strict-mcp-config'];
    case 'none':
      return ['--strict-mcp-config', '--tools', none];
    case 'allowlist': {
      const args = ['--strict-mcp-config'];
      if (!o.zeroTools && o.mcpConfigPath) args.push('--mcp-config', o.mcpConfigPath);
      args.push('--tools', o.zeroTools ? none : HOP_BUILTIN_ALLOWLIST);
      return args;
    }
  }
}

// ============================================================================
// 档案解析(带备忘:env 指纹不变时不重复读 ~/.claude.json)
// ============================================================================

export interface CompanionCliProfile {
  toolsMode: HopToolsMode;
  effort: HopEffort | null;
  /** 传给 spawn 的 cwd;null = 继承服务进程 cwd。 */
  cwd: string | null;
  /** 追加到 args 尾部的档案参数(--tools 恒在最后)。 */
  args: string[];
  /** 常驻进程复用判定键(工具档 + effort + cwd + MCP 文件实况)。 */
  key: string;
  /** 诊断用:本次实际生效的派生文件路径。 */
  mcpConfigPath: string | null;
  settingsPath: string | null;
}

let cached: { fp: string; profile: CompanionCliProfile } | null = null;

function envFingerprint(env: NodeJS.ProcessEnv, zeroTools: boolean, platform: NodeJS.Platform): string {
  return [
    env[HOP_TOOLS_ENV] ?? '',
    env[HOP_EFFORT_ENV] ?? '',
    env[VOICE_CWD_ENV] ?? '',
    env[MCP_SOURCE_ENV] ?? '',
    env.XDG_DATA_HOME ?? '',
    env.USERPROFILE ?? '',
    env.HOME ?? '',
    platform,
    zeroTools ? 'zero' : 'full',
  ].join('\u0000');
}

/** 测试用:清备忘与 warn-once 台账。 */
export function resetCompanionCliProfileForTests(): void {
  cached = null;
  warnedKeys.clear();
}

/**
 * 解析本次 spawn 的完整档案。任何内部失败都收敛为「安全降级」(无档案参数 + 继承 cwd),
 * 绝不抛错——spawn 主链路不允许被档案层打断。
 */
export function resolveCompanionCliProfile(opts: {
  zeroTools?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
} = {}): CompanionCliProfile {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const zeroTools = !!opts.zeroTools;
  const fp = envFingerprint(env, zeroTools, platform);
  if (cached && cached.fp === fp) return cached.profile;
  const profile = computeProfile(env, platform, zeroTools);
  cached = { fp, profile };
  return profile;
}

function computeProfile(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, zeroTools: boolean): CompanionCliProfile {
  const fallback: CompanionCliProfile = { toolsMode: 'default', effort: null, cwd: null, args: [], key: 'fallback', mcpConfigPath: null, settingsPath: null };
  try {
    const toolsMode = resolveHopToolsMode(env);
    const effort = resolveHopEffort(env);
    const dataDir = resolveVoiceDataDir(env);
    const cwd = resolveVoiceCwd(env);
    const settingsPath = effort ? ensureEffortSettingsFile(effort, dataDir) : null;
    const mcpConfigPath = toolsMode === 'allowlist' && !zeroTools ? ensureAllowlistMcpConfig(env, dataDir) : null;
    const args = [
      ...(settingsPath ? ['--settings', settingsPath] : []),
      ...buildHopProfileArgs({ toolsMode, zeroTools, platform, mcpConfigPath }),
    ];
    const key = [toolsMode, settingsPath ?? '-', cwd ?? 'inherit', mcpConfigPath ?? '-'].join('|');
    return { toolsMode, effort, cwd, args, key, mcpConfigPath, settingsPath };
  } catch (err) {
    warnOnce('profile-fallback', `档案解析异常(${(err as Error).message}),按逐字回退执行`);
    return fallback;
  }
}
