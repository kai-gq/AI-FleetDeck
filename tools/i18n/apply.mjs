#!/usr/bin/env node
/**
 * i18n apply — regenerate public/locales/<lang>/*.json from the en key order plus a
 * translation memory, so the locale files are NEVER hand-edited.
 *
 *   node tools/i18n/apply.mjs [options]
 *     (no flags)        normalize: seed memory from current files, rewrite files in en order
 *     --kit <file>      merge a translation kit { "<ns>": { "<key>": "zh" | { "zh": "..." } } }
 *                       into the memory (repeatable; keys may be plural stems, e.g. sheetCount)
 *     --glossary        re-apply glossary forbidden-term replacements to all values
 *     --adopt           take current file values over stale memory values (after manual file edits)
 *     --dry-run         do everything except writing files / memory
 *     --json            machine-readable report
 *     --lang/--base/--root/--work/--memory <path>
 *
 * Memory layout (tools/i18n/work/memory.json, gitignored):  "ns:key": {"h": "<en hash>", "zh": "..."}
 *   h = sha1/8 of the en value when the translation was made; null for zh-only keys
 *   (defaultValue pattern).  Stale h → the en text changed since; retranslate.
 *
 * Canonical zh plural form: when a base key and a plural variant exist for the same family,
 * the base key wins and the variant is folded into it (i18next 26 resolves a bare base key for
 * any count). A live `_other` whose text differs from the base is kept and flagged instead.
 *
 * Rules: only the memory is authoritative; file edits not adopted will be overwritten.
 * en files are never touched. Exit: 0 ok · 2 parse/usage error.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseJsonWithDups, walkLeaves, splitPlural, applyGlossaryRuleToValue } from './audit.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

function parseArgs(argv) {
  const o = {
    lang: 'zh-CN', base: 'en', root: DEFAULT_ROOT, work: null, memory: null,
    kits: [], glossary: false, adopt: false, dryRun: false, json: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--lang') o.lang = next();
    else if (a === '--base') o.base = next();
    else if (a === '--root') o.root = path.resolve(next());
    else if (a === '--work') o.work = path.resolve(next());
    else if (a === '--memory') o.memory = path.resolve(next());
    else if (a === '--kit') o.kits.push(path.resolve(next()));
    else if (a === '--glossary') o.glossary = true;
    else if (a === '--adopt') o.adopt = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else { console.error(`unknown option: ${a}`); process.exit(2); }
  }
  return o;
}

const HELP = `i18n apply — regenerate locale files from en order + translation memory
usage: node tools/i18n/apply.mjs [--kit <file>]... [--glossary] [--adopt] [--dry-run] [--json]
       [--lang zh-CN] [--base en] [--root <dir>] [--work <dir>] [--memory <file>]`;

const sha8 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 8);

function readLeaves(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const { value } = parseJsonWithDups(text, file);
  const map = new Map();
  const order = [];
  walkLeaves(value, (k, v) => { map.set(k, v); order.push(k); });
  return { map, order };
}

function loadMemory(file) {
  const map = new Map();
  const order = [];
  let corrupt = 0;
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('//') || k.startsWith('_')) continue;
      if (!v || typeof v.zh !== 'string') { corrupt++; continue; } // skip malformed entries
      map.set(k, { h: typeof v.h === 'string' ? v.h : null, zh: v.zh });
      order.push(k);
    }
  }
  return { map, order, corrupt };
}

function saveMemory(file, order, map) {
  const body = order
    .filter(k => map.get(k) && typeof map.get(k).zh === 'string')
    .map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(map.get(k))}`)
    .join(',\n');
  fs.writeFileSync(file, `{\n${body}\n}\n`, 'utf8');
}

function loadGlossaryRules(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8')).rules || [];
}

/** flatten keys are dot-joined paths; set a leaf back into a nested object (no literal dotted keys exist in the locale files) */
function setByPath(obj, pathStr, value) {
  const parts = pathStr.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  const root = opts.root;
  const workDir = opts.work || path.join(SCRIPT_DIR, 'work');
  const memoryFile = opts.memory || path.join(workDir, 'memory.json');
  const baseDir = path.join(root, 'public', 'locales', opts.base);
  const langDir = path.join(root, 'public', 'locales', opts.lang);
  if (!fs.existsSync(baseDir)) { console.error(`missing ${baseDir}`); process.exitCode = 2; return; }

  const nsAll = fs.readdirSync(baseDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
  const en = {}, zh = {}, enStems = {};
  try {
    for (const ns of nsAll) {
      en[ns] = readLeaves(path.join(baseDir, `${ns}.json`));
      const stems = new Set();
      for (const k of en[ns].map.keys()) stems.add(splitPlural(k).stem);
      enStems[ns] = stems;
      const lf = path.join(langDir, `${ns}.json`);
      zh[ns] = fs.existsSync(lf) ? readLeaves(lf) : { map: new Map(), order: [] };
    }
  } catch (e) { console.error(`parse error: ${e.message}`); process.exitCode = 2; return; }

  const memory = loadMemory(memoryFile);
  if (memory.corrupt) console.error(`warning: skipped ${memory.corrupt} malformed memory entr${memory.corrupt === 1 ? 'y' : 'ies'} in ${memoryFile}`);
  const report = { seeded: 0, adopted: 0, kitApplied: 0, kitSkipped: 0, kitUnchanged: 0, kitDeleted: [], glossaryChanges: [], stale: [], orphaned: [], dropped: [], normalizedPlural: [], pluralConflicts: [], extras: 0, fileDrift: [], wrote: [], unchanged: [] };

  // en representative hash for a ns:key (exact key, else its plural-family representative)
  const reprOf = (ns, key) => {
    const m = en[ns].map;
    if (m.has(key)) return m.get(key);
    const { stem, suf } = splitPlural(key);
    if (suf !== null) {
      const cand = m.has(stem) ? stem : (m.has(`${stem}_other`) ? `${stem}_other` : (m.has(`${stem}_one`) ? `${stem}_one` : (m.has(`${stem}_plural`) ? `${stem}_plural` : null)));
      if (cand) return m.get(cand);
    }
    return null;
  };
  const hashOf = (ns, key) => {
    const v = reprOf(ns, key);
    return typeof v === 'string' ? sha8(v) : null;
  };

  // ---- 1) seed memory from current files (only fills gaps)
  for (const ns of nsAll) {
    for (const [k, v] of zh[ns].map) {
      const nsk = `${ns}:${k}`;
      if (!memory.map.has(nsk)) {
        memory.map.set(nsk, { h: hashOf(ns, k), zh: v });
        memory.order.push(nsk);
        report.seeded++;
      }
    }
  }

  // ---- 2) adopt file values (explicit opt-in)
  if (opts.adopt) {
    for (const ns of nsAll) {
      for (const [k, v] of zh[ns].map) {
        const e = memory.map.get(`${ns}:${k}`);
        if (e && e.zh !== v) { e.zh = v; report.adopted++; }
      }
    }
  }

  // ---- file drift snapshot (before this run's changes; cleared by --adopt)
  for (const ns of nsAll) {
    for (const [k, v] of zh[ns].map) {
      const e = memory.map.get(`${ns}:${k}`);
      if (e && e.zh !== v) report.fileDrift.push({ key: `${ns}:${k}`, file: v, memory: e.zh });
    }
  }

  // ---- 3) merge kits
  for (const kitFile of opts.kits) {
    let kit;
    try { kit = JSON.parse(fs.readFileSync(kitFile, 'utf8')); }
    catch (e) { console.error(`kit parse error (${kitFile}): ${e.message}`); process.exitCode = 2; return; }
    for (const [ns, entries] of Object.entries(kit)) {
      if (ns.startsWith('//') || ns.startsWith('_')) continue;
      if (!nsAll.includes(ns)) { console.error(`kit ${kitFile}: unknown namespace "${ns}" (have: ${nsAll.join(', ')})`); process.exitCode = 2; return; }
      for (const [k, raw] of Object.entries(entries)) {
        if (k.startsWith('//')) continue;
        if (raw === null) { // null = remove the key from zh (e.g. redundant plural forms)
          const nsk = `${ns}:${k}`;
          if (memory.map.delete(nsk)) report.kitDeleted.push(nsk);
          continue;
        }
        const value = typeof raw === 'string' ? raw : raw && raw.zh;
        if (!value) { report.kitSkipped++; continue; }
        const nsk = `${ns}:${k}`;
        const prev = memory.map.get(nsk);
        if (!prev) {
          memory.map.set(nsk, { h: hashOf(ns, k), zh: value });
          memory.order.push(nsk);
          report.kitApplied++;
        } else if (prev.zh !== value) {
          prev.zh = value;
          prev.h = hashOf(ns, k);
          report.kitApplied++;
        } else {
          prev.h = hashOf(ns, k); // explicit entry = deliberate re-assertion against current en
          report.kitUnchanged++;
        }
      }
    }
  }

  // ---- 4) glossary pass
  if (opts.glossary) {
    const rules = loadGlossaryRules(path.join(SCRIPT_DIR, 'glossary.json'));
    for (const [nsk, e] of memory.map) {
      const i = nsk.indexOf(':');
      const ns = nsk.slice(0, i), key = nsk.slice(i + 1);
      let v = e.zh;
      for (const rule of rules) {
        const nv = applyGlossaryRuleToValue(rule, ns, key, v);
        if (nv != null) v = nv;
      }
      if (v !== e.zh) { report.glossaryChanges.push({ key: nsk, from: e.zh, to: v }); e.zh = v; }
    }
  }

  // ---- 5) build outputs in en order
  const outputs = {};
  for (const ns of nsAll) {
    const out = {};
    const emitted = new Set();
    const mem = (k) => memory.map.get(`${ns}:${k}`);
    for (const k of en[ns].order) {
      if (emitted.has(k)) continue;
      const e = mem(k);
      const { stem, suf } = splitPlural(k);
      if (suf !== null) {
        const be = mem(stem); // zh base key covers the whole plural family
        if (be) {
          if (!emitted.has(stem)) { setByPath(out, stem, be.zh); emitted.add(stem); }
          emitted.add(k);
          if (e && e.zh !== be.zh && suf === 'other') {
            // live v4 form wins over the base at runtime — keep it and flag for review
            setByPath(out, k, e.zh);
            report.pluralConflicts.push(`${ns}:${k} (base ${JSON.stringify(be.zh)} vs _other ${JSON.stringify(e.zh)})`);
          } else if (e) {
            report.normalizedPlural.push(`${ns}:${k}`);
          }
          continue;
        }
        if (e) { setByPath(out, k, e.zh); emitted.add(k); continue; }
        const o = mem(`${stem}_other`); // zh only has the _other form
        if (o && !emitted.has(`${stem}_other`)) { setByPath(out, `${stem}_other`, o.zh); emitted.add(`${stem}_other`); }
        continue;
      }
      if (e) { setByPath(out, k, e.zh); emitted.add(k); continue; }
      const o = mem(`${k}_other`); // en base key, zh only has the _other form
      if (o && !emitted.has(`${k}_other`)) { setByPath(out, `${k}_other`, o.zh); emitted.add(`${k}_other`); }
    }
    const prefix = `${ns}:`;
    for (const nsk of memory.order) {
      if (!nsk.startsWith(prefix)) continue;
      const k = nsk.slice(prefix.length);
      if (emitted.has(k)) continue;
      const e = memory.map.get(nsk);
      if (!e) continue; // deleted by a kit
      const { stem, suf } = splitPlural(k);
      const enHasStem = enStems[ns].has(stem);
      if (suf !== null && enHasStem) {
        if (emitted.has(stem) || emitted.has(`${stem}_other`)) { report.dropped.push(nsk); continue; }
        setByPath(out, k, e.zh); emitted.add(k);
        continue;
      }
      if (e.h !== null && !enHasStem) { report.orphaned.push(nsk); continue; }
      setByPath(out, k, e.zh); emitted.add(k);
      if (e.h === null) report.extras++;
    }
    // stale check: emitted keys whose en text changed since translation
    const flatKeys = [];
    walkLeaves(out, (k) => flatKeys.push(k));
    for (const k of flatKeys) {
      const e = mem(k);
      if (!e || e.h === null) continue;
      const h = hashOf(ns, k);
      if (h !== null && h !== e.h) report.stale.push({ key: `${ns}:${k}`, en: String(reprOf(ns, k)).slice(0, 80) });
    }
    outputs[ns] = out;
  }

  // ---- 6) write files (and prune memory to what was emitted)
  const newOrder = [];
  const newMap = new Map();
  for (const ns of nsAll) {
    const out = outputs[ns];
    const flatKeys = [];
    walkLeaves(out, (k) => flatKeys.push(k));
    for (const k of flatKeys) {
      const nsk = `${ns}:${k}`;
      newOrder.push(nsk);
      newMap.set(nsk, memory.map.get(nsk));
    }
    const text = JSON.stringify(out, null, 2) + '\n';
    const file = path.join(langDir, `${ns}.json`);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (before !== text) {
      report.wrote.push({ ns, keys: flatKeys.length });
      if (!opts.dryRun) fs.writeFileSync(file, text, 'utf8');
    } else {
      report.unchanged.push(ns);
    }
  }
  if (!opts.dryRun) {
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    saveMemory(memoryFile, newOrder, newMap);
  }

  // ---- 7) report
  if (opts.json) {
    console.log(JSON.stringify({ dryRun: opts.dryRun, memory: newOrder.length, ...report }, null, 2));
  } else {
    console.log(`apply — ${opts.lang} (base ${opts.base})${opts.dryRun ? ' [dry-run]' : ''}`);
    console.log(`  memory: ${newOrder.length} entries (seeded ${report.seeded}, adopted ${report.adopted})`);
    if (opts.kits.length) console.log(`  kits: ${report.kitApplied} applied, ${report.kitUnchanged} re-asserted, ${report.kitDeleted.length} deleted, ${report.kitSkipped} skipped (empty)`);
    if (report.glossaryChanges.length) {
      console.log(`  glossary: ${report.glossaryChanges.length} value(s) updated`);
      for (const g of report.glossaryChanges.slice(0, 8)) console.log(`      ${g.key}: ${JSON.stringify(g.from).slice(0, 50)} → ${JSON.stringify(g.to).slice(0, 50)}`);
    }
    if (report.wrote.length) console.log(`  wrote: ${report.wrote.map(w => `${w.ns}(${w.keys})`).join(' ')}`);
    if (report.unchanged.length) console.log(`  unchanged: ${report.unchanged.join(' ')}`);
    const lists = [
      ['stale en (retranslate)', report.stale.slice(0, 8).map(s => `${s.key} — en="${s.en}"`), report.stale.length],
      ['orphaned en keys (removed from memory)', report.orphaned.slice(0, 8), report.orphaned.length],
      ['redundant plural forms (dropped)', report.dropped.slice(0, 8), report.dropped.length],
      ['plural variants folded into base', report.normalizedPlural.slice(0, 8), report.normalizedPlural.length],
      ['plural conflicts (kept, review)', report.pluralConflicts.slice(0, 8), report.pluralConflicts.length],
      ['file drift (file value != memory)', report.fileDrift.slice(0, 8).map(d => `${d.key} file=${JSON.stringify(d.file).slice(0, 30)} mem=${JSON.stringify(d.memory).slice(0, 30)}`), report.fileDrift.length],
    ];
    for (const [title, items, n] of lists) {
      if (!n) continue;
      console.log(`  ${title}: ${n}`);
      for (const it of items) console.log(`      ${it}`);
      if (n > items.length) console.log(`      … +${n - items.length} more`);
    }
    if (report.extras) console.log(`  zh-only extras kept: ${report.extras}`);
  }
}

main();
