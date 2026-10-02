/**
 * zh-CN locale guards.
 *
 * 1. Canonical parity audit (tools/i18n/audit.mjs --strict): missing keys,
 *    placeholder mismatches, untranslated leftovers, glossary violations,
 *    duplicate keys, JSON hygiene. The audit tool is the single source of
 *    truth for counting rules — see tools/i18n/README.md.
 * 2. Runtime resolution smoke with the real i18next: every zh-CN leaf must
 *    resolve through t() to the zh value, not silently fall back to en
 *    (catches broken namespace wiring and plural-family traps that a
 *    file-level diff cannot see).
 *
 * Locale edits go through tools/i18n/apply.mjs; never hand-edit
 * public/locales/zh-CN/*.json.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import i18next from 'i18next';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NS = ['common', 'tools', 'config', 'errors', 'notifications', 'dashboard', 'terminal'];

type Json = Record<string, unknown>;

const readLocale = (lang: string): Record<string, Json> =>
  Object.fromEntries(
    NS.map(ns => [ns, JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'locales', lang, `${ns}.json`), 'utf8'))]),
  );

const leaves = (node: unknown, prefix = ''): Array<[string, unknown]> => {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    return Object.entries(node as Json).flatMap(([k, v]) =>
      leaves(v, prefix ? `${prefix}.${k}` : k),
    );
  }
  return [[prefix, node]];
};

const PLACEHOLDER = /\{\{(\w+)[^}]*\}\}/g;

describe('zh-CN locale', () => {
  it('passes the canonical parity audit (--strict)', () => {
    try {
      const out = execFileSync(
        process.execPath,
        [path.join(ROOT, 'tools', 'i18n', 'audit.mjs'), '--strict'],
        { cwd: ROOT, encoding: 'utf8' },
      );
      expect(out).toContain('totals: 0 FAIL');
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      throw new Error(`i18n audit failed:\n${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`);
    }
  });

  it('resolves every zh-CN key through real i18next (no silent en fallback)', async () => {
    const resources = { en: readLocale('en'), 'zh-CN': readLocale('zh-CN') };
    const inst = i18next.createInstance();
    await inst.init({
      lng: 'zh-CN',
      fallbackLng: 'en',
      ns: NS,
      defaultNS: 'common',
      resources,
      interpolation: { escapeValue: false },
    });

    const failures: string[] = [];
    let checked = 0;

    for (const ns of NS) {
      for (const [key, zhVal] of leaves(resources['zh-CN'][ns])) {
        if (typeof zhVal !== 'string') continue;
        // Feed placeholder names as their own values so interpolation is
        // observable; count gets a real number (also exercises plural path).
        const vars: Record<string, string | number> = {};
        for (const m of zhVal.matchAll(PLACEHOLDER)) vars[m[1]] = m[1] === 'count' ? 2 : m[1];
        const expected = zhVal.replace(PLACEHOLDER, (_all, name: string) => (name === 'count' ? '2' : name));
        const got = inst.t(`${ns}:${key}`, vars);
        checked++;
        if (got !== expected) {
          failures.push(`${ns}:${key}\n  zh:  ${JSON.stringify(zhVal)}\n  got: ${JSON.stringify(got)}`);
        }
      }
    }

    expect(failures.slice(0, 20).join('\n')).toBe('');
    expect(failures.length).toBe(0);
    expect(checked).toBeGreaterThan(1500);
  });
});
