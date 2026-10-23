"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.internal = exports.validationError = exports.conflict = exports.notFound = exports.forbidden = exports.unauthorized = exports.badRequest = exports.AppError = void 0;
class AppError extends Error {
    constructor(code, message, status, details) {
        super(message);
        this.name = "AppError";
        this.code = code;
        this.status = status;
        this.details = details;
    }
}
exports.AppError = AppError;
const badRequest = (msg, details) => new AppError("BAD_REQUEST", msg, 400, details);
exports.badRequest = badRequest;
const unauthorized = (msg = "未认证") => new AppError("UNAUTHORIZED", msg, 401);
exports.unauthorized = unauthorized;
const forbidden = (msg = "无权限") => new AppError("FORBIDDEN", msg, 403);
exports.forbidden = forbidden;
const notFound = (msg = "资源不存在") => new AppError("NOT_FOUND", msg, 404);
exports.notFound = notFound;
const conflict = (msg, details) => new AppError("CONFLICT", msg, 409, details);
exports.conflict = conflict;
const validationError = (msg, details) => new AppError("VALIDATION", msg, 422, details);
exports.validationError = validationError;
const internal = (msg = "服务器内部错误") => new AppError("INTERNAL", msg, 500);
exports.internal = internal;
//# sourceMappingURL=errors.js.map