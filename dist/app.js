"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const logger_1 = require("./lib/logger");
const requestId_1 = require("./middleware/requestId");
const errorHandler_1 = require("./middleware/errorHandler");
const cors_2 = require("./middleware/cors");
const federation_1 = require("./middleware/federation");
const tenant_1 = require("./middleware/tenant");
const card_controller_1 = require("./features/card/card.controller");
const enrollment_controller_1 = require("./features/enrollment/enrollment.controller");
const checkin_controller_1 = require("./features/checkin/checkin.controller");
const reward_controller_1 = require("./features/reward/reward.controller");
const auth_controller_1 = require("./features/auth/auth.controller");
const period_controller_1 = require("./features/period/period.controller");
const merchant_controller_1 = require("./features/merchant/merchant.controller");
const notify_controller_1 = require("./features/notify/notify.controller");
const sdk_controller_1 = require("./features/sdk/sdk.controller");
/**
 * 服务定位：**纯 API**。
 *
 * 2026-10-20 起本服务不再对外提供任何页面：
 *   - `public/` 已移出部署树（legacy/standalone/ 仅存档，不参与运行）；
 *   - `express.static` 已移除 —— 留着的风险是「以为下线了，其实还能访问」，
 *     站点下线必须是真下线（同「删配置 ≠ 退役，要验运行时」的教训）。
 *
 * C 端 / 商户端 / 运营端全部改为内联 SDK 形态（sdk/octo-yangyu.v2.0.0.js），
 * 挂在既有联邦站页面上，身份走 .ws.hi.cn cookie + 主站 /auth/me。
 */
const SDK_PREFIX = "/yangyu-api";
function createApp() {
    const app = (0, express_1.default)();
    // 反代来源：nginx /yangyu-api/* → 本服务。这里自带前缀剥离，
    // 不依赖 nginx `proxy_pass` 的尾斜杠写法（那是运维侧最易漂移的一处）。
    app.use((req, _res, next) => {
        if (req.url === SDK_PREFIX || req.url.startsWith(SDK_PREFIX + "/")) {
            req.url = req.url.slice(SDK_PREFIX.length) || "/";
        }
        next();
    });
    app.use((0, cors_1.default)(cors_2.corsOptions));
    // 预检不进业务中间件链（federate 会打 8100，预检白跑一次）
    app.options("*", (0, cors_1.default)(cors_2.corsOptions));
    app.use(express_1.default.json({ limit: "1mb" }));
    app.use(requestId_1.requestId);
    // 租户上下文：Host/Origin 推导归属（不认客户端自报头），失败按 TENANT_ENFORCE 决定拒或放
    // 放在 federate 之前：它是纯归属判定，不依赖身份；先判定，后续日志与业务都能拿到 req.tenant
    app.use(tenant_1.tenantContext);
    // [Task-193] 联邦统一身份：解析 ai 站 token -> 主站 /auth/me -> 本地域档案
    app.use(federation_1.federate);
    app.get("/health", (_req, res) => res.json({ code: 0, message: "ok", ok: true, data: { status: "up" } }));
    app.get("/ready", (_req, res) => res.json({ code: 0, message: "ok", ok: true, data: { status: "ready" } }));
    // SDK 聚合层（内联 SDK 的唯一入口，放在原子端点之前便于一眼看出主入口）
    app.use("/api/sdk", sdk_controller_1.sdkRouter);
    app.use("/api/cards", card_controller_1.cardRouter);
    app.use("/api/enrollments", enrollment_controller_1.enrollmentRouter);
    app.use("/api/checkin", checkin_controller_1.checkinRouter);
    app.use("/api/reward", reward_controller_1.rewardRouter);
    app.use("/api/auth", auth_controller_1.authRouter);
    app.use("/api/periods", period_controller_1.periodRouter);
    app.use("/api/merchant", merchant_controller_1.merchantRouter);
    app.use("/api/notify", notify_controller_1.notifyRouter);
    app.use(errorHandler_1.notFoundHandler);
    app.use(errorHandler_1.errorHandler);
    logger_1.logger.info("应用已装配（API-only，页面由内联 SDK 提供）");
    return app;
}
//# sourceMappingURL=app.js.map