/**
 * HTML 预览的本地依赖改写(样式/脚本/文档与 URL 重写)。
 *
 * 自 files.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { resolveAndValidateFilePath } from './fs-utils.js';
import { findFileWithFallbacks } from './path-resolve.js';
import { Request } from 'express';
import * as fs from 'fs';
import * as path from 'path';

export const HTML_PREVIEW_DOCUMENT_EXTENSIONS = new Set(['.html', '.htm']);

export const HTML_PREVIEW_STYLESHEET_EXTENSIONS = new Set(['.css']);

export const HTML_PREVIEW_SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

function isExternalPreviewReference(reference: string): boolean {
  const trimmed = reference.trim();
  return !trimmed
    || trimmed.startsWith('#')
    || trimmed.startsWith('//')
    || /^(?:[a-z][a-z\d+.-]*:)/i.test(trimmed);
}

function resolvePreviewReference(reference: string, sourcePath: string, previewRoot: string): string | null {
  if (isExternalPreviewReference(reference)) return null;
  const withoutFragment = reference.split('#', 1)[0].split('?', 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    decoded = withoutFragment;
  }
  return decoded.startsWith('/')
    ? path.resolve(previewRoot, `.${decoded}`)
    : path.resolve(path.dirname(sourcePath), decoded);
}

export function htmlPreviewUrl(
  targetPath: string,
  previewRoot: string,
  authToken: string,
  forceDocument = false,
): string {
  const extension = path.extname(targetPath).toLowerCase();
  const endpoint = forceDocument || HTML_PREVIEW_DOCUMENT_EXTENSIONS.has(extension)
    ? '/api/files/html-preview'
    : '/api/files/html-preview-resource';
  const params = new URLSearchParams({ path: targetPath, root: previewRoot });
  if (authToken) params.set('token', authToken);
  return `${endpoint}?${params.toString()}`;
}

function rewritePreviewReference(
  reference: string,
  sourcePath: string,
  previewRoot: string,
  authToken: string,
): string {
  const resolved = resolvePreviewReference(reference, sourcePath, previewRoot);
  return resolved ? htmlPreviewUrl(resolved, previewRoot, authToken) : reference;
}

/** Rewrite CSS dependencies so url(), fonts, images and nested @imports stay authenticated. */
export function rewriteHtmlPreviewCss(
  css: string,
  sourcePath: string,
  previewRoot: string,
  authToken = '',
): string {
  const rewrite = (reference: string) => rewritePreviewReference(reference, sourcePath, previewRoot, authToken);
  return css
    .replace(/url\(\s*(['"]?)([^)'"\s][^)'"\s]*|[^)'"\s])\1\s*\)/gi, (_match, quote: string, reference: string) => (
      `url(${quote}${rewrite(reference)}${quote})`
    ))
    .replace(/(@import\s+)(['"])([^'"]+)\2/gi, (_match, prefix: string, quote: string, reference: string) => (
      `${prefix}${quote}${rewrite(reference)}${quote}`
    ));
}

/** Rewrite static/dynamic ES module specifiers in locally-served scripts. */
export function rewriteHtmlPreviewScript(
  script: string,
  sourcePath: string,
  previewRoot: string,
  authToken = '',
): string {
  return script.replace(
    /(\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?|\bimport\s*\(\s*)(['"])([^'"]+)\2/g,
    (match, prefix: string, quote: string, reference: string) => {
      // Browser import maps/package loaders own bare specifiers such as
      // "react"; only filesystem-style module paths belong to the preview.
      if (!reference.startsWith('.') && !reference.startsWith('/')) return match;
      const resolved = resolvePreviewReference(reference, sourcePath, previewRoot);
      if (!resolved) return match;
      return `${prefix}${quote}${htmlPreviewUrl(resolved, previewRoot, authToken)}${quote}`;
    },
  );
}

/** Build a sandbox-ready HTML document whose local assets use authenticated preview URLs. */
export function rewriteHtmlPreviewDocument(
  html: string,
  sourcePath: string,
  previewRoot: string,
  authToken = '',
): string {
  let output = html.replace(
    /\b(src|href|poster)\s*=\s*(['"])([^'"]+)\2/gi,
    (_match, attribute: string, quote: string, reference: string) => (
      `${attribute}=${quote}${rewritePreviewReference(reference, sourcePath, previewRoot, authToken)}${quote}`
    ),
  );
  output = output.replace(/\bsrcset\s*=\s*(['"])([^'"]+)\1/gi, (_match, quote: string, value: string) => {
    // A data URL legitimately contains commas; splitting it as a candidate
    // list would corrupt the embedded image.
    if (value.trim().startsWith('data:')) return `srcset=${quote}${value}${quote}`;
    const rewritten = value.split(',').map((candidate) => {
      const trimmed = candidate.trim();
      const separator = trimmed.search(/\s/);
      const reference = separator < 0 ? trimmed : trimmed.slice(0, separator);
      const descriptor = separator < 0 ? '' : trimmed.slice(separator);
      return `${rewritePreviewReference(reference, sourcePath, previewRoot, authToken)}${descriptor}`;
    }).join(', ');
    return `srcset=${quote}${rewritten}${quote}`;
  });
  output = output.replace(/\bstyle\s*=\s*(['"])([\s\S]*?)\1/gi, (_match, quote: string, css: string) => (
    `style=${quote}${rewriteHtmlPreviewCss(css, sourcePath, previewRoot, authToken)}${quote}`
  ));
  output = output.replace(/<style(\s[^>]*)?>([\s\S]*?)<\/style>/gi, (_match, attributes = '', css: string) => (
    `<style${attributes}>${rewriteHtmlPreviewCss(css, sourcePath, previewRoot, authToken)}</style>`
  ));
  output = output.replace(/<script([^>]*\btype\s*=\s*['"]module['"][^>]*)>([\s\S]*?)<\/script>/gi, (_match, attributes: string, script: string) => (
    `<script${attributes}>${rewriteHtmlPreviewScript(script, sourcePath, previewRoot, authToken)}</script>`
  ));

  const bridge = `<script>(function(){window.addEventListener('keydown',function(event){if(event.key==='Escape'){parent.postMessage({type:'tide-html-preview-escape'},'*');}},true);})();</script>`;
  return /<\/body\s*>/i.test(output)
    ? output.replace(/<\/body\s*>/i, `${bridge}</body>`)
    : `${output}${bridge}`;
}

export function resolveHtmlPreviewRequest(req: Request): { ok: true; filePath: string; previewRoot: string; token: string } | { ok: false; status: number; error: string } {
  const resolution = findFileWithFallbacks(
    req.query.path as string | undefined,
    req.query.root as string | undefined,
  );
  if (!resolution.ok) return { ok: false, status: resolution.status, error: resolution.error };
  const filePath = resolution.path;
  const rootQuery = req.query.root as string | undefined;
  const rootResolution = rootQuery
    ? resolveAndValidateFilePath(rootQuery)
    : { ok: true as const, path: path.dirname(filePath) };
  const previewRoot = rootResolution.ok && fs.existsSync(rootResolution.path) && fs.statSync(rootResolution.path).isDirectory()
    ? rootResolution.path
    : path.dirname(filePath);
  return {
    ok: true,
    filePath,
    previewRoot,
    token: typeof req.query.token === 'string' ? req.query.token : '',
  };
}
