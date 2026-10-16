"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rewardRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../../middleware/auth");
const http_1 = require("../../lib/http");
const reward_service_1 = require("./reward.service");
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