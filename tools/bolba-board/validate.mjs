/**
 * bolba-board — request body/query normalization: field aliases, status
 * aliases (Spanish + English), string sanitation, date/timestamp checks,
 * timeline parsing. Zero imports (modules are hot-reloaded individually).
 */

export const STATUS_VALUES = ['open', 'waiting', 'delegated', 'done', 'completed', 'discarded'];

const STATUS_ALIASES = new Map(Object.entries({
  // open
  abierta: 'open', abierto: 'open', pendiente: 'open',
  // waiting
  espera: 'waiting', esperando: 'waiting',
  // delegated
  delegada: 'delegated', delegado: 'delegated',
  // done
  hecha: 'done', hecho: 'done', cerrada: 'done', cerrado: 'done',
  // completed
  completada: 'completed', completado: 'completed', terminada: 'completed', terminado: 'completed',
  // discarded
  descartada: 'discarded', descartado: 'discarded', cancelada: 'discarded', cancelado: 'discarded',
}));

const FIELD_ALIASES = new Map(Object.entries({
  head: 'title', titulo: 'title', título: 'title',
  project: 'proj', proyecto: 'proj',
  tipo: 'type',
  estado: 'status',
  vencimiento: 'due', fecha: 'due', plazo: 'due',
  description: 'notes', notas: 'notes', descripcion: 'notes', descripción: 'notes',
  from: 'from_person', de: 'from_person', desde: 'from_person', solicitante: 'from_person', persona: 'from_person',
  prioridad: 'priority', urgencia: 'priority',
  seccion: 'section', sección: 'section',
  gmail_url: 'gmail', correo: 'gmail',
  cotizacion: 'coti', cotización: 'coti',
  source: 'origen', origin: 'origen', fuente: 'origen',
  real: 'real_minutes', real_minutes: 'real_minutes', minutos: 'real_minutes',
}));

const CANONICAL_FIELDS = new Set([
  'title', 'proj', 'type', 'status', 'due', 'notes', 'from_person',
  'priority', 'section', 'gmail', 'coti', 'origen', 'real_minutes',
]);

/** Human-readable field list reported on 400s (rendered by the curl card). */
export const VALID_FIELDS = [
  'title', 'proj', 'type', 'status', 'due', 'notes', 'from_person',
  'priority', 'section', 'gmail', 'coti', 'origen', 'timeline',
];

const CAPS = { title: 500, notes: 8000, q: 300 };
const DEFAULT_CAP = 200;
// Control characters except tab (9), LF (10) and CR (13).
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function isRecord(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function cleanString(value, cap = DEFAULT_CAP, { multiline = false } = {}) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  s = s.replace(/\r\n?/g, '\n').replace(CTRL_RE, ' ');
  if (!multiline) s = s.replace(/\n/g, ' ');
  s = s.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n');
  return s.trim().slice(0, cap);
}

export function normalizeStatus(raw) {
  const key = String(raw ?? '').trim().toLowerCase();
  if (!key) return undefined;
  if (STATUS_VALUES.includes(key)) return key;
  return STATUS_ALIASES.get(key);
}

