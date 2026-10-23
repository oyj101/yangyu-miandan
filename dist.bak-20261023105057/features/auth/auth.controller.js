"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const errors_1 = require("../../lib/errors");
const auth_1 = require("../../middleware/auth");
// 开发/演示用登录：真实环境应由联邦统一登录（微信/手机）签发令牌后回调。
const loginSchema = zod_1.z.object({
    user_id: zod_1.z.string().min(1),
    role: zod_1.z.enum(["USER", "MERCHANT", "OPERATOR", "CASHIER"]),
    merchant_id: zod_1.z.string().optional(),
});
exports.authRouter = (0, express_1.Router)();
exports.authRouter.post("/dev-login", (req, res, next) => {
    try {
        if (process.env.NODE_ENV === "production") {
            return next((0, errors_1.unauthorized)("生产环境请使用 ai 站统一登录（ai.ws.hi.cn），联邦身份自动贯通本站"));
        }
        const { user_id, role, merchant_id } = loginSchema.parse(req.body);
        const user = { userId: user_id, role: role, merchantId: merchant_id };
        const accessToken = (0, auth_1.signAccessToken)(user);
        const refreshToken = (0, auth_1.signRefreshToken)(user);
        res.cookie("yy_refresh", refreshToken, {
            httpOnly: true,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
            maxAge: 7 * 24 * 3600 * 1000,
        });
        res.json({ ok: true, data: { accessToken, role, userId: user_id } });
    }
    catch (e) {
        next(e);
    }
});
// [Task-213] 联邦兑换端点：消费中间件 federate 注入的 req.fedUser，签发养鱼本地 JWT。
// 前端 SDK withFederationAuth() 调用本端点取得 accessToken 后，即可用 Bearer 直连其余接口，
// 不必每次依赖 ai 站 cookie 透传，亦便于非 cookie 场景复用。
exports.authRouter.post("/exchange", (req, res, next) => {
    try {
        const fed = req.fedUser;
        if (!fed) {
            return next((0, errors_1.unauthorized)("请先在 ai 站（ai.ws.hi.cn）登录，联邦身份将自动贯通本站"));
        }
        const user = {
            userId: fed.userId,
            role: fed.role,
            merchantId: fed.merchantId || undefined,
        };
        const accessToken = (0, auth_1.signAccessToken)(user);
        const refreshToken = (0, auth_1.signRefreshToken)(user);
        res.cookie("yy_refresh", refreshToken, {
            httpOnly: true,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
            maxAge: 7 * 24 * 3600 * 1000,
        });
        res.json({
            ok: true,
            data: {
                accessToken,
                refreshToken,
                role: fed.role,
                userId: fed.userId,
                aiUid: fed.aiUid,
            },
        });
    }
    catch (e) {
        next(e);
    }
});
exports.default = exports.authRouter;
//# sourceMappingURL=auth.controller.js.map