import { PoolConnection } from "mysql2/promise";
import { query, newId } from "../../lib/db";
import { ymdOf, ymdOfOrEmpty } from "../../lib/date";
import { Period } from "./period.types";

function mapRow(r: any): Period {
  return {
    id: r.id,
    enrollmentId: r.enrollment_id,
    cardId: r.card_id,
    userId: r.user_id,
    merchantId: r.merchant_id,
    periodNo: Number(r.period_no),
    isoYear: Number(r.iso_year),
    isoWeek: Number(r.iso_week),
    // week_start/week_end 是 DATE 列：mysql2 返回 Date 对象，必须走 ymdOf，
    // 直接 String(Date).slice(0,10) 会得到 'Tue Nov 03' → 周边界比较全部 NaN
    weekStart: ymdOfOrEmpty(r.week_start),
    weekEnd: ymdOfOrEmpty(r.week_end),
    unitPrice: Number(r.unit_price),
    supplyPrice: Number(r.supply_price),
    // 006 快照列；旧行/未迁移环境回落到全局缺省，保证金额口径不会变成 NaN
    shareRatio: r.share_ratio == null ? 0.3 : Number(r.share_ratio),
    refundNowRatio: r.refund_now_ratio == null ? 0.7 : Number(r.refund_now_ratio),
    checkinId: r.checkin_id || null,
    taskMet: Number(r.task_met) === 1,
    metDays: Number(r.met_days) || 0,
    windowStart: ymdOf(r.window_start),
    refund70Amount: Number(r.refund70_amount) || 0,
    refund70Flow: r.refund70_flow || null,
    refund70At: r.refund70_at || null,
    refund30Amount: Number(r.refund30_amount) || 0,
    refund30Flow: r.refund30_flow || null,
    refund30At: r.refund30_at || null,
    merchantSettled: Number(r.merchant_settled) === 1,
    merchantAmount: Number(r.merchant_amount) || 0,
    expired: Number(r.expired) === 1,
    extendedFrom: r.extended_from || null,
    noticeFlags: Number(r.notice_flags) || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface NewPeriodRow {
  enrollmentId: string;
  cardId: string;
  userId: string;
  merchantId: string;
  periodNo: number;
  isoYear: number;
  isoWeek: number;
  weekStart: string;
  weekEnd: string;
  unitPrice: number;
  supplyPrice: number;
  /** 生成时从卡快照的分享比例 */
  shareRatio: number;
  /** 核销即时退比例 = 1 - shareRatio */
  refundNowRatio: number;
}

/**
 * 批量创建期次。幂等：uk_period_no 冲突时整批失败 → 调用方视为"已建"。
 * 用单条多值 INSERT，避免 N 次往返。
 */
export async function insertPeriods(rows: NewPeriodRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const cols = 14;
  const placeholders = rows.map(() => `(${Array(cols).fill("?").join(",")})`).join(",");
  const params: unknown[] = [];
  for (const r of rows) {
    params.push(
      newId(),
      r.enrollmentId,
      r.cardId,
      r.userId,
      r.merchantId,
      r.periodNo,
      r.isoYear,
      r.isoWeek,
      r.weekStart,
      r.weekEnd,
      r.unitPrice,
      r.supplyPrice,
      r.shareRatio,
      r.refundNowRatio
    );
  }
  await query(
    `INSERT INTO period
       (id, enrollment_id, card_id, user_id, merchant_id, period_no,
        iso_year, iso_week, week_start, week_end, unit_price, supply_price,
        share_ratio, refund_now_ratio)
     VALUES ${placeholders}`,
    params
  );
  return rows.length;
}

export async function listByEnrollment(enrollmentId: string): Promise<Period[]> {
  const res = await query<any>(
    `SELECT * FROM period WHERE enrollment_id = ? ORDER BY period_no ASC`,
    [enrollmentId]
  );
  return res.rows.map(mapRow);
}

export async function findById(id: string): Promise<Period | null> {
  const res = await query<any>(`SELECT * FROM period WHERE id = ?`, [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** 锁定读：资金类操作必须走这个，禁止先普通读再写（并发双发） */
export async function lockById(client: PoolConnection, id: string): Promise<Period | null> {
  const [rows] = await client.query(`SELECT * FROM period WHERE id = ? FOR UPDATE`, [id]);
  const r = (rows as any[])[0];
  return r ? mapRow(r) : null;
}

export async function findByWeek(
  enrollmentId: string,
  isoYear: number,
  isoWeek: number
): Promise<Period | null> {
  const res = await query<any>(
    `SELECT * FROM period WHERE enrollment_id = ? AND iso_year = ? AND iso_week = ?`,
    [enrollmentId, isoYear, isoWeek]
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function setCheckinAndTask(
  client: PoolConnection,
  periodId: string,
  input: {
    checkinId: string;
    taskMet: boolean;
    metDays: number;
    windowStart: string | null;
    dataAvailable: boolean;
  }
): Promise<void> {
  await client.query(
    `UPDATE period
        SET checkin_id = ?, task_met = ?, met_days = ?, window_start = ?, data_available = ?
      WHERE id = ?`,
    [
      input.checkinId,
      input.taskMet ? 1 : 0,
      input.metDays,
      input.windowStart,
      input.dataAvailable ? 1 : 0,
      periodId,
    ]
  );
}

export async function setRefund70(
  client: PoolConnection,
  periodId: string,
  amount: number,
  flowNo: string
): Promise<void> {
  await client.query(
    `UPDATE period
        SET refund70_amount = ?, refund70_flow = ?, refund70_at = CURRENT_TIMESTAMP(3)
      WHERE id = ?`,
    [amount, flowNo, periodId]
  );
}

export async function setRefund30(
  client: PoolConnection,
  periodId: string,
  amount: number,
  flowNo: string
): Promise<void> {
  await client.query(
    `UPDATE period
        SET refund30_amount = ?, refund30_flow = ?, refund30_at = CURRENT_TIMESTAMP(3)
      WHERE id = ?`,
    [amount, flowNo, periodId]
  );
}

export async function setMerchantSettled(
  client: PoolConnection,
  periodId: string,
  netAmount: number
): Promise<void> {
  await client.query(
    `UPDATE period SET merchant_settled = 1, merchant_amount = ? WHERE id = ?`,
    [netAmount, periodId]
  );
}

export async function setNoticeFlag(periodId: string, flag: number): Promise<void> {
  await query(`UPDATE period SET notice_flags = notice_flags | ? WHERE id = ?`, [flag, periodId]);
}

export async function hasNoticeFlag(periodId: string, flag: number): Promise<boolean> {
  const res = await query<any>(`SELECT notice_flags FROM period WHERE id = ?`, [periodId]);
  const v = Number(res.rows[0]?.notice_flags) || 0;
  return (v & flag) !== 0;
}

/** 把已过周且未核销的期次置为作废（幂等：只动 expired=0 的行） */
export async function expirePast(nowYmd: string): Promise<number> {
  const res = await query<any>(
    `UPDATE period
        SET expired = 1
      WHERE expired = 0 AND checkin_id IS NULL AND week_end < ?`,
    [nowYmd]
  );
  return Number(res.rowCount) || 0;
}

export async function listExpiringSoon(dateYmd: string): Promise<Period[]> {
  const res = await query<any>(
    `SELECT * FROM period
      WHERE expired = 0 AND checkin_id IS NULL AND week_end >= ?
      ORDER BY week_end ASC`,
    [dateYmd]
  );
  return res.rows.map(mapRow);
}
