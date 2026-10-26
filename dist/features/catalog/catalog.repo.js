"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.insertProduct = insertProduct;
exports.findProductById = findProductById;
exports.listByMerchant = listByMerchant;
exports.listAll = listAll;
exports.updateProduct = updateProduct;
exports.setProductStatus = setProductStatus;
const db_1 = require("../../lib/db");
function mapRow(r) {
    return {
        id: r.id,
        merchantId: r.merchant_id,
        name: r.name,
        category: r.category ?? null,
        coverUrl: r.cover_url ?? null,
        spec: r.spec ?? null,
        originPrice: r.origin_price == null ? null : Number(r.origin_price),
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}
async function insertProduct(input) {
    const id = (0, db_1.newId)();
    await (0, db_1.query)(`INSERT INTO merchant_product (id, merchant_id, name, category, cover_url, spec, origin_price)
     VALUES (?,?,?,?,?,?,?)`, [id, input.merchantId, input.name, input.category, input.coverUrl, input.spec, input.originPrice]);
    const row = await findProductById(id);
    if (!row)
        throw new Error("insertProduct 回读失败");
    return row;
}
async function findProductById(id) {
    const res = await (0, db_1.query)(`SELECT * FROM merchant_product WHERE id = ?`, [id]);
    return res.rows[0] ? mapRow(res.rows[0]) : null;
}
async function listByMerchant(merchantId) {
    const res = await (0, db_1.query)(`SELECT * FROM merchant_product WHERE merchant_id = ? ORDER BY created_at DESC`, [merchantId]);
    return res.rows.map(mapRow);
}
async function listAll() {
    const res = await (0, db_1.query)(`SELECT * FROM merchant_product ORDER BY created_at DESC`);
    return res.rows.map(mapRow);
}
async function updateProduct(id, patch) {
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(patch)) {
        sets.push(`${k} = ?`);
        params.push(v);
    }
    if (!sets.length)
        return findProductById(id);
    params.push(id);
    await (0, db_1.query)(`UPDATE merchant_product SET ${sets.join(", ")} WHERE id = ?`, params);
    return findProductById(id);
}
async function setProductStatus(id, status) {
    await (0, db_1.query)(`UPDATE merchant_product SET status = ? WHERE id = ?`, [status, id]);
    return findProductById(id);
}
//# sourceMappingURL=catalog.repo.js.map