import { getI18nInstance } from '../../utils/formatting';

/**
 * Translate a `terminal:` key outside React (module-level helpers, plugin
 * registration titles). The English default keeps en output unchanged
 * (locale-only keys live in public/locales/<lang>); before i18n init (unit
 * tests) it is returned with its `{{vars}}` interpolated so callers never see
 * raw placeholders.
 */
export function bolbaT(key: string, defaultValue: string, vars?: Record<string, unknown>): string {
  const i18n = getI18nInstance();
  const t = i18n?.t?.bind(i18n);
  if (t) return t(`terminal:${key}`, { defaultValue, ...vars });
  if (!vars) return defaultValue;
  return defaultValue.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}
