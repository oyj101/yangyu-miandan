import { Router } from "express";
import { auth } from "../../middleware/auth";
import { ok } from "../../lib/http";
import { badRequest } from "../../lib/errors";
import { listMessages, markRead, runNoticeScan } from "./notify.service";

export const notifyRouter = Router();

/** C 端站内消息（此前完全没有通知能力，是投诉主因） */
notifyRouter.get("/messages", auth(), async (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 50;
    ok(res, await listMessages(req.user!.userId, limit));
  } catch (e) {
    next(e);
  }
});

notifyRouter.post("/messages/:id/read", auth(), async (req, res, next) => {
  try {
    const okRead = await markRead(req.user!.userId, req.params.id);
    ok(res, { read: okRead });
  } catch (e) {
    next(e);
  }
});

/** 每日扫描（cron 09:00 / 20:00）；幂等，重复跑不重复发 */
notifyRouter.post("/scan", auth(["OPERATOR"]), async (_req, res, next) => {
  try {
    ok(res, await runNoticeScan());
  } catch (e) {
    next(e);
  }
});

export default notifyRouter;
