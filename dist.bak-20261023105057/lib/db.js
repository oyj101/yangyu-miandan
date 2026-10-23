"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.newId = newId;
exports.query = query;
exports.withTx = withTx;
const promise_1 = __importDefault(require("mysql2/promise"));
const crypto_1 = require("crypto");
const config_1 = require("../config");
const logger_1 = require("./logger");
// 主键策略：应用层生成 UUID（CHAR(36) 存储）。
// MariaDB 的 UUID() 不是 v4（含 MAC/时间戳），不满足资金系统 ID 不可预测性要求。
function newId() {
    return (0, crypto_1.randomUUID)();
}
exports.pool = global.__myPool ??
    promise_1.default.createPool({
        host: config_1.config.db.host,
        port: config_1.config.db.port,
        user: config_1.config.db.user,
        password: config_1.config.db.password,
        database: config_1.config.db.database,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        // 迁移文件含多语句；参数化查询仍走 mysql2 escape，无注入面
        multipleStatements: true,
        // DATETIME 无时区语义：按服务器本地时区（CST）解释为 JS Date，与部署机 TZ 约定一致
        timezone: "local",
    });
if (process.env.NODE_ENV !== "production") {
    global.__myPool = exports.pool;
}
async function run(conn, text, params) {
    const [res] = await conn.query(text, params);
    if (Array.isArray(res)) {
        return { rows: res, rowCount: res.length };
    }
    return { rows: [], rowCount: res?.affectedRows ?? null };
}
async function query(text, params = []) {
    const start = Date.now();
    try {
        const r = await run(exports.pool, text, params);
        logger_1.logger.debug({ ms: Date.now() - start, rows: r.rowCount }, "db query");
        return r;
    }
    catch (err) {
        logger_1.logger.error({ err, text }, "db query 失败");
        throw err;
    }
}
async function withTx(fn) {
    const client = await exports.pool.getConnection();
    try {
        await client.beginTransaction();
        const r = await fn(client);
        await client.commit();
        return r;
    }
    catch (err) {
        await client.rollback();
        throw err;
    }
    finally {
        client.release();
    }
}
//# sourceMappingURL=db.js.map