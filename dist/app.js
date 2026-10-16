"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const cors_1 = __importDefault(require("cors"));
const config_1 = require("./config");
const logger_1 = require("./lib/logger");
const requestId_1 = require("./middleware/requestId");
const errorHandler_1 = require("./middleware/errorHandler");
const card_controller_1 = require("./features/card/card.controller");
const enrollment_controller_1 = require("./features/enrollment/enrollment.controller");
const checkin_controller_1 = require("./features/checkin/checkin.controller");
const reward_controller_1 = require("./features/reward/reward.controller");
const auth_controller_1 = require("./features/auth/auth.controller");
function createApp() {
    const app = (0, express_1.default)();
    app.use((0, cors_1.default)({
        origin: config_1.config.corsOrigins.length ? config_1.config.corsOrigins : false,
        credentials: true,
    }));
    app.use(express_1.default.json({ limit: "1mb" }));
    app.use(requestId_1.requestId);
    app.use(express_1.default.static(path_1.default.join(__dirname, "..", "public")));
    app.get("/health", (_req, res) => res.json({ ok: true, status: "up" }));
    app.get("/ready", (_req, res) => res.json({ ok: true, status: "ready" }));
    app.use("/api/cards", card_controller_1.cardRouter);
    app.use("/api/enrollments", enrollment_controller_1.enrollmentRouter);
    app.use("/api/checkin", checkin_controller_1.checkinRouter);
    app.use("/api/reward", reward_controller_1.rewardRouter);
    app.use("/api/auth", auth_controller_1.authRouter);
    app.use(errorHandler_1.notFoundHandler);
    app.use(errorHandler_1.errorHandler);
    logger_1.logger.info("应用已装配");
    return app;
}
//# sourceMappingURL=app.js.map