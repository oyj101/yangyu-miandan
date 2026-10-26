"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listMerchantEnrollments = void 0;
exports.normalizeReceiver = normalizeReceiver;
exports.assertFulfillSupported = assertFulfillSupported;
exports.calcFreightTotal = calcFreightTotal;
exports.purchase = purchase;
exports.getEnrollment = getEnrollment;
exports.refundEnrollment = refundEnrollment;
exports.getEnrollmentUserId = getEnrollmentUserId;
exports.listUserEnrollments = listUserEnrollments;
exports.setFulfillMode = setFulfillMode;
exports.payFreight = payFreight;
const errors_1 = require("../../lib/errors");
const enrollment_repo_1 = require("./enrollment.repo");
const card_repo_1 = require("../card/card.repo");
const period_service_1 = require("../period/period.service");
const db_1 = require("../../lib/db");
const logger_1 = require("../../lib/logger");
const fund_1 = require("../../lib/fund");
const pay_guard_1 = require("./pay-guard");
const freight_guard_1 = require("./freight-guard");
const delivery_service_1 = require("../delivery/delivery.service");
const PHONE_RE = /^1[3-9]\d{9}$/;
/**
 * 收货信息归一 + 校验。
 * 配送的每一期都要落到一个真实地址，缺任何一项都必须拒（不能落半截数据，
 * 否则商户拿到空地址的配送任务，只能人工返工）。
 */
function normalizeReceiver(input) {
    const name = String(input?.name ?? "").trim();
    const phone = String(input?.phone ?? "").trim();
    const address = String(input?.address ?? "").trim();
    if (!name)
        throw (0, errors_1.badRequest)("配送需填写收货人姓名");
    if (!PHONE_RE.test(phone))
        throw (0, errors_1.badRequest)("收货手机号格式不正确");
    if (address.length < 5)
        throw (0, errors_1.badRequest)("收货地址过短，请填写详细地址");
    if (name.length > 64 || address.length > 255)
        throw (0, errors_1.badRequest)("收货信息过长");
    return { name, phone, address };
}
/** 卡能力闸门：卡的 fulfillment 决定用户能不能选配送（反向也要拦） */
function assertFulfillSupported(card, mode) {
    if (mode === "delivery" && card.fulfillment === "pickup") {
        throw (0, errors_1.badRequest)("该免单卡仅支持到店自提，不支持配送");
    }
    if (mode === "pickup" && card.fulfillment === "delivery") {
        throw (0, errors_1.badRequest)("该免单卡仅支持配送到家，请填写收货信息");
    }
}
/**
 * 运费总额 = 每期运费 × 期数（一次收齐）。
 * 不并入卡价：卡价参与 70%/30% 返还计算，运费不参与，
 * 混在一起会让退款额和奖励口径同时失真。
 *
 * 先按「分」做十进制四舍五入再乘期数：直接 a*n*100 会被 IEEE754 存成
 * 100.49999999999999 这类值，Math.round 会把 1.005 抹成 1.00 —— 少收运费。
 */
function calcFreightTotal(perPeriod, periods) {
    const a = Math.max(0, Number(perPeriod) || 0);
    const n = Math.max(0, Math.floor(Number(periods) || 0));
    if (a === 0 || n === 0)
        return 0;
    const perCents = Math.round(Number((a * 100).toFixed(6)));
    return (perCents * n) / 100;
}
/** 20261017 购买接支付(PO): pay=true 时走 8100 统一支付真源下单(NATIVE/JSAPI), 落 pay_order_no + pay_status=unpaid;
 * 支付成功后由 pay-guard 查单确认并回写 paid，核销才放行。pay=false/缺省=免费领卡模式(pay_status=none)。
 * 基础能力不得自实现：微信下单/查单/退款一律经 lib/fund.ts（唯一出口）。 */
