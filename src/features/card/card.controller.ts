import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth";
import { ok, created, page } from "../../lib/http";
import * as svc from "./card.service";

const createSchema = z.object({
  merchantId: z.string().min(1),
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

// v2：平台设计套餐卡（商户不定价）
const designSchema = z.object({
  merchantId: z.string().min(1),
  unitPrice: z.number().positive(),
  periods: z.number().int().positive(),
  supplyPrice: z.number().nonnegative(),
  suppliesName: z.string().min(1).max(120),
  // 集合页展示三件套：名称/卖点/商户名。缺省时 title 回落 suppliesName。
  title: z.string().max(120).optional(),
  subtitle: z.string().max(255).nullish(),
  merchantName: z.string().max(120).nullish(),
  freq: z.string().optional(),
  category: z.string().max(32).nullable().optional(),
  coverUrl: z.string().max(512).nullable().optional(),
  sortWeight: z.number().int().optional(),
  coverageCap: z.number().min(0).max(2).optional(),
  /** 每卡独立分享分成（0~0.5）；不传取全局缺省 */
  shareRatio: z.number().min(0).max(0.5).optional(),
  /** 履约能力：缺省 pickup（仅到店自提） */
  fulfillment: z.enum(["pickup", "delivery", "both"]).optional(),
  /** 配送到家每期运费；缺省 0 */
  deliveryFee: z.number().nonnegative().optional(),
  /** 商品库选品：直接关联商品（与 submissionId 二选一） */
  productId: z.string().min(1).nullish(),
  /** 商品库选品：取某条已审核通过的提报（优先；自动带出 supplyPrice/quota/商品名/封面） */
  submissionId: z.string().min(1).nullish(),
  /** 可售份数上限（传 submissionId 时取 quota，无需再传） */
  stock: z.number().int().nonnegative().nullish(),
  forceRisk: z.boolean().optional(),
});

export const cardRouter = Router();

cardRouter.post("/design", auth(["OPERATOR"]), async (req, res, next) => {
  try {
    const body = designSchema.parse(req.body);
    const card = await svc.designPackageCard(body, req.user!.userId, {
      forceRisk: !!body.forceRisk,
    });
    created(res, card);
  } catch (e) {
    next(e);
  }
});

cardRouter.get("/exposure", auth(["OPERATOR"]), async (_req, res, next) => {
  try {
    ok(res, await svc.budgetExposure());
  } catch (e) {
    next(e);
  }
});

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

// [Task-213] 公开免单卡列表（C 端「拼场大厅」）：联邦登录用户可浏览已上架卡片。
// 原先直接返回 Card 实体，等于把 supply_price（商户供应价）发给所有登录用户 ——
// 商户拿到这个数就能算出平台每期毛利并压价。此处收敛为白名单投影。
cardRouter.get("/public", auth(["USER", "MERCHANT", "OPERATOR", "CASHIER"]), async (_req, res, next) => {
  try {
    const cards = await svc.listPublicCards();
    ok(
      res,
      cards.map((c) => ({
        id: c.id,
        title: c.title,
        subtitle: c.subtitle,
        merchantName: c.merchantName,
        merchantId: c.merchantId,
        category: c.category,
        coverUrl: c.coverUrl,
        unitPrice: c.unitPrice,
        periods: c.periods,
        price: c.price,
        shareRatio: c.shareRatio,
        soldCount: null,
        listedAt: c.listedAt,
      }))
    );
  } catch (e) {
    next(e);
  }
});

export default cardRouter;
