import type { PoolConnection } from "mysql2/promise";
import { query, newId } from "../../lib/db";
import { ymdOfOrEmpty } from "../../lib/date";
import { DeliveryMode, DeliveryStatus, DeliveryTask } from "./delivery.types";

function mapRow(r: any): DeliveryTask {
  return {
    id: r.id,
    periodId: r.period_id,
    enrollmentId: r.enrollment_id,
    cardId: r.card_id,
    userId: r.user_id,
    merchantId: r.merchant_id,
    periodNo: Number(r.period_no),
    // DATE 列（mysql2 返回 Date 对象）：必须归一，否则得到 'Tue Nov 03'
    weekStart: ymdOfOrEmpty(r.week_start),
    weekEnd: ymdOfOrEmpty(r.week_end),
    mode: (r.mode ?? "delivery") as DeliveryMode,
    status: r.status as DeliveryStatus,
    receiverName: r.receiver_name ?? null,
    receiverPhone: r.receiver_phone ?? null,
    receiverAddress: r.receiver_address ?? null,
    courier: r.courier ?? null,
    trackingNo: r.tracking_no ?? null,
    remark: r.remark ?? null,
    operator: r.operator ?? null,
    shippedAt: r.shipped_at ?? null,
    deliveredAt: r.delivered_at ?? null,
    signedAt: r.signed_at ?? null,
    signedBy: r.signed_by ?? null,
    checkinId: r.checkin_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface NewDeliveryRow {
  periodId: string;
  enrollmentId: string;
  cardId: string;
  userId: string;
  merchantId: string;
  periodNo: number;
  weekStart: string;
  weekEnd: string;
  mode: DeliveryMode;
  receiverName: string | null;
  receiverPhone: string | null;
  receiverAddress: string | null;
}

/**
 * 批量建配送任务。
 * INSERT IGNORE + uk_delivery_period：一期一条，重复调用不报错也不重复建，
 * 这是 attach（购买时/补建时/切换履约时都会调）能安全幂等的前提。
 */
export async function insertTasks(rows: NewDeliveryRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const cols = 13;
  const placeholders = rows.map(() => `(${Array(cols).fill("?").join(",")})`).join(",");
  const params: unknown[] = [];
  for (const r of rows) {
    params.push(
      newId(),
      r.periodId,
      r.enrollmentId,
      r.cardId,
      r.userId,
      r.merchantId,
      r.periodNo,
      r.weekStart,
      r.weekEnd,
      r.mode,
      r.receiverName,
      r.receiverPhone,
      r.receiverAddress
    );
  }
  const res = await query<any>(
    `INSERT IGNORE INTO delivery_task
       (id, period_id, enrollment_id, card_id, user_id, merchant_id, period_no,
        week_start, week_end, mode, receiver_name, receiver_phone, receiver_address)
     VALUES ${placeholders}`,
    params
  );
  return Number(res.rowCount) || 0;
}

export async function findById(id: string): Promise<DeliveryTask | null> {
  const res = await query<any>(`SELECT * FROM delivery_task WHERE id = ?`, [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function findByPeriodId(periodId: string): Promise<DeliveryTask | null> {
  const res = await query<any>(`SELECT * FROM delivery_task WHERE period_id = ?`, [periodId]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** 锁定读：签收要触发资金发奖，必须先锁任务行，防并发双签 */
export async function lockById(client: PoolConnection, id: string): Promise<DeliveryTask | null> {
  const [rows] = await client.query(`SELECT * FROM delivery_task WHERE id = ? FOR UPDATE`, [id]);
  const r = (rows as any[])[0];
  return r ? mapRow(r) : null;
}

export async function listByEnrollment(enrollmentId: string): Promise<DeliveryTask[]> {
  const res = await query<any>(
    `SELECT * FROM delivery_task WHERE enrollment_id = ? ORDER BY period_no ASC`,
    [enrollmentId]
  );
  return res.rows.map(mapRow);
}

export async function listByUser(userId: string): Promise<DeliveryTask[]> {
  const res = await query<any>(
    `SELECT * FROM delivery_task WHERE user_id = ? ORDER BY week_start DESC, period_no ASC`,
    [userId]
  );
  return res.rows.map(mapRow);
}

export async function listByMerchant(
  merchantId: string,
  opts: { status?: DeliveryStatus; limit?: number } = {}
): Promise<DeliveryTask[]> {
  const params: unknown[] = [merchantId];
  let sql = `SELECT * FROM delivery_task WHERE merchant_id = ?`;
  if (opts.status) {
    sql += ` AND status = ?`;
    params.push(opts.status);
  }
  sql += ` ORDER BY week_start ASC, period_no ASC LIMIT ?`;
  params.push(Math.min(Math.max(Number(opts.limit) || 200, 1), 500));
  const res = await query<any>(sql, params);
  return res.rows.map(mapRow);
}

export async function markShipped(
  id: string,
  input: { courier: string | null; trackingNo: string | null; operator: string; remark: string | null }
): Promise<void> {
  await query(
    `UPDATE delivery_task
        SET status='shipped', shipped_at=CURRENT_TIMESTAMP(3),
            courier=?, tracking_no=?, operator=?, remark=COALESCE(?, remark)
      WHERE id=?`,
    [input.courier, input.trackingNo, input.operator, input.remark, id]
  );
}

export async function markDelivered(
  id: string,
  input: { operator: string; remark: string | null }
): Promise<void> {
  await query(
    `UPDATE delivery_task
        SET status='delivered', delivered_at=CURRENT_TIMESTAMP(3),
            operator=?, remark=COALESCE(?, remark)
      WHERE id=?`,
    [input.operator, input.remark, id]
  );
}

/** 签收 + 回写核销记录（同一事务内，保证"签收了但没核销"不会留下中间态） */
export async function markSigned(
  client: PoolConnection,
  id: string,
  input: { signedBy: string; operator: string; remark: string | null; checkinId: string | null }
): Promise<void> {
  await client.query(
    `UPDATE delivery_task
        SET status='signed', signed_at=CURRENT_TIMESTAMP(3), signed_by=?, operator=?,
            remark=COALESCE(?, remark), checkin_id=COALESCE(?, checkin_id)
      WHERE id=?`,
    [input.signedBy, input.operator, input.remark, input.checkinId, id]
  );
}

export async function markCancelled(id: string, operator: string, remark: string | null): Promise<void> {
  await query(
    `UPDATE delivery_task SET status='cancelled', operator=?, remark=COALESCE(?, remark) WHERE id=?`,
    [operator, remark, id]
  );
}

/** 回写核销 id（签收走核销链路后调用；独立事务时的兜底路径） */
export async function setCheckinId(id: string, checkinId: string): Promise<void> {
  await query(`UPDATE delivery_task SET checkin_id=? WHERE id=? AND checkin_id IS NULL`, [checkinId, id]);
}

export async function countByEnrollmentStatus(
  enrollmentId: string,
  statuses: DeliveryStatus[]
): Promise<number> {
  if (statuses.length === 0) return 0;
  const ph = statuses.map(() => "?").join(",");
  const res = await query<any>(
    `SELECT COUNT(*) AS c FROM delivery_task WHERE enrollment_id = ? AND status IN (${ph})`,
    [enrollmentId, ...statuses]
  );
  return Number(res.rows[0]?.c) || 0;
}
