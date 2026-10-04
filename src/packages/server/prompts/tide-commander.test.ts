/**
 * 任务17·A1 统一安全护栏单测
 *
 * 覆盖：红线四要点齐备（不删项目外文件 / 不编造 / 危险先报告 / 写操作先报告或确认）、
 * 护栏为「尾部追加」（既有路径规则原样保留）、条目数落在 3-5 条区间。
 * 判据全部锚在可判别的整句片段上：删掉任一条或改语义即红。
 */
import { describe, expect, it } from 'vitest';
import { TIDE_COMMANDER_APPENDED_PROMPT } from './tide-commander.js';

/** 护栏段（从标题到文末）。 */
function guardrailSection(): string {
  const idx = TIDE_COMMANDER_APPENDED_PROMPT.indexOf('## Safety Guardrails');
  expect(idx).toBeGreaterThan(-1);
  return TIDE_COMMANDER_APPENDED_PROMPT.slice(idx);
}

describe('TIDE_COMMANDER_APPENDED_PROMPT — A1 安全护栏', () => {
  it('四要点齐备（整句片段锚定，改语义即红）', () => {
    // ① 不删项目外文件
    expect(TIDE_COMMANDER_APPENDED_PROMPT).toContain(
      'Never delete or overwrite files outside the current project root.',
    );
    // ② 不编造
    expect(TIDE_COMMANDER_APPENDED_PROMPT).toContain(
      'Never fabricate results, file contents, commands, or paths.',
    );
    // ③ 危险操作先报告
    expect(TIDE_COMMANDER_APPENDED_PROMPT).toContain(
      'Stop and report before any destructive or hard-to-undo action',
    );
    // ④ 写操作先报告或确认（含范围限定：requested scope）
    expect(TIDE_COMMANDER_APPENDED_PROMPT).toContain(
      'explicit confirmation for, write operations outside the requested scope',
    );
  });

  it('护栏为尾部追加：既有路径规则原样保留，护栏位于其后', () => {
    const pathRule = '- Every file reference must use its full project-relative path from the repo root.';
    expect(TIDE_COMMANDER_APPENDED_PROMPT).toContain(pathRule);
    expect(TIDE_COMMANDER_APPENDED_PROMPT.indexOf(pathRule)).toBeLessThan(
      TIDE_COMMANDER_APPENDED_PROMPT.indexOf('## Safety Guardrails'),
    );
    // 头部标题与「追加」语义不变（agents 依赖该常量被追加到 system prompt）
    expect(TIDE_COMMANDER_APPENDED_PROMPT.startsWith('## Tide Commander Appended Instructions')).toBe(true);
  });

  it('护栏条目数为 3-5 条（预算约束；少于 3 或多于 5 即红）', () => {
    const bullets = guardrailSection()
      .split('\n')
      .filter((line) => line.trim().startsWith('- '));
    expect(bullets.length).toBeGreaterThanOrEqual(3);
    expect(bullets.length).toBeLessThanOrEqual(5);
  });

  it('任务委派/危险操作的措辞不弱化为「可以/允许」式许可', () => {
    const section = guardrailSection();
    expect(section).not.toMatch(/you may (delete|remove|overwrite|fabricate)/i);
    expect(section).not.toMatch(/no need to (report|confirm)/i);
  });
});
