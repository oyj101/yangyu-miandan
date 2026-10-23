"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.merchantRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../../middleware/auth");
const http_1 = require("../../lib/http");
const merchant_service_1 = require("./merchant.service");
exports.merchantRouter = (0, express_1.Router)();
/** 商户结算账户（含负余额：为负即欠平台，下期结算自动抵扣） */
exports.merchantRouter.get("/:merchantId/account", (0, auth_1.auth)(["MERCHANT", "OPERATOR"]), async (req, res, next) => {
    try {
        const mid = req.params.merchantId;
        if (req.user.role === "MERCHANT" && req.user.merchantId && req.user.merchantId !== mid) {
            return res
                .status(403)
                .json({ ok: false, error: { code: "FORBIDDEN", message: "只能查看自己商家账户" } });
        }
        (0, http_1.ok)(res, await (0, merchant_service_1.getAccount)(mid));
    }
    catch (e) {
        next(e);
    }
});
/** 欠款商户清单：欠款长期不还要先暂停上架，避免继续扩大敞口 */
exports.merchantRouter.get("/negative", (0, auth_1.auth)(["OPERATOR"]), async (_req, res, next) => {
    try {
        (0, http_1.ok)(res, await (0, merchant_service_1.listNegativeAccounts)());
    }
    catch (e) {
        next(e);
    }
});
/**
 * 撤销核销 → 向商户追回供应价（形成负余额，下期抵扣）。
 * 仅用于核销有误/判定作弊；用户达标退费属平台补贴，不走这个端点。
 */
exports.merchantRouter.post("/clawback", (0, auth_1.auth)(["OPERATOR"]), async (req, res, next) => {
    try {
        const body = zod_1.z
            .object({
            periodId: zod_1.z.string().min(1),
            checkinId: zod_1.z.string().min(1),
            reason: zod_1.z.string().min(2).max(200),
        })
            .parse(req.body);
        const r = await (0, merchant_service_1.clawbackCheckin)(body.periodId, body.checkinId, body.reason, req.user.userId);
        (0, http_1.ok)(res, r);
    }
    catch (e) {
        next(e);
    }
});
exports.default = exports.merchantRouter;
//# sourceMappingURL=merchant.controller.js.map