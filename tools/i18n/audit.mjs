#!/usr/bin/env node
/**
 * i18n locale audit — zero-dependency checks for public/locales/<lang> vs <base>.
 *
 * Usage: node tools/i18n/audit.mjs [options]
 *   --lang <code>        target language (default: zh-CN)
 *   --base <code>        base language   (default: en)
 *   --ns <a,b,c>         limit to namespaces (repeatable, comma separated)
 *   --wiring             scan src/ for t() usage (slower; enables context + locale-only classification)
 *   --export-kit <dir>   write translation kits for missing keys (fill the "zh" fields, then run apply.mjs)
 *   --polish             with --export-kit: include already-translated keys too (en+zh side by side)
 *   --json               machine-readable output
 *   --strict             warnings also fail (exit 1)
 *   --limit <n>          max items listed per check in human output (default 40)
 *   --report-info        list INFO findings too (default: counted only)
 *   --glossary <path>    glossary file (default tools/i18n/glossary.json, optional)
 *   --allowlist <path>   allowlist file (default tools/i18n/allowlist.json, optional;
 *                        categories: identical | noCJK | localeOnly)
 *   --root <path>        repo root (default: two levels up from this script)
 *   --help
 *
 * Exit codes: 0 clean, 1 FAIL findings (or WARN with --strict), 2 parse/config error.
 *
 * This tool defines the canonical counting rules: empty objects are not leaves,
 * plural families are compared by stem, en key order is the canonical order.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const MODERN_SUFFIXES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const LEGACY_SUFFIX = 'plural';
const CJK_RE = /[㐀-鿿豈-﫿぀-ヿ]/;
const DEFAULT_NS_ORDER = ['common', 'tools', 'config', 'errors', 'notifications', 'dashboard', 'terminal'];

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const o = {
    lang: 'zh-CN', base: 'en', ns: [], wiring: false, exportKit: null, polish: false,
    json: false, strict: false, limit: 40, reportInfo: false, glossary: null, noGlossary: false, allowlist: null,
    root: DEFAULT_ROOT, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--lang') o.lang = next();
    else if (a === '--base') o.base = next();
    else if (a === '--ns') o.ns.push(...String(next()).split(',').map(s => s.trim()).filter(Boolean));
    else if (a === '--wiring') o.wiring = true;
    else if (a === '--export-kit') o.exportKit = next();
    else if (a === '--polish') o.polish = true;
    else if (a === '--json') o.json = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--limit') o.limit = Number(next());
    else if (a === '--report-info') o.reportInfo = true;
    else if (a === '--glossary') o.glossary = next();
    else if (a === '--no-glossary') o.noGlossary = true;
    else if (a === '--allowlist') o.allowlist = next();
    else if (a === '--root') o.root = path.resolve(next());
    else if (a === '--help' || a === '-h') o.help = true;
    else { console.error(`unknown option: ${a} (see --help)`); process.exit(2); }
  }
  return o;
}

const HELP = `i18n locale audit
usage: node tools/i18n/audit.mjs [--lang zh-CN] [--base en] [--ns a,b] [--wiring]
       [--export-kit <dir>] [--polish] [--json] [--strict] [--limit N] [--report-info]
       [--glossary <path>] [--no-glossary] [--allowlist <path>] [--root <path>]
exit codes: 0 clean · 1 findings · 2 parse/config error`;

// ---------------------------------------------------------------- JSON parser with duplicate detection

/**
 * Recursive-descent JSON parser that also reports duplicate keys (same object scope)
 * and records the line of every leaf. Throws {parse:true, message} on syntax errors.
 */
