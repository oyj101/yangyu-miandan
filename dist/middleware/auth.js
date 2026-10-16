"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signAccessToken = signAccessToken;
exports.signRefreshToken = signRefreshToken;
exports.auth = auth;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = require("../config");
const errors_1 = require("../lib/errors");
const logger_1 = require("../lib/logger");
function signAccessToken(user) {
    return jsonwebtoken_1.default.sign(user, config_1.config.jwt.secret, {
        expiresIn: config_1.config.jwt.accessTtl,
    });
}
function signRefreshToken(user) {
    return jsonwebtoken_1.default.sign({ ...user, typ: "refresh" }, config_1.config.jwt.secret, {
        expiresIn: config_1.config.jwt.refreshTtl,
    });
}
function auth(roles) {
    return (req, _res, next) => {
        // [Task-193] 联邦统一身份优先：federate 中间件已验过主站 /auth/me 并挂 req.fedUser
        if (req.fedUser) {
            if (roles && roles.length && !roles.includes(req.fedUser.role)) {
                logger_1.logger.warn({ userId: req.fedUser.userId, role: req.fedUser.role, need: roles, via: "federated" }, "RBAC 拒绝");
                return next((0, errors_1.unauthorized)("角色无权访问"));
            }
            req.user = {
                userId: req.fedUser.userId,
                role: req.fedUser.role,
                merchantId: req.fedUser.merchantId,
            };
            return next();
        }
        const header = req.headers.authorization;
        if (!header || !header.startsWith("Bearer ")) {
            return next((0, errors_1.unauthorized)("缺少访问令牌"));
        }
        const token = header.slice(7);
        try {
            const payload = jsonwebtoken_1.default.verify(token, config_1.config.jwt.secret);
            if (payload.typ === "refresh") {
                return next((0, errors_1.unauthorized)("刷新令牌不能用于访问接口"));
            }
            const user = {
                userId: payload.userId,
                role: payload.role,
                merchantId: payload.merchantId,
            };
            if (roles && roles.length && !roles.includes(user.role)) {
                logger_1.logger.warn({ userId: user.userId, role: user.role, need: roles }, "RBAC 拒绝");
                return next((0, errors_1.unauthorized)("角色无权访问"));
            }
            req.user = user;
            next();
        }
        catch (err) {
            logger_1.logger.warn({ err }, "令牌校验失败");
            next((0, errors_1.unauthorized)("令牌无效或已过期"));
        }
    };
}
//# sourceMappingURL=auth.js.map