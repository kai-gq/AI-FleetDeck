/**
 * 任务19 · 秘书 CLI spawn 档案(companion-cli-profile)单测。
 *
 * 覆盖:三档开关解析(缺省/非法回退)、cwd 中立目录与降级、args 组装
 * (--tools 恒在末尾 / win32 空值字面量 '""' / allowlist 的 MCP 过滤文件)、
 * effort 的 --settings 覆盖文件、以及「源配置不可用 → 按无 MCP 降级」。
 * 全部走显式 env 参数(不污染 process.env),数据目录用沙箱重定向。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../utils/index.js';
import {
  ALLOWLIST_MCP_FILENAME,
  HOP_BUILTIN_ALLOWLIST,
  MCP_SOURCE_ENV,
  VOICE_CWD_DIRNAME,
  buildHopProfileArgs,
  resolveCompanionCliProfile,
  resolveHopEffort,
  resolveHopToolsMode,
  resolveVoiceCwd,
  resetCompanionCliProfileForTests,
} from './companion-cli-profile.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-cli-profile-'));
const dataDir = path.join(sandbox, 'xdg', 'tide-commander');

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetCompanionCliProfileForTests();
  // 注意:对已 mock 的方法再 spyOn 会复用同一 spy 对象 → 必须显式清计数。
  warnSpy = vi.spyOn(logger.server, 'warn');
  warnSpy.mockClear();
  warnSpy.mockImplementation(() => {});
});

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function writeMcpFixture(): string {
  const file = path.join(sandbox, 'claude-global.json');
  fs.writeFileSync(file, JSON.stringify({
    mcpServers: {
      'mcp-server-mysql': { command: 'npx', args: ['-y', '@benborla29/mcp-server-mysql'], env: { MYSQL_HOST: 'localhost' } },
      obsidian: { command: 'npx', args: ['-y', '@istrejo/obsidian-mcp'] },
      'obsidian-boshi': { command: 'npx', args: ['-y', '@istrejo/obsidian-mcp'] },
      'mcp-server-clickhouse': { command: 'should-not-appear' },
    },
  }));
  return file;
}

describe('任务19 档案:开关解析', () => {
  it('TC_VOICE_HOP_TOOLS:未设 → allowlist;合法值原样;非法值 warn 一次后回退 allowlist', () => {
    expect(resolveHopToolsMode({})).toBe('allowlist');
    expect(resolveHopToolsMode({ TC_VOICE_HOP_TOOLS: 'default' })).toBe('default');
    expect(resolveHopToolsMode({ TC_VOICE_HOP_TOOLS: ' nomcp ' })).toBe('nomcp');
    expect(resolveHopToolsMode({ TC_VOICE_HOP_TOOLS: 'NONE' })).toBe('none');

    expect(resolveHopToolsMode({ TC_VOICE_HOP_TOOLS: 'bogus' })).toBe('allowlist');
    expect(resolveHopToolsMode({ TC_VOICE_HOP_TOOLS: 'bogus' })).toBe('allowlist');
    // warn-once:同一非法值只提示一次。
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('bogus');
  });

  it('TC_VOICE_EFFORT:未设/非法 → null(不传);合法值原样', () => {
    expect(resolveHopEffort({})).toBeNull();
    expect(resolveHopEffort({ TC_VOICE_EFFORT: 'low' })).toBe('low');
    expect(resolveHopEffort({ TC_VOICE_EFFORT: 'XHIGH' })).toBe('xhigh');
    expect(resolveHopEffort({ TC_VOICE_EFFORT: 'max' })).toBe('max');
    expect(resolveHopEffort({ TC_VOICE_EFFORT: 'turbo' })).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('TC_VOICE_CWD:缺省建 <data dir>/voice-cwd;inherit → null;mkdir 失败 → null + warn', () => {
    const env = { XDG_DATA_HOME: path.join(sandbox, 'xdg') };
    const dir = resolveVoiceCwd(env);
    expect(dir).toBe(path.join(dataDir, VOICE_CWD_DIRNAME));
    expect(fs.existsSync(dir!)).toBe(true);

    expect(resolveVoiceCwd({ ...env, TC_VOICE_CWD: 'inherit' })).toBeNull();

    // 阻断:把 cwd 指到「普通文件之下」→ mkdir 必败 → 降级继承。
    const blocker = path.join(sandbox, 'blocker-file');
    fs.writeFileSync(blocker, 'x');
    expect(resolveVoiceCwd({ ...env, TC_VOICE_CWD: path.join(blocker, 'sub') })).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('回退继承');
  });
});

describe('任务19 档案:args 组装(--tools 恒在末尾)', () => {
  const P = 'E:\\fake\\mcp.json';

  it('default 档 = 逐字回今日(主链路零档案参数;垫话仅 strict)', () => {
    expect(buildHopProfileArgs({ toolsMode: 'default', zeroTools: false, platform: 'win32', mcpConfigPath: null })).toEqual([]);
    expect(buildHopProfileArgs({ toolsMode: 'default', zeroTools: true, platform: 'win32', mcpConfigPath: null })).toEqual(['--strict-mcp-config']);
  });

  it('nomcp 档:主链路 strict;垫话额外禁全部内置工具', () => {
    expect(buildHopProfileArgs({ toolsMode: 'nomcp', zeroTools: false, platform: 'win32', mcpConfigPath: null })).toEqual(['--strict-mcp-config']);
    expect(buildHopProfileArgs({ toolsMode: 'nomcp', zeroTools: true, platform: 'win32', mcpConfigPath: null })).toEqual(['--strict-mcp-config', '--tools', '""']);
    expect(buildHopProfileArgs({ toolsMode: 'nomcp', zeroTools: true, platform: 'linux', mcpConfigPath: null })).toEqual(['--strict-mcp-config', '--tools', '']);
  });

  it('none 档:主链路也禁全部内置工具(--tools 收尾)', () => {
    const args = buildHopProfileArgs({ toolsMode: 'none', zeroTools: false, platform: 'win32', mcpConfigPath: null });
    expect(args).toEqual(['--strict-mcp-config', '--tools', '""']);
    expect(args[args.length - 1]).toBe('""');
  });

  it('allowlist 档:白名单 5 内置 + 过滤 MCP 文件;源不可用则仅白名单;垫话零工具', () => {
    const full = buildHopProfileArgs({ toolsMode: 'allowlist', zeroTools: false, platform: 'win32', mcpConfigPath: P });
    expect(full).toEqual(['--strict-mcp-config', '--mcp-config', P, '--tools', HOP_BUILTIN_ALLOWLIST]);
    expect(full[full.length - 1]).toBe(HOP_BUILTIN_ALLOWLIST);

    const degraded = buildHopProfileArgs({ toolsMode: 'allowlist', zeroTools: false, platform: 'win32', mcpConfigPath: null });
    expect(degraded).toEqual(['--strict-mcp-config', '--tools', HOP_BUILTIN_ALLOWLIST]);

    const zero = buildHopProfileArgs({ toolsMode: 'allowlist', zeroTools: true, platform: 'win32', mcpConfigPath: P });
    expect(zero).toEqual(['--strict-mcp-config', '--tools', '""']); // 垫话不给 MCP 文件
  });
});

describe('任务19 档案:整档解析(沙箱)', () => {
  const env = (): NodeJS.ProcessEnv => ({ XDG_DATA_HOME: path.join(sandbox, 'xdg'), [MCP_SOURCE_ENV]: writeMcpFixture() });

  it('allowlist 缺省:过滤文件只留名单内 3 个服务;cwd 建到中立目录;同指纹两次解析同对象', () => {
    const e = env();
    const profile = resolveCompanionCliProfile({ env: e, platform: 'win32' });

    const mcpPath = path.join(dataDir, ALLOWLIST_MCP_FILENAME);
    expect(profile.args).toEqual(['--strict-mcp-config', '--mcp-config', mcpPath, '--tools', HOP_BUILTIN_ALLOWLIST]);
    expect(profile.cwd).toBe(path.join(dataDir, VOICE_CWD_DIRNAME));
    expect(profile.settingsPath).toBeNull();

    const written = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(written.mcpServers).sort()).toEqual(['mcp-server-mysql', 'obsidian', 'obsidian-boshi']);
    expect(written.mcpServers['mcp-server-clickhouse']).toBeUndefined();

    // 备忘:同指纹(同 env 对象)直接复用,不再重解析。
    expect(resolveCompanionCliProfile({ env: e, platform: 'win32' })).toBe(profile);
  });

  it('effort=low:args 头部 --settings 覆盖文件,内容为 env 覆盖;文件缺失即补写', () => {
    const e = { ...env(), TC_VOICE_EFFORT: 'low' };
    const profile = resolveCompanionCliProfile({ env: e, platform: 'win32' });

    const settingsPath = path.join(dataDir, 'voice-companion-effort-low.json');
    expect(profile.args.slice(0, 2)).toEqual(['--settings', settingsPath]);
    expect(profile.settingsPath).toBe(settingsPath);
    // --tools 仍在最末(变参安全)。
    expect(profile.args[profile.args.length - 2]).toBe('--tools');
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({ env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } });
  });

  it('MCP 源配置缺失:allowlist 降级为「无 MCP」,仍保内置白名单 + warn 一次', () => {
    const e = { XDG_DATA_HOME: path.join(sandbox, 'xdg'), [MCP_SOURCE_ENV]: path.join(sandbox, 'no-such-file.json') };
    const profile = resolveCompanionCliProfile({ env: e, platform: 'win32' });

    expect(profile.args).toEqual(['--strict-mcp-config', '--tools', HOP_BUILTIN_ALLOWLIST]);
    expect(profile.mcpConfigPath).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('按「无 MCP」执行');
  });
});
