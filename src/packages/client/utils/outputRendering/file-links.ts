/**
 * 文件路径识别与 markdown 链接化(tide-file:// 解码)。
 *
 * 自 utils/outputRendering.ts 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { COMMAND_FILE_REF_REGEX } from './output-classify';

const TIDE_FILE_LINK_SCHEME = 'tide-file://';

// Path segments allow Unicode letters/marks (see COMMAND_FILE_REF_REGEX above)
// so accented absolute paths (e.g. /home/.../Operación/file.pdf) are matched in
// full. The `u` flag is required for the \p{...} escapes.
// The trailing lookahead must NOT let a token end on an interior dot. A bare `.`
// terminator plus a dot-bearing character class means the engine can backtrack a
// greedy domain match and stop mid-name whenever the next char is not a valid
// terminator (`/`, `?`, `#`, `"`, `*`, ...). That truncated the domain in e.g.
// "inbound-smtp.us-west-2.amazonaws.com/path" to "inbound-smtp.us-west-2.amazonaws",
// which no longer ends in a TLD, so the URL_TLDS guard below missed it and the
// fragment was linkified as a file. A `.` therefore only terminates a token when the
// dot itself is followed by end-of-line or real punctuation (sentence periods).
const FILE_PATH_TOKEN_REGEX = /(^|[\s(>])((?:\.\.?\/|\/)?(?:[\p{L}\p{M}\p{N}._-]+\/)*[\p{L}\p{M}\p{N}._-]+(?:\.[\p{L}\p{M}\p{N}._-]+)+(?:#L\d+(?:C\d+)?)?(?::\d+(?::\d+)?)?)(?=$|[\s),;:?!'"]|\.(?:$|[\s),;:?!'"]))/gu;

const INLINE_CODE_FILE_PATH_REGEX = /`((?:\.\.?\/|\/)?(?:[\p{L}\p{M}\p{N}._-]+\/)*[\p{L}\p{M}\p{N}._-]+(?:\.[\p{L}\p{M}\p{N}._-]+)+(?:#L\d+(?:C\d+)?)?(?::\d+(?::\d+)?)?)`/gu;

// Common TLDs to distinguish URLs from file paths
const URL_TLDS = /\.(com|org|net|io|dev|app|co|me|info|biz|us|uk|de|fr|jp|cn|ru|edu|gov|mil|int|xyz|tech|online|site|store|blog|cloud|ai|gg|tv|cc|sh|fm|to|ly|gl|so|is|it|at|nl|ch|se|no|fi|dk|be|cz|pl|pt|br|mx|ar|cl|in|au|nz|za|sg|hk|tw|kr|id|ph|th|vn|my)(?:[:/\s#?]|$)/i;

// Trailing `:12`, `:12:3`, `#L12` and `#L12C3` suffixes are part of a file
// reference, not of its extension, so they are stripped before either the
// extension check or token de-duplication looks at the name.
const FILE_PATH_LINE_SUFFIX_REGEX = /(?:#L\d+(?:C\d+)?)?(?::\d+(?::\d+)?)?$/;

// A dotted token with no path separator only reads as a file when it ends in a
// known extension. Agent prose is full of property accesses and qualified names
// -- `alert.kind`, `res.data`, `Transaction.transferPeerId` -- and every one of
// them used to become a `tide-file://` link, because the only test was "contains
// a dot". Anything containing a `/` is still treated as a path regardless of
// extension, so unusual ones (`config/app.local`) keep working.
const FILE_EXTENSIONS = new Set([
  // source
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'pyi', 'rb', 'go', 'rs',
  'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'hh', 'cs', 'swift', 'dart',
  'scala', 'groovy', 'php', 'pl', 'pm', 'lua', 'r', 'jl', 'ex', 'exs', 'erl', 'hs',
  'clj', 'cljs', 'vue', 'svelte', 'astro', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
  'cmd', 'sql', 'wasm',
  // markup and styles
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl', 'svg', 'xml', 'xsl',
  // config and data
  'json', 'jsonc', 'json5', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'properties', 'lock', 'gradle', 'tf', 'tfvars', 'csv', 'tsv', 'parquet',
  // docs
  'md', 'mdx', 'txt', 'rst', 'adoc', 'tex', 'pdf', 'doc', 'docx', 'xls', 'xlsx',
  'ppt', 'pptx', 'odt', 'ods', 'rtf', 'epub', 'log',
  // media
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tiff', 'psd',
  'mp3', 'wav', 'ogg', 'flac', 'mp4', 'mov', 'webm', 'mkv', 'avi',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // archives and binaries
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war', 'apk', 'deb',
  'rpm', 'iso', 'dmg', 'so', 'dll', 'dylib', 'exe', 'bin', 'class', 'o', 'a',
  // misc build output
  'map', 'snap', 'patch', 'diff', 'sqlite', 'db', 'bak', 'tmp',
]);

// A few file extensions double as country/vanity TLDs, so the domain guard below
// would otherwise swallow them. Shell scripts come up far more often in agent
// output than `.sh` domains do, so `sh` wins; `so` deliberately does not, since a
// shared object is a binary rather than something worth opening in the viewer.
// `cc` and `pl` also collide but stay with the domain guard.
const EXTENSIONS_BEATING_URL_TLDS = new Set(['sh']);

function isLikelyFilePathToken(token: string): boolean {
  if (!token) return false;
  if (token.includes('://')) return false;
  if (token.startsWith('www.')) return false;
  if (token.includes('@')) return false;
  if (!token.includes('.') || token.endsWith('.')) return false;

  const bare = token.replace(FILE_PATH_LINE_SUFFIX_REGEX, '');
  // Everything after the last dot. For a domain carrying a path this still holds
  // the path ("example.sh/run" -> "sh/run"), so such a token can never pass as a
  // bare script through the TLD exception below.
  const ext = bare.slice(bare.lastIndexOf('.') + 1).toLowerCase();

  // Exclude domain-like tokens (e.g. npmmirror.com, github.io/path)
  const base = token.split('/')[0];
  if (URL_TLDS.test(base) && !EXTENSIONS_BEATING_URL_TLDS.has(ext)) return false;

  // An explicit path separator is signal enough on its own.
  if (bare.includes('/')) return true;
  return FILE_EXTENSIONS.has(ext);
}

/**
 * Convert bare file paths in plain output text into markdown links.
 * Uses a custom scheme so markdown renderers can route clicks to the file viewer modal.
 */
