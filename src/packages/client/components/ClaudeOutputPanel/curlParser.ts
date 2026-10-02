import type { TFunction } from 'i18next';
import { getI18nInstance } from '../../utils/formatting';

/**
 * Tokenize a POSIX-style shell command string into argv tokens.
 * Handles single quotes (literal), double quotes (with backslash escapes for " $ ` \),
 * backslash escapes outside quotes, and the `'\''` idiom for embedding single quotes
 * inside a single-quoted string.
 *
 * Returns null if the input has an unterminated quote.
 */
export function shellTokenize(input: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
        hasToken = true;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '\\') {
        const next = input[i + 1];
        if (next === '\n') {
          // Backslash-newline inside double quotes is a line continuation — both removed.
          i++;
        } else if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next;
          i++;
          hasToken = true;
        } else {
          current += ch;
          hasToken = true;
        }
      } else if (ch === '"') {
        inDouble = false;
      } else {
        current += ch;
        hasToken = true;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }
    if (ch === '\\') {
      const next = input[i + 1];
      if (next === '\n') {
        // Line continuation: backslash-newline is removed entirely (no token).
        i++;
      } else if (next !== undefined) {
        current += next;
        i++;
        hasToken = true;
      }
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }

    current += ch;
    hasToken = true;
  }

  if (inSingle || inDouble) {
    return null;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

export interface ParsedCurl {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  bodyJson: unknown | undefined;
  flags: string[];
}

const SHORT_FLAGS_TAKING_VALUE = new Set([
  'X', 'H', 'd', 'F', 'A', 'b', 'c', 'e', 'u', 'w', 'o', 'r', 'T', 'K', 'E', 'z', 'y', 'Y', 't',
]);

const LONG_FLAGS_TAKING_VALUE = new Set([
  'data', 'data-raw', 'data-binary', 'data-urlencode', 'data-ascii',
  'header', 'request', 'url', 'user-agent', 'referer', 'cookie', 'cookie-jar',
  'user', 'write-out', 'output', 'range', 'upload-file', 'config', 'cert',
  'max-time', 'form', 'form-string', 'connect-timeout',
]);

const LONG_FLAGS_NO_VALUE = new Set([
  'insecure', 'silent', 'verbose', 'compressed', 'location', 'include',
  'fail', 'show-error', 'head', 'get', 'no-progress-meter', 'no-buffer',
]);

function looksLikeUrl(token: string): boolean {
  return /^(https?:\/\/|\/\/)/i.test(token) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token);
}

function splitHeader(raw: string): [string, string] | null {
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const name = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1).trim();
  if (!name) return null;
  return [name, value];
}

/**
 * Parse a curl command string into its logical parts.
 * Returns null if the input isn't a curl invocation or tokenization fails.
 */
