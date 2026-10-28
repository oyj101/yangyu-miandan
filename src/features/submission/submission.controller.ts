import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth";
import { ok, created } from "../../lib/http";
import * as svc from "./submission.service";

const createSchema = z.object({
  merchantId: z.string().min(1),
  productId: z.string().min(1),
  supplyPrice: z.number().nonnegative(),
  quota: z.number().int().positive(),
});

const reviewSchema = z.object({
  approve: z.boolean(),
  rejectReason: z.string().optional(),
});

export const submissionRouter = Router();

/** 商户提报：选商品 + 活动供应价 + 参与数量 */
submissionRouter.post("/", auth(["MERCHANT", "OPERATOR"]), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const sub = await svc.createSubmission(body, {
      role: req.user!.role as "MERCHANT" | "OPERATOR",
      merchantId: req.user!.merchantId,
    });
    created(res, sub);
  } catch (e) {
    next(e);
  }
});

/** 列提报：MERCHANT 看自己(:merchantId)；OPERATOR 看待审队列 */
submissionRouter.get("/merchant/:merchantId", auth(["MERCHANT", "OPERATOR"]), async (req, res, next) => {
  try {
    const subs = await svc.listSubmissions(req.params.merchantId, {
      role: req.user!.role,
      merchantId: req.user!.merchantId,
    });
    ok(res, subs);
  } catch (e) {
    next(e);
  }
});

submissionRouter.get("/pending", auth(["OPERATOR"]), async (_req, res, next) => {
  try {
    ok(res, await svc.listSubmissions("", { role: "OPERATOR" }));
  } catch (e) {
    next(e);
  }
});

/** OPERATOR 审核提报 */
submissionRouter.post("/:id/review", auth(["OPERATOR"]), async (req, res, next) => {
  try {
    const body = reviewSchema.parse(req.body);
    const sub = await svc.reviewSubmission(
      req.params.id,
      body.approve,
      req.user!.userId,
      body.rejectReason
    );
    ok(res, sub);
  } catch (e) {
    next(e);
  }
});

export default submissionRouter;
