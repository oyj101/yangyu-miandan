"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.cardRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../../middleware/auth");
const http_1 = require("../../lib/http");
const svc = __importStar(require("./card.service"));
const createSchema = zod_1.z.object({
    merchantId: zod_1.z.string().min(1),
    type: zod_1.z.enum(["year", "times"]),
    times: zod_1.z.number().int().positive(),
    freq: zod_1.z.string().min(1),
    rewardPerTime: zod_1.z.number().nonnegative(),
    price: zod_1.z.number().nonnegative(),
    coverage: zod_1.z.number().min(0).max(2).optional(),
    coverageCap: zod_1.z.number().min(0).max(2).optional(),
    perMerchantQuota: zod_1.z.number().int().nonnegative().optional(),
});
const reviewSchema = zod_1.z.object({
    approve: zod_1.z.boolean(),
    rejectReason: zod_1.z.string().optional(),
});
// v2：平台设计套餐卡（商户不定价）
const designSchema = zod_1.z.object({
    merchantId: zod_1.z.string().min(1),
    unitPrice: zod_1.z.number().positive(),
    periods: zod_1.z.number().int().positive(),
    supplyPrice: zod_1.z.number().nonnegative(),
    suppliesName: zod_1.z.string().min(1).max(120),
    // 集合页展示三件套：名称/卖点/商户名。缺省时 title 回落 suppliesName。
    title: zod_1.z.string().max(120).optional(),
    subtitle: zod_1.z.string().max(255).nullish(),
    merchantName: zod_1.z.string().max(120).nullish(),
    freq: zod_1.z.string().optional(),
    category: zod_1.z.string().max(32).nullable().optional(),
    coverUrl: zod_1.z.string().max(512).nullable().optional(),
    sortWeight: zod_1.z.number().int().optional(),
    coverageCap: zod_1.z.number().min(0).max(2).optional(),
    /** 每卡独立分享分成（0~0.5）；不传取全局缺省 */
    shareRatio: zod_1.z.number().min(0).max(0.5).optional(),
    /** 履约能力：缺省 pickup（仅到店自提） */
    fulfillment: zod_1.z.enum(["pickup", "delivery", "both"]).optional(),
    /** 配送到家每期运费；缺省 0 */
    deliveryFee: zod_1.z.number().nonnegative().optional(),
    /** 商品库选品：直接关联商品（与 submissionId 二选一） */
    productId: zod_1.z.string().min(1).nullish(),
    /** 商品库选品：取某条已审核通过的提报（优先；自动带出 supplyPrice/quota/商品名/封面） */
    submissionId: zod_1.z.string().min(1).nullish(),
    /** 可售份数上限（传 submissionId 时取 quota，无需再传） */
    stock: zod_1.z.number().int().nonnegative().nullish(),
    forceRisk: zod_1.z.boolean().optional(),
});
exports.cardRouter = (0, express_1.Router)();
exports.cardRouter.post("/design", (0, auth_1.auth)(["OPERATOR"]), async (req, res, next) => {
    try {
        const body = designSchema.parse(req.body);
        const card = await svc.designPackageCard(body, req.user.userId, {
            forceRisk: !!body.forceRisk,
        });
        (0, http_1.created)(res, card);
    }
    catch (e) {
        next(e);
    }
});
exports.cardRouter.get("/exposure", (0, auth_1.auth)(["OPERATOR"]), async (_req, res, next) => {
    try {
        (0, http_1.ok)(res, await svc.budgetExposure());
    }
    catch (e) {
        next(e);
    }
});
exports.cardRouter.post("/", (0, auth_1.auth)(["MERCHANT"]), async (req, res, next) => {
    try {
        const body = createSchema.parse(req.body);
        if (req.user.merchantId && req.user.merchantId !== body.merchantId) {
            return res.status(403).json({ ok: false, error: { code: "FORBIDDEN", message: "只能为自己商家申请" } });
        }
        const card = await svc.createApplication(body);
        (0, http_1.created)(res, card);
    }
    catch (e) {
        next(e);
    }
});
exports.cardRouter.get("/merchant/:merchantId", (0, auth_1.auth)(["MERCHANT", "OPERATOR"]), async (req, res, next) => {
    try {
        const cards = await svc.listMerchantCards(req.params.merchantId);
        (0, http_1.ok)(res, cards);
    }
    catch (e) {
        next(e);
    }
});
exports.cardRouter.get("/pending", (0, auth_1.auth)(["OPERATOR"]), async (_req, res, next) => {
    try {
        const cards = await svc.listPendingCards();
        (0, http_1.ok)(res, cards);
    }
    catch (e) {
        next(e);
    }
});
exports.cardRouter.post("/:id/review", (0, auth_1.auth)(["OPERATOR"]), async (req, res, next) => {
    try {
        const body = reviewSchema.parse(req.body);
        const card = await svc.review(req.params.id, body.approve, req.user.userId, body.rejectReason);
        (0, http_1.ok)(res, card);
    }
    catch (e) {
        next(e);
    }
});
exports.cardRouter.get("/params", (0, auth_1.auth)(["OPERATOR"]), async (_req, res, next) => {
    try {
        const params = await svc.getGlobalParams();
        (0, http_1.ok)(res, params);
    }
    catch (e) {
        next(e);
    }
});
exports.cardRouter.put("/params/:key", (0, auth_1.auth)(["OPERATOR"]), async (req, res, next) => {
    try {
        const value = zod_1.z.number().parse(req.body.value);
        const param = await svc.setGlobalParam(req.params.key, value, req.user.userId);
        (0, http_1.ok)(res, param);
    }
    catch (e) {
        next(e);
    }
});
// [Task-213] 公开免单卡列表（C 端「拼场大厅」）：联邦登录用户可浏览已上架卡片。
// 原先直接返回 Card 实体，等于把 supply_price（商户供应价）发给所有登录用户 ——
// 商户拿到这个数就能算出平台每期毛利并压价。此处收敛为白名单投影。
exports.cardRouter.get("/public", (0, auth_1.auth)(["USER", "MERCHANT", "OPERATOR", "CASHIER"]), async (_req, res, next) => {
    try {
        const cards = await svc.listPublicCards();
        (0, http_1.ok)(res, cards.map((c) => ({
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
        })));
    }
    catch (e) {
        next(e);
    }
});
exports.default = exports.cardRouter;
//# sourceMappingURL=card.controller.js.map