export function parseCurlCommand(raw: string): ParsedCurl | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const tokens = shellTokenize(trimmed);
  if (!tokens || tokens.length === 0) return null;

  // Strip leading env assignments or plain "curl" at the start.
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i++;
  if (i >= tokens.length) return null;
  const head = tokens[i];
  if (head !== 'curl' && !head.endsWith('/curl')) return null;
  i++;

  let method: string | undefined;
  let url: string | undefined;
  let body: string | undefined;
  const headers: Record<string, string> = {};
  const flags: string[] = [];

  const consumeValue = (flagToken: string): string | undefined => {
    const eq = flagToken.indexOf('=');
    if (flagToken.startsWith('--') && eq !== -1) {
      return flagToken.slice(eq + 1);
    }
    if (i < tokens.length) {
      const v = tokens[i];
      i++;
      return v;
    }
    return undefined;
  };

  while (i < tokens.length) {
    const tok = tokens[i];
    i++;

    // Stop at shell chain/pipe separators so compound commands don't
    // leak flags from later commands into this curl invocation.
    if (tok === '&&' || tok === '||' || tok === ';' || tok === '|' || tok === '&') {
      break;
    }

    if (tok === '--') {
      while (i < tokens.length) {
        const rest = tokens[i]; i++;
        if (!url && looksLikeUrl(rest)) url = rest;
      }
      break;
    }

    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      if (LONG_FLAGS_TAKING_VALUE.has(name)) {
        const val = consumeValue(tok);
        if (val === undefined) continue;
        if (name === 'request') {
          method = val.toUpperCase();
        } else if (name === 'url') {
          if (!url) url = val;
        } else if (name === 'header') {
          const kv = splitHeader(val);
          if (kv) headers[kv[0]] = kv[1];
        } else if (name === 'data' || name === 'data-raw' || name === 'data-binary' || name === 'data-urlencode' || name === 'data-ascii') {
          body = body === undefined ? val : `${body}&${val}`;
        } else {
          flags.push(`--${name}=${val}`);
        }
      } else if (LONG_FLAGS_NO_VALUE.has(name)) {
        flags.push(`--${name}`);
        if (name === 'head') method = method ?? 'HEAD';
        if (name === 'get') method = method ?? 'GET';
      } else {
        // Unknown long flag — preserve it as a flag token.
        flags.push(tok);
      }
      continue;
    }

    if (tok.startsWith('-') && tok.length > 1) {
      // Could be a cluster like -sk or a single short flag with a value following.
      let j = 1;
      while (j < tok.length) {
        const ch = tok[j];
        if (SHORT_FLAGS_TAKING_VALUE.has(ch)) {
          let val: string;
          if (j + 1 < tok.length) {
            val = tok.slice(j + 1);
            j = tok.length;
          } else if (i < tokens.length) {
            val = tokens[i];
            i++;
            j = tok.length;
          } else {
            break;
          }
          if (ch === 'X') {
            method = val.toUpperCase();
          } else if (ch === 'H') {
            const kv = splitHeader(val);
            if (kv) headers[kv[0]] = kv[1];
          } else if (ch === 'd') {
            body = body === undefined ? val : `${body}&${val}`;
          } else {
            flags.push(`-${ch} ${JSON.stringify(val)}`);
          }
          break;
        }
        // Flag with no value — e.g. -s, -k, -v
        flags.push(`-${ch}`);
        if (ch === 'I') method = method ?? 'HEAD';
        if (ch === 'G') method = method ?? 'GET';
        j++;
      }
      continue;
    }

    if (!url && looksLikeUrl(tok)) {
      url = tok;
      continue;
    }
    if (!url) {
      // First positional non-URL, treat as URL anyway (curl accepts bare hosts).
      url = tok;
      continue;
    }
  }

  if (!url) return null;

  if (!method) method = body !== undefined ? 'POST' : 'GET';

  let bodyJson: unknown | undefined;
  if (body !== undefined) {
    const maybe = body.trim();
    if (maybe.startsWith('{') || maybe.startsWith('[')) {
      try {
        bodyJson = JSON.parse(maybe);
      } catch {
        bodyJson = undefined;
      }
    }
  }

  return { method, url, headers, body, bodyJson, flags };
}

/** Cheap pre-check — used by the renderer to decide whether to attempt parsing. */
export function looksLikeCurl(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trimStart();
  return /^[A-Z_][A-Z0-9_]*=\S+\s+curl\b/.test(trimmed) || /^curl\b/.test(trimmed);
}

const AGENT_FETCH_URL_RE = /^https?:\/\/[^/]+\/api\/agents\/([A-Za-z0-9_-]+)$/;

/**
 * Detect the narrow `GET /api/agents/<id>` single-agent fetch shape.
 * Rejects sibling endpoints like /history, /search, /sessions, /status,
 * /tool-history — those keep the generic curl card.
 */
export function detectAgentFetch(parsed: ParsedCurl): { agentId: string } | null {
  if (!parsed) return null;
  if (parsed.method !== 'GET') return null;
  if (parsed.body !== undefined) return null;
  const match = AGENT_FETCH_URL_RE.exec(parsed.url);
  if (!match) return null;
  return { agentId: match[1] };
}

const BROWSER_URL_RE = /^https?:\/\/[^/]+\/api\/browser\/(.+?)\/?$/;

