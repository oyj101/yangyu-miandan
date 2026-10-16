"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPendingCards = exports.listMerchantCards = void 0;
exports.createApplication = createApplication;
exports.review = review;
exports.getGlobalParams = getGlobalParams;
exports.setGlobalParam = setGlobalParam;
const config_1 = require("../../config");
const errors_1 = require("../../lib/errors");
const card_repo_1 = require("./card.repo");
const db_1 = require("../../lib/db");
async function createApplication(input) {
    const coverageCap = input.coverageCap ?? config_1.config.reward.coverageCap;
    const coverage = input.coverage ?? 1.0;
    const perMerchantQuota = input.perMerchantQuota ?? config_1.config.reward.perMerchantQuota;
    // PRD F1.1：单次奖励 × 次数 ≤ 卡售价 × coverage_cap（防倒挂）
    const projectedReward = input.rewardPerTime * input.times;
    const upperBound = input.price * coverageCap;
    if (projectedReward > upperBound + 1e-9) {
        throw (0, errors_1.validationError)("奖励总额超过卡售价×coverage_cap上限，存在倒挂风险", {
            projectedReward,
            upperBound,
        });
    }
    // PRD 十：每店限量发行免单卡
    const active = await (0, card_repo_1.countActiveByMerchant)(input.merchantId);
    if (active >= perMerchantQuota) {
        throw (0, errors_1.conflict)(`该商家免单卡已达每店上限 ${perMerchantQuota}`);
    }
    return (0, card_repo_1.insertCard)({
        merchantId: input.merchantId,
        type: input.type,
        times: input.times,
        freq: input.freq,
        rewardPerTime: input.rewardPerTime,
        price: input.price,
        coverage,
        coverageCap,
        perMerchantQuota,
    });
}
async function review(cardId, approve, operator, rejectReason) {
    const card = await (0, card_repo_1.findCardById)(cardId);
    if (!card)
        throw (0, errors_1.notFound)("免单卡不存在");
    if (card.status !== "pending")
        throw (0, errors_1.badRequest)("该卡非待审核状态");
    if (!approve && !rejectReason)
        throw (0, errors_1.badRequest)("驳回需填写理由");
    const updated = await (0, card_repo_1.setCardStatus)(cardId, approve ? "active" : "offline", approve ? null : rejectReason ?? "未说明", operator);
    if (!updated)
        throw (0, errors_1.notFound)("免单卡不存在");
    return updated;
}
exports.listMerchantCards = card_repo_1.listByMerchant;
exports.listPendingCards = card_repo_1.listPending;
async function getGlobalParams() {
    const res = await (0, db_1.query)(`SELECT * FROM global_param`);
    return res.rows.map((r) => ({
        key: r.key,
        value: Number(r.value),
        operator: r.operator,
        updatedAt: r.updated_at,
    }));
}
async function setGlobalParam(key, value, operator) {
    await (0, db_1.query)(`INSERT INTO global_param (\`key\`, value, operator, updated_at)
     VALUES (?,?,?,CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE value = ?, operator = ?, updated_at = CURRENT_TIMESTAMP(3)`, [key, value, operator, value, operator]);
    const res = await (0, db_1.query)(`SELECT * FROM global_param WHERE \`key\` = ?`, [key]);
    const r = res.rows[0];
    return {
        key: r.key,
        value: Number(r.value),
        operator: r.operator,
        updatedAt: r.updated_at,
    };
}
//# sourceMappingURL=card.service.js.map