/**
 * Runtime availability — GET /api/runtimes
 *
 * Reports which provider CLIs are installed on the machine running the server
 * (plus the static-catalog model ids for claude/codex/grok). Consumed by the
 * boss instructions before team planning and by the client dialogs, which
 * only offer detected runtimes.
 *
 * Never 500s: a detection failure still returns 200 with a degraded,
 * fail-open payload, so no consumer hides runtimes because of it.
 */
import { Router } from 'express';
import { getRuntimeAvailability } from '../services/runtime-availability-service.js';

const router = Router();

router.get('/', (req, res) => {
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  try {
    res.json(getRuntimeAvailability({ refresh }));
  } catch (err) {
    res.json({
      ok: false,
      generatedAt: Date.now(),
      platform: process.platform,
      degraded: true,
      providers: [],
      notes: [`detection failed: ${err instanceof Error ? err.message : String(err)}`],
    });
  }
});

export default router;
