"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../../middleware/auth");
const http_1 = require("../../lib/http");
const notify_service_1 = require("./notify.service");
exports.notifyRouter = (0, express_1.Router)();
/** C 端站内消息（此前完全没有通知能力，是投诉主因） */
exports.notifyRouter.get("/messages", (0, auth_1.auth)(), async (req, res, next) => {
    try {
        const limit = Number(req.query.limit) || 50;
        (0, http_1.ok)(res, await (0, notify_service_1.listMessages)(req.user.userId, limit));
    }
    catch (e) {
        next(e);
    }
});
exports.notifyRouter.post("/messages/:id/read", (0, auth_1.auth)(), async (req, res, next) => {
    try {
        const okRead = await (0, notify_service_1.markRead)(req.user.userId, req.params.id);
        (0, http_1.ok)(res, { read: okRead });
    }
    catch (e) {
        next(e);
    }
});
/** 每日扫描（cron 09:00 / 20:00）；幂等，重复跑不重复发 */
exports.notifyRouter.post("/scan", (0, auth_1.auth)(["OPERATOR"]), async (_req, res, next) => {
    try {
        (0, http_1.ok)(res, await (0, notify_service_1.runNoticeScan)());
    }
    catch (e) {
        next(e);
    }
});
exports.default = exports.notifyRouter;
//# sourceMappingURL=notify.controller.js.map