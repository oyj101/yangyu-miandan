// 时区约定：DB 以服务器本地时间（CST/UTC+8）存储 DATETIME，与联邦站现网 MySQL 一致。
// 部署机必须处于 CST 时区（或由进程管理器注入 TZ=Asia/Shanghai），否则时间字段漂移。
process.env.TZ ||= "Asia/Shanghai";

import { createApp } from "./app";
import { config } from "./config";
import { logger } from "./lib/logger";
import { pool } from "./lib/db";

const app = createApp();

// 监听地址：默认仅绑回环，禁止直接暴露网卡。
// 安全理由：服务统一由 nginx 在 HTTPS/域名层收口（认证、限流、日志、证书），
// 后端直接监听 0.0.0.0 会绕过网关被公网直连。确需本机以外访问时显式设置 HOST。
const HOST = process.env.HOST || "127.0.0.1";

const server = app.listen(config.port, HOST, () => {
  logger.info({ port: config.port, host: HOST }, "养鱼免单服务已启动");
});

function shutdown(signal: string) {
  logger.info({ signal }, "收到关闭信号，优雅停机");
  server.close(() => {
    logger.info("HTTP 服务已停止");
    pool.end().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
