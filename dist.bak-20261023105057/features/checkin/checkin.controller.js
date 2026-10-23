"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkinRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../../middleware/auth");
const http_1 = require("../../lib/http");
const reward_service_1 = require("../reward/reward.service");
const checkinSchema = zod_1.z.object({ enrollmentId: zod_1.z.string().min(1) });
exports.checkinRouter = (0, express_1.Router)();
// F5 商户客户端核销（CASHIER / OPERATOR）
exports.checkinRouter.post("/", (0, auth_1.auth)(["CASHIER", "OPERATOR"]), async (req, res, next) => {
    try {
        const { enrollmentId } = checkinSchema.parse(req.body);
        // 商户客户端账号须归属该商家；此处 merchantId 来自 token（CASHIER 绑定 merchantId）
        const merchantId = req.user.merchantId;
        if (!merchantId) {
            return res.status(403).json({ ok: false, error: { code: "FORBIDDEN", message: "客户端账号未绑定商家" } });
        }
        const result = await (0, reward_service_1.computeOnCheckin)(enrollmentId, merchantId);
        (0, http_1.created)(res, result);
    }
    catch (e) {
        next(e);
    }
});
exports.default = exports.checkinRouter;
//# sourceMappingURL=checkin.controller.js.map