"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notFoundHandler = notFoundHandler;
exports.errorHandler = errorHandler;
const zod_1 = require("zod");
const errors_1 = require("../lib/errors");
const logger_1 = require("../lib/logger");
function notFoundHandler(_req, res) {
    res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } });
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function errorHandler(err, req, res, _next) {
    if (err instanceof zod_1.ZodError) {
        logger_1.logger.warn({ requestId: req.requestId, issues: err.issues }, "参数校验失败");
        return res.status(422).json({
            ok: false,
            error: { code: "VALIDATION", message: "参数校验失败", details: err.issues },
        });
    }
    if (err instanceof errors_1.AppError) {
        if (err.status >= 500)
            logger_1.logger.error({ requestId: req.requestId, err }, "业务错误(5xx)");
        return res.status(err.status).json({
            ok: false,
            error: { code: err.code, message: err.message, details: err.details },
        });
    }
    logger_1.logger.error({ requestId: req.requestId, err }, "未捕获异常");
    return res.status(500).json({
        ok: false,
        error: { code: "INTERNAL", message: "服务器内部错误" },
    });
}
//# sourceMappingURL=errorHandler.js.map