"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.insertEnrollment = insertEnrollment;
exports.findEnrollment = findEnrollment;
exports.findActiveByUserCard = findActiveByUserCard;
exports.updateEnrollState = updateEnrollState;
exports.setEnrollStatus = setEnrollStatus;
exports.listByMerchant = listByMerchant;
exports.listByUser = listByUser;
exports.toState = toState;
const db_1 = require("../../lib/db");
function mapRow(r) {
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
        // v2：分享成交解锁整卡剩余 30%（整卡一次，非每期一次）
        shareUnlocked: Number(r.share_unlocked) === 1,
        // 配送分支（009）：未迁移环境无这些列时按自提/免运费兜底，读路径不会 NaN
        fulfillMode: (r.fulfill_mode ?? "pickup"),
        receiverName: r.receiver_name ?? null,
        receiverPhone: r.receiver_phone ?? null,
        receiverAddress: r.receiver_address ?? null,
        freightAmount: r.freight_amount == null ? 0 : Number(r.freight_amount),
        freightPayOrderNo: r.freight_pay_order_no || null,
        freightPayStatus: r.freight_pay_status || "none",
        totalPeriods: r.total_periods == null ? null : Number(r.total_periods),
    };
}
// 主键应用层生成 + 插入后回读（同 card.repo：不依赖 INSERT..RETURNING）
async function insertEnrollment(input) {
    const id = (0, db_1.newId)();
    await (0, db_1.query)(`INSERT INTO enrollment (id, user_id, card_id, merchant_id, reward_total, re_enrolled)
     VALUES (?,?,?,?,?,?)`, [id, input.userId, input.cardId, input.merchantId, input.rewardTotal, input.reEnrolled]);
    const row = await findEnrollment(id);
    if (!row)
        throw new Error("insertEnrollment 回读失败");
    return row;
}
async function findEnrollment(id) {
    const res = await (0, db_1.query)(`SELECT * FROM enrollment WHERE id = ?`, [id]);
    return res.rows[0] ? mapRow(res.rows[0]) : null;
}
async function findActiveByUserCard(userId, cardId) {
    const res = await (0, db_1.query)(`SELECT * FROM enrollment WHERE user_id = ? AND card_id = ? AND status NOT IN ('exited','refunded')`, [userId, cardId]);
    return res.rows[0] ? mapRow(res.rows[0]) : null;
}
async function updateEnrollState(conn, id, state) {
    await conn.query(`UPDATE enrollment
     SET status=?, consecutive_miss=?, total_miss_count=?, pause_remaining=?, reward_paid=?
     WHERE id=?`, [state.status, state.consecutiveMiss, state.totalMissCount, state.pauseRemaining, state.rewardPaid, id]);
}
async function setEnrollStatus(conn, id, status) {
    await conn.query(`UPDATE enrollment SET status=? WHERE id=?`, [status, id]);
}
async function listByMerchant(merchantId, statusFilter) {
    const params = [merchantId];
    let sql = `SELECT * FROM enrollment WHERE merchant_id = ?`;
    if (statusFilter) {
        sql += ` AND status = ?`;
        params.push(statusFilter);
    }
    sql += ` ORDER BY enroll_at DESC`;
    const res = await (0, db_1.query)(sql, params);
    return res.rows.map(mapRow);
}
// [Task-213] 我的入渔列表（C 端「我的免单」）：按联邦用户 user_id 反查全部入渔记录。
// enrollment.user_id 锚定 merchant_user.user_id（如 au_1），与 federate 注入的 req.fedUser.userId 一致。
async function listByUser(userId) {
    const res = await (0, db_1.query)(`SELECT * FROM enrollment WHERE user_id = ? ORDER BY enroll_at DESC`, [userId]);
    return res.rows.map(mapRow);
}
function toState(e) {
    return {
        status: e.status,
        consecutiveMiss: e.consecutiveMiss,
        totalMissCount: e.totalMissCount,
        pauseRemaining: e.pauseRemaining,
        rewardPaid: e.rewardPaid,
        rewardTotal: e.rewardTotal,
    };
}
//# sourceMappingURL=enrollment.repo.js.map