async function purchase(userId, cardId, opts = {}) {
    const card = await (0, card_repo_1.findCardById)(cardId);
    if (!card)
        throw (0, errors_1.notFound)("免单卡不存在");
    if (card.status !== "active")
        throw (0, errors_1.badRequest)("该免单卡未上架");
    // 参与数量（可售份数上限）：来自提报 quota 落到 card.stock。
    // NULL=不限（存量卡）。软上限（非事务）：内测期并发抢购概率极低，避免引入分布式锁。
    if (card.stock != null) {
        const soldRes = await (0, db_1.query)(`SELECT COUNT(*) AS c FROM enrollment WHERE card_id = ? AND status NOT IN ('refunded','exited')`, [cardId]);
        const sold = Number(soldRes.rows[0]?.c) || 0;
        if (sold >= card.stock) {
            throw (0, errors_1.badRequest)("该免单卡已售罄");
        }
    }
    // 履约方式（配送分支）：在建单之前完成校验，避免"卡建好了、地址却是空的"
    const fulfillMode = opts.fulfillMode === "delivery" ? "delivery" : "pickup";
    assertFulfillSupported(card, fulfillMode);
    const receiver = fulfillMode === "delivery" ? normalizeReceiver(opts.receiver) : null;
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
    // 履约选择落库（地址快照）。此后用户改地址只影响尚未发货的期次。
    await (0, db_1.query)("UPDATE enrollment SET fulfill_mode=?, receiver_name=?, receiver_phone=?, receiver_address=? WHERE id=?", [fulfillMode, receiver?.name ?? null, receiver?.phone ?? null, receiver?.address ?? null, e.id]);
    e.fulfillMode = fulfillMode;
    e.receiverName = receiver?.name ?? null;
    e.receiverPhone = receiver?.phone ?? null;
    e.receiverAddress = receiver?.address ?? null;
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
    // ---------- 配送分支：运费单独一笔 + 按期为每期建配送任务 ----------
    // 时序图要求「运费与差价单独支付」：运费不并入卡价，独立支付单（bizRef=freight:{id}）。
    let freightTotal = 0;
    let freightOrderNo = null;
    let freightPayParams = null;
    if (isPackage && fulfillMode === "delivery") {
        freightTotal = calcFreightTotal(Number(card.deliveryFee ?? 0), Number(card.periods ?? 0));
        await (0, db_1.query)("UPDATE enrollment SET freight_amount=?, freight_pay_status=? WHERE id=?", [
            freightTotal,
            freightTotal > 0 ? "unpaid" : "none",
            e.id,
        ]);
        e.freightAmount = freightTotal;
        e.freightPayStatus = freightTotal > 0 ? "unpaid" : "none";
        if (opts.pay && freightTotal > 0) {
            try {
                const aiUid = await (0, fund_1.resolveAiUid)(userId);
                if (!aiUid) {
                    logger_1.logger.warn({ userId, enrollmentId: e.id }, "未联邦用户运费下单被跳过");
                }
                else {
                    const r = await (0, fund_1.payCreate)({
                        aiUid,
                        amountFen: Math.round(freightTotal * 100),
                        channel: opts.channel === "jsapi" ? "jsapi" : "native",
                        openid: opts.openid,
                        // 与卡价单（bizRef=enrollment.id）区分的独立幂等键
                        bizRef: `freight:${e.id}`,
                        description: `养鱼免单运费 ${cardId}`,
                    });
                    if (r.ok) {
                        freightOrderNo = r.data.orderNo;
                        freightPayParams = r.data.payParams;
                        await (0, db_1.query)("UPDATE enrollment SET freight_pay_order_no=? WHERE id=?", [freightOrderNo, e.id]);
                        e.freightPayOrderNo = freightOrderNo;
                    }
                    else {
                        (0, fund_1.logFundFailure)("enrollment.pay.freight_create", { refType: "enrollment", refId: e.id, userId }, r);
                    }
                }
            }
            catch (err) {
                logger_1.logger.error({ userId, enrollmentId: e.id, err: err?.message }, "运费下单异常");
            }
        }
        // 期次已生成才建任务；生成失败时 attach 返回 0，由运营补建后再次调用即可（幂等）
        try {
            await (0, delivery_service_1.attachDeliveryTasks)(e.id);
        }
        catch (err) {
            logger_1.logger.error({ enrollmentId: e.id, err: err?.message }, "配送任务生成失败，需补建");
            await (0, db_1.query)("INSERT INTO audit (id, operator, action, ref_type, ref_id, `after`) VALUES (?,?,?,?,?,?)", [
                (0, db_1.newId)(),
                "system",
                "delivery.task_create_failed",
                "enrollment",
                e.id,
                JSON.stringify({ err: String(err?.message ?? err).slice(0, 400) }),
            ]);
        }
    }
    e.freightPayParams = freightPayParams;
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
// ============================================================
// 配送分支（009）：切换履约方式 / 运费补付
// ============================================================
/**
 * 切换履约方式（购买后再改）。
 *
 * 允许：自提 → 配送（补建配送任务 + 产生运费应收）
 * 允许：配送 → 自提（仅当没有任何已发货/送达/签收的期次）
 * 禁止：已有实物在路上的期次退回自提（货已发，退不回去）
 *
 * 运费已付过则不重复收（freight_amount 保持原值），避免用户改来改去被重复扣钱。
 */
async function setFulfillMode(userId, enrollmentId, mode, receiver, opts = {}) {
    const e = await (0, enrollment_repo_1.findEnrollment)(enrollmentId);
    if (!e)
        throw (0, errors_1.notFound)("入渔记录不存在");
    if (!opts.byOperator && e.userId !== userId)
        throw (0, errors_1.forbidden)("只能修改自己的入渔");
    if (e.status !== "normal" && e.status !== "pause1" && e.status !== "pause3") {
        throw (0, errors_1.badRequest)(`当前状态(${e.status})不可修改履约方式`);
    }
    const card = await (0, card_repo_1.findCardById)(e.cardId);
    if (!card)
        throw (0, errors_1.notFound)("免单卡不存在");
    assertFulfillSupported(card, mode);
    const before = { mode: e.fulfillMode ?? "pickup", freightAmount: Number(e.freightAmount ?? 0) };
    if (mode === "pickup") {
        const busy = await (0, db_1.query)(`SELECT COUNT(*) AS c FROM delivery_task
        WHERE enrollment_id = ? AND status IN ('shipped','delivered','signed')`, [enrollmentId]);
        if ((Number(busy.rows[0]?.c) || 0) > 0) {
            throw (0, errors_1.badRequest)("已有配送中或已签收的期次，不能改为到店自提");
        }
        await (0, db_1.query)("UPDATE enrollment SET fulfill_mode='pickup' WHERE id=?", [enrollmentId]);
    }
    else {
        const rc = normalizeReceiver(receiver);
        const periods = Number(e.totalPeriods ?? card.periods ?? 0);
        const freightTotal = calcFreightTotal(Number(card.deliveryFee ?? 0), periods);
        await (0, db_1.query)(`UPDATE enrollment
          SET fulfill_mode='delivery', receiver_name=?, receiver_phone=?, receiver_address=?,
              freight_amount = CASE WHEN freight_pay_status = 'paid' THEN freight_amount ELSE ? END,
              freight_pay_status = CASE WHEN freight_pay_status = 'paid' THEN 'paid' ELSE ? END
        WHERE id=?`, [rc.name, rc.phone, rc.address, freightTotal, freightTotal > 0 ? "unpaid" : "none", enrollmentId]);
        // 幂等：已有任务的期次不会被覆盖（repo 层按 period_id 去重）
        await (0, delivery_service_1.attachDeliveryTasks)(enrollmentId);
    }
    const after = await (0, enrollment_repo_1.findEnrollment)(enrollmentId);
    await (0, db_1.query)("INSERT INTO audit (id, operator, action, ref_type, ref_id, `before`, `after`) VALUES (?,?,?,?,?,?,?)", [
        (0, db_1.newId)(),
        userId,
        "enrollment.fulfill",
        "enrollment",
        enrollmentId,
        JSON.stringify(before),
        JSON.stringify({ mode: after?.fulfillMode ?? mode, freightAmount: Number(after?.freightAmount ?? 0) }),
    ]);
    if (!after)
        throw (0, errors_1.notFound)("入渔记录不存在");
    return after;
}
/**
 * 运费补付 / 重新下单（幂等复用同一 bizRef=freight:{id}）。
 * 已付则直接返回，不产生第二笔单。
 */
async function payFreight(userId, enrollmentId, opts = {}) {
    const e = await (0, enrollment_repo_1.findEnrollment)(enrollmentId);
    if (!e)
        throw (0, errors_1.notFound)("入渔记录不存在");
    if (e.userId !== userId)
        throw (0, errors_1.forbidden)("只能为自己的入渔支付运费");
    if ((e.fulfillMode ?? "pickup") !== "delivery") {
        throw (0, errors_1.badRequest)("该入渔为到店自提，无需支付运费");
    }
    const amount = Number(e.freightAmount ?? 0);
    if (!(amount > 0)) {
        return { amount: 0, orderNo: null, payParams: null, alreadyPaid: true, note: "该入渔无需支付运费" };
    }
    // 先查真源：可能用户已在微信付过，本地还没回写
    const g = await (0, freight_guard_1.ensureFreightPaid)(e);
    if (g.state === "paid") {
        return {
            amount,
            orderNo: e.freightPayOrderNo ?? null,
            payParams: null,
            alreadyPaid: true,
            note: "运费已支付",
        };
    }
    const aiUid = await (0, fund_1.resolveAiUid)(userId);
    if (!aiUid)
        throw (0, errors_1.badRequest)("当前账号未完成平台身份绑定，无法发起支付");
    const r = await (0, fund_1.payCreate)({
        aiUid,
        amountFen: Math.round(amount * 100),
        channel: opts.channel === "jsapi" ? "jsapi" : "native",
        openid: opts.openid,
        bizRef: `freight:${enrollmentId}`,
        description: `养鱼免单运费 ${e.cardId}`,
    });
    if (!r.ok) {
        (0, fund_1.logFundFailure)("enrollment.pay.freight_create", { refType: "enrollment", refId: enrollmentId, userId }, r);
        throw (0, errors_1.badRequest)(`运费下单失败(${r.code ?? "UNKNOWN"}): ${r.err ?? "未知原因"}`);
    }
    await (0, db_1.query)("UPDATE enrollment SET freight_pay_order_no=?, freight_pay_status='unpaid' WHERE id=?", [
        r.data.orderNo,
        enrollmentId,
    ]);
    return {
        amount,
        orderNo: r.data.orderNo,
        payParams: r.data.payParams,
        alreadyPaid: false,
        note: "运费支付单已创建",
    };
}
//# sourceMappingURL=enrollment.service.js.map