export interface BrowserAction {
  /** Raw endpoint path under /api/browser/, e.g. `click`, `dom`, `tab/activate`. */
  endpoint: string;
  /** Human-readable action label, e.g. `Click`, `Read DOM`. */
  verb: string;
  /** Icon name (from the shared Icon set). */
  icon: string;
  /** Tab target display string (`#<tabId>` or the `tab` substring), if any. */
  tab?: string;
  /** The selector/text/url the action operates on, if any. */
  target?: string;
  /** Secondary detail (typed text, key, level, field/step count, …). */
  detail?: string;
  /** Whether a DOM diff was requested. */
  diff: boolean;
  /** The raw JSON body (for the expandable details view). */
  body: unknown;
}

/**
 * Detect a `/api/browser/<action>` bridge call and summarize it for a compact card.
 * Generic over every browser endpoint (reads + drives + tab ops); returns null for
 * any non-browser URL so the generic curl card still handles those.
 */
export function detectBrowserAction(parsed: ParsedCurl): BrowserAction | null {
  if (!parsed) return null;
  const match = BROWSER_URL_RE.exec(parsed.url);
  if (!match) return null;
  const endpoint = match[1].toLowerCase();

  // Display labels go through the shared i18n singleton; the English literals
  // are the pre-init / unit-test fallback (getI18nInstance() is null until
  // i18n.ts finishes loading).
  const i18n = getI18nInstance();
  const t = i18n?.t?.bind(i18n);

  const body: Record<string, unknown> =
    parsed.bodyJson && typeof parsed.bodyJson === 'object' && !Array.isArray(parsed.bodyJson)
      ? (parsed.bodyJson as Record<string, unknown>)
      : {};

  const asStr = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : undefined;

  let tab: string | undefined;
  if (body.tabId != null && body.tabId !== '') tab = `#${String(body.tabId)}`;
  else if (typeof body.tab === 'string' && body.tab) tab = body.tab;

  const diff = body.diff === true;
  let verb = endpoint;
  let icon = 'robot';
  let target = asStr(body.selector) ?? asStr(body.text);
  let detail: string | undefined;

  switch (endpoint) {
    case 'page':
      verb = t ? t('terminal:curlCard.browserReadPage', { defaultValue: 'Read page' }) : 'Read page';
      icon = 'file-text';
      target = undefined;
      break;
    case 'dom':
      if (body.actionable === true) {
        verb = t ? t('terminal:curlCard.browserMapElements', { defaultValue: 'Map elements' }) : 'Map elements';
        icon = 'grid';
      } else {
        verb = t ? t('terminal:curlCard.browserReadDom', { defaultValue: 'Read DOM' }) : 'Read DOM';
        icon = 'eye';
      }
      target = asStr(body.selector);
      break;
    case 'click':
      verb = t ? t('terminal:curlCard.browserClick', { defaultValue: 'Click' }) : 'Click';
      icon = 'hand-point';
      break;
    case 'hover':
      verb = t ? t('terminal:curlCard.browserHover', { defaultValue: 'Hover' }) : 'Hover';
      icon = 'hand-point';
      break;
    case 'type':
      verb = t ? t('terminal:curlCard.browserType', { defaultValue: 'Type' }) : 'Type';
      icon = 'keyboard';
      target = asStr(body.selector) ?? asStr(body.within);
      detail = asStr(body.text) != null ? `“${asStr(body.text)}”` : undefined;
      break;
    case 'fill': {
      verb = t ? t('terminal:curlCard.browserFillForm', { defaultValue: 'Fill form' }) : 'Fill form';
      icon = 'list-checks';
      const fields = Array.isArray(body.fields) ? body.fields.length : 0;
      detail = t
        ? t('terminal:curlCard.browserFieldCount', { defaultValue: '{{n}} field{{plural}}', n: fields, plural: fields === 1 ? '' : 's' })
        : `${fields} field${fields === 1 ? '' : 's'}`;
      if (body.submit) detail += t ? t('terminal:curlCard.browserSubmitSuffix', { defaultValue: ' + submit' }) : ' + submit';
      target = undefined;
      break;
    }
    case 'key':
      verb = t ? t('terminal:curlCard.browserPressKey', { defaultValue: 'Press key' }) : 'Press key';
      icon = 'keyboard';
      detail = asStr(body.key);
      target = asStr(body.selector);
      break;
    case 'select':
      verb = t ? t('terminal:spotlight.select') : 'Select';
      icon = 'list';
      detail = asStr(body.label) ?? asStr(body.value);
      target = asStr(body.selector);
      break;
    case 'scroll':
      verb = t ? t('terminal:curlCard.browserScroll', { defaultValue: 'Scroll' }) : 'Scroll';
      icon = 'scroll';
      break;
    case 'navigate':
      verb = t ? t('terminal:spotlight.navigate') : 'Navigate';
      icon = 'arrow-right';
      target = asStr(body.url);
      break;
    case 'console':
      verb = t ? t('terminal:curlCard.browserReadConsole', { defaultValue: 'Read console' }) : 'Read console';
      icon = 'terminal';
      detail = asStr(body.level);
      target = undefined;
      break;
    case 'network':
      verb = t ? t('terminal:curlCard.browserReadNetwork', { defaultValue: 'Read network' }) : 'Read network';
      icon = 'wifi';
      detail = asStr(body.filter);
      target = undefined;
      break;
    case 'errors':
      verb = t ? t('terminal:curlCard.browserReadErrors', { defaultValue: 'Read errors' }) : 'Read errors';
      icon = 'bug';
      target = undefined;
      break;
    case 'screenshot':
      verb = t ? t('terminal:curlCard.browserScreenshot', { defaultValue: 'Screenshot' }) : 'Screenshot';
      icon = 'frame';
      target = asStr(body.selector);
      break;
    case 'batch': {
      verb = t ? t('terminal:curlCard.browserBatch', { defaultValue: 'Batch' }) : 'Batch';
      icon = 'list-bullets';
      const steps = Array.isArray(body.steps) ? body.steps.length : 0;
      detail = t
        ? t('terminal:curlCard.browserStepCount', { defaultValue: '{{n}} step{{plural}}', n: steps, plural: steps === 1 ? '' : 's' })
        : `${steps} step${steps === 1 ? '' : 's'}`;
      target = undefined;
      break;
    }
    case 'status':
      verb = t ? t('terminal:curlCard.browserStatus', { defaultValue: 'Browser status' }) : 'Browser status';
      icon = 'info';
      target = undefined;
      break;
    case 'tabs':
      verb = t ? t('terminal:curlCard.browserListTabs', { defaultValue: 'List tabs' }) : 'List tabs';
      icon = 'list-bullets';
      target = undefined;
      break;
    case 'targets':
      verb = t ? t('terminal:curlCard.browserListTargets', { defaultValue: 'List targets' }) : 'List targets';
      icon = 'target';
      target = undefined;
      break;
    case 'tab/open':
      verb = t ? t('terminal:curlCard.browserOpenTab', { defaultValue: 'Open tab' }) : 'Open tab';
      icon = 'plus';
      target = asStr(body.url);
      break;
    case 'tab/close':
      verb = t ? t('terminal:database.closeTab') : 'Close tab';
      icon = 'close';
      break;
    case 'tab/activate':
      verb = t ? t('terminal:curlCard.browserActivateTab', { defaultValue: 'Activate tab' }) : 'Activate tab';
      icon = 'arrow-up-right';
      break;
    default:
      verb = endpoint.charAt(0).toUpperCase() + endpoint.slice(1);
      break;
  }

  return { endpoint, verb, icon, tab, target, detail, diff, body: parsed.bodyJson };
}

