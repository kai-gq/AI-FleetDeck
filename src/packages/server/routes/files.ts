/**
 * Files Routes
 * REST API endpoints for file operations
 * 端点处理器按主题拆入 ./files/(2026-10-11 W3 拆分);本文件保留 Router 实例、
 * /git-*path 缓存中间件与按原顺序的路由注册表。
 */

// ============================================================================
// 模块拆分(W3,2026-10-11):端点处理器按主题拆入 ./files/,此处只保留 Router
// 实例、/git-*path 缓存中间件与路由注册表(注册顺序与拆分前一致);导出面不变。
// ============================================================================

import { handleGetRead, handleGetHtmlPreview, handleGetHtmlPreviewResource, handleGetResolve, handleGetExists, handlePostExistsBatch, handleGetRecover } from './files/read-routes.js';
import { handleUseInfoBinary, handleGetInfo, handleGetArchive, handleGetSpreadsheet, handleGetDocument, handleGetDocumentMedia, handleGetBinary, handleGetDownloadFolder, handlePostMarkdownPdf } from './files/content-routes.js';
import { handleGetList, handleGetTree, handlePostRename, handlePostCreate, handlePostCopy, handlePostPaste } from './files/tree-routes.js';
import { handleGetSearch, handleGetSearchGlobal, handleGetSearchContentGlobal, handleGetSearchContent } from './files/search-routes.js';
import { handleGetGitStatus, handlePostGitAdd, handlePostGitDiscard, handlePostGitDiscardAll, handleGetGitOriginal, handleGetGitOriginalBinary, handleGetGitDiff } from './files/git-status-routes.js';
import { handleGetGitBranch, handleGetGitBranches, handlePostGitCheckout, handlePostGitBranchCreate, handlePostGitPull, handlePostGitPush, handleGetGitLogMessage, handlePostGitCommit, handlePostGitFetch } from './files/git-branch-routes.js';
import { handlePostGitMerge, handleGetGitConflictFile, handlePostGitResolveConflict, handlePostGitMergeContinue, handlePostGitMergeAbort, handleGetGitBranchCompare, handleGetGitShow, handleGetGitCommitFileDiff } from './files/git-merge-routes.js';
import { handlePostOpenInEditor, handlePostReveal, handlePostWrite, handlePostByPath, handlePostUpload, handleGetTempDir, handleGetAutocomplete, handleDeleteTempFilename, handlePostDelete } from './files/file-ops-routes.js';
import { handleGetGitLog, handleGetGitCommitFiles, handleGetGitFileHistory, handleGetGitFileCommitDiff, handleGetGitBranchesList, handleGetGitAuthors } from './files/git-log-routes.js';
import { Router, Request, Response } from 'express';

export { TEMP_DIR, looksLikeBinaryBuffer, parseByteRange, isAbsolutePathCrossPlatform, toPosixSeparators, resolveAndValidateFilePath } from './files/fs-utils.js';
export type { ResolutionStrategy } from './files/path-resolve.js';
export { _resetAreaDirCacheForTests, _setAreaLoaderForTests, _resetSuffixWalkCacheForTests, findByChildAnchor, findFileWithFallbacks } from './files/path-resolve.js';
export { rewriteHtmlPreviewCss, rewriteHtmlPreviewScript, rewriteHtmlPreviewDocument } from './files/html-preview.js';

const router = Router();

// Prevent browser from caching git-related GET responses (status, diff, branch, etc.)
// Without this, browsers may serve stale cached data — e.g. deleted files still appearing.
router.use('/git-*path', (_req: Request, res: Response, next: import('express').NextFunction) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});

// ---------------------------------------------------------------------------
// 路由注册表(处理器见 ./files/;顺序与拆分前一致)
// ---------------------------------------------------------------------------
router.get('/read', handleGetRead);
router.get('/html-preview', handleGetHtmlPreview);
router.get('/html-preview-resource', handleGetHtmlPreviewResource);
router.get('/resolve', handleGetResolve);
router.get('/exists', handleGetExists);
router.post('/exists-batch', handlePostExistsBatch);
router.get('/recover', handleGetRecover);
router.use(['/info', '/binary'], handleUseInfoBinary);
router.get('/info', handleGetInfo);
router.get('/archive', handleGetArchive);
router.get('/spreadsheet', handleGetSpreadsheet);
router.get('/document', handleGetDocument);
router.get('/document-media', handleGetDocumentMedia);
router.get('/binary', handleGetBinary);
router.get('/download-folder', handleGetDownloadFolder);
router.post('/markdown-pdf', handlePostMarkdownPdf);
router.get('/list', handleGetList);
router.get('/tree', handleGetTree);
router.post('/rename', handlePostRename);
router.post('/create', handlePostCreate);
router.post('/copy', handlePostCopy);
router.post('/paste', handlePostPaste);
router.get('/search', handleGetSearch);
router.get('/search-global', handleGetSearchGlobal);
router.get('/search-content-global', handleGetSearchContentGlobal);
router.get('/search-content', handleGetSearchContent);
router.get('/git-status', handleGetGitStatus);
router.post('/git-add', handlePostGitAdd);
router.post('/git-discard', handlePostGitDiscard);
router.post('/git-discard-all', handlePostGitDiscardAll);
router.get('/git-original', handleGetGitOriginal);
router.get('/git-original-binary', handleGetGitOriginalBinary);
router.get('/git-diff', handleGetGitDiff);
router.get('/git-branch', handleGetGitBranch);
router.get('/git-branches', handleGetGitBranches);
router.post('/git-checkout', handlePostGitCheckout);
router.post('/git-branch-create', handlePostGitBranchCreate);
router.post('/git-pull', handlePostGitPull);
router.post('/git-push', handlePostGitPush);
router.get('/git-log-message', handleGetGitLogMessage);
router.post('/git-commit', handlePostGitCommit);
router.post('/git-merge', handlePostGitMerge);
router.get('/git-conflict-file', handleGetGitConflictFile);
router.post('/git-resolve-conflict', handlePostGitResolveConflict);
router.post('/git-merge-continue', handlePostGitMergeContinue);
router.post('/git-merge-abort', handlePostGitMergeAbort);
router.get('/git-branch-compare', handleGetGitBranchCompare);
router.get('/git-show', handleGetGitShow);
router.get('/git-commit-file-diff', handleGetGitCommitFileDiff);
router.post('/open-in-editor', handlePostOpenInEditor);
router.post('/reveal', handlePostReveal);
router.post('/write', handlePostWrite);
router.post('/by-path', handlePostByPath);
router.post('/upload', handlePostUpload);
router.get('/temp-dir', handleGetTempDir);
router.get('/autocomplete', handleGetAutocomplete);
router.delete('/temp/:filename', handleDeleteTempFilename);
router.post('/git-fetch', handlePostGitFetch);
router.post('/delete', handlePostDelete);
router.get('/git-log', handleGetGitLog);
router.get('/git-commit-files', handleGetGitCommitFiles);
router.get('/git-file-history', handleGetGitFileHistory);
router.get('/git-file-commit-diff', handleGetGitFileCommitDiff);
router.get('/git-branches-list', handleGetGitBranchesList);
router.get('/git-authors', handleGetGitAuthors);

export default router;
