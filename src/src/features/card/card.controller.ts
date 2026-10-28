import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth";
import { ok, created, page } from "../../lib/http";
import * as svc from "./card.service";

const createSchema = z.object({
  merchantId: z.string().min(1),
  merchantName: z.string().max(64).optional(),
  type: z.enum(["year", "times"]),
  times: z.number().int().positive(),
  freq: z.string().min(1),
  rewardPerTime: z.number().nonnegative(),
  price: z.number().nonnegative(),
  coverage: z.number().min(0).max(2).optional(),
  coverageCap: z.number().min(0).max(2).optional(),
  perMerchantQuota: z.number().int().nonnegative().optional(),
});

const reviewSchema = z.object({
  approve: z.boolean(),
  rejectReason: z.string().optional(),
});

export const cardRouter = Router();

cardRouter.post("/", auth(["MERCHANT"]), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    if (req.user!.merchantId && req.user!.merchantId !== body.merchantId) {
      return res.status(403).json({ ok: false, error: { code: "FORBIDDEN", message: "只能为自己商家申请" } });
    }
    const card = await svc.createApplication(body);
    created(res, card);
  } catch (e) {
    next(e);
  }
});

cardRouter.get("/merchant/:merchantId", auth(["MERCHANT", "OPERATOR"]), async (req, res, next) => {
  try {
    const cards = await svc.listMerchantCards(req.params.merchantId);
    ok(res, cards);
  } catch (e) {
    next(e);
  }
});

cardRouter.get("/pending", auth(["OPERATOR"]), async (_req, res, next) => {
  try {
    const cards = await svc.listPendingCards();
    ok(res, cards);
  } catch (e) {
    next(e);
  }
});

cardRouter.post("/:id/review", auth(["OPERATOR"]), async (req, res, next) => {
  try {
    const body = reviewSchema.parse(req.body);
    const card = await svc.review(req.params.id, body.approve, req.user!.userId, body.rejectReason);
    ok(res, card);
  } catch (e) {
    next(e);
  }
});

cardRouter.get("/params", auth(["OPERATOR"]), async (_req, res, next) => {
  try {
    const params = await svc.getGlobalParams();
    ok(res, params);
  } catch (e) {
    next(e);
  }
});

cardRouter.put("/params/:key", auth(["OPERATOR"]), async (req, res, next) => {
  try {
    const value = z.number().parse(req.body.value);
    const param = await svc.setGlobalParam(req.params.key, value, req.user!.userId);
    ok(res, param);
  } catch (e) {
    next(e);
  }
});

// FEDERATION_API · 联邦消费项目集合（公开，游客可访问）：跨商户聚合。
// GET /api/cards/federation?status=active|pending|offline|all&q=关键词
cardRouter.get("/federation", async (req, res, next) => {
  try {
    const status = String(req.query.status || "active");
    const q = String(req.query.q || "").trim();
    const data = await svc.listFederation(status, q);
    ok(res, data);
  } catch (e) {
    next(e);
  }
});

// [Task-213] 公开免单卡列表（C 端「拼场大厅」）：联邦登录用户可浏览已上架卡片。
cardRouter.get("/public", auth(["USER", "MERCHANT", "OPERATOR", "CASHIER"]), async (_req, res, next) => {
  try {
    const cards = await svc.listPublicCards();
    ok(res, cards);
  } catch (e) {
    next(e);
  }
});

export default cardRouter;
