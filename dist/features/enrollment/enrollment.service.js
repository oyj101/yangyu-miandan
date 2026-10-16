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
exports.getEnrollmentUserId = getEnrollmentUserId;
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
/** 20261017 PO: 退款通道可选 —— balance=退到钱包余额(即时); original=微信原路退(支付接入后执行, 先落 pending 单据)。
 * 运营后台(OPERATOR)可选通道并代退任意入渔; 用户自助退默认 balance。 */
async function refundEnrollment(userId, enrollmentId, opts = {}) {
    const channel = opts.channel === "original" ? "original" : "balance";
    const e = await (0, enrollment_repo_1.findEnrollment)(enrollmentId);
    if (!e)
        throw (0, errors_1.notFound)("入渔记录不存在");
    if (!opts.byOperator && e.userId !== userId)
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
    // 资金面: ①收回已发奖励(奖励扣除) ②退款按通道执行
    const cfg = await Promise.resolve().then(() => __importStar(require("../../config")));
    const svcKey = cfg.config.wallet.serviceKey;
    const base = cfg.config.wallet.base;
    const mu = await (0, db_1.query)("SELECT ai_uid FROM merchant_user WHERE user_id = ? LIMIT 1", [e.userId]);
    const aiUid = Number(mu.rows[0]?.ai_uid || 0);
    const callWallet = async (amount, bizType, remark) => {
        if (!aiUid || !svcKey)
            return false;
        try {
            const resp = await fetch(`${base}/wallet/change`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Service-Key": svcKey },
                body: JSON.stringify({ uid: aiUid, asset: "balance", amount, biz_type: bizType, ledger: "zy", remark, biz_id: 0 }),
            });
            const j = await resp.json().catch(() => ({}));
            return !!(j && (j.code === 0 || j.code === "0") && j.data && j.data.ok);
        }
        catch (err) {
            console.error("[refund] wallet call failed", { enrollmentId, err: err?.message });
            return false;
        }
    };
    let recovered = false;
    if (Number(e.rewardPaid) > 0) {
        recovered = await callWallet(-Number(e.rewardPaid), "yangyu:refund", `退款收回已发奖励 入渔 ${enrollmentId}`);
        if (!recovered)
            console.error("[refund] reward recovery failed, see audit", { enrollmentId });
    }
    // 退款本金: 当前免费领卡无实付, 接支付后 balance=即时到账 / original=微信原路退。无实付仅记账不发放。
    let refunded = false;
    let refundNote = "";
    if (channel === "balance") {
        refunded = await callWallet(refundAmount, "yangyu:refund_payout", `退款到余额 入渔 ${enrollmentId} 通道:balance`);
        refundNote = refunded ? "已退到余额" : "余额退款失败, 待人工";
    }
    else {
        refundNote = "原路退通道: 待微信支付退款API接入后执行(pending)";
        await (0, db_1.withTx)(async (client) => {
            await client.query("INSERT INTO audit (id, operator, action, ref_type, ref_id, `before`, `after`) VALUES (?,?,?,?,?,?,?)", [(0, db_1.newId)(), userId, "enrollment.refund.original_pending", "enrollment", enrollmentId, before,
                JSON.stringify({ channel, refundAmount, state: "pending_wechat_refund_api" })]);
        });
    }
    return { refundAmount, channel, recovered, refunded, refundNote, status: "refunded" };
}
/** 退款权限判定辅助: 返回 enrollment 归属 userId(不存在返回空串) */
async function getEnrollmentUserId(enrollmentId) {
    const e = await (0, enrollment_repo_1.findEnrollment)(enrollmentId);
    return e ? e.userId : "";
}
exports.listMerchantEnrollments = enrollment_repo_1.listByMerchant;
// [Task-213] C 端「我的免单」：列出当前联邦用户全部入渔记录。
async function listUserEnrollments(userId) {
    return (0, enrollment_repo_1.listByUser)(userId);
}
//# sourceMappingURL=enrollment.service.js.map