import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth";
import { ok, created } from "../../lib/http";
import { computeOnCheckin } from "../reward/reward.service";
import { computeOnCheckinV2, nextPeriodHint } from "./checkin.service";
import { findEnrollment } from "../enrollment/enrollment.repo";
import { findCardById } from "../card/card.repo";

const checkinSchema = z.object({ enrollmentId: z.string().min(1) });

export const checkinRouter = Router();

/**
 * F5 商户客户端核销（CASHIER / OPERATOR）
 *
 * 分发规则（平滑迁移，存量卡不受影响）：
 *   - 套餐卡（card.periods / unit_price 已设）→ v2：一期限一次 + 连续5天 + 商户即时结算 + 退70%
 *   - 存量卡（v1，无套餐四要素）→ 旧逻辑，保持上线中的行为完全不变
 */
checkinRouter.post("/", auth(["CASHIER", "OPERATOR"]), async (req, res, next) => {
  try {
    const { enrollmentId } = checkinSchema.parse(req.body);
    const merchantId = req.user!.merchantId;
    if (!merchantId) {
      return res
        .status(403)
        .json({ ok: false, error: { code: "FORBIDDEN", message: "客户端账号未绑定商家" } });
    }

    const e = await findEnrollment(enrollmentId);
    const card = e ? await findCardById(e.cardId) : null;
    const isPackageCard = !!(card && card.periods != null && card.unitPrice != null);

    const result = isPackageCard
      ? await computeOnCheckinV2(enrollmentId, merchantId)
      : await computeOnCheckin(enrollmentId, merchantId);

    created(res, result);
  } catch (e) {
    next(e);
  }
});

/** C 端：本期进度与两个死线（最晚开始日 / 核销截止日） */
checkinRouter.get("/period-hint", auth(), async (req, res, next) => {
  try {
    const enrollmentId = String(req.query.enrollmentId ?? "");
    if (!enrollmentId) {
      return res
        .status(400)
        .json({ ok: false, error: { code: "BAD_REQUEST", message: "缺少 enrollmentId" } });
    }
    const hint = await nextPeriodHint(enrollmentId);
    ok(res, hint);
  } catch (e) {
    next(e);
  }
});

export default checkinRouter;
