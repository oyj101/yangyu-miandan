import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth";
import { ok, created } from "../../lib/http";
import { forbidden } from "../../lib/errors";
import * as svc from "./enrollment.service";

const receiverSchema = z.object({
  name: z.string().min(1).max(64),
  phone: z.string().min(6).max(32),
  address: z.string().min(5).max(255),
});

const purchaseSchema = z.object({
  cardId: z.string().min(1),
  pay: z.boolean().optional(),
  channel: z.string().optional(),
  openid: z.string().optional(),
  /** 履约方式：缺省 pickup（存量行为不变） */
  fulfillMode: z.enum(["pickup", "delivery"]).optional(),
  /** 配送收货信息；fulfillMode=delivery 时必填 */
  receiver: receiverSchema.optional(),
});

const fulfillSchema = z.object({
  mode: z.enum(["pickup", "delivery"]),
  receiver: receiverSchema.optional(),
});

export const enrollmentRouter = Router();

enrollmentRouter.post("/purchase", auth(["USER"]), async (req, res, next) => {
  try {
    const body = purchaseSchema.parse(req.body);
    const cardId = body.cardId;
    const e = await svc.purchase(req.user!.userId, cardId, {
      pay: body.pay,
      channel: body.channel,
      openid: body.openid,
      fulfillMode: body.fulfillMode,
      receiver: body.receiver,
    });
    /**
     * 分享判定不再挂在「购买」上（2026-10-21 第三代口径）：
     *   尾款归属由分享绑定（share_bind）决定，绑定发生在被分享者开链接那一刻，
     *   与"谁买了什么"无关。购买时再判一次会与绑定口径打架，也可能给同一个人发两份。
     *   这里只为存量 v1 卡保留旧的转介绍逻辑（它没有 share_bind 通道）。
     */
    import("../card/card.repo")
      .then(async (m) => {
        const card = await m.findCardById(cardId);
        const isPackage = !!(card && card.periods != null && card.unitPrice != null);
        if (isPackage) return null; // 套餐卡：由绑定通路处理
        const rw = await import("../reward/reward.service");
        return rw.triggerIntroBonus(req.user!.userId, cardId);
      })
      .catch((err) => console.error("[share] trigger failed", err?.message));
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

/**
 * 配送分支（009）：切换履约方式（自提 ↔ 配送）。
 * 运营可代改（byOperator）；用户只能改自己的。
 * 已有发货/签收期次时不允许退回自提——实物已经在路上。
 */
enrollmentRouter.patch("/:id/fulfill", auth(["USER", "OPERATOR"]), async (req, res, next) => {
  try {
    const body = fulfillSchema.parse(req.body ?? {});
    const byOperator =
      req.user!.role === "OPERATOR" && req.user!.userId !== (await svc.getEnrollmentUserId(req.params.id));
    const e = await svc.setFulfillMode(req.user!.userId, req.params.id, body.mode, body.receiver, {
      byOperator,
    });
    ok(res, e);
  } catch (e2) {
    next(e2);
  }
});

/** 配送分支（009）：运费补付 / 重新下单（幂等，已付直接返回） */
enrollmentRouter.post("/:id/freight/pay", auth(["USER"]), async (req, res, next) => {
  try {
    const r = await svc.payFreight(req.user!.userId, req.params.id, {
      channel: req.body?.channel,
      openid: req.body?.openid,
    });
    ok(res, r);
  } catch (e2) {
    next(e2);
  }
});

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
