"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.insertTasks = insertTasks;
exports.findById = findById;
exports.findByPeriodId = findByPeriodId;
exports.lockById = lockById;
exports.listByEnrollment = listByEnrollment;
exports.listByUser = listByUser;
exports.listByMerchant = listByMerchant;
exports.markShipped = markShipped;
exports.markDelivered = markDelivered;
exports.markSigned = markSigned;
exports.markCancelled = markCancelled;
exports.setCheckinId = setCheckinId;
exports.countByEnrollmentStatus = countByEnrollmentStatus;
const db_1 = require("../../lib/db");
const date_1 = require("../../lib/date");
function mapRow(r) {
    return {
        id: r.id,
        periodId: r.period_id,
        enrollmentId: r.enrollment_id,
        cardId: r.card_id,
        userId: r.user_id,
        merchantId: r.merchant_id,
        periodNo: Number(r.period_no),
        // DATE 列（mysql2 返回 Date 对象）：必须归一，否则得到 'Tue Nov 03'
        weekStart: (0, date_1.ymdOfOrEmpty)(r.week_start),
        weekEnd: (0, date_1.ymdOfOrEmpty)(r.week_end),
        mode: (r.mode ?? "delivery"),
        status: r.status,
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
/**
 * 批量建配送任务。
 * INSERT IGNORE + uk_delivery_period：一期一条，重复调用不报错也不重复建，
 * 这是 attach（购买时/补建时/切换履约时都会调）能安全幂等的前提。
 */
async function insertTasks(rows) {
    if (rows.length === 0)
        return 0;
    const cols = 13;
    const placeholders = rows.map(() => `(${Array(cols).fill("?").join(",")})`).join(",");
    const params = [];
    for (const r of rows) {
        params.push((0, db_1.newId)(), r.periodId, r.enrollmentId, r.cardId, r.userId, r.merchantId, r.periodNo, r.weekStart, r.weekEnd, r.mode, r.receiverName, r.receiverPhone, r.receiverAddress);
    }
    const res = await (0, db_1.query)(`INSERT IGNORE INTO delivery_task
       (id, period_id, enrollment_id, card_id, user_id, merchant_id, period_no,
        week_start, week_end, mode, receiver_name, receiver_phone, receiver_address)
     VALUES ${placeholders}`, params);
    return Number(res.rowCount) || 0;
}
async function findById(id) {
    const res = await (0, db_1.query)(`SELECT * FROM delivery_task WHERE id = ?`, [id]);
    return res.rows[0] ? mapRow(res.rows[0]) : null;
}
async function findByPeriodId(periodId) {
    const res = await (0, db_1.query)(`SELECT * FROM delivery_task WHERE period_id = ?`, [periodId]);
    return res.rows[0] ? mapRow(res.rows[0]) : null;
}
/** 锁定读：签收要触发资金发奖，必须先锁任务行，防并发双签 */
async function lockById(client, id) {
    const [rows] = await client.query(`SELECT * FROM delivery_task WHERE id = ? FOR UPDATE`, [id]);
    const r = rows[0];
    return r ? mapRow(r) : null;
}
async function listByEnrollment(enrollmentId) {
    const res = await (0, db_1.query)(`SELECT * FROM delivery_task WHERE enrollment_id = ? ORDER BY period_no ASC`, [enrollmentId]);
    return res.rows.map(mapRow);
}
async function listByUser(userId) {
    const res = await (0, db_1.query)(`SELECT * FROM delivery_task WHERE user_id = ? ORDER BY week_start DESC, period_no ASC`, [userId]);
    return res.rows.map(mapRow);
}
async function listByMerchant(merchantId, opts = {}) {
    const params = [merchantId];
    let sql = `SELECT * FROM delivery_task WHERE merchant_id = ?`;
    if (opts.status) {
        sql += ` AND status = ?`;
        params.push(opts.status);
    }
    sql += ` ORDER BY week_start ASC, period_no ASC LIMIT ?`;
    params.push(Math.min(Math.max(Number(opts.limit) || 200, 1), 500));
    const res = await (0, db_1.query)(sql, params);
    return res.rows.map(mapRow);
}
async function markShipped(id, input) {
    await (0, db_1.query)(`UPDATE delivery_task
        SET status='shipped', shipped_at=CURRENT_TIMESTAMP(3),
            courier=?, tracking_no=?, operator=?, remark=COALESCE(?, remark)
      WHERE id=?`, [input.courier, input.trackingNo, input.operator, input.remark, id]);
}
async function markDelivered(id, input) {
    await (0, db_1.query)(`UPDATE delivery_task
        SET status='delivered', delivered_at=CURRENT_TIMESTAMP(3),
            operator=?, remark=COALESCE(?, remark)
      WHERE id=?`, [input.operator, input.remark, id]);
}
/** 签收 + 回写核销记录（同一事务内，保证"签收了但没核销"不会留下中间态） */
async function markSigned(client, id, input) {
    await client.query(`UPDATE delivery_task
        SET status='signed', signed_at=CURRENT_TIMESTAMP(3), signed_by=?, operator=?,
            remark=COALESCE(?, remark), checkin_id=COALESCE(?, checkin_id)
      WHERE id=?`, [input.signedBy, input.operator, input.remark, input.checkinId, id]);
}
async function markCancelled(id, operator, remark) {
    await (0, db_1.query)(`UPDATE delivery_task SET status='cancelled', operator=?, remark=COALESCE(?, remark) WHERE id=?`, [operator, remark, id]);
}
/** 回写核销 id（签收走核销链路后调用；独立事务时的兜底路径） */
async function setCheckinId(id, checkinId) {
    await (0, db_1.query)(`UPDATE delivery_task SET checkin_id=? WHERE id=? AND checkin_id IS NULL`, [checkinId, id]);
}
async function countByEnrollmentStatus(enrollmentId, statuses) {
    if (statuses.length === 0)
        return 0;
    const ph = statuses.map(() => "?").join(",");
    const res = await (0, db_1.query)(`SELECT COUNT(*) AS c FROM delivery_task WHERE enrollment_id = ? AND status IN (${ph})`, [enrollmentId, ...statuses]);
    return Number(res.rows[0]?.c) || 0;
}
//# sourceMappingURL=delivery.repo.js.map