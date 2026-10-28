import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { pool, query } from "../lib/db";
import { logger } from "../lib/logger";

async function ensureTable() {
  await query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name VARCHAR(255) PRIMARY KEY,
       applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
     )`
  );
}

async function applied(): Promise<Set<string>> {
  const res = await query<{ name: string }>(`SELECT name FROM _migrations`);
  return new Set(res.rows.map((r) => r.name));
}

export async function migrate() {
  const dir = join(__dirname, "..", "..", "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  await ensureTable();
  const done = await applied();
  for (const f of files) {
    if (done.has(f)) {
      logger.info({ file: f }, "迁移已应用，跳过");
      continue;
    }
    const sql = readFileSync(join(dir, f), "utf8");
    logger.info({ file: f }, "应用迁移");
    await query(sql);
    await query(`INSERT INTO _migrations (name) VALUES (?)`, [f]);
  }
  logger.info("迁移完成");
  await pool.end();
}

if (require.main === module) {
  migrate().then(
    () => process.exit(0),
    (e) => {
      logger.error({ err: e }, "迁移失败");
      process.exit(1);
    }
  );
}