export function parseJsonWithDups(text, file) {
  let i = 0, line = 1, col = 1;
  const dups = [];
  const positions = new Map();
  const fail = (msg) => { const e = new Error(`${file}:${line}:${col}: ${msg}`); e.parse = true; e.file = file; e.line = line; throw e; };
  const bump = (c) => { if (c === '\n') { line++; col = 1; } else col++; };
  const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) { bump(text[i]); i++; } };
  function str() {
    let out = ''; i++; col++; // consume opening quote
    while (i < text.length) {
      const c = text[i];
      if (c === '"') { i++; col++; return out; }
      if (c === '\\') {
        const n = text[i + 1];
        if (n === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail('bad \\u escape');
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6; col += 6;
        } else {
          const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };
          if (!(n in map)) fail(`bad escape "\\${n}"`);
          out += map[n]; i += 2; col += 2;
        }
      } else { out += c; i++; col++; }
    }
    return fail('unterminated string');
  }
  function value(p) {
    ws();
    const c = text[i];
    if (c === undefined) fail('unexpected end of file');
    if (c === '{') {
      i++; col++; ws();
      const obj = {};
      if (text[i] === '}') { i++; col++; return obj; }
      const seen = new Map();
      for (;;) {
        ws();
        if (text[i] !== '"') fail('expected object key');
        const kLine = line;
        const k = str();
        const kp = p ? `${p}.${k}` : k;
        if (seen.has(k)) dups.push({ path: kp, line: kLine, firstLine: seen.get(k) });
        else seen.set(k, kLine);
        ws();
        if (text[i] !== ':') fail(`expected ':' after key '${k}'`);
        i++; col++;
        obj[k] = value(kp);
        ws();
        if (text[i] === ',') { i++; col++; continue; }
        if (text[i] === '}') { i++; col++; return obj; }
        fail(`expected ',' or '}' in object${p ? ` at ${p}` : ''}`);
      }
    }
    if (c === '[') {
      i++; col++; ws();
      const arr = [];
      if (text[i] === ']') { i++; col++; return arr; }
      for (;;) {
        arr.push(value(`${p}[]`));
        ws();
        if (text[i] === ',') { i++; col++; continue; }
        if (text[i] === ']') { i++; col++; return arr; }
        fail(`expected ',' or ']' in array${p ? ` at ${p}` : ''}`);
      }
    }
    if (c === '"') { const v = str(); positions.set(p, line); return v; }
    const num = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 32));
    if (num && num[0]) { const v = Number(num[0]); i += num[0].length; col += num[0].length; positions.set(p, line); return v; }
    for (const lit of ['true', 'false', 'null']) {
      if (text.startsWith(lit, i)) {
        i += lit.length; col += lit.length;
        const v = lit === 'true' ? true : lit === 'false' ? false : null;
        positions.set(p, line); return v;
      }
    }
    return fail(`unexpected character '${c}'`);
  }
  const root = value('');
  ws();
  if (i < text.length) fail('trailing content after JSON value');
  return { value: root, dups, positions };
}

// ---------------------------------------------------------------- leaf helpers

/** Walk leaves depth-first in document order. Empty objects are skipped (not leaves). */
export function walkLeaves(value, cb, prefix = '') {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (!keys.length) return;
    for (const k of keys) walkLeaves(value[k], cb, prefix ? `${prefix}.${k}` : k);
    return;
  }
  cb(prefix, value);
}

export function splitPlural(key) {
  const m = /^(.*)_(zero|one|two|few|many|other|plural)$/.exec(key);
  if (!m) return { stem: key, suf: null };
  return { stem: m[1], suf: m[2] };
}

function placeholders(s) {
  const out = [];
  for (const m of String(s).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) out.push(m[1]);
  return out.sort();
}

function nNewlines(s) { return (String(s).match(/\n/g) || []).length; }

// ---------------------------------------------------------------- allowlist & glossary

function loadAllowlist(file) {
  if (!file || !fs.existsSync(file)) return { identical: [], noCJK: [], localeOnly: [] };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    identical: raw.identical || [],
    noCJK: raw.noCJK || [],
    localeOnly: raw.localeOnly || [],
  };
}

function listed(list, nsKey) {
  for (const entry of list) {
    if (entry === nsKey) return true;
    if (entry.startsWith('re:')) {
      try { if (new RegExp(entry.slice(3)).test(nsKey)) return true; } catch { /* ignore bad regex */ }
    }
  }
  return false;
}

function loadGlossary(file) {
  if (!file || !fs.existsSync(file)) return { rules: [], style: [] };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { rules: raw.rules || [], style: raw.style || [] };
}

