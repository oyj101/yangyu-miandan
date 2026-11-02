"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rewardRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../../middleware/auth");
const http_1 = require("../../lib/http");
const logger_1 = require("../../lib/logger");
const reward_service_1 = require("./reward.service");
const refund_config_service_1 = require("./refund-config.service");
const evalSchema = zod_1.z.object({
    enrollmentId: zod_1.z.string().min(1),
    met: zod_1.z.boolean(),
});
exports.rewardRouter = (0, express_1.Router)();
// 周评估（由章鱼仔 AI 养鱼服务或定时任务调用；P0 先开放 OPERATOR 手动触发）
exports.rewardRouter.post("/evaluate", (0, auth_1.auth)(["OPERATOR"]), async (req, res, next) => {
    try {
        const { enrollmentId, met } = evalSchema.parse(req.body);
        const state = await (0, reward_service_1.evaluateWeek)(enrollmentId, met);
        (0, http_1.ok)(res, state);
    }
    catch (e) {
        next(e);
    }
});
// 20261018 P1-2: 批量周评估(定时任务/运营触发)。幂等: 同入渔同周只评估一次;
// 养鱼数据不可用的入渔跳过(不惩罚, 下次重试)。
exports.rewardRouter.post("/evaluate-all", (0, auth_1.auth)(["OPERATOR"]), async (_req, res, next) => {
    try {
        const r = await (0, reward_service_1.evaluateAllWeekly)();
        (0, http_1.ok)(res, r);
    }
    catch (e) {
        next(e);
    }
});
// 退款公式配置（契约 v1.0 2026-11-02）：GET 读真源 / PUT 持久化。
// 必须注册在 GET /:enrollmentId 之前，否则被通配路由吞掉。
exports.rewardRouter.get("/refund-config", (0, auth_1.auth)(["OPERATOR"]), async (_req, res, next) => {
    try {
        (0, http_1.ok)(res, await (0, refund_config_service_1.getRefundConfig)());
    }
    catch (e) {
        next(e);
    }
});
exports.rewardRouter.put("/refund-config", (0, auth_1.auth)(["OPERATOR"]), async (req, res, next) => {
    try {
        const d = refund_config_service_1.refundPutSchema.parse(req.body);
        const by = String(req.user?.userId ?? "operator");
        const saved = await (0, refund_config_service_1.saveRefundConfig)(d, by);
        logger_1.logger.info({ by, caliber: saved.caliber, now: saved.refundNowRatio, share: saved.refundShareRatio, streakDays: saved.streakDays }, "退款公式配置已更新");
        (0, http_1.ok)(res, saved);
    }
    catch (e) {
        next(e);
    }
});
exports.rewardRouter.get("/:enrollmentId", (0, auth_1.auth)(["USER", "MERCHANT", "OPERATOR"]), async (req, res, next) => {
    try {
        const list = await (0, reward_service_1.listRewards)(req.params.enrollmentId);
        (0, http_1.ok)(res, list);
    }
    catch (e) {
        next(e);
    }
});
exports.default = exports.rewardRouter;
//# sourceMappingURL=reward.controller.js.map