"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.corsOptions = void 0;
exports.isAllowedOrigin = isAllowedOrigin;
const config_1 = require("../config");
/**
 * CORS 策略（SDK 内联版）
 *
 * 前提：SDK 默认走「同源反代」路径 `/yangyu-api/*`（nginx 剥前缀转发到本服务），
 *       此时根本不该有跨域请求，CORS 只是兜底。
 * 但既然兜底，就必须是白名单，不能用 `origin: true`：
 *   - 本服务所有身份来自 `domain=.ws.hi.cn` 的 cookie；
 *   - `origin: true` + credentials 会把「任何站点都能带着用户 cookie 调本服务」变成事实，
 *     等于把 CSRF 面直接铺开（与 ADR-116 的网关口径同一条教训：能过 ≠ 该过）。
 *
 * 允许：
 *   1) config.corsOrigins 显式列出的完整 origin（含协议端口）
 *   2) 任意 *.ws.hi.cn 子域（https only）
 *   3) 本机开发（127.0.0.1 / localhost，任意端口，仅非生产）
 */
const WS_SUFFIX = ".ws.hi.cn";
const WS_ROOT = "ws.hi.cn";
function isLocal(hostname) {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0";
}
function isAllowedOrigin(origin) {
    let u;
    try {
        u = new URL(origin);
    }
    catch {
        return false;
    }
    if (config_1.config.corsOrigins.includes(origin))
        return true;
    if (isLocal(u.hostname))
        return config_1.config.nodeEnv !== "production";
    if (u.protocol !== "https:")
        return false;
    return u.hostname === WS_ROOT || u.hostname.endsWith(WS_SUFFIX);
}
exports.corsOptions = {
    origin(origin, cb) {
        // 无 Origin：同源请求 / curl / 服务端互调（X-Service-Key），放行但不回 CORS 头
        if (!origin)
            return cb(null, true);
        if (isAllowedOrigin(origin))
            return cb(null, true);
        // 不回错误（避免 500），只是不加 Access-Control-Allow-Origin，浏览器侧自然拦截
        return cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id", "X-Client", "X-Sdk-Version"],
    exposedHeaders: ["X-Request-Id"],
    maxAge: 600,
};
//# sourceMappingURL=cors.js.map