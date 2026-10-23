"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// 时区约定：DB 以服务器本地时间（CST/UTC+8）存储 DATETIME，与联邦站现网 MySQL 一致。
// 部署机必须处于 CST 时区（或由进程管理器注入 TZ=Asia/Shanghai），否则时间字段漂移。
process.env.TZ ||= "Asia/Shanghai";
const app_1 = require("./app");
const config_1 = require("./config");
const logger_1 = require("./lib/logger");
const db_1 = require("./lib/db");
const app = (0, app_1.createApp)();
// 监听地址：默认仅绑回环，禁止直接暴露网卡。
// 安全理由：服务统一由 nginx 在 HTTPS/域名层收口（认证、限流、日志、证书），
// 后端直接监听 0.0.0.0 会绕过网关被公网直连。确需本机以外访问时显式设置 HOST。
const HOST = process.env.HOST || "127.0.0.1";
const server = app.listen(config_1.config.port, HOST, () => {
    logger_1.logger.info({ port: config_1.config.port, host: HOST }, "养鱼免单服务已启动");
});
function shutdown(signal) {
    logger_1.logger.info({ signal }, "收到关闭信号，优雅停机");
    server.close(() => {
        logger_1.logger.info("HTTP 服务已停止");
        db_1.pool.end().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
//# sourceMappingURL=server.js.map