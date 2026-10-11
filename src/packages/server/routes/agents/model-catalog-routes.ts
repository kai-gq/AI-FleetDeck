/**
 * 模型目录路由:/opencode/models(1 小时 CLI 缓存)与 /pi/models。
 *
 * 自 agents.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log, runCommandWithTimeout } from './helpers.js';
import { Request, Response } from 'express';
import { runtimeService } from '../../services/index.js';
import { OpencodeBackend } from '../../opencode/backend.js';
import { getPiModelCatalog, getPiModelCatalogFetchedAt } from '../../pi/model-catalog.js';

// GET /api/agents/opencode/models - List opencode CLI models
// NOTE: Defined BEFORE /:id routes so "opencode" is not parsed as an agent id.
interface OpencodeModelsCache {
  models: string[];
  fetchedAt: number;
  source: 'cli' | 'fallback';
}

let opencodeModelsCache: OpencodeModelsCache | null = null;

const OPENCODE_MODELS_TTL_MS = 60 * 60 * 1000; // 1 hour

export const handleGetOpencodeModels = async (req: Request, res: Response) => {
  const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
  const now = Date.now();

  if (!refresh && opencodeModelsCache && now - opencodeModelsCache.fetchedAt < OPENCODE_MODELS_TTL_MS) {
    res.json({
      models: opencodeModelsCache.models,
      source: opencodeModelsCache.source,
      cached: true,
      fetchedAt: opencodeModelsCache.fetchedAt,
    });
    return;
  }

  try {
    const opencodeExe = new OpencodeBackend().getExecutablePath();
    const args = refresh ? ['models', '--refresh'] : ['models'];
    const result = await runCommandWithTimeout(opencodeExe, args, 15000);

    const models = result.output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.includes('/'));

    if (models.length === 0) {
      res.status(502).json({
        error: 'opencode CLI returned no models',
        stderr: result.errorOutput || undefined,
        exitCode: result.exitCode,
      });
      return;
    }

    opencodeModelsCache = { models, fetchedAt: now, source: 'cli' };
    // `opencode serve` keeps the Models.dev catalog in memory for its entire
    // lifetime. Refreshing the CLI cache alone can therefore show a new model
    // in the picker while the persistent daemon still rejects it. Invalidate
    // the daemon too; active turns defer this safely until they finish.
    const daemonReload = refresh
      ? runtimeService.requestOpencodeModelCatalogReload()
      : undefined;
    res.json({ models, source: 'cli', cached: false, fetchedAt: now, daemonReload });
  } catch (err: any) {
    log.error(' opencode models fetch failed:', err);
    res.status(500).json({ error: err?.message || 'Failed to run opencode CLI' });
  }
};

// GET /api/agents/pi/models - List Pi CLI models and their authoritative
// context windows (providers with credentials only). Defined before /:id so
// "pi" is not parsed as an agent id.
export const handleGetPiModels = async (req: Request, res: Response) => {
  const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
  const previousFetchedAt = getPiModelCatalogFetchedAt();

  try {
    const modelDetails = await getPiModelCatalog(refresh);
    const fetchedAt = getPiModelCatalogFetchedAt() || Date.now();
    res.json({
      models: modelDetails.map((entry) => entry.id),
      modelDetails,
      source: 'cli',
      cached: !refresh && previousFetchedAt === fetchedAt,
      fetchedAt,
    });
  } catch (err: any) {
    log.error(' pi models fetch failed:', err);
    res.status(500).json({ error: err?.message || 'Failed to run pi CLI' });
  }
};
