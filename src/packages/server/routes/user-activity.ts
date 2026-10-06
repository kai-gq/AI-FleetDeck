/**
 * W13 前置 · 用户活动上报路由
 *
 * 用途：客户端把「用户在本机干了什么（粗粒度）」上报给服务端活动账
 * （services/user-activity-service），供播报时机 / 时间感知（起床问候、
 * 主动汇报是否开口）判断「用户是否在场」。
 *
 *   POST /api/user-activity/report  { kind }  上报一次活动
 *   GET  /api/user-activity/status            读当前快照（最近活动 / 最近说话）
 *
 * 隐私口径：只接受 kind（粗粒度类别），**不接受客户端时间戳**（服务端取时，
 * 防伪造/防客户端时钟漂移污染），更不接受任何输入内容；快照只有三个
 * 时间/类别字段。
 *
 * voice-turn（用户说话）是服务端内部专用：由 voice-companion 路由在用户回合
 * 成功后登记；客户端上报一律 400 —— 防止客户端伪造「用户刚说过话」影响播报时机。
 */

import { Router, Request, Response } from 'express';
import { getUserActivitySnapshot, noteUserActivity } from '../services/user-activity-service.js';
import { createLogger } from '../utils/index.js';

const router = Router();
const log = createLogger('UserActivity');

/** 客户端允许上报的 kind 白名单（voice-turn 不收，见文件头）。 */
const CLIENT_KINDS = ['voice-page', 'focus', 'input'] as const;

/**
 * 稳定错误码：客户端按 code 做中文映射；error 保留英文原文兼容。
 *   400 INVALID_KIND
 *   500 INTERNAL
 */
const ERROR_CODE = {
  INVALID_KIND: 'INVALID_KIND',
  INTERNAL: 'INTERNAL',
} as const;

function isClientKind(value: unknown): value is (typeof CLIENT_KINDS)[number] {
  return typeof value === 'string' && (CLIENT_KINDS as readonly string[]).includes(value);
}

/**
 * POST /api/user-activity/report  { kind }
 * 不接受客户端时间戳：body 里的 at/timestamp 等字段一律忽略，服务端取时。
 */
router.post('/report', (req: Request, res: Response) => {
  try {
    const { kind } = req.body ?? {};
    if (!isClientKind(kind)) {
      return res.status(400).json({ error: 'Invalid kind', code: ERROR_CODE.INVALID_KIND });
    }
    noteUserActivity(kind);
    res.json({ success: true });
  } catch (err) {
    // noteUserActivity 内部保证不上抛；此处仅兜底意外（如 body 非常规输入）
    log.warn(`[UserActivity] 上报失败: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'activity report failed', code: ERROR_CODE.INTERNAL });
  }
});

/**
 * GET /api/user-activity/status
 */
router.get('/status', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, activity: getUserActivitySnapshot() });
  } catch (err) {
    log.warn(`[UserActivity] 快照读取失败: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'activity status unavailable', code: ERROR_CODE.INTERNAL });
  }
});

export default router;
