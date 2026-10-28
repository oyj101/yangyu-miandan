import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth";
import { ok, created } from "../../lib/http";
import { forbidden } from "../../lib/errors";
import * as svc from "./enrollment.service";

const purchaseSchema = z.object({ cardId: z.string().min(1), pay: z.boolean().optional(), channel: z.string().optional(), openid: z.string().optional() });

export const enrollmentRouter = Router();

enrollmentRouter.post("/purchase", auth(["USER"]), async (req, res, next) => {
  try {
    const body = purchaseSchema.parse(req.body);
    const cardId = body.cardId;
    const e = await svc.purchase(req.user!.userId, cardId, { pay: body.pay, channel: body.channel, openid: body.openid });
    // 20261017 转介绍30%触发(异fire-and-forget, 不阻塞购卡响应)
    import("../reward/reward.service").then((m) => m.triggerIntroBonus(req.user!.userId, cardId))
      .catch((err) => console.error("[intro] trigger failed", err?.message));
    created(res, e);
  } catch (e2) {
    next(e2);
  }
});

// [Task-213] 我的入渔列表（C 端「我的免单」）：须置于 GET /:id 之前，
// 否则 /me 会被 :id 路由捕获为 id="me" 导致 404。
// 20261017 退款: 30%前~70%内且无违规, 随时退, 扣所有奖励。
// 通道(PO): balance=退到余额(即时); original=微信原路退(支付接入后执行)。运营后台(OPERATOR)可选通道代退。
enrollmentRouter.post(
  "/:id/refund",
  auth(["USER", "OPERATOR"]),
  async (req, res, next) => {
    try {
      const channel = req.body?.channel === "original" ? "original" : "balance";
      const byOperator = req.user!.role === "OPERATOR" && req.user!.userId !== (await svc.getEnrollmentUserId(req.params.id));
      const r = await svc.refundEnrollment(req.user!.userId, req.params.id, { channel, byOperator });
      ok(res, r);
    } catch (e2) {
      next(e2);
    }
  }
);

// 20261017 支付完成后由前端调用: 向统一支付真源查单并同步本地(也可由核销前自动同步兜底)
enrollmentRouter.post(
  "/:id/pay-sync",
  auth(["USER", "OPERATOR"]),
  async (req, res, next) => {
    try {
      const st = await svc.syncPayStatus(req.params.id);
      ok(res, { payStatus: st });
    } catch (e2) {
      next(e2);
    }
  }
);

enrollmentRouter.get(
  "/me",
  auth(["USER", "MERCHANT", "OPERATOR", "CASHIER"]),
  async (req, res, next) => {
    try {
      const list = await svc.listUserEnrollments(req.user!.userId);
      ok(res, list);
    } catch (e2) {
      next(e2);
    }
  }
);

enrollmentRouter.get("/:id", auth(["USER", "MERCHANT", "OPERATOR", "CASHIER"]), async (req, res, next) => {
  try {
    const e = await svc.getEnrollment(req.params.id);
    // 20261018 P0-2 水平越权防护: 仅本人 / 归属商户(含该商户收银员) / 运营 可查看详情
    const u = req.user!;
    const isOwner = e.userId === u.userId;
    const isStaffOfIt =
      !!u.merchantId &&
      e.merchantId === u.merchantId &&
      (u.role === "MERCHANT" || u.role === "CASHIER");
    const isOperator = u.role === "OPERATOR";
    if (!isOwner && !isStaffOfIt && !isOperator) throw forbidden("无权查看该入渔记录");
    ok(res, e);
  } catch (e2) {
    next(e2);
  }
});

// F7 任务名单集合页（商户侧）
enrollmentRouter.get(
  "/merchant/:merchantId",
  auth(["MERCHANT", "OPERATOR", "CASHIER"]),
  async (req, res, next) => {
    try {
      // 20261018 P0-2 水平越权防护: 商户/收银员仅可查本商户名单(含 userId/发放金额), 运营不限
      const u = req.user!;
      const isStaffOfIt =
        !!u.merchantId &&
        u.merchantId === req.params.merchantId &&
        (u.role === "MERCHANT" || u.role === "CASHIER");
      const isOperator = u.role === "OPERATOR";
      if (!isStaffOfIt && !isOperator) throw forbidden("无权查看该商户的入渔名单");
      const statusFilter = req.query.status as string | undefined;
      const list = await svc.listMerchantEnrollments(req.params.merchantId, statusFilter);
      ok(res, list);
    } catch (e2) {
      next(e2);
    }
  }
);

export default enrollmentRouter;
