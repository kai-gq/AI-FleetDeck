/**
 * bolba-board — duplicate task detection.
 *
 * Pure functions, zero imports (dependency-injected by server.mjs).
 * Titles are folded (lowercase + strip diacritics), tokenized, Spanish/English
 * stopwords and tiny tokens dropped; numbers are always kept.
 */

const STOPWORDS = new Set([
  // Spanish
  'de', 'la', 'el', 'los', 'las', 'y', 'o', 'u', 'para', 'por', 'con', 'un', 'una',
  'del', 'al', 'en', 'a', 'su', 'se', 'que', 'es', 'lo',
  // English
  'the', 'and', 'for', 'with', 'of', 'to', 'in', 'on', 'an', 'at', 'or',
]);

export function fold(s) {
  return String(s ?? '')
    .normalize('NFD')
    .split('')
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return !(code >= 0x300 && code <= 0x36f);
    })
    .join('')
    .toLowerCase();
}

export function normalizeTitle(title) {
  const tokens = fold(title)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
    .filter((t) => (t.length >= 3 || /\d/.test(t)) && !STOPWORDS.has(t));
  return Array.from(new Set(tokens));
}

function r3(x) {
  return Math.round(x * 1000) / 1000;
}

export function pairScores(aTokens, bTokens) {
  const setB = new Set(bTokens);
  let inter = 0;
  for (const token of new Set(aTokens)) {
    if (setB.has(token)) inter += 1;
  }
  const union = aTokens.length + bTokens.length - inter;
  const jaccard = union > 0 ? inter / union : 0;
  const minSize = Math.min(aTokens.length, bTokens.length);
  const containment = minSize > 0 ? inter / minSize : 0;
  const similarity = 0.6 * jaccard + 0.4 * containment;
  return { similarity: r3(similarity), jaccard: r3(jaccard), containment: r3(containment) };
}

export function isCandidate({ jaccard, containment, similarity }) {
  return jaccard >= 0.5 || containment >= 0.75 || similarity >= 0.6;
}

/**
 * Rank duplicate candidates for a (new or proposed) title against existing
 * light task rows ({id,title,proj,status}). Discarded tasks are ignored.
 * Pending tasks sort first, then by similarity desc. Cap `limit` (default 5).
 */
export function rankCandidates(title, tasks, { limit = 5 } = {}) {
  const tokens = normalizeTitle(title);
  if (!tokens.length) return [];
  const out = [];
  for (const task of tasks) {
    if (task.status === 'discarded') continue;
    const candidateTokens = normalizeTitle(task.title);
    if (!candidateTokens.length) continue;
    const scores = pairScores(tokens, candidateTokens);
    if (!isCandidate(scores)) continue;
    out.push({ task, ...scores });
  }
  out.sort((a, b) => {
    const aPending = a.task.status !== 'done' && a.task.status !== 'completed' ? 1 : 0;
    const bPending = b.task.status !== 'done' && b.task.status !== 'completed' ? 1 : 0;
    return (bPending - aPending) || (b.similarity - a.similarity) || (b.task.id - a.task.id);
  });
  return out.slice(0, limit);
}
