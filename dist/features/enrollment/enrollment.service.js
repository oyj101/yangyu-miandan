"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.listMerchantEnrollments = void 0;
exports.purchase = purchase;
exports.getEnrollment = getEnrollment;
exports.refundEnrollment = refundEnrollment;
exports.listUserEnrollments = listUserEnrollments;
const errors_1 = require("../../lib/errors");
const enrollment_repo_1 = require("./enrollment.repo");
const card_repo_1 = require("../card/card.repo");
const db_1 = require("../../lib/db");
async function purchase(userId, cardId) {
    const card = await (0, card_repo_1.findCardById)(cardId);
    if (!card)
        throw (0, errors_1.notFound)("免单卡不存在");
    if (card.status !== "active")
        throw (0, errors_1.badRequest)("该免单卡未上架");
    // PRD 4.4：应发奖励总额 = 卡售价 × 免单覆盖率（受 coverage_cap 封顶）
    const effectiveCoverage = Math.min(card.coverage, card.coverageCap);
    const rewardTotal = Math.round(card.price * effectiveCoverage * 100) / 100;
    const existing = await (0, enrollment_repo_1.findActiveByUserCard)(userId, cardId);
    const reEnrolled = !!existing;
    return (0, enrollment_repo_1.insertEnrollment)({
        userId,
        cardId,
        merchantId: card.merchantId,
        rewardTotal,
        reEnrolled,
    });
}
async function getEnrollment(id) {
    const e = await (0, enrollment_repo_1.findEnrollment)(id);
    if (!e)
        throw (0, errors_1.notFound)("入渔记录不存在");
    return e;
}
/** 20261017 退款(PO 规则): 进度 30% 前~70% 内且无违规(养鱼零未达标) → 随时可退, 扣除所有已发奖励。
 * 退款额 = 卡价 - 已领奖励; 同步收回已发奖励余额(wallet debit, 失败记 audit 人工处理)。 */
async function refundEnrollment(userId, enrollmentId) {
    const e = await (0, enrollment_repo_1.findEnrollment)(enrollmentId);
    if (!e)
        throw (0, errors_1.notFound)("入渔记录不存在");
    if (e.userId !== userId)
        throw (0, errors_1.forbidden)("只能退自己的入渔");
    if (e.status !== "normal")
        throw (0, errors_1.badRequest)("当前状态不可退款");
    const progress = Number(e.rewardTotal) > 0 ? Number(e.rewardPaid) / Number(e.rewardTotal) : 0;
    if (progress >= 0.7)
        throw (0, errors_1.badRequest)("进度已达70%, 不可退款(完成转介绍可领最后30%)");
    if (Number(e.totalMissCount) > 0)
        throw (0, errors_1.badRequest)("存在养鱼未达标记录, 不符合退款条件");
    const card = await (0, card_repo_1.findCardById)(e.cardId);
    if (!card)
        throw (0, errors_1.notFound)("免单卡不存在");
    const refundAmount = Math.round((Number(card.price) - Number(e.rewardPaid)) * 100) / 100;
    const before = JSON.stringify({ status: e.status, rewardPaid: Number(e.rewardPaid) });
    await (0, db_1.withTx)(async (client) => {
        await client.query("UPDATE enrollment SET status='refunded', pause_remaining=0 WHERE id=?", [enrollmentId]);
        await client.query("INSERT INTO audit (id, operator, action, ref_type, ref_id, `before`, `after`) VALUES (?,?,?,?,?,?,?)", [(0, db_1.newId)(), userId, "enrollment.refund", "enrollment", enrollmentId, before,
            JSON.stringify({ status: "refunded", refundAmount })]);
    });
    // 收回已发奖励(余额 debit); 失败不影响退款标记, audit 已留痕
    let recovered = false;
    try {
        const mu = await (0, db_1.query)("SELECT ai_uid FROM merchant_user WHERE user_id = ? LIMIT 1", [userId]);
        const aiUid = mu.rows[0]?.ai_uid;
        const cfgMod = await Promise.resolve().then(() => __importStar(require("../../config")));
        const svcKey = (cfgMod.config?.wallet?.serviceKey) || (await Promise.resolve().then(() => __importStar(require("../../config")))).config.wallet.serviceKey;
        if (aiUid && svcKey) {
            const resp = await fetch(`${(cfgMod.config?.wallet?.base) || (await Promise.resolve().then(() => __importStar(require("../../config")))).config.wallet.base}/wallet/change`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Service-Key": svcKey },
                body: JSON.stringify({ uid: Number(aiUid), asset: "balance", amount: -Number(e.rewardPaid),
                    biz_type: "yangyu:refund", ledger: "zy", remark: `退款收回已发奖励 入渔 ${enrollmentId}`, biz_id: 0 }),
            });
            const j = await resp.json().catch(() => ({}));
            recovered = !!(j && (j.code === 0 || j.code === "0") && j.data && j.data.ok);
        }
    }
    catch (err) {
        console.error("[refund] recover failed", { enrollmentId, err: err?.message });
    }
    return { refundAmount, recovered, status: "refunded" };
}
exports.listMerchantEnrollments = enrollment_repo_1.listByMerchant;
// [Task-213] C 端「我的免单」：列出当前联邦用户全部入渔记录。
async function listUserEnrollments(userId) {
    return (0, enrollment_repo_1.listByUser)(userId);
}
//# sourceMappingURL=enrollment.service.js.map