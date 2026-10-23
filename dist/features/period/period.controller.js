"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.periodRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../../middleware/auth");
const http_1 = require("../../lib/http");
const period_repo_1 = require("./period.repo");
const period_service_1 = require("./period.service");
const refund_service_1 = require("../refund/refund.service");
const task_service_1 = require("../task/task.service");
const reward_service_1 = require("../reward/reward.service");
exports.periodRouter = (0, express_1.Router)();
/** 某入渔的全部期次（C 端进度页 / 运营查询共用） */
exports.periodRouter.get("/", (0, auth_1.auth)(), async (req, res, next) => {
    try {
        const enrollmentId = String(req.query.enrollmentId ?? "");
        if (!enrollmentId) {
            return res
                .status(400)
                .json({ ok: false, error: { code: "BAD_REQUEST", message: "缺少 enrollmentId" } });
        }
        (0, http_1.ok)(res, await (0, period_repo_1.listByEnrollment)(enrollmentId));
    }
    catch (e) {
        next(e);
    }
});
/** 运营补期：漏一周即永久损失，没有这个通道投诉无解 */
exports.periodRouter.post("/:id/extend", (0, auth_1.auth)(["OPERATOR"]), async (req, res, next) => {
    try {
        const body = zod_1.z.object({ week: zod_1.z.string().regex(/^\d{4}W\d{1,2}$/) }).parse(req.body);
        const p = await (0, period_service_1.extendPeriod)(req.params.id, body.week, req.user.userId);
        (0, http_1.ok)(res, p);
    }
    catch (e) {
        next(e);
    }
});
/** 手动补退（自动流程失败后运营重放；幂等，重复调用不会二次出账） */
exports.periodRouter.post("/:id/refund70", (0, auth_1.auth)(["OPERATOR"]), async (req, res, next) => {
    try {
        (0, http_1.ok)(res, await (0, refund_service_1.refund70)(req.params.id));
    }
    catch (e) {
        next(e);
    }
});
exports.periodRouter.post("/:id/refund30", (0, auth_1.auth)(["OPERATOR"]), async (req, res, next) => {
    try {
        (0, http_1.ok)(res, await (0, refund_service_1.refund30)(req.params.id));
    }
    catch (e) {
        next(e);
    }
});
/** 逾期作废扫描（cron 每日 00:10；幂等） */
exports.periodRouter.post("/sweep", (0, auth_1.auth)(["OPERATOR"]), async (_req, res, next) => {
    try {
        const n = await (0, period_service_1.sweepExpired)();
        (0, http_1.ok)(res, { expired: n });
    }
    catch (e) {
        next(e);
    }
});
/**
 * v2 周评估（cron 周一 00:10 跑上一 ISO 周）。
 * 停奖阶梯 pause1 → pause3 → exited 在这里真正推进；
 * 未核销期次在这里被算作未达标。
 */
exports.periodRouter.post("/evaluate", (0, auth_1.auth)(["OPERATOR"]), async (_req, res, next) => {
    try {
        const r = await (0, reward_service_1.evaluateAllWeeklyV2)();
        (0, http_1.ok)(res, r);
    }
    catch (e) {
        next(e);
    }
});
/** 手动同步某周任务数据（8100 不可达后回补） */
exports.periodRouter.post("/sync-task", (0, auth_1.auth)(["OPERATOR"]), async (req, res, next) => {
    try {
        const body = zod_1.z
            .object({
            enrollmentId: zod_1.z.string().min(1),
            userId: zod_1.z.string().min(1),
            from: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            to: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        })
            .parse(req.body);
        (0, http_1.ok)(res, await (0, task_service_1.syncRange)(body.enrollmentId, body.userId, body.from, body.to));
    }
    catch (e) {
        next(e);
    }
});
/** 退费对账：扫描长时间 pending 的流水（进程崩溃残留） */
exports.periodRouter.get("/refunds/stuck", (0, auth_1.auth)(["OPERATOR"]), async (req, res, next) => {
    try {
        const minutes = Number(req.query.minutes) || 30;
        (0, http_1.ok)(res, await (0, refund_service_1.listStuckRefunds)(minutes));
    }
    catch (e) {
        next(e);
    }
});
exports.default = exports.periodRouter;
//# sourceMappingURL=period.controller.js.map