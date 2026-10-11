/**
 * 本目录内部共享的小工具(不对外导出:shell 包装归一 / codex exec 脚本提取 / JS 字符串字段等)。
 *
 * 自 utils/outputRendering.ts 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

export function codexExecScript(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  const direct = record.input || record.code || record.script;
  if (typeof direct === 'string') return direct;
  // Some persisted sessions normalize the outer Codex `exec` call to Bash and
  // place its JavaScript wrapper in the command field.
  if (typeof record.command === 'string' && /\btools\.[A-Za-z0-9_]+\s*\(/.test(record.command)) return record.command;
  return '';
}

export function extractJavaScriptStringField(script: string, field: string): string | null {
  // Accept both JS object keys (`cmd: "..."`) and JSON-style quoted keys
  // (`"cmd":"..."`) used by persisted Codex wrappers.
  const match = script.match(new RegExp(`\\b${field}["']?\\s*:\\s*(["'\x60])((?:\\\\[\\s\\S]|(?!\\1)[\\s\\S])*)\\1`));
  return match?.[2]?.replace(/\\n/g, '\n').replace(/\\(["'\x60\\])/g, '$1') || null;
}

export function normalizeShellWrapper(command: string): string {
  let clean = command.replace(/^\s*(?:\/usr\/bin\/|\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+/, '').trim();
  if (clean.length >= 2) {
    const quote = clean[0];
    if ((quote === '"' || quote === "'") && clean.endsWith(quote)) {
      clean = clean.slice(1, -1).trim();
    }
  }
  return clean.replace(/\\"/g, '"').replace(/\\'/g, "'");
}