const TC_API_URL_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/api\/[^?#]*)/i;

export interface TcApiCall {
  method: string;
  /** Normalized endpoint path, e.g. `/api/agents`. */
  path: string;
  /** First path segment under /api/, e.g. `agents`. */
  resource: string;
  /** Display label for the resource, e.g. `Agents`. */
  label: string;
  /** Icon name (from the shared Icon set). */
  icon: string;
}

// Known internal API resources → branding for the card header. Anything not
// listed still gets a TC card, just with the raw segment as its label.
const TC_API_RESOURCES: Record<string, { label: string; icon: string }> = {
  agents: { label: 'Agents', icon: 'robot' },
  skills: { label: 'Skills', icon: 'sparkle' },
  areas: { label: 'Areas', icon: 'map' },
  buildings: { label: 'Buildings', icon: 'buildings' },
  notify: { label: 'Notify', icon: 'bell' },
  sessions: { label: 'Sessions', icon: 'history' },
  system: { label: 'System', icon: 'gear' },
  'http-requests': { label: 'HTTP requests', icon: 'globe' },
  tests: { label: 'Tests', icon: 'flask' },
  exec: { label: 'Exec', icon: 'terminal' },
};

/**
 * Detect a curl against Tide Commander's OWN local API (`localhost:…/api/…`)
 * so the transcript can brand it as an internal call instead of a generic
 * HTTP request. Runs AFTER the more specific detectors (browser bridge,
 * agent fetch, agent message) — those keep their dedicated cards.
 */
export function detectTcApiCall(parsed: ParsedCurl): TcApiCall | null {
  if (!parsed) return null;
  const match = TC_API_URL_RE.exec(parsed.url);
  if (!match) return null;
  const path = match[1].replace(/\/+$/, '') || '/api';
  const segments = path.split('/').filter(Boolean); // ['api', 'agents', …]
  const resource = (segments[1] || '').toLowerCase();
  if (!resource) return null;
  const meta = TC_API_RESOURCES[resource];
  const i18n = getI18nInstance();
  const t = i18n?.t?.bind(i18n);
  return {
    method: parsed.method,
    path,
    resource,
    label: meta ? (t ? tcApiResourceLabel(t, resource, meta.label) : meta.label) : resource,
    icon: meta?.icon ?? 'waves',
  };
}

/**
 * Localized header label for a known TC API resource. Existing locale keys are
 * reused where the English text matches; the rest carry their English as
 * defaultValue. Unknown resources keep the raw path segment (caller handles).
 */
function tcApiResourceLabel(t: TFunction, resource: string, fallback: string): string {
  switch (resource) {
    case 'agents': return t('common:labels.agents');
    case 'skills': return t('tools:skills.title');
    case 'areas': return t('terminal:overview.areas');
    case 'buildings': return t('terminal:spotlight.tabs.buildings');
    case 'sessions': return t('terminal:usage.sessions');
    case 'system': return t('common:labels.system');
    case 'notify': return t('terminal:curlCard.tcApiNotify', { defaultValue: 'Notify' });
    case 'http-requests': return t('terminal:curlCard.tcApiHttpRequests', { defaultValue: 'HTTP requests' });
    case 'tests': return t('terminal:curlCard.tcApiTests', { defaultValue: 'Tests' });
    case 'exec': return t('terminal:curlCard.tcApiExec', { defaultValue: 'Exec' });
    default: return fallback;
  }
}

const AGENT_MESSAGE_URL_RE = /^https?:\/\/[^/]+\/api\/agents\/([A-Za-z0-9_-]+)\/message$/;

/**
 * Extract the body of a bash heredoc from a raw command string.
 * Matches `<<` then optional `'`/`"` quote + TAG + same quote, captures
 * body up to the closing TAG on its own line. Returns null if no match.
 */
function extractHeredocBody(raw: string): string | null {
  const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?:\n|$)/;
  const m = re.exec(raw);
  if (!m) return null;
  return m[3] ?? null;
}

/**
 * Detect the `POST /api/agents/<id>/message` agent-to-agent message shape.
 * Rejects sibling endpoints — only exact `/message` suffix matches.
 * Handles both inline `-d '{...}'` bodies and `-d @-` heredoc bodies.
 */
export function detectAgentMessage(
  parsed: ParsedCurl,
  rawCommand?: string,
): { targetAgentId: string; message: string } | null {
  if (!parsed) return null;
  if (parsed.method !== 'POST') return null;
  const match = AGENT_MESSAGE_URL_RE.exec(parsed.url);
  if (!match) return null;
  const targetAgentId = match[1];

  const readMessage = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const msg = (value as Record<string, unknown>).message;
    return typeof msg === 'string' ? msg : undefined;
  };

  // Inline body first (-d '{...}')
  let message = readMessage(parsed.bodyJson);

  // Heredoc fallback: body was -d @- so the real JSON lives in a heredoc block.
  if (message === undefined && rawCommand) {
    const heredocBody = extractHeredocBody(rawCommand);
    if (heredocBody) {
      try {
        message = readMessage(JSON.parse(heredocBody.trim()));
      } catch {
        /* ignore — fall through to null */
      }
    }
  }

  if (message === undefined) return null;
  return { targetAgentId, message };
}
