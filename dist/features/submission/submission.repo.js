"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.insertSubmission = insertSubmission;
exports.findSubmissionById = findSubmissionById;
exports.listByMerchant = listByMerchant;
exports.listPending = listPending;
exports.setSubmissionStatus = setSubmissionStatus;
const db_1 = require("../../lib/db");
function mapRow(r) {
    return {
        id: r.id,
        merchantId: r.merchant_id,
        productId: r.product_id,
        supplyPrice: Number(r.supply_price),
        quota: Number(r.quota),
        status: r.status,
        rejectReason: r.reject_reason ?? null,
        operator: r.operator ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}
async function insertSubmission(input) {
    const id = (0, db_1.newId)();
    await (0, db_1.query)(`INSERT INTO merchant_submission (id, merchant_id, product_id, supply_price, quota)
     VALUES (?,?,?,?,?)`, [id, input.merchantId, input.productId, input.supplyPrice, input.quota]);
    const row = await findSubmissionById(id);
    if (!row)
        throw new Error("insertSubmission 回读失败");
    return row;
}
async function findSubmissionById(id) {
    const res = await (0, db_1.query)(`SELECT * FROM merchant_submission WHERE id = ?`, [id]);
    return res.rows[0] ? mapRow(res.rows[0]) : null;
}
async function listByMerchant(merchantId) {
    const res = await (0, db_1.query)(`SELECT * FROM merchant_submission WHERE merchant_id = ? ORDER BY created_at DESC`, [merchantId]);
    return res.rows.map(mapRow);
}
async function listPending() {
    const res = await (0, db_1.query)(`SELECT * FROM merchant_submission WHERE status = 'submitted' ORDER BY created_at ASC`);
    return res.rows.map(mapRow);
}
async function setSubmissionStatus(id, status, operator, rejectReason) {
    await (0, db_1.query)(`UPDATE merchant_submission SET status = ?, operator = ?, reject_reason = ? WHERE id = ?`, [status, operator, status === "rejected" ? rejectReason ?? "未说明" : null, id]);
    return findSubmissionById(id);
}
//# sourceMappingURL=submission.repo.js.map