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
            return next((0, errors_1.unauthorized)("生产环境禁用开发登录"));
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
exports.default = exports.authRouter;
//# sourceMappingURL=auth.controller.js.map