"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applySubmissionReview = applySubmissionReview;
exports.createSubmission = createSubmission;
exports.listSubmissions = listSubmissions;
exports.reviewSubmission = reviewSubmission;
const errors_1 = require("../../lib/errors");
const submission_repo_1 = require("./submission.repo");
const catalog_repo_1 = require("../catalog/catalog.repo");
/**
 * 提报审核状态机（纯函数，便于穷举测试）。
 * 只有 submitted 可被审核；approved/rejected 终态不可逆（重提请新建提报）。
 */
function applySubmissionReview(current, action) {
    if (current !== "submitted") {
        throw (0, errors_1.badRequest)(`提报当前为 ${current}，已是终态，不可重复审核`);
    }
    return action === "approve" ? "approved" : "rejected";
}
/**
 * 商户提报：从自有商品库选品 + 设活动供应价 + 参与数量（份数）。
 * 校验：商品存在、属于该商户、且为 active（下架商品不可提报）。
 */
async function createSubmission(input, actor) {
    if (actor.role === "MERCHANT" && actor.merchantId && actor.merchantId !== input.merchantId) {
        throw (0, errors_1.forbidden)("只能为自己的商家提报");
    }
    if (input.supplyPrice < 0)
        throw (0, errors_1.badRequest)("活动供应价不能为负");
    if (!(input.quota > 0))
        throw (0, errors_1.badRequest)("参与数量必须为正整数");
    const product = await (0, catalog_repo_1.findProductById)(input.productId);
    if (!product)
        throw (0, errors_1.notFound)("所选商品不存在");
    if (product.merchantId !== input.merchantId) {
        throw (0, errors_1.forbidden)("只能提报自己商家的商品");
    }
    if (product.status !== "active") {
        throw (0, errors_1.badRequest)("该商品已下架，请先上架再提报");
    }
    return (0, submission_repo_1.insertSubmission)({
        merchantId: input.merchantId,
        productId: input.productId,
        supplyPrice: Math.round(input.supplyPrice * 100) / 100,
        quota: Math.floor(input.quota),
    });
}
/** 列提报：MERCHANT 看自己；OPERATOR 看全部 */
async function listSubmissions(merchantId, actor) {
    if (actor.role === "MERCHANT") {
        if (actor.merchantId && actor.merchantId !== merchantId) {
            throw (0, errors_1.forbidden)("只能查看自己商家的提报");
        }
        return (0, submission_repo_1.listByMerchant)(merchantId);
    }
    return (0, submission_repo_1.listPending)();
}
/**
 * OPERATOR 审核提报。通过后由「据此设计套餐卡」(card.designPackageCard + submissionId) 落地。
 * 此处只改提报状态，不耦合卡设计，职责单一。
 */
async function reviewSubmission(submissionId, approve, operator, rejectReason) {
    const sub = await (0, submission_repo_1.findSubmissionById)(submissionId);
    if (!sub)
        throw (0, errors_1.notFound)("提报不存在");
    const next = applySubmissionReview(sub.status, approve ? "approve" : "reject");
    if (approve && !rejectReason) {
        // 通过无需理由；仅占位
    }
    else if (!approve && !rejectReason) {
        throw (0, errors_1.badRequest)("驳回需填写理由");
    }
    const updated = await (0, submission_repo_1.setSubmissionStatus)(submissionId, next, operator, approve ? null : rejectReason ?? "未说明");
    if (!updated)
        throw (0, errors_1.notFound)("提报不存在");
    return updated;
}
//# sourceMappingURL=submission.service.js.map