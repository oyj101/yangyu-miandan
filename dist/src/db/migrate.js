"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrate = migrate;
const fs_1 = require("fs");
const path_1 = require("path");
const db_1 = require("../lib/db");
const logger_1 = require("../lib/logger");
async function ensureTable() {
    await (0, db_1.query)(`CREATE TABLE IF NOT EXISTS _migrations (
       name VARCHAR(255) PRIMARY KEY,
       applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
     )`);
}
async function applied() {
    const res = await (0, db_1.query)(`SELECT name FROM _migrations`);
    return new Set(res.rows.map((r) => r.name));
}
async function migrate() {
    const dir = (0, path_1.join)(__dirname, "..", "..", "migrations");
    const files = (0, fs_1.readdirSync)(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
    await ensureTable();
    const done = await applied();
    for (const f of files) {
        if (done.has(f)) {
            logger_1.logger.info({ file: f }, "迁移已应用，跳过");
            continue;
        }
        const sql = (0, fs_1.readFileSync)((0, path_1.join)(dir, f), "utf8");
        logger_1.logger.info({ file: f }, "应用迁移");
        await (0, db_1.query)(sql);
        await (0, db_1.query)(`INSERT INTO _migrations (name) VALUES (?)`, [f]);
    }
    logger_1.logger.info("迁移完成");
    await db_1.pool.end();
}
if (require.main === module) {
    migrate().then(() => process.exit(0), (e) => {
        logger_1.logger.error({ err: e }, "迁移失败");
        process.exit(1);
    });
}
//# sourceMappingURL=migrate.js.map