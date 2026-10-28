import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth";
import { ok, created } from "../../lib/http";
import { computeOnCheckin } from "../reward/reward.service";

const checkinSchema = z.object({ enrollmentId: z.string().min(1) });

export const checkinRouter = Router();

// F5 商户客户端核销（CASHIER / OPERATOR）
checkinRouter.post("/", auth(["CASHIER", "OPERATOR"]), async (req, res, next) => {
  try {
    const { enrollmentId } = checkinSchema.parse(req.body);
    // 商户客户端账号须归属该商家；此处 merchantId 来自 token（CASHIER 绑定 merchantId）
    const merchantId = req.user!.merchantId;
    if (!merchantId) {
      return res.status(403).json({ ok: false, error: { code: "FORBIDDEN", message: "客户端账号未绑定商家" } });
    }
    const result = await computeOnCheckin(enrollmentId, merchantId);
    created(res, result);
  } catch (e) {
    next(e);
  }
});

export default checkinRouter;
