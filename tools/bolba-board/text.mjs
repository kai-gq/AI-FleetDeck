/**
 * bolba-board — presentation helpers: task serialization (JSON payloads) and
 * the `?as=text` renderings (fixed-width board table / single-task markdown
 * block). Zero imports: server.mjs hot-reloads each module individually.
 *
 * The table format must stay parseable by the TC client
 * (src/packages/client/plugins/bolba-tasks/bolbaTasksOutput.ts):
 *   header line  -> /^id\s+proj\s+status\s+due/
 *   row line     -> /^(\d+)\s+(\S+)\s+(\S+)\s+(\S+(?:\s\d{2}:\d{2})?|-)\s+(\S+)\s+(.*)$/
 *   status column only ever one of: open|waiting|delegated|done|discarded
 */

const TYPE_EMOJI_RULES = [
  [/bug|falla|error|incid/i, '🐞'],
  [/compra|comprar|pedido|order/i, '🛒'],
  [/correo|email|mail|gmail/i, '✉️'],
  [/llamada|telefono|teléfono|call/i, '☎️'],
  [/reuni|meeting|agenda/i, '📅'],
  [/pago|factura|invoice|cobro/i, '💰'],
];
const DEFAULT_PROJ_EMOJI = '🚢';

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatTs(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Collapse anything multi-line to a single line for table/timeline safety. */
export function singleLine(s) {
  return String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

export function ageDays(reg, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(reg || ''));
  if (!m) return 0;
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today.getTime() - then.getTime()) / 86400000));
}

export function createText({ projEmojis = {} } = {}) {
  const projEmoji = (proj) => (proj && projEmojis[proj]) || projEmojis.default || DEFAULT_PROJ_EMOJI;

  const typeEmoji = (type) => {
    const t = String(type || '');
    if (!t || /^(tarea|task)$/i.test(t)) return '🛠️';
    for (const [re, emoji] of TYPE_EMOJI_RULES) {
      if (re.test(t)) return emoji;
    }
    return '📌';
  };

  /** Text-table status set (client only accepts these 5). */
  const statusForText = (status) => (status === 'completed' ? 'done' : status);

  const checkbox = (status) => (status === 'done' || status === 'completed' ? 'x' : status === 'discarded' ? '-' : ' ');

  function headFor(row) {
    const projPart = row.proj ? `${projEmoji(row.proj)} ${row.proj} — ` : '';
    return `- [${checkbox(row.status)}] ${projPart}${typeEmoji(row.type)} **${row.title}**`;
  }

  /** JSON task object (aliases included; extra keys are harmless to clients). */
  function toApiTask(row) {
    return {
      id: row.id,
      title: row.title,
      head: headFor(row),
      status: row.status,
      proj: row.proj,
      type: row.type,
      due: row.due,
      reg: row.reg,
      created_at: row.reg,
      done: row.done,
      notes: row.notes,
      description: row.notes,
      from_person: row.from_person,
      priority: row.priority,
      prioridad: row.priority,
      section: row.section,
      gmail: row.gmail,
      coti: row.coti,
      origen: row.origen,
      real: row.real_minutes ?? 0,
      timeline_count: row.timeline_count ?? 0,
      last_event: row.last_event ?? '',
      updated_at: row.updated_at ? formatTs(new Date(Number(row.updated_at))) : '',
    };
  }

  const TABLE_HEADER = 'id'.padEnd(6) + 'proj'.padEnd(16) + 'status'.padEnd(10) + 'due'.padEnd(17) + 'age'.padEnd(4) + 'title';

  function tableText(rows, { now = new Date() } = {}) {
    const lines = [TABLE_HEADER];
    for (const row of rows) {
      const proj = row.proj ? singleLine(row.proj).replace(/\s+/g, '_') : '-';
      lines.push(
        String(row.id).padEnd(6)
        + proj.padEnd(16)
        + statusForText(row.status).padEnd(10)
        + (row.due || '-').padEnd(17)
        + `${ageDays(row.reg, now)}d`.padEnd(4)
        + singleLine(row.title).slice(0, 120),
      );
    }
    return lines.join('\n');
  }

  /** Single-task markdown block (dataview-style fields; also the md-mirror format). */
  function taskText(row, events = []) {
    const lines = [headFor(row)];
    const field = (key, value) => {
      if (value !== undefined && value !== null && String(value).length) lines.push(`  - ${key}:: ${singleLine(value)}`);
    };
    field('id', row.id);
    field('status', row.status);
    field('proj', row.proj);
    field('type', row.type);
    lines.push(`  - due:: ${row.due || '-'}`);
    field('reg', row.reg);
    lines.push(`  - done:: ${row.done || '-'}`);
    field('prioridad', row.priority);
    field('coti', row.coti);
    field('desde', row.from_person);
    field('section', row.section);
    field('gmail', row.gmail);
    field('origen', row.origen);
    if (row.real_minutes) lines.push(`  - real:: ${row.real_minutes}m`);
    field('notas', row.notes);
    const last = events.length ? events[events.length - 1] : null;
    lines.push(`  - timeline:: ${events.length} eventos${last ? ` · último ${last.ts} ${singleLine(last.text)}` : ''}`);
    return lines.join('\n');
  }

  return {
    formatTs,
    todayStr,
    singleLine,
    ageDays,
    statusForText,
    checkbox,
    headFor,
    toApiTask,
    tableText,
    taskText,
    typeEmoji,
    projEmoji,
  };
}
