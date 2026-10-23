"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkinRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../../middleware/auth");
const http_1 = require("../../lib/http");
const reward_service_1 = require("../reward/reward.service");
const checkin_service_1 = require("./checkin.service");
const enrollment_repo_1 = require("../enrollment/enrollment.repo");
const card_repo_1 = require("../card/card.repo");
const checkinSchema = zod_1.z.object({ enrollmentId: zod_1.z.string().min(1) });
exports.checkinRouter = (0, express_1.Router)();
/**
 * F5 商户客户端核销（CASHIER / OPERATOR）
 *
 * 分发规则（平滑迁移，存量卡不受影响）：
 *   - 套餐卡（card.periods / unit_price 已设）→ v2：一期限一次 + 连续5天 + 商户即时结算 + 退70%
 *   - 存量卡（v1，无套餐四要素）→ 旧逻辑，保持上线中的行为完全不变
 */
exports.checkinRouter.post("/", (0, auth_1.auth)(["CASHIER", "OPERATOR"]), async (req, res, next) => {
    try {
        const { enrollmentId } = checkinSchema.parse(req.body);
        const merchantId = req.user.merchantId;
        if (!merchantId) {
            return res
                .status(403)
                .json({ ok: false, error: { code: "FORBIDDEN", message: "客户端账号未绑定商家" } });
        }
        const e = await (0, enrollment_repo_1.findEnrollment)(enrollmentId);
        const card = e ? await (0, card_repo_1.findCardById)(e.cardId) : null;
        const isPackageCard = !!(card && card.periods != null && card.unitPrice != null);
        const result = isPackageCard
            ? await (0, checkin_service_1.computeOnCheckinV2)(enrollmentId, merchantId)
            : await (0, reward_service_1.computeOnCheckin)(enrollmentId, merchantId);
        (0, http_1.created)(res, result);
    }
    catch (e) {
        next(e);
    }
});
/** C 端：本期进度与两个死线（最晚开始日 / 核销截止日） */
exports.checkinRouter.get("/period-hint", (0, auth_1.auth)(), async (req, res, next) => {
    try {
        const enrollmentId = String(req.query.enrollmentId ?? "");
        if (!enrollmentId) {
            return res
                .status(400)
                .json({ ok: false, error: { code: "BAD_REQUEST", message: "缺少 enrollmentId" } });
        }
        const hint = await (0, checkin_service_1.nextPeriodHint)(enrollmentId);
        (0, http_1.ok)(res, hint);
    }
    catch (e) {
        next(e);
    }
});
exports.default = exports.checkinRouter;
//# sourceMappingURL=checkin.controller.js.map