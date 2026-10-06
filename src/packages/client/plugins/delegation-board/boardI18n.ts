import { getI18nInstance } from '../../utils/formatting';

/**
 * Translate a `terminal:` key outside React (plugin registration titles).
 * Mirrors bolbaI18n: English default keeps en output unchanged; before i18n
 * init (unit tests) `{{vars}}` are interpolated so callers never see raw
 * placeholders.
 */
export function boardT(key: string, defaultValue: string, vars?: Record<string, unknown>): string {
  const i18n = getI18nInstance();
  const t = i18n?.t?.bind(i18n);
  if (t) return t(`terminal:${key}`, { defaultValue, ...vars });
  if (!vars) return defaultValue;
  return defaultValue.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}
