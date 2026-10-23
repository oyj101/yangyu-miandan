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
exports.enrollmentRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../../middleware/auth");
const http_1 = require("../../lib/http");
const errors_1 = require("../../lib/errors");
const svc = __importStar(require("./enrollment.service"));
const purchaseSchema = zod_1.z.object({ cardId: zod_1.z.string().min(1), pay: zod_1.z.boolean().optional(), channel: zod_1.z.string().optional(), openid: zod_1.z.string().optional() });
exports.enrollmentRouter = (0, express_1.Router)();
exports.enrollmentRouter.post("/purchase", (0, auth_1.auth)(["USER"]), async (req, res, next) => {
    try {
        const body = purchaseSchema.parse(req.body);
        const cardId = body.cardId;
        const e = await svc.purchase(req.user.userId, cardId, { pay: body.pay, channel: body.channel, openid: body.openid });
        /**
         * 分享判定不再挂在「购买」上（2026-10-21 第三代口径）：
         *   尾款归属由分享绑定（share_bind）决定，绑定发生在被分享者开链接那一刻，
         *   与"谁买了什么"无关。购买时再判一次会与绑定口径打架，也可能给同一个人发两份。
         *   这里只为存量 v1 卡保留旧的转介绍逻辑（它没有 share_bind 通道）。
         */
        Promise.resolve().then(() => __importStar(require("../card/card.repo"))).then(async (m) => {
            const card = await m.findCardById(cardId);
            const isPackage = !!(card && card.periods != null && card.unitPrice != null);
            if (isPackage)
                return null; // 套餐卡：由绑定通路处理
            const rw = await Promise.resolve().then(() => __importStar(require("../reward/reward.service")));
            return rw.triggerIntroBonus(req.user.userId, cardId);
        })
            .catch((err) => console.error("[share] trigger failed", err?.message));
        (0, http_1.created)(res, e);
    }
    catch (e2) {
        next(e2);
    }
});
// [Task-213] 我的入渔列表（C 端「我的免单」）：须置于 GET /:id 之前，
// 否则 /me 会被 :id 路由捕获为 id="me" 导致 404。
// 20261017 退款: 30%前~70%内且无违规, 随时退, 扣所有奖励。
// 通道(PO): balance=退到余额(即时); original=微信原路退(支付接入后执行)。运营后台(OPERATOR)可选通道代退。
exports.enrollmentRouter.post("/:id/refund", (0, auth_1.auth)(["USER", "OPERATOR"]), async (req, res, next) => {
    try {
        const channel = req.body?.channel === "original" ? "original" : "balance";
        const byOperator = req.user.role === "OPERATOR" && req.user.userId !== (await svc.getEnrollmentUserId(req.params.id));
        const r = await svc.refundEnrollment(req.user.userId, req.params.id, { channel, byOperator });
        (0, http_1.ok)(res, r);
    }
    catch (e2) {
        next(e2);
    }
});
exports.enrollmentRouter.get("/me", (0, auth_1.auth)(["USER", "MERCHANT", "OPERATOR", "CASHIER"]), async (req, res, next) => {
    try {
        const list = await svc.listUserEnrollments(req.user.userId);
        (0, http_1.ok)(res, list);
    }
    catch (e2) {
        next(e2);
    }
});
exports.enrollmentRouter.get("/:id", (0, auth_1.auth)(["USER", "MERCHANT", "OPERATOR", "CASHIER"]), async (req, res, next) => {
    try {
        const e = await svc.getEnrollment(req.params.id);
        // 20261018 P0-2 水平越权防护: 仅本人 / 归属商户(含该商户收银员) / 运营 可查看详情
        const u = req.user;
        const isOwner = e.userId === u.userId;
        const isStaffOfIt = !!u.merchantId &&
            e.merchantId === u.merchantId &&
            (u.role === "MERCHANT" || u.role === "CASHIER");
        const isOperator = u.role === "OPERATOR";
        if (!isOwner && !isStaffOfIt && !isOperator)
            throw (0, errors_1.forbidden)("无权查看该入渔记录");
        (0, http_1.ok)(res, e);
    }
    catch (e2) {
        next(e2);
    }
});
// F7 任务名单集合页（商户侧）
exports.enrollmentRouter.get("/merchant/:merchantId", (0, auth_1.auth)(["MERCHANT", "OPERATOR", "CASHIER"]), async (req, res, next) => {
    try {
        // 20261018 P0-2 水平越权防护: 商户/收银员仅可查本商户名单(含 userId/发放金额), 运营不限
        const u = req.user;
        const isStaffOfIt = !!u.merchantId &&
            u.merchantId === req.params.merchantId &&
            (u.role === "MERCHANT" || u.role === "CASHIER");
        const isOperator = u.role === "OPERATOR";
        if (!isStaffOfIt && !isOperator)
            throw (0, errors_1.forbidden)("无权查看该商户的入渔名单");
        const statusFilter = req.query.status;
        const list = await svc.listMerchantEnrollments(req.params.merchantId, statusFilter);
        (0, http_1.ok)(res, list);
    }
    catch (e2) {
        next(e2);
    }
});
exports.default = exports.enrollmentRouter;
//# sourceMappingURL=enrollment.controller.js.map