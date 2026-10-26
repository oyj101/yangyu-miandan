"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.insertPeriods = insertPeriods;
exports.listByEnrollment = listByEnrollment;
exports.findById = findById;
exports.lockById = lockById;
exports.findByWeek = findByWeek;
exports.setCheckinAndTask = setCheckinAndTask;
exports.setRefund70 = setRefund70;
exports.setRefund30 = setRefund30;
exports.setMerchantSettled = setMerchantSettled;
exports.setNoticeFlag = setNoticeFlag;
exports.hasNoticeFlag = hasNoticeFlag;
exports.expirePast = expirePast;
exports.listExpiringSoon = listExpiringSoon;
const db_1 = require("../../lib/db");
const date_1 = require("../../lib/date");
function mapRow(r) {
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
        weekStart: (0, date_1.ymdOfOrEmpty)(r.week_start),
        weekEnd: (0, date_1.ymdOfOrEmpty)(r.week_end),
        unitPrice: Number(r.unit_price),
        supplyPrice: Number(r.supply_price),
        // 006 快照列；旧行/未迁移环境回落到全局缺省，保证金额口径不会变成 NaN
        shareRatio: r.share_ratio == null ? 0.3 : Number(r.share_ratio),
        refundNowRatio: r.refund_now_ratio == null ? 0.7 : Number(r.refund_now_ratio),
        checkinId: r.checkin_id || null,
        taskMet: Number(r.task_met) === 1,
        metDays: Number(r.met_days) || 0,
        windowStart: (0, date_1.ymdOf)(r.window_start),
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
/**
 * 批量创建期次。幂等：uk_period_no 冲突时整批失败 → 调用方视为"已建"。
 * 用单条多值 INSERT，避免 N 次往返。
 */
async function insertPeriods(rows) {
    if (rows.length === 0)
        return 0;
    const cols = 14;
    const placeholders = rows.map(() => `(${Array(cols).fill("?").join(",")})`).join(",");
    const params = [];
    for (const r of rows) {
        params.push((0, db_1.newId)(), r.enrollmentId, r.cardId, r.userId, r.merchantId, r.periodNo, r.isoYear, r.isoWeek, r.weekStart, r.weekEnd, r.unitPrice, r.supplyPrice, r.shareRatio, r.refundNowRatio);
    }
    await (0, db_1.query)(`INSERT INTO period
       (id, enrollment_id, card_id, user_id, merchant_id, period_no,
        iso_year, iso_week, week_start, week_end, unit_price, supply_price,
        share_ratio, refund_now_ratio)
     VALUES ${placeholders}`, params);
    return rows.length;
}
async function listByEnrollment(enrollmentId) {
    const res = await (0, db_1.query)(`SELECT * FROM period WHERE enrollment_id = ? ORDER BY period_no ASC`, [enrollmentId]);
    return res.rows.map(mapRow);
}
async function findById(id) {
    const res = await (0, db_1.query)(`SELECT * FROM period WHERE id = ?`, [id]);
    return res.rows[0] ? mapRow(res.rows[0]) : null;
}
/** 锁定读：资金类操作必须走这个，禁止先普通读再写（并发双发） */
async function lockById(client, id) {
    const [rows] = await client.query(`SELECT * FROM period WHERE id = ? FOR UPDATE`, [id]);
    const r = rows[0];
    return r ? mapRow(r) : null;
}
async function findByWeek(enrollmentId, isoYear, isoWeek) {
    const res = await (0, db_1.query)(`SELECT * FROM period WHERE enrollment_id = ? AND iso_year = ? AND iso_week = ?`, [enrollmentId, isoYear, isoWeek]);
    return res.rows[0] ? mapRow(res.rows[0]) : null;
}
async function setCheckinAndTask(client, periodId, input) {
    await client.query(`UPDATE period
        SET checkin_id = ?, task_met = ?, met_days = ?, window_start = ?, data_available = ?
      WHERE id = ?`, [
        input.checkinId,
        input.taskMet ? 1 : 0,
        input.metDays,
        input.windowStart,
        input.dataAvailable ? 1 : 0,
        periodId,
    ]);
}
async function setRefund70(client, periodId, amount, flowNo) {
    await client.query(`UPDATE period
        SET refund70_amount = ?, refund70_flow = ?, refund70_at = CURRENT_TIMESTAMP(3)
      WHERE id = ?`, [amount, flowNo, periodId]);
}
async function setRefund30(client, periodId, amount, flowNo) {
    await client.query(`UPDATE period
        SET refund30_amount = ?, refund30_flow = ?, refund30_at = CURRENT_TIMESTAMP(3)
      WHERE id = ?`, [amount, flowNo, periodId]);
}
async function setMerchantSettled(client, periodId, netAmount) {
    await client.query(`UPDATE period SET merchant_settled = 1, merchant_amount = ? WHERE id = ?`, [netAmount, periodId]);
}
async function setNoticeFlag(periodId, flag) {
    await (0, db_1.query)(`UPDATE period SET notice_flags = notice_flags | ? WHERE id = ?`, [flag, periodId]);
}
async function hasNoticeFlag(periodId, flag) {
    const res = await (0, db_1.query)(`SELECT notice_flags FROM period WHERE id = ?`, [periodId]);
    const v = Number(res.rows[0]?.notice_flags) || 0;
    return (v & flag) !== 0;
}
/** 把已过周且未核销的期次置为作废（幂等：只动 expired=0 的行） */
async function expirePast(nowYmd) {
    const res = await (0, db_1.query)(`UPDATE period
        SET expired = 1
      WHERE expired = 0 AND checkin_id IS NULL AND week_end < ?`, [nowYmd]);
    return Number(res.rowCount) || 0;
}
async function listExpiringSoon(dateYmd) {
    const res = await (0, db_1.query)(`SELECT * FROM period
      WHERE expired = 0 AND checkin_id IS NULL AND week_end >= ?
      ORDER BY week_end ASC`, [dateYmd]);
    return res.rows.map(mapRow);
}
//# sourceMappingURL=period.repo.js.map