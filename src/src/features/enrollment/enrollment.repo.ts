import { query, newId, pool } from "../../lib/db";
import type { Pool, PoolConnection } from "mysql2/promise";
import { Enrollment } from "./enrollment.types";
import { EnrollState } from "../reward/engine";

// 可传入事务连接（withTx 内的写必须在同一连接同一事务，否则 InnoDB 下
// INSERT 的 FK 共享锁与另一连接的 UPDATE 排他锁互等 → 锁超时）
type AnyConn = Pool | PoolConnection;

function mapRow(r: any): Enrollment {
  return {
    id: r.id,
    userId: r.user_id,
    cardId: r.card_id,
    merchantId: r.merchant_id,
    status: r.status,
    consecutiveMiss: r.consecutive_miss,
    totalMissCount: r.total_miss_count,
    pauseRemaining: r.pause_remaining,
    rewardPaid: Number(r.reward_paid),
    rewardTotal: Number(r.reward_total),
    enrollAt: r.enroll_at,
    reEnrolled: !!r.re_enrolled,
    // 20261017 付费模式字段: none=免费领卡 / unpaid=已下单待付 / paid=已支付
    payOrderNo: r.pay_order_no || null,
    payStatus: (r.pay_status || "none"),
  };
}

// 主键应用层生成 + 插入后回读（同 card.repo：不依赖 INSERT..RETURNING）
export async function insertEnrollment(input: {
  userId: string;
  cardId: string;
  merchantId: string;
  rewardTotal: number;
  reEnrolled: boolean;
}): Promise<Enrollment> {
  const id = newId();
  await query(
    `INSERT INTO enrollment (id, user_id, card_id, merchant_id, reward_total, re_enrolled)
     VALUES (?,?,?,?,?,?)`,
    [id, input.userId, input.cardId, input.merchantId, input.rewardTotal, input.reEnrolled]
  );
  const row = await findEnrollment(id);
  if (!row) throw new Error("insertEnrollment 回读失败");
  return row;
}

export async function findEnrollment(id: string): Promise<Enrollment | null> {
  const res = await query<any>(`SELECT * FROM enrollment WHERE id = ?`, [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function findActiveByUserCard(
  userId: string,
  cardId: string
): Promise<Enrollment | null> {
  const res = await query<any>(
    `SELECT * FROM enrollment WHERE user_id = ? AND card_id = ? AND status NOT IN ('exited','refunded')`,
    [userId, cardId]
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function updateEnrollState(
  conn: AnyConn,
  id: string,
  state: EnrollState
): Promise<void> {
  await conn.query(
    `UPDATE enrollment
     SET status=?, consecutive_miss=?, total_miss_count=?, pause_remaining=?, reward_paid=?
     WHERE id=?`,
    [state.status, state.consecutiveMiss, state.totalMissCount, state.pauseRemaining, state.rewardPaid, id]
  );
}

export async function setEnrollStatus(
  conn: AnyConn,
  id: string,
  status: Enrollment["status"]
): Promise<void> {
  await conn.query(`UPDATE enrollment SET status=? WHERE id=?`, [status, id]);
}

export async function listByMerchant(
  merchantId: string,
  statusFilter?: string
): Promise<Enrollment[]> {
  const params: unknown[] = [merchantId];
  let sql = `SELECT * FROM enrollment WHERE merchant_id = ?`;
  if (statusFilter) {
    sql += ` AND status = ?`;
    params.push(statusFilter);
  }
  sql += ` ORDER BY enroll_at DESC`;
  const res = await query<any>(sql, params);
  return res.rows.map(mapRow);
}

// [Task-213] 我的入渔列表（C 端「我的免单」）：按联邦用户 user_id 反查全部入渔记录。
// enrollment.user_id 锚定 merchant_user.user_id（如 au_1），与 federate 注入的 req.fedUser.userId 一致。
export async function listByUser(userId: string): Promise<Enrollment[]> {
  const res = await query<any>(
    `SELECT * FROM enrollment WHERE user_id = ? ORDER BY enroll_at DESC`,
    [userId]
  );
  return res.rows.map(mapRow);
}

export function toState(e: Enrollment): EnrollState {
  return {
    status: e.status,
    consecutiveMiss: e.consecutiveMiss,
    totalMissCount: e.totalMissCount,
    pauseRemaining: e.pauseRemaining,
    rewardPaid: e.rewardPaid,
    rewardTotal: e.rewardTotal,
  };
}
