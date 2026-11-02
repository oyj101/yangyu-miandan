import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth";
import { ok } from "../../lib/http";
import { logger } from "../../lib/logger";
import { evaluateWeek, evaluateAllWeekly, listRewards } from "./reward.service";
import {
  getRefundConfig,
  saveRefundConfig,
  refundPutSchema,
} from "./refund-config.service";

const evalSchema = z.object({
  enrollmentId: z.string().min(1),
  met: z.boolean(),
});

export const rewardRouter = Router();

// 周评估（由章鱼仔 AI 养鱼服务或定时任务调用；P0 先开放 OPERATOR 手动触发）
rewardRouter.post("/evaluate", auth(["OPERATOR"]), async (req, res, next) => {
  try {
    const { enrollmentId, met } = evalSchema.parse(req.body);
    const state = await evaluateWeek(enrollmentId, met);
    ok(res, state);
  } catch (e) {
    next(e);
  }
});

// 20261018 P1-2: 批量周评估(定时任务/运营触发)。幂等: 同入渔同周只评估一次;
// 养鱼数据不可用的入渔跳过(不惩罚, 下次重试)。
rewardRouter.post("/evaluate-all", auth(["OPERATOR"]), async (_req, res, next) => {
  try {
    const r = await evaluateAllWeekly();
    ok(res, r);
  } catch (e) {
    next(e);
  }
});

// 退款公式配置（契约 v1.0 2026-11-02）：GET 读真源 / PUT 持久化。
// 必须注册在 GET /:enrollmentId 之前，否则被通配路由吞掉。
rewardRouter.get("/refund-config", auth(["OPERATOR"]), async (_req, res, next) => {
  try {
    ok(res, await getRefundConfig());
  } catch (e) {
    next(e);
  }
});

rewardRouter.put("/refund-config", auth(["OPERATOR"]), async (req, res, next) => {
  try {
    const d = refundPutSchema.parse(req.body);
    const by = String(req.user?.userId ?? "operator");
    const saved = await saveRefundConfig(d, by);
    logger.info({ by, caliber: saved.caliber, now: saved.refundNowRatio, share: saved.refundShareRatio, streakDays: saved.streakDays }, "退款公式配置已更新");
    ok(res, saved);
  } catch (e) {
    next(e);
  }
});

rewardRouter.get("/:enrollmentId", auth(["USER", "MERCHANT", "OPERATOR"]), async (req, res, next) => {
  try {
    const list = await listRewards(req.params.enrollmentId);
    ok(res, list);
  } catch (e) {
    next(e);
  }
});

export default rewardRouter;
