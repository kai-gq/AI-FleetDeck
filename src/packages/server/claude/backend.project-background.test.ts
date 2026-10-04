/**
 * 任务18·B3 Onboarding 测试（L2）：项目背景段注入新 spawn agent 的系统提示。
 *
 * 落点①（统一段）：buildAppendedProjectInstructions 新增「## Project Background」节，
 * 随 --append-system-prompt-file 对所有 claude agent 生效（spawn 链路的系统提示组装）。
 *
 * 覆盖：工作目录 → 工作区/区域映射（Windows 反斜杠 + 大小写不敏感）、映射不上如实写
 *   not mapped、归档区域不参与、体积有界（名单上限/名称截断/整段硬上限）、
 *   工作区索引读失败 → 跳过整段不炸组装。
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workspaces: [
    { id: 'ws-alpha', name: 'Alpha Platform', areaIds: ['area-alpha', 'area-alpha-docs'] },
    { id: 'ws-beta', name: 'Beta Tools', areaIds: ['area-beta'] },
    { id: 'ws-gamma', name: 'Gamma Legacy', areaIds: [] },
  ],
  areas: [
    { id: 'area-alpha', name: 'Alpha Core', directories: ['E:\\repos\\alpha'] },
    { id: 'area-alpha-docs', name: 'Alpha Docs', directories: ['E:/repos/alpha/docs'] },
    { id: 'area-beta', name: 'Beta Lab', directories: ['/home/dev/beta'] },
    { id: 'area-archived', name: 'Old Alpha', directories: ['E:\\repos\\old'], archived: true },
  ],
  getWorkspaces: vi.fn(),
  loadAreas: vi.fn(),
}));

vi.mock('../services/workspace-service.js', () => ({ getWorkspaces: mocks.getWorkspaces }));
vi.mock('../data/index.js', () => ({ loadAreas: mocks.loadAreas }));
vi.mock('../services/system-prompt-service.js', () => ({
  isEchoPromptEnabled: vi.fn(() => false),
  getSystemPrompt: vi.fn(() => ''),
}));
vi.mock('../services/agent-service.js', () => ({
  getAgent: vi.fn(() => null),
}));

import {
  buildAppendedProjectInstructions,
  renderProjectBackgroundSection,
  MAX_PROJECT_BACKGROUND_LINE_CHARS,
  MAX_PROJECT_BACKGROUND_SECTION_CHARS,
} from './backend.js';

beforeEach(() => {
  mocks.getWorkspaces.mockReturnValue(mocks.workspaces);
  mocks.loadAreas.mockReturnValue(mocks.areas);
});

describe('renderProjectBackgroundSection（B3 纯渲染）', () => {
  it('按区域目录把工作目录映射回工作区（反斜杠/大小写不敏感），并列区域名', () => {
    const section = renderProjectBackgroundSection({
      workingDir: 'E:\\repos\\ALPHA',
      workspaces: mocks.workspaces,
      areas: mocks.areas,
    });
    expect(section).toContain('## Project Background (Onboarding)');
    expect(section).toContain('- Working directory: E:\\repos\\ALPHA');
    expect(section).toContain('- Project/workspace: Alpha Platform (areas: Alpha Core)');
    expect(section).toContain('- Other workspaces in this Commander: Beta Tools, Gamma Legacy');
  });

  it('子目录同样命中（前缀匹配，非整目录相等）', () => {
    const section = renderProjectBackgroundSection({
      workingDir: 'E:/repos/alpha/docs/examples',
      workspaces: mocks.workspaces,
      areas: mocks.areas,
    });
    expect(section).toContain('- Project/workspace: Alpha Platform');
    expect(section).toContain('Alpha Docs');
  });

  it('映射不上 → 如实写 not mapped（不猜项目名）', () => {
    const section = renderProjectBackgroundSection({
      workingDir: '/tmp/unrelated',
      workspaces: mocks.workspaces,
      areas: mocks.areas,
    });
    expect(section).toContain('- Project/workspace: not mapped to a named workspace');
    expect(section).toContain('Beta Tools');
  });

  it('归档区域不参与匹配', () => {
    const section = renderProjectBackgroundSection({
      workingDir: 'E:\\repos\\old',
      workspaces: mocks.workspaces,
      areas: mocks.areas,
    });
    expect(section).toContain('not mapped to a named workspace');
  });

  it('工作目录为空 → 整段不输出', () => {
    expect(renderProjectBackgroundSection({ workingDir: '   ', workspaces: mocks.workspaces, areas: mocks.areas })).toBe('');
  });

  it('体积有界：工作区名单上限 +N more（短名场景）', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `ws-${i}`, name: `W${i}`, areaIds: [] }));
    const section = renderProjectBackgroundSection({ workingDir: 'E:\\repos\\alpha', workspaces: many, areas: mocks.areas });
    expect(section).toContain('(+4 more)');
    expect(section.length).toBeLessThanOrEqual(MAX_PROJECT_BACKGROUND_SECTION_CHARS);
  });

  it('体积有界：长名截断 + 每行/整段硬上限', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `ws-${i}`,
      name: `Workspace-${i}-${'z'.repeat(80)}`,
      areaIds: [],
    }));
    const section = renderProjectBackgroundSection({ workingDir: 'E:\\repos\\alpha', workspaces: many, areas: mocks.areas });
    expect(section.length).toBeLessThanOrEqual(MAX_PROJECT_BACKGROUND_SECTION_CHARS);
    for (const line of section.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(MAX_PROJECT_BACKGROUND_LINE_CHARS);
    }
  });

  it('整段硬上限（F3 钉·直测渲染层）：三行顶满使未截断段长 638 > 600 → 整段被截到 600', () => {
    // 旧夹具段长 ~330（行上限先兜住），整段截断分支实际不可达。
    // 此例：超长 workingDir（行截到 200）+ 4 个超长名匹配区域（工作区行截到 200）+
    // 7 个超长名其他工作区（其他工作区行截到 200，(+2 more) 位于被截尾部）→
    // 未截断 36+200+1+200+1+200 = 638 > 600，钉住整段截断：变异「删掉 600 截断」→ 长度断言失败。
    const longName = (core: string) => `${core}-${'z'.repeat(80)}`;
    const areas = Array.from({ length: 4 }, (_, i) => ({
      id: `a-${i}`,
      name: longName(`Area ${i}`),
      directories: ['E:\\repos\\huge'],
    }));
    const workspaces = [
      { id: 'w-matched', name: longName('Matched Workspace'), areaIds: ['a-0'] },
      ...Array.from({ length: 7 }, (_, i) => ({ id: `w-${i}`, name: longName(`Other ${i}`), areaIds: [] })),
    ];
    const section = renderProjectBackgroundSection({
      workingDir: `E:\\repos\\huge\\${'d'.repeat(300)}`,
      workspaces,
      areas,
    });
    expect(section.startsWith('## Project Background (Onboarding)')).toBe(true);
    expect(section.endsWith('…')).toBe(true);
    expect(section.length).toBe(MAX_PROJECT_BACKGROUND_SECTION_CHARS);
    // (+2 more) 在未截断全文里位于被截掉的尾部，最终不应残留（钉住「整段确实被截」的语义）
    expect(section).not.toContain('(+2 more)');
  });
});

describe('buildAppendedProjectInstructions（B3 组装链路）', () => {
  it('spawn 链路的系统提示组装包含项目背景段，既有段不丢', () => {
    const text = buildAppendedProjectInstructions({
      workingDir: 'E:\\repos\\alpha',
      prompt: 'do the task',
    });

    expect(text).toContain('## Project Background (Onboarding)');
    expect(text).toContain('Alpha Platform');
    // 既有段回归：静态规则段仍在
    expect(text).toContain('## Tide Commander Appended Instructions');
  });

  it('工作区索引读失败 → 跳过背景段，不打断组装（降级）', () => {
    mocks.getWorkspaces.mockImplementation(() => {
      throw new Error('workspaces.json unreadable');
    });
    try {
      const text = buildAppendedProjectInstructions({
        workingDir: 'E:\\repos\\alpha',
        prompt: 'do the task',
      });
      expect(text).not.toContain('## Project Background');
      expect(text).toContain('## Tide Commander Appended Instructions');
    } finally {
      mocks.getWorkspaces.mockReturnValue(mocks.workspaces);
    }
  });
});
