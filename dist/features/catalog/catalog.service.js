"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProduct = createProduct;
exports.listProducts = listProducts;
exports.updateProductById = updateProductById;
exports.setStatus = setStatus;
const errors_1 = require("../../lib/errors");
const catalog_repo_1 = require("./catalog.repo");
/**
 * 商户新建自有商品（商品库）。
 * 商户只能给自己建；OPERATOR 代建也允许（运营帮商户录入）。
 */
async function createProduct(input, actor) {
    if (!input.name || !input.name.trim())
        throw (0, errors_1.badRequest)("商品名不能为空");
    if (actor.role === "MERCHANT" && actor.merchantId && actor.merchantId !== input.merchantId) {
        throw (0, errors_1.forbidden)("只能为自己的商家创建商品");
    }
    if (input.originPrice != null && input.originPrice < 0) {
        throw (0, errors_1.badRequest)("原价不能为负");
    }
    return (0, catalog_repo_1.insertProduct)({
        merchantId: input.merchantId,
        name: input.name.trim().slice(0, 120),
        category: input.category ?? null,
        coverUrl: input.coverUrl ?? null,
        spec: input.spec ?? null,
        originPrice: input.originPrice ?? null,
    });
}
/** 列商品：MERCHANT 只看自己的；OPERATOR 看全部 */
async function listProducts(merchantId, actor) {
    if (actor.role === "MERCHANT") {
        if (actor.merchantId && actor.merchantId !== merchantId) {
            throw (0, errors_1.forbidden)("只能查看自己商家的商品");
        }
        return (0, catalog_repo_1.listByMerchant)(merchantId);
    }
    return (0, catalog_repo_1.listAll)();
}
async function assertOwned(productId, actor) {
    const p = await (0, catalog_repo_1.findProductById)(productId);
    if (!p)
        throw (0, errors_1.notFound)("商品不存在");
    if (actor.role === "MERCHANT" && actor.merchantId && actor.merchantId !== p.merchantId) {
        throw (0, errors_1.forbidden)("只能修改自己商家的商品");
    }
    return p;
}
async function updateProductById(productId, patch, actor) {
    await assertOwned(productId, actor);
    if (patch.name !== undefined && !patch.name.trim())
        throw (0, errors_1.badRequest)("商品名不能为空");
    const normalized = {};
    if (patch.name !== undefined)
        normalized.name = patch.name.trim().slice(0, 120);
    if (patch.category !== undefined)
        normalized.category = patch.category;
    if (patch.coverUrl !== undefined)
        normalized.cover_url = patch.coverUrl;
    if (patch.spec !== undefined)
        normalized.spec = patch.spec;
    if (patch.originPrice != null) {
        if (patch.originPrice < 0)
            throw (0, errors_1.badRequest)("原价不能为负");
        normalized.origin_price = patch.originPrice;
    }
    const updated = await (0, catalog_repo_1.updateProduct)(productId, normalized);
    if (!updated)
        throw (0, errors_1.notFound)("商品不存在");
    return updated;
}
async function setStatus(productId, status, actor) {
    await assertOwned(productId, actor);
    const updated = await (0, catalog_repo_1.setProductStatus)(productId, status);
    if (!updated)
        throw (0, errors_1.notFound)("商品不存在");
    return updated;
}
//# sourceMappingURL=catalog.service.js.map