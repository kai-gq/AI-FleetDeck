/**
 * GuakeGitPanel 的常量(自动展开上限 / 过滤渲染上限 / 最近目录与搜索限制 / 过滤帮助 / 二进制扩展名)。
 *
 * 自 GuakeGitPanel.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */


// A repo with this many changes is generated output (build dirs, caches), not
// work in progress: expanding it renders one row per file and would lock up the
// browser, so it stays collapsed until the user asks for it.
export const AUTO_EXPAND_MAX_FILES = 500;

// Filter results auto-expand, so a loose query ("s") on a huge repo would
// otherwise paint every change at once. Beyond this the user refines instead.
export const FILTER_RENDER_CAP = 300;

/** How many recently-used agent working directories the Files tab lists. */
export const RECENT_FOLDER_LIMIT = 10;

// The Files tab tree is lazy-loaded (3 levels), so a filter there also asks the
// server to walk the folder — debounced, and only once the seed term is usable.
export const EXPLORER_SEARCH_LIMIT = 200;

export const EXPLORER_SEARCH_DEBOUNCE_MS = 220;

export const FILTER_HELP = [
  'Filter files:',
  '  runner          fuzzy match on the filename, then the path',
  '  server/claude   a term with "/" matches the full path',
  '  .tsx  *.tsx     extension',
  '  "exact text"    contiguous match, no fuzzy scatter',
  '  !test           exclude matches',
  '  status:mod      only that status (m/a/d/u/r/c)',
  'Terms combine with AND. Uppercase makes a term case-sensitive.',
].join('\n');

export const GIT_BINARY_EXTENSIONS = new Set([
  '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dmg', '.app', '.deb', '.rpm', '.apk', '.aab', '.ipa', '.msi',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.webm',
  '.ttf', '.otf', '.woff', '.woff2', '.eot', '.sqlite', '.db',
  '.so', '.dll', '.dylib', '.a', '.o', '.obj', '.bin', '.dat', '.iso', '.img',
  '.jar', '.war', '.ear', '.class',
]);
