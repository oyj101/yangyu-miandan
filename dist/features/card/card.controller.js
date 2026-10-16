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
exports.cardRouter = (0, express_1.Router)();
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
exports.cardRouter.get("/public", (0, auth_1.auth)(["USER", "MERCHANT", "OPERATOR", "CASHIER"]), async (_req, res, next) => {
    try {
        const cards = await svc.listPublicCards();
        (0, http_1.ok)(res, cards);
    }
    catch (e) {
        next(e);
    }
});
exports.default = exports.cardRouter;
//# sourceMappingURL=card.controller.js.map