export function linkifyFilePathsForMarkdown(text: string): string {
  if (!text || !text.includes('.')) return text;

  const lines = text.split('\n');
  let inFence = false;

  const rendered = lines.map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;

    const withInlineCodeLinks = line.replace(INLINE_CODE_FILE_PATH_REGEX, (match, token: string) => {
      if (!isLikelyFilePathToken(token)) {
        return match;
      }
      const encoded = encodeURIComponent(token);
      return `[\`${token}\`](${TIDE_FILE_LINK_SCHEME}${encoded})`;
    });

    return withInlineCodeLinks.replace(FILE_PATH_TOKEN_REGEX, (match, prefix: string, token: string, offset: number) => {
      const tokenStart = offset + prefix.length;
      const prevChar = tokenStart > 0 ? withInlineCodeLinks[tokenStart - 1] : '';
      const nextChar = tokenStart + token.length < withInlineCodeLinks.length ? withInlineCodeLinks[tokenStart + token.length] : '';

      // Avoid rewriting markdown link targets like [label](path/to/file)
      if (prevChar === '(' && tokenStart > 1 && withInlineCodeLinks[tokenStart - 2] === ']') {
        return match;
      }
      if (prevChar === '[' || nextChar === ']') {
        return match;
      }
      if (!isLikelyFilePathToken(token)) {
        return match;
      }

      const encoded = encodeURIComponent(token);
      return `${prefix}[${token}](${TIDE_FILE_LINK_SCHEME}${encoded})`;
    });
  });

  return rendered.join('\n');
}

/**
 * Extract bare file-path tokens from free text (not markdown).
 *
 * Reuses the exact detection heuristics of linkifyFilePathsForMarkdown
 * (FILE_PATH_TOKEN_REGEX + isLikelyFilePathToken) so search indexing and
 * rendering agree on what counts as a file path. Trailing line/column suffixes
 * (:12, :12:3, #L12, #L12C3) are stripped so callers get the bare path, and the
 * result is de-duplicated preserving first-seen order.
 */
export function extractFilePathTokens(text: string): string[] {
  if (!text || !text.includes('.')) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  FILE_PATH_TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_PATH_TOKEN_REGEX.exec(text)) !== null) {
    const token = match[2];
    if (!isLikelyFilePathToken(token)) continue;
    const bare = token.replace(FILE_PATH_LINE_SUFFIX_REGEX, '');
    if (!bare || seen.has(bare)) continue;
    seen.add(bare);
    out.push(bare);
  }
  return out;
}

/**
 * Decode custom markdown href back into a file reference string.
 */
export function decodeTideFileHref(href?: string | null): string | null {
  if (!href || !href.startsWith(TIDE_FILE_LINK_SCHEME)) return null;
  const encoded = href.slice(TIDE_FILE_LINK_SCHEME.length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}
