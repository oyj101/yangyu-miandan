"use strict";
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
const period_service_1 = require("../period/period.service");
const db_1 = require("../../lib/db");
const logger_1 = require("../../lib/logger");
const fund_1 = require("../../lib/fund");
const pay_guard_1 = require("./pay-guard");
/** 20261017 购买接支付(PO): pay=true 时走 8100 统一支付真源下单(NATIVE/JSAPI), 落 pay_order_no + pay_status=unpaid;
 * 支付成功后由 pay-guard 查单确认并回写 paid，核销才放行。pay=false/缺省=免费领卡模式(pay_status=none)。
 * 基础能力不得自实现：微信下单/查单/退款一律经 lib/fund.ts（唯一出口）。 */
async function purchase(userId, cardId, opts = {}) {
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
    // v2 套餐卡：先校验四要素（fail-closed），避免"付了钱却没有期次可核销"
    const isPackage = card.periods != null && card.unitPrice != null && card.supplyPrice != null;
    if (isPackage)
        (0, period_service_1.assertPackageCard)(card);
    const e = await (0, enrollment_repo_1.insertEnrollment)({
        userId,
        cardId,
        merchantId: card.merchantId,
        rewardTotal,
        reEnrolled,
    });
    // v2：购买即生成 N 条期次（首期 = 下一个完整 ISO 周）。
    // 期次只是日程表，不含资金；未实付前不可核销，由核销侧 pay_status 闸门拦截。
    // 生成失败不阻断支付主流程（期次可由运营补建，幂等），但必须留痕。
    if (isPackage) {
        try {
            await (0, period_service_1.createPeriodsForEnrollment)({
                enrollmentId: e.id,
                cardId,
                userId,
                merchantId: card.merchantId,
                purchasedAt: new Date(),
            });
        }
        catch (err) {
            console.error("[purchase] 期次生成失败，需补建", {
                enrollmentId: e.id,
                cardId,
                err: err?.message,
            });
            await (0, db_1.query)("INSERT INTO audit (id, operator, action, ref_type, ref_id, `after`) VALUES (?,?,?,?,?,?)", [
                (0, db_1.newId)(),
                "system",
                "period.create_failed",
                "enrollment",
                e.id,
                JSON.stringify({ cardId, err: String(err?.message ?? err).slice(0, 400) }),
            ]);
        }
    }
    if (opts.pay) {
        // 下单只是"生成支付单"，不等于已支付。支付态唯一真源在 8100，
        // 本地 pay_status 只写 unpaid，等 ensurePaid() 查单回写。
        // 失败不阻断购卡（期次已生成、卡已到手），但必须留结构化失败痕迹供对账。
        try {
            const aiUid = await (0, fund_1.resolveAiUid)(userId);
            const amountFen = Math.round(Number(card.price) * 100);
            if (!aiUid) {
                logger_1.logger.warn({ userId, cardId, enrollmentId: e.id }, "未联邦用户下单被跳过");
            }
            else {
                const r = await (0, fund_1.payCreate)({
                    aiUid,
                    amountFen,
                    channel: opts.channel === "jsapi" ? "jsapi" : "native",
                    openid: opts.openid,
                    bizRef: e.id, // 幂等键：一个入渔只对应一张支付单
                    description: `养鱼免单卡 ${cardId}`,
                });
                if (r.ok) {
                    await (0, db_1.query)("UPDATE enrollment SET pay_order_no=?, pay_status='unpaid' WHERE id=?", [
                        r.data.orderNo,
                        e.id,
                    ]);
                    e.payOrderNo = r.data.orderNo;
                    e.payStatus = "unpaid";
                    e.payParams = r.data.payParams;
                }
                else {
                    (0, fund_1.logFundFailure)("enrollment.pay.create", { refType: "enrollment", refId: e.id, userId }, r);
                }
            }
        }
        catch (err) {
            logger_1.logger.error({ userId, cardId, enrollmentId: e.id, err: err?.message }, "下单异常");
        }
    }
    return e;
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
    // 资金安全闸门：只有真付过钱的入渔才产生退款资金。
    // 免费领卡(none)/已下单未付(unpaid)均无实付, 走退款即凭空造钱
    // (历史实证: 流水 2519 对 pay_status=none 入渔 +100 发放, 靠人工 -100 对冲)。
    // 这里必须用 state === "paid"，不能用 canProceed —— 免费卡在核销场景可放行，
    // 但退款场景绝不可。两种业务对"能否放行"的口径本来就不同，闸门只提供事实，不替业务决定。
    const guard = await (0, pay_guard_1.ensurePaid)(e);
    if (guard.state !== "paid") {
        throw (0, errors_1.badRequest)("该入渔无实付记录, 不涉及资金退回(免费领卡或未完成支付不可退款)");
    }
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
    // 两笔动账都走 lib/fund 的唯一出口：闭包里自造 fetch 会把失败压成 boolean，
    // 丢掉 code/flowNo，退款单据上就只剩一句「失败待人工」，运营无从对账。
    let recovered = false;
    if (Number(e.rewardPaid) > 0) {
        const r = await (0, fund_1.walletChangeOfUser)(e.userId, {
            amount: -Number(e.rewardPaid),
            bizType: "yangyu:refund",
            remark: `退款收回已发奖励 入渔 ${enrollmentId}`,
        });
        recovered = r.ok;
        if (!recovered) {
            (0, fund_1.logFundFailure)("enrollment.refund.recover", { refType: "enrollment", refId: enrollmentId, userId: e.userId }, r);
        }
    }
    // 退款本金: 当前免费领卡无实付, 接支付后 balance=即时到账 / original=微信原路退。无实付仅记账不发放。
    let refunded = false;
    let refundErrCode;
    let refundNote = "";
    if (channel === "balance") {
        const r = await (0, fund_1.walletChangeOfUser)(e.userId, {
            amount: refundAmount,
            bizType: "yangyu:refund_payout",
            remark: `退款到余额 入渔 ${enrollmentId} 通道:balance`,
        });
        refunded = r.ok;
        refundErrCode = r.code;
        refundNote = refunded
            ? "已退到余额"
            : `余额退款失败(${r.code ?? "UNKNOWN"}): ${r.err ?? "无原因"}，待人工`;
        if (!refunded) {
            (0, fund_1.logFundFailure)("enrollment.refund.payout", { refType: "enrollment", refId: enrollmentId, userId: e.userId }, r);
        }
    }
    else {
        refundNote = "原路退通道: 待微信支付退款API接入后执行(pending)";
        await (0, db_1.withTx)(async (client) => {
            await client.query("INSERT INTO audit (id, operator, action, ref_type, ref_id, `before`, `after`) VALUES (?,?,?,?,?,?,?)", [(0, db_1.newId)(), userId, "enrollment.refund.original_pending", "enrollment", enrollmentId, before,
                JSON.stringify({ channel, refundAmount, state: "pending_wechat_refund_api" })]);
        });
    }
    return { refundAmount, channel, recovered, refunded, refundNote, refundErrCode, status: "refunded" };
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