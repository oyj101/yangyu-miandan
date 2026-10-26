"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// 驱动探针：验证 mysql2 + MariaDB 10.11 关键行为，为联调改造兜底
// 覆盖：多语句迁移 / ENUM / DECIMAL 返回类型 / DATETIME→JS Date / COUNT 返回类型 /
//       INSERT..RETURNING 是否回传 rows / ON DUPLICATE KEY UPDATE / 1062 错误码 / 同表 UPDATE 子查询
const promise_1 = __importDefault(require("mysql2/promise"));
const PORT = 3399;
async function main() {
    // 1) 连接 + 版本
    const admin = await promise_1.default.createConnection({
        host: "127.0.0.1", port: PORT, user: "root", password: "", multipleStatements: true,
    });
    const [verRows] = await admin.query("SELECT VERSION() AS v, NOW(3) AS n");
    console.log("PROBE version:", JSON.stringify(verRows[0]));
    // 2) 建库 + 多语句迁移执行
    await admin.query("DROP DATABASE IF EXISTS probe_db");
    await admin.query("CREATE DATABASE probe_db DEFAULT CHARSET utf8mb4");
    const db = await promise_1.default.createConnection({
        host: "127.0.0.1", port: PORT, user: "root", password: "", database: "probe_db", multipleStatements: true, timezone: "local",
    });
    const ddl = `
    CREATE TABLE t1 (
      id CHAR(36) PRIMARY KEY,
      st ENUM('a','b') NOT NULL DEFAULT 'a',
      amt DECIMAL(12,2) NOT NULL,
      ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      j JSON
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    CREATE UNIQUE INDEX uk ON t1 (st, amt);
  `;
    const [ddlRes] = await db.query(ddl);
    console.log("PROBE multi-statement DDL ok:", JSON.stringify(ddlRes));
    // 3) ENUM / DECIMAL / DATETIME / JSON 写入与返回类型
    const [insRes] = await db.query("INSERT INTO t1 (id, st, amt, j) VALUES (?,?,?,?)", ["11111111-1111-1111-1111-111111111111", "a", 12.5, JSON.stringify({ x: 1 })]);
    console.log("PROBE insert result keys:", Object.keys(insRes).join(","), "affectedRows=", insRes.affectedRows);
    const [selRows] = await db.query("SELECT * FROM t1 WHERE id = ?", ["11111111-1111-1111-1111-111111111111"]);
    const r = selRows[0];
    console.log("PROBE types: amt=", typeof r.amt, JSON.stringify(r.amt), "| ts=", typeof r.ts, r.ts instanceof Date ? "Date" : "not-Date", "| j=", typeof r.j, JSON.stringify(r.j), "| st=", JSON.stringify(r.st));
    // 4) COUNT(*) 返回类型
    const [cntRows] = await db.query("SELECT COUNT(*) AS c FROM t1");
    console.log("PROBE count type:", typeof cntRows[0].c, JSON.stringify(cntRows[0].c));
    // 5) INSERT..RETURNING 是否回传 rows（informational，正式代码不依赖）
    try {
        const [retRows] = await db.query("INSERT INTO t1 (id, st, amt) VALUES (?,?,?) RETURNING id", ["22222222-2222-2222-2222-222222222222", "b", 1]);
        console.log("PROBE RETURNING rows:", JSON.stringify(retRows));
    }
    catch (e) {
        console.log("PROBE RETURNING error:", e.code, e.message?.slice(0, 80));
    }
    // 6) 唯一冲突错误码
    try {
        await db.query("INSERT INTO t1 (id, st, amt) VALUES (?,?,?)", ["33333333-3333-3333-3333-333333333333", "a", 12.5]);
        console.log("PROBE dup: NO ERROR (unexpected!)");
    }
    catch (e) {
        console.log("PROBE dup errno:", e.errno, "code:", e.code);
    }
    // 7) ON DUPLICATE KEY UPDATE + 占位符按位置绑定验证（插入撞唯一键的值，强制走 UPDATE 分支）
    await db.query("DELETE FROM t1");
    await db.query("INSERT INTO t1 (id, st, amt) VALUES (?,?,?)", ["66666666-6666-6666-6666-666666666666", "a", 12.5]);
    await db.query("INSERT INTO t1 (id, st, amt) VALUES (?,?,?) ON DUPLICATE KEY UPDATE amt = ?, id = ?", ["77777777-7777-7777-7777-777777777777", "a", 12.5, 77, "77777777-7777-7777-7777-777777777777"]);
    const [updRows] = await db.query("SELECT amt, id FROM t1");
    console.log("PROBE on-dup result:", JSON.stringify(updRows[0]), "(期望 amt=77, id=7777…)");
    // 8) 同表 UPDATE 子查询（联调 week 改写需要派生表包裹）
    await db.query(`UPDATE t1 SET st = 'b' WHERE id = (SELECT id FROM (SELECT id FROM t1 WHERE st = 'a' LIMIT 1) t)`);
    console.log("PROBE same-table subquery update: OK");
    // 9) 事务回滚验证（Connection 级别）
    await db.beginTransaction();
    await db.query("INSERT INTO t1 (id, st, amt) VALUES (?,?,?)", ["55555555-5555-5555-5555-555555555555", "a", 5]);
    await db.rollback();
    const [rbRows] = await db.query("SELECT COUNT(*) AS c FROM t1 WHERE id = ?", ["55555555-5555-5555-5555-555555555555"]);
    console.log("PROBE rollback count:", rbRows[0].c, "(期望 0)");
    await admin.query("DROP DATABASE IF EXISTS probe_db");
    await admin.end();
    await db.end();
    console.log("=== PROBE DONE ===");
}
main().catch((e) => { console.error("PROBE FAILED:", e); process.exit(1); });
//# sourceMappingURL=probe-mysql2.js.map