/** Does a glossary rule apply to ns:key? Scope: {ns, keyPattern, keys}, exclude: {keyPattern, keys}. */
function ruleApplies(rule, ns, key) {
  const nsKey = `${ns}:${key}`;
  const scope = rule.scope || {};
  if (scope.ns && scope.ns !== '*' && !(Array.isArray(scope.ns) ? scope.ns.includes(ns) : scope.ns === ns)) return false;
  const sKeys = scope.keys || [];
  const sPat = scope.keyPattern ? new RegExp(scope.keyPattern) : null;
  if (!sKeys.length && !sPat && scope.ns === undefined) { /* global rule */ }
  const inScope = (sKeys.length || sPat)
    ? (sKeys.includes(nsKey) || sKeys.includes(key) || (sPat ? (sPat.test(nsKey) || sPat.test(key)) : false))
    : true;
  if (!inScope) return false;
  const ex = rule.exclude || {};
  if (ex.keyPattern && new RegExp(ex.keyPattern).test(nsKey)) return false;
  if (ex.keys && (ex.keys.includes(nsKey) || ex.keys.includes(key))) return false;
  return true;
}

/** Apply forbidden-term replacement for one rule; returns new string or null if unchanged. */
export function applyGlossaryRuleToValue(rule, ns, key, value) {
  if (!ruleApplies(rule, ns, key)) return null;
  let out = String(value);
  for (const bad of rule.forbidden || []) {
    if (out.includes(bad)) out = out.split(bad).join(rule.zh);
  }
  return out === value ? null : out;
}

// ---------------------------------------------------------------- source wiring scan

