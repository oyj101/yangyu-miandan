import mysql, { Pool, PoolConnection } from "mysql2/promise";
import { randomUUID } from "crypto";
import { config } from "../config";
import { logger } from "./logger";

declare global {
  // eslint-disable-next-line no-var
  var __myPool: Pool | undefined;
}

// 主键策略：应用层生成 UUID（CHAR(36) 存储）。
// MariaDB 的 UUID() 不是 v4（含 MAC/时间戳），不满足资金系统 ID 不可预测性要求。
export function newId(): string {
  return randomUUID();
}

export const pool: Pool =
  global.__myPool ??
  mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // 迁移文件含多语句；参数化查询仍走 mysql2 escape，无注入面
    multipleStatements: true,
    // DATETIME 无时区语义：按服务器本地时区（CST）解释为 JS Date，与部署机 TZ 约定一致
    timezone: "local",
  });

if (process.env.NODE_ENV !== "production") {
  global.__myPool = pool;
}

// 注意：mysql2/promise 的 Pool 无 'error' 事件（仅 'enqueue'）；
// 空闲连接错误通过 query rejection 冒泡，由 errorHandler 统一处理。

// mysql2 返回分两态：结果集（SELECT / INSERT..RETURNING）→ RowDataPacket[]；
// 无结果集（INSERT/UPDATE/DELETE）→ ResultSetHeader。统一适配成 pg 风格的 {rows,rowCount}。
type AnyConn = Pool | PoolConnection;

async function run(conn: AnyConn, text: string, params: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> {
  const [res] = await conn.query(text, params as any);
  if (Array.isArray(res)) {
    return { rows: res, rowCount: res.length };
  }
  return { rows: [], rowCount: (res as any)?.affectedRows ?? null };
}

export async function query<T = any>(
  text: string,
  params: unknown[] = []
): Promise<{ rows: T[]; rowCount: number | null }> {
  const start = Date.now();
  try {
    const r = await run(pool, text, params);
    logger.debug({ ms: Date.now() - start, rows: r.rowCount }, "db query");
    return r as { rows: T[]; rowCount: number | null };
  } catch (err) {
    logger.error({ err, text }, "db query 失败");
    throw err;
  }
}

export async function withTx<T>(fn: (client: PoolConnection) => Promise<T>): Promise<T> {
  const client = await pool.getConnection();
  try {
    await client.beginTransaction();
    const r = await fn(client);
    await client.commit();
    return r;
  } catch (err) {
    await client.rollback();
    throw err;
  } finally {
    client.release();
  }
}
