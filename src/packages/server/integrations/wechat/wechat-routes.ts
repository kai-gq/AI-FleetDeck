/**
 * WeChat (ClawBot) Routes
 * Express Router for the QR login flow, connection status, and outbound sends.
 * Mounted at /api/wechat/ by the integration registry.
 */

import { Router, Request, Response } from 'express';
import type { IntegrationContext } from '../../../shared/integration-types.js';
import { createLogger } from '../../utils/logger.js';
import { ILinkError } from './ilink-client.js';
import { getConfigValues, setConfigValues } from './wechat-config.js';
import {
  WeChatConnectionError,
  getWeChatConnection,
  syncWeChatConnection,
} from './wechat-connection.js';

const log = createLogger('WeChatRoutes');

export function createWeChatRoutes(ctx: IntegrationContext): Router {
  const router = Router();

  function requireConnection(res: Response): ReturnType<typeof getWeChatConnection> {
    const conn = getWeChatConnection();
    if (!conn) {
      res.status(503).json({ error: 'WeChat integration not initialized' });
      return null;
    }
    return conn;
  }

  function sendError(res: Response, err: unknown, fallbackStatus = 500): void {
    if (err instanceof WeChatConnectionError) {
      const status =
        err.code === 'already_connected' ? 409
        : err.code === 'qr_unavailable' ? 502
        : err.code === 'not_connected' ? 503
        : err.code === 'no_context_token' ? 400
        : err.code === 'rate_limited' ? 429
        : 500;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof ILinkError) {
      res.status(502).json({ error: err.message, ret: err.ret });
      return;
    }
    res.status(fallbackStatus).json({ error: err instanceof Error ? err.message : String(err) });
  }

  // ─── GET /status — connection health ───
  router.get('/status', (_req: Request, res: Response) => {
    const conn = getWeChatConnection();
    const base = { ...getConfigValues(ctx.secrets) };
    if (!conn) {
      res.status(503).json({ error: 'WeChat integration not initialized', ...base });
      return;
    }
    res.json({ ...conn.getInfo(), recentInboundCount: conn.getRecentInbound().length });
  });

  // ─── POST /login/start — fetch a QR and begin server-side polling ───
  router.post('/login/start', async (_req: Request, res: Response) => {
    const conn = requireConnection(res);
    if (!conn) return;
    try {
      const session = await conn.startLogin();
      res.json({ login: session });
    } catch (err) {
      log.error(`WeChat login/start error: ${err instanceof Error ? err.message : String(err)}`);
      sendError(res, err, 502);
    }
  });

  // ─── GET /login/status — poll the in-flight QR session ───
  router.get('/login/status', (_req: Request, res: Response) => {
    const conn = requireConnection(res);
    if (!conn) return;
    const session = conn.getLoginSession();
    res.json({
      state: conn.getInfo().state,
      login: session
        ? {
            status: session.status,
            error: session.error ?? null,
            confirmed: session.confirmed,
            imgContent: session.imgContent,
            startedAt: session.startedAt,
            deadlineAt: session.deadlineAt,
            remainingMs: Math.max(0, session.deadlineAt - Date.now()),
          }
        : null,
    });
  });

  // ─── POST /login/cancel — drop the in-flight QR session ───
  router.post('/login/cancel', (_req: Request, res: Response) => {
    const conn = requireConnection(res);
    if (!conn) return;
    conn.cancelLogin();
    res.json({ success: true, state: conn.getInfo().state });
  });

  // ─── POST /logout — clear the token and stop the loop ───
  router.post('/logout', (_req: Request, res: Response) => {
    const conn = requireConnection(res);
    if (!conn) return;
    conn.logout();
    res.json({ success: true, state: conn.getInfo().state });
  });

  // ─── GET /config — non-secret config (token never leaves the secrets store) ───
  router.get('/config', (_req: Request, res: Response) => {
    res.json(getConfigValues(ctx.secrets));
  });

  // ─── PATCH /config — update non-secret config, then reconcile the loop ───
  router.patch('/config', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      await setConfigValues(body, ctx.secrets);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    syncWeChatConnection(ctx);
    res.json(getConfigValues(ctx.secrets));
  });

  // ─── GET /recent-inbound — reply-eligible senders (tokens stay server-side) ───
  router.get('/recent-inbound', (_req: Request, res: Response) => {
    const conn = requireConnection(res);
    if (!conn) return;
    res.json({ items: conn.getRecentInbound() });
  });

  // ─── POST /send-message — reply via a context token (explicit or backfilled) ───
  router.post('/send-message', async (req: Request, res: Response) => {
    const conn = requireConnection(res);
    if (!conn) return;
    const body = (req.body ?? {}) as { to?: unknown; text?: unknown; contextToken?: unknown };
    if (typeof body.to !== 'string' || !body.to.trim()) {
      res.status(400).json({ error: 'to is required' });
      return;
    }
    if (typeof body.text !== 'string' || !body.text.trim()) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    const contextToken = typeof body.contextToken === 'string' ? body.contextToken : undefined;
    try {
      await conn.sendMessage({ toUserId: body.to.trim(), text: body.text, contextToken });
      res.json({ success: true });
    } catch (err) {
      log.error(`WeChat send-message error: ${err instanceof Error ? err.message : String(err)}`);
      sendError(res, err, 502);
    }
  });

  return router;
}
