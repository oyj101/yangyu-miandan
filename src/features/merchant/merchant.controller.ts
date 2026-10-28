import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth";
import { ok } from "../../lib/http";
import { badRequest } from "../../lib/errors";
import { clawbackCheckin, getAccount, listNegativeAccounts } from "./merchant.service";

export const merchantRouter = Router();

/** 商户结算账户（含负余额：为负即欠平台，下期结算自动抵扣） */
merchantRouter.get("/:merchantId/account", auth(["MERCHANT", "OPERATOR"]), async (req, res, next) => {
  try {
    const mid = req.params.merchantId;
    if (req.user!.role === "MERCHANT" && req.user!.merchantId && req.user!.merchantId !== mid) {
      return res
        .status(403)
        .json({ ok: false, error: { code: "FORBIDDEN", message: "只能查看自己商家账户" } });
    }
    ok(res, await getAccount(mid));
  } catch (e) {
    next(e);
  }
});

/** 欠款商户清单：欠款长期不还要先暂停上架，避免继续扩大敞口 */
merchantRouter.get("/negative", auth(["OPERATOR"]), async (_req, res, next) => {
  try {
    ok(res, await listNegativeAccounts());
  } catch (e) {
    next(e);
  }
});

/**
 * 撤销核销 → 向商户追回供应价（形成负余额，下期抵扣）。
 * 仅用于核销有误/判定作弊；用户达标退费属平台补贴，不走这个端点。
 */
merchantRouter.post("/clawback", auth(["OPERATOR"]), async (req, res, next) => {
  try {
    const body = z
      .object({
        periodId: z.string().min(1),
        checkinId: z.string().min(1),
        reason: z.string().min(2).max(200),
      })
      .parse(req.body);
    const r = await clawbackCheckin(
      body.periodId,
      body.checkinId,
      body.reason,
      req.user!.userId
    );
    ok(res, r);
  } catch (e) {
    next(e);
  }
});

export default merchantRouter;
