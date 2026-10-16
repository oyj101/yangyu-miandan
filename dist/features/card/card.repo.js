"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.insertCard = insertCard;
exports.findCardById = findCardById;
exports.countActiveByMerchant = countActiveByMerchant;
exports.setCardStatus = setCardStatus;
exports.listByMerchant = listByMerchant;
exports.listPending = listPending;
exports.listPublic = listPublic;
const db_1 = require("../../lib/db");
function mapRow(r) {
    return {
        id: r.id,
        merchantId: r.merchant_id,
        type: r.type,
        times: r.times,
        freq: r.freq,
        rewardPerTime: Number(r.reward_per_time),
        price: Number(r.price),
        coverage: Number(r.coverage),
        coverageCap: Number(r.coverage_cap),
        perMerchantQuota: r.per_merchant_quota,
        status: r.status,
        rejectReason: r.reject_reason,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}
// 主键由应用层生成（CHAR(36)），插入后回读拿 DB 默认值（created_at 等）。
// 不用 INSERT..RETURNING：mysql2 对该语法结果集回传无保证，跨版本行为不稳。
async function insertCard(input) {
    const id = (0, db_1.newId)();
    await (0, db_1.query)(`INSERT INTO card (id, merchant_id, type, times, freq, reward_per_time, price, coverage, coverage_cap, per_merchant_quota)
     VALUES (?,?,?,?,?,?,?,?,?,?)`, [
        id,
        input.merchantId,
        input.type,
        input.times,
        input.freq,
        input.rewardPerTime,
        input.price,
        input.coverage,
        input.coverageCap,
        input.perMerchantQuota,
    ]);
    const row = await findCardById(id);
    if (!row)
        throw new Error("insertCard 回读失败");
    return row;
}
async function findCardById(id) {
    const res = await (0, db_1.query)(`SELECT * FROM card WHERE id = ?`, [id]);
    return res.rows[0] ? mapRow(res.rows[0]) : null;
}
async function countActiveByMerchant(merchantId) {
    const res = await (0, db_1.query)(`SELECT COUNT(*) AS c FROM card WHERE merchant_id = ? AND status = 'active'`, [merchantId]);
    // mysql2 对 COUNT(*) 返回字符串（BIGINT），必须显式数值化；"0" 为 truthy，不可用 ??
    return Number(res.rows[0]?.c) || 0;
}
async function setCardStatus(id, status, rejectReason, operator) {
    return (0, db_1.withTx)(async (client) => {
        await client.query(`UPDATE card SET status = ?, reject_reason = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`, [status, rejectReason, id]);
        const sel = await client.query(`SELECT * FROM card WHERE id = ?`, [id]);
        const row = sel[0][0];
        if (!row)
            return null;
        await client.query(`INSERT INTO audit (id, operator, action, ref_type, ref_id, \`after\`) VALUES (?,'review',?,?,?,?)`, [(0, db_1.newId)(), operator, "card", id, JSON.stringify({ status, rejectReason })]);
        return mapRow(row);
    });
}
async function listByMerchant(merchantId) {
    const res = await (0, db_1.query)(`SELECT * FROM card WHERE merchant_id = ? ORDER BY created_at DESC`, [
        merchantId,
    ]);
    return res.rows.map(mapRow);
}
async function listPending() {
    const res = await (0, db_1.query)(`SELECT * FROM card WHERE status = 'pending' ORDER BY created_at ASC`);
    return res.rows.map(mapRow);
}
// [Task-213] 公开免单卡列表（C 端「拼场大厅」）：仅返回已上架(active)卡片。
// 注：merchant_id 锚定主站 zy_merchants.id，商户展示名由 C 端经主平台门店接口解析（后续迭代）。
async function listPublic() {
    const res = await (0, db_1.query)(`SELECT * FROM card WHERE status = 'active' ORDER BY created_at DESC`);
    return res.rows.map(mapRow);
}
//# sourceMappingURL=card.repo.js.map