/** Accepts YYYY-MM-DD, YYYY-MM-DD HH:MM, YYYY-MM-DDTHH:MM[:ss] -> canonical ts. */
export function normalizeTs(raw) {
  if (raw === null || raw === undefined) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(raw).trim());
  if (!m) return undefined;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4] || '00'}:${m[5] || '00'}`;
}

/** Accepts YYYY-MM-DD, YYYY/MM/DD, DD-MM-YYYY -> canonical YYYY-MM-DD ('' allowed). */
export function normalizeDate(raw) {
  if (raw === null || raw === undefined) return undefined;
  const s = String(raw).trim();
  if (!s) return '';
  const valid = (year, month, day) => Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31;
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return valid(m[1], m[2], m[3]) ? `${m[1]}-${pad2(m[2])}-${pad2(m[3])}` : undefined;
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return valid(m[3], m[2], m[1]) ? `${m[3]}-${pad2(m[2])}-${pad2(m[1])}` : undefined;
  return undefined;
}

/**
 * Normalize a JSON body into canonical store fields.
 * @returns {{ fields: object, warnings: string[] } | { error: string, valid?: string[] }}
 */
export function normalizeBody(raw, { partial = false } = {}) {
  if (!isRecord(raw)) return { error: 'cuerpo JSON inválido (se espera un objeto)' };
  const fields = {};
  const warnings = [];

  for (const [key, value] of Object.entries(raw)) {
    const lk = String(key).toLowerCase();
    if (lk === 'force' || lk === 'timeline') continue;
    const canonical = CANONICAL_FIELDS.has(lk) ? lk : FIELD_ALIASES.get(lk);
    if (!canonical) {
      warnings.push(`campo ignorado: ${key}`);
      continue;
    }
    if (canonical === 'status') {
      const status = normalizeStatus(value);
      if (!status) return { error: `estado inválido: ${value}`, valid: STATUS_VALUES };
      fields.status = status;
      continue;
    }
    if (canonical === 'due') {
      if (value === null || value === undefined || value === '') {
        fields.due = '';
        continue;
      }
      const date = normalizeDate(value);
      if (date === undefined) {
        warnings.push(`fecha inválida ignorada: ${value}`);
        continue;
      }
      fields.due = date;
      continue;
    }
    if (canonical === 'real_minutes') {
      fields.real_minutes = Number(value) || 0;
      continue;
    }
    const cap = CAPS[canonical] || DEFAULT_CAP;
    fields[canonical] = cleanString(value, cap, { multiline: canonical === 'notes' });
  }

  if ('title' in fields && !fields.title) {
    return { error: 'title no puede estar vacío', valid: VALID_FIELDS };
  }
  if (!partial && !fields.title) {
    return { error: 'title es obligatorio', valid: VALID_FIELDS };
  }
  if (fields.due && fields.due < todayStr()) warnings.push('due en el pasado');
  return { fields, warnings };
}

/**
 * Parse `timeline` input: array of strings or {ts, text} objects.
 * Text is flattened to one line (the details modal parses one line per entry).
 * @returns {{ entries: Array<{ts?: string, text: string}>, warnings: string[] }}
 */
export function parseTimeline(raw) {
  if (raw === undefined || raw === null) return { entries: [], warnings: [] };
  const list = Array.isArray(raw) ? raw : [raw];
  const entries = [];
  const warnings = [];

  for (const item of list) {
    if (typeof item === 'string' || typeof item === 'number') {
      const text = cleanString(item, 4000);
      if (!text) {
        warnings.push('entrada de timeline vacía ignorada');
        continue;
      }
      entries.push({ ts: undefined, text });
      continue;
    }
    if (isRecord(item)) {
      const text = cleanString(item.text ?? item.evento ?? item.mensaje, 4000);
      if (!text) {
        warnings.push('entrada de timeline sin texto ignorada');
        continue;
      }
      entries.push({ ts: normalizeTs(item.ts ?? item.fecha), text });
      continue;
    }
    warnings.push('entrada de timeline ignorada');
  }
  return { entries, warnings };
}

/**
 * Normalize GET query params into store filters + `as=text` flag.
 * @returns {{ filters: object, asText: boolean } | { error: string, valid?: string[] }}
 */
export function normalizeQuery(searchParams, { actor = '' } = {}) {
  const get = (key) => {
    const v = searchParams.get(key);
    return v === null ? undefined : String(v).trim();
  };
  const filters = {};
  const asText = get('as') === 'text';

  const statusRaw = get('status');
  if (statusRaw) {
    const statuses = new Set();
    for (const part of statusRaw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const status = normalizeStatus(part);
      if (!status) return { error: `estado inválido: ${part}`, valid: STATUS_VALUES };
      statuses.add(status);
      if (status === 'done' || status === 'completed') {
        statuses.add('done');
        statuses.add('completed');
      }
    }
    filters.statuses = Array.from(statuses);
  }

  const dueRaw = get('due');
  if (dueRaw) {
    const mode = dueRaw.toLowerCase();
    if (mode === 'overdue' || mode === 'today' || mode === 'week') {
      filters.due = { mode };
    } else {
      const date = normalizeDate(dueRaw);
      if (!date) return { error: `due inválido: ${dueRaw}`, valid: ['overdue', 'today', 'week', 'YYYY-MM-DD'] };
      filters.due = { mode: 'date', date };
    }
  }

  const staleRaw = get('stale');
  if (staleRaw !== undefined) {
    const n = Number.parseInt(staleRaw, 10);
    filters.staleDays = Number.isFinite(n) && n > 0 ? n : 14;
  }

  const scope = (get('scope') || '').toLowerCase();
  if (['all', 'pending', 'active', 'done', 'mine'].includes(scope)) filters.scope = scope;

  const proj = get('proj');
  if (proj) filters.proj = cleanString(proj, CAPS.q);
  const type = get('type');
  if (type) filters.type = cleanString(type, CAPS.q);
  const from = get('from');
  if (from) filters.from = cleanString(from, CAPS.q);
  const coti = get('coti');
  if (coti) filters.coti = cleanString(coti, CAPS.q);
  const q = get('q') ?? get('query') ?? get('title');
  if (q) filters.q = cleanString(q, CAPS.q);

  const limitRaw = get('limit');
  if (limitRaw !== undefined) {
    const n = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(n)) filters.limit = n;
  }
  if (filters.scope === 'mine') filters.mineActor = actor || 'tide-commander';

  return { filters, asText };
}