const SRC_EXTS = new Set(['.ts', '.tsx']);
function walkSourceFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSourceFiles(p, out);
    else if (SRC_EXTS.has(path.extname(e.name)) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Best-effort scan of src/ for i18n usage.
 * Returns { usages: [{ns|null, key, file, line, hasDefaultValue, ambiguous}], byNsKey: Map }
 */
function scanWiring(root, nsList) {
  const usages = [];
  const files = walkSourceFiles(path.join(root, 'src'));
  const useArrRe = /useTranslation\(\s*\[([^\]]*)\]/g;
  const useOneRe = /useTranslation\(\s*['"]([^'"]+)['"]\s*\)/g;
  const tRe = /(?:i18n\.t|(?<![\w$.])t)\(\s*(['"`])([^'"`$]{1,160}?)\1/g;
  const nsPfx = /^(common|tools|config|errors|notifications|dashboard|terminal):/;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const fileNs = [];
    for (const m of text.matchAll(useArrRe)) {
      for (const q of m[1].matchAll(/['"]([^'"]+)['"]/g)) if (nsList.includes(q[1])) fileNs.push(q[1]);
    }
    for (const m of text.matchAll(useOneRe)) if (nsList.includes(m[1])) fileNs.push(m[1]);
    for (const m of text.matchAll(tRe)) {
      const keyRaw = m[2];
      if (!/[A-Za-z]/.test(keyRaw)) continue;
      const idx = m.index;
      const tail = text.slice(idx, idx + 500);
      const hasDefaultValue = /defaultValue/.test(tail);
      let ns = null, key = keyRaw;
      const pfx = nsPfx.exec(keyRaw);
      if (pfx) { ns = pfx[1]; key = keyRaw.slice(ns.length + 1); }
      else if (fileNs.length === 1) ns = fileNs[0];
      const rel = path.relative(root, file).replace(/\\/g, '/');
      usages.push({ ns, key, keyRaw, file: rel, line: lineOf(text, idx), hasDefaultValue, ambiguous: !ns });
    }
  }
  const byNsKey = new Map();
  for (const u of usages) {
    if (!u.ns) continue;
    const k = `${u.ns}:${u.key}`;
    if (!byNsKey.has(k)) byNsKey.set(k, []);
    byNsKey.get(k).push(u);
  }
  return { usages, byNsKey };
}

// ---------------------------------------------------------------- audit core

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }

  const baseDir = path.join(opts.root, 'public', 'locales', opts.base);
  const langDir = path.join(opts.root, 'public', 'locales', opts.lang);
  if (!fs.existsSync(baseDir) || !fs.existsSync(langDir)) {
    console.error(`locale directory missing: ${baseDir} or ${langDir}`);
    process.exitCode = 2; return;
  }
  let nsList = fs.readdirSync(baseDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
  nsList.sort((a, b) => {
    const ia = DEFAULT_NS_ORDER.indexOf(a), ib = DEFAULT_NS_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  if (opts.ns.length) {
    const bad = opts.ns.filter(n => !nsList.includes(n));
    if (bad.length) { console.error(`unknown namespace(s): ${bad.join(', ')} (have: ${nsList.join(', ')})`); process.exitCode = 2; return; }
    nsList = nsList.filter(n => opts.ns.includes(n));
  }

  const allowlist = loadAllowlist(opts.allowlist || path.join(SCRIPT_DIR, 'allowlist.json'));
  const glossary = opts.noGlossary ? { rules: [], style: [] } : loadGlossary(opts.glossary || path.join(SCRIPT_DIR, 'glossary.json'));

  const findings = [];
  const add = (level, check, ns, key, detail) => findings.push({ level, check, ns, key, detail });
  const summary = [];
  const parityFail = { missing: 0 };

  for (const ns of nsList) {
    const fileBase = path.join(baseDir, `${ns}.json`);
    const fileLang = path.join(langDir, `${ns}.json`);
    const nsStat = { ns, en: 0, zh: 0, missing: 0, extra: 0, identical: 0, placeholder: 0, orderDrift: 0 };

    // ---- file hygiene
    const loadSide = (file, side) => {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); }
      catch { add('FAIL', 'fileMissing', ns, '', `${side} file missing: ${file}`); return null; }
      if (text.charCodeAt(0) === 0xfeff) { add('FAIL', 'hygiene', ns, '', `${side}: BOM present`); text = text.slice(1); }
      if (text.includes('\r')) add('FAIL', 'hygiene', ns, '', `${side}: CR/CRLF line ending found (must be LF)`);
      if (!text.endsWith('\n')) add('INFO', 'hygiene', ns, '', `${side}: no trailing newline`);
      try {
        return { text, ...parseJsonWithDups(text, `${side}/${ns}.json`) };
      } catch (e) {
        add('FAIL', 'parse', ns, '', e.message);
        return { error: true };
      }
    };
    const B = loadSide(fileBase, opts.base);
    const L = loadSide(fileLang, opts.lang);
    if (!B || !L || B.error || L.error) { nsStat.error = true; summary.push(nsStat); continue; }

    for (const d of B.dups) add('FAIL', 'duplicateKey', ns, d.path, `base en: duplicate key (first at line ${d.firstLine}, again at line ${d.line})`);
    for (const d of L.dups) add('FAIL', 'duplicateKey', ns, d.path, `target ${opts.lang}: duplicate key (first at line ${d.firstLine}, again at line ${d.line})`);

    // ---- leaves
    const enLeaves = new Map(); const enOrder = [];
    walkLeaves(B.value, (k, v) => { enLeaves.set(k, v); enOrder.push(k); });
    const zhLeaves = new Map(); const zhOrder = [];
    walkLeaves(L.value, (k, v) => { zhLeaves.set(k, v); zhOrder.push(k); });
    nsStat.en = enLeaves.size; nsStat.zh = zhLeaves.size;

    // non-string leaves
    for (const [k, v] of enLeaves) if (typeof v !== 'string') add('WARN', 'nonString', ns, k, `en value is ${Array.isArray(v) ? 'array' : typeof v}`);
    for (const [k, v] of zhLeaves) if (typeof v !== 'string') add('WARN', 'nonString', ns, k, `${opts.lang} value is ${Array.isArray(v) ? 'array' : typeof v}`);
    for (const [k, v] of zhLeaves) if (typeof v === 'string' && v === '') add('FAIL', 'emptyValue', ns, k, '');

    // ---- coverage maps (plural aware)
    // A raw key K is *covered* by the other side when the other side has any of:
    //   K itself (handled by exact pairing) · stem base key · stem_other key  (v3 _plural does NOT resolve)
    const coverOf = (sideMap) => {
      const cover = new Map(); // stem -> {key, form: 'base'|'other'}
      for (const k of sideMap.keys()) {
        const { stem, suf } = splitPlural(k);
        if (suf === null) cover.set(stem, { key: k, form: 'base' });
      }
      for (const k of sideMap.keys()) {
        const { stem, suf } = splitPlural(k);
        if (suf === 'other' && (!cover.has(stem) || cover.get(stem).form !== 'base')) cover.set(stem, { key: k, form: 'other' });
      }
      return cover;
    };
    const zhCover = coverOf(zhLeaves);
    const enCover = coverOf(enLeaves);

    // ---- missing (en key not usable from zh)
    const missing = [];
    for (const [k] of enLeaves) {
      if (zhLeaves.has(k)) continue;
      const { stem, suf } = splitPlural(k);
      const cov = zhCover.get(stem);
      if (suf === LEGACY_SUFFIX) {
        if (cov && cov.form !== 'plural') { add('INFO', 'coveredByPlural', ns, k, `covered by ${opts.lang} "${cov.key}"`); continue; }
        add('WARN', 'legacyPluralMissing', ns, k, `en legacy _plural key not in ${opts.lang} (dead under i18next 26; add a base key instead)`); continue;
      }
      if (cov && cov.form !== 'plural') { add('INFO', 'coveredByPlural', ns, k, `covered by ${opts.lang} "${cov.key}"`); continue; }
      missing.push(k);
    }
    missing.sort();
    nsStat.missing = missing.length;
    for (const k of missing) add('FAIL', 'missing', ns, k, `en="${String(enLeaves.get(k)).slice(0, 90)}"`);
    parityFail.missing += missing.length;

    // ---- extra (zh key not needed by en)
    for (const [k] of zhLeaves) {
      if (enLeaves.has(k)) continue;
      if (listed(allowlist.localeOnly, `${ns}:${k}`)) {
        add('INFO', 'localeOnly', ns, k, 'zh-only key used by t(key, { defaultValue }) in source (approved)');
        continue;
      }
      const { stem, suf } = splitPlural(k);
      const enHasStem = enCover.has(stem) || enLeaves.has(stem);
      if (suf === null && enHasStem) { add('INFO', 'extraCovering', ns, k, 'base key covers en plural family (fine, preferred form)'); continue; }
      if (suf !== null && enHasStem) { add('INFO', 'extraCovering', ns, k, `plural form for stem also present in en (redundant; base preferred)`); continue; }
      if (suf === LEGACY_SUFFIX) { add('INFO', 'extraLegacyPlural', ns, k, 'legacy _plural key, not in en (dead)'); continue; }
      nsStat.extra++;
      add('WARN', 'extra', ns, k, `only in ${opts.lang}: "${String(zhLeaves.get(k)).slice(0, 90)}"`);
    }

    // ---- pairwise value checks (exact pairs + plural-stem pairs)
    const pairFor = (k) => {
      if (zhLeaves.has(k)) return k;
      const { stem, suf } = splitPlural(k);
      if (suf === null || suf === LEGACY_SUFFIX) {
        const cov = zhCover.get(stem);
        return cov ? cov.key : null;
      }
      return zhLeaves.has(stem) ? stem : (zhLeaves.has(`${stem}_other`) ? `${stem}_other` : null);
    };
    // one check per zh key; prefer en "_other" as the family representative
    const pairEnFor = new Map();
    for (const k of enOrder) {
      const zk = pairFor(k);
      if (!zk) continue;
      if (!pairEnFor.has(zk) || k.endsWith('_other')) pairEnFor.set(zk, k);
    }
    for (const [zk, k] of pairEnFor) {
      const enVal = enLeaves.get(k);
      const zhVal = zhLeaves.get(zk);
      if (typeof enVal !== 'string' || typeof zhVal !== 'string') continue;
      const nsKey = `${ns}:${zk}`;
      if (enVal === zhVal) {
        if (!listed(allowlist.identical, nsKey)) {
          nsStat.identical++;
          add('FAIL', 'identical', ns, zk, `same as en: "${enVal.slice(0, 90)}"`);
        }
        continue;
      }
      const ph = placeholders(enVal).join(',');
      if (ph !== placeholders(zhVal).join(',')) {
        nsStat.placeholder++;
        add('FAIL', 'placeholder', ns, zk, `en has [${ph}] but ${opts.lang} has [${placeholders(zhVal).join(',')}]`);
      }
      if (nNewlines(enVal) !== nNewlines(zhVal)) {
        add('WARN', 'newlines', ns, zk, `newline count differs (en ${nNewlines(enVal)} vs ${opts.lang} ${nNewlines(zhVal)})`);
      }
      if (!CJK_RE.test(zhVal) && !listed(allowlist.noCJK, nsKey)) {
        add('INFO', 'noCJK', ns, zk, `${opts.lang} value has no CJK: "${zhVal.slice(0, 60)}"`);
      }
    }

    // ---- canonical key order (en order is canonical; extras may trail in any order)
    const expectedZhSeq = [];
    const expectedSet = new Set();
    for (const k of enOrder) {
      const zk = pairFor(k);
      if (!zk || expectedSet.has(zk)) continue;
      expectedSet.add(zk);
      expectedZhSeq.push(zk);
    }
    const zhSeq = zhOrder.filter(k => expectedSet.has(k));
    let drift = 0;
    const len = Math.max(zhSeq.length, expectedZhSeq.length);
    for (let i = 0; i < len; i++) if (zhSeq[i] !== expectedZhSeq[i]) drift++;
    nsStat.orderDrift = drift;
    if (drift) add('INFO', 'orderDrift', ns, '', `${drift} position(s) differ from en key order`);

    // ---- glossary rules
    for (const rule of glossary.rules) {
      const forbidden = rule.forbidden || [];
      if (!forbidden.length) continue;
      for (const [k, v] of zhLeaves) {
        if (typeof v !== 'string') continue;
        if (!ruleApplies(rule, ns, k)) continue;
        for (const bad of forbidden) {
          if (v.includes(bad)) add('FAIL', 'glossary', ns, k, `"${bad}" forbidden by rule ${rule.id} (use "${rule.zh}")`);
        }
      }
    }

    summary.push(nsStat);
  }

  // ---- wiring (optional)
  let wiring = null;
  const nsAll = fs.readdirSync(baseDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
  if (opts.wiring) {
    wiring = scanWiring(opts.root, nsAll);
    const enAll = new Map(); // ns:key -> value (ALL namespaces, regardless of --ns filter)
    for (const ns of nsAll) {
      const f = path.join(baseDir, `${ns}.json`);
      if (!fs.existsSync(f)) continue;
      const parsed = parseJsonWithDups(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''), f);
      walkLeaves(parsed.value, (k, v) => enAll.set(`${ns}:${k}`, v));
    }
    const zhAll = new Set();
    for (const ns of nsAll) {
      const f = path.join(langDir, `${ns}.json`);
      if (!fs.existsSync(f)) continue;
      const parsed = parseJsonWithDups(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''), f);
      walkLeaves(parsed.value, (k) => zhAll.add(`${ns}:${k}`));
    }
    // cross-namespace / defaultValue-only detection
    const seen = new Set();
    for (const u of wiring.usages) {
      if (!u.ns) continue;
      const nsKey = `${u.ns}:${u.key}`;
      if (enAll.has(nsKey)) continue;
      const dupKey = `${u.ns}:${u.key}@${u.file}:${u.line}`;
      if (seen.has(dupKey)) continue;
      seen.add(dupKey);
      const elsewhere = nsAll.filter(n => enAll.has(`${n}:${u.key}`));
      if (elsewhere.length && !u.hasDefaultValue) {
        add('WARN', 'wiringCrossNs', u.ns, u.key, `not in ${u.ns} but in [${elsewhere.join(',')}] — used at ${u.file}:${u.line} (no fallbackNS configured)`);
      } else {
        add('INFO', 'wiringNotInEn', u.ns, u.key, `used at ${u.file}:${u.line}${u.hasDefaultValue ? ' with defaultValue' : ''}${elsewhere.length ? ` (same key exists in [${elsewhere.join(',')}])` : ''} — needs a ${opts.lang}-only entry or an en key`);
      }
    }
    // usage info for missing keys
    for (const f of findings) {
      if (f.check !== 'missing') continue;
      const us = wiring.byNsKey.get(`${f.ns}:${f.key}`);
      if (us && us.length) f.detail += ` — used at ${us.slice(0, 2).map(u => `${u.file}:${u.line}`).join(', ')}`;
    }
  }

  // ---- export kit
  if (opts.exportKit) {
    fs.mkdirSync(opts.exportKit, { recursive: true });
    for (const ns of nsList) {
      const kit = {};
      const f = path.join(baseDir, `${ns}.json`);
      const parsed = parseJsonWithDups(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''), f);
      const enLeaves = new Map(); walkLeaves(parsed.value, (k, v) => enLeaves.set(k, v));
      const langLeaves = new Map();
      const lf = path.join(langDir, `${ns}.json`);
      if (fs.existsSync(lf)) {
        const lp = parseJsonWithDups(fs.readFileSync(lf, 'utf8').replace(/^﻿/, ''), lf);
        walkLeaves(lp.value, (k, v) => langLeaves.set(k, v));
      }
      const collected = new Set();
      for (const [k, v] of enLeaves) {
        if (typeof v !== 'string') continue;
        const stemInfo = splitPlural(k);
        if (stemInfo.suf !== null && stemInfo.suf !== LEGACY_SUFFIX) {
          if (collected.has(`stem:${stemInfo.stem}`)) continue;
          collected.add(`stem:${stemInfo.stem}`);
          const already = langLeaves.has(stemInfo.stem) || langLeaves.has(`${stemInfo.stem}_other`);
          if (already) continue;
          const rep = enLeaves.get(`${stemInfo.stem}_other`) ?? enLeaves.get(k);
          const usedAt = wiring ? (wiring.byNsKey.get(`${ns}:${k}`) || []).slice(0, 2).map(u => `${u.file}:${u.line}`) : [];
          kit[stemInfo.stem] = { en: rep, plural: true, ...(usedAt.length ? { usedAt } : {}), zh: '' };
          continue;
        }
        if (langLeaves.has(k)) {
          if (opts.polish) kit[k] = { en: v, zh: langLeaves.get(k) };
          continue;
        }
        const usedAt = wiring ? (wiring.byNsKey.get(`${ns}:${k}`) || []).slice(0, 2).map(u => `${u.file}:${u.line}`) : [];
        kit[k] = { en: v, ...(usedAt.length ? { usedAt } : {}), zh: '' };
      }
      const out = path.join(opts.exportKit, `kit-${ns}.json`);
      if (Object.keys(kit).length || opts.polish) {
        fs.writeFileSync(out, JSON.stringify({ [ns]: kit }, null, 2) + '\n', 'utf8');
      }
    }
  }

  // ---- output
  if (opts.json) {
    const totals = {
      missing: parityFail.missing,
      fail: findings.filter(f => f.level === 'FAIL').length,
      warn: findings.filter(f => f.level === 'WARN').length,
      info: findings.filter(f => f.level === 'INFO').length,
    };
    console.log(JSON.stringify({ lang: opts.lang, base: opts.base, summary, totals, findings }, null, 2));
  } else {
    const nsPad = Math.max(...summary.map(s => s.ns.length), 10);
    console.log(`${opts.lang} locale audit — base: ${opts.base}`);
    console.log(`  ${'namespace'.padEnd(nsPad)}  ${String(opts.base).padStart(4)} ${String(opts.lang).padStart(5)}  miss  extra  ident  ph`);
    for (const s of summary) {
      console.log(`  ${s.ns.padEnd(nsPad)}  ${String(s.en).padStart(4)} ${String(s.zh).padStart(5)}  ${String(s.missing).padStart(4)}  ${String(s.extra).padStart(5)}  ${String(s.identical).padStart(5)}  ${String(s.placeholder).padStart(5)}`);
    }
    const byLevel = { FAIL: {}, WARN: {}, INFO: {} };
    for (const f of findings) { (byLevel[f.level][f.check] ||= []).push(f); }
    const printGroup = (level) => {
      for (const [check, items] of Object.entries(byLevel[level])) {
        if (level === 'INFO' && !opts.reportInfo && check !== 'wiringNotInEn') {
          console.log(`  ${level} ${check}: ${items.length}`);
          continue;
        }
        console.log(`  ${level} ${check}: ${items.length}`);
        for (const it of items.slice(0, opts.limit)) console.log(`      ${it.ns}:${it.key}${it.detail ? `  — ${it.detail}` : ''}`);
        if (items.length > opts.limit) console.log(`      … +${items.length - opts.limit} more`);
      }
    };
    printGroup('FAIL'); printGroup('WARN'); printGroup('INFO');
    const fails = byLevel.FAIL && Object.values(byLevel.FAIL).flat().length || 0;
    const warns = byLevel.WARN && Object.values(byLevel.WARN).flat().length || 0;
    console.log(`totals: ${fails} FAIL · ${warns} WARN · ${findings.filter(f => f.level === 'INFO').length} INFO`);
  }

  const anyFail = findings.some(f => f.level === 'FAIL');
  const anyWarn = findings.some(f => f.level === 'WARN');
  if (findings.some(f => f.check === 'parse' || f.check === 'fileMissing')) process.exitCode = 2;
  else if (anyFail || (opts.strict && anyWarn)) process.exitCode = 1;
  else process.exitCode = 0;
}

// run only when executed directly (apply.mjs imports helpers from this file)
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main();
