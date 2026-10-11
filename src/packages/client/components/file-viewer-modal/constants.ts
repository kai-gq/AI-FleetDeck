/**
 * FileViewerModal 的常量(代码行高 / 各预览类型扩展名表)。
 *
 * 自 FileViewerModal.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */


// Row heights from _file-viewer.scss: 12px font at line-height 1.6 (normal
// view) and 1.5 (read-highlight view). Rows never wrap (`white-space: pre`),
// so these are exact and the windowed list keeps the real scroll height.
export const CODE_LINE_HEIGHT = 19.2;

export const HIGHLIGHT_LINE_HEIGHT = 18;

export const MARKDOWN_EXTENSIONS = ['.md', '.mdx', '.markdown'];

export const HTML_EXTENSIONS = ['.html', '.htm'];

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'];

export const PDF_EXTENSIONS = ['.pdf'];

export const STL_EXTENSIONS = ['.stl'];

export const FCSTD_EXTENSIONS = ['.fcstd'];

export const GLB_EXTENSIONS = ['.glb', '.gbl'];

export const GCODE_EXTENSIONS = ['.gcode', '.gco'];
