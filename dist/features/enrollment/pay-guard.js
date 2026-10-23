"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensurePaid = ensurePaid;
exports.payGuardMessage = payGuardMessage;
const db_1 = require("../../lib/db");
const logger_1 = require("../../lib/logger");
const fund_1 = require("../../lib/fund");
/**
 * 确认入渔支付态。幂等、可重复调用。
 *
 * 判定顺序：
 *   1. 本地已是 paid → 直接放行（已确认过的事实，不必每次打 8100）
 *   2. 有 pay_order_no → 向 8100 查单（支付态唯一真源），查到 paid 就回写
 *   3. 没有 pay_order_no → 视为免费领卡，放行（与既有 pay_status='none' 行为一致）
 *
 * 查单失败一律不放行 —— 钱的事宁可拒，也不能"没查到就当付过了"。
 */
async function ensurePaid(e) {
    const local = String(e.payStatus ?? "none");
    if (local === "paid") {
        return { state: "paid", canProceed: true, remoteChecked: false };
    }
    if (!e.payOrderNo) {
        // 免费领卡：没有支付单，也就没有待确认的支付态。
        // 注意这里仍然要区分"从没下过单"和"下过单但单号丢了"：
        // 后者如果本地状态是 unpaid/pending，说明单据存在过，必须当作异常拒掉。
        if (local === "unpaid" || local === "pending") {
            logger_1.logger.error({ enrollmentId: e.id }, "入渔处于待支付态但缺少 pay_order_no，拒绝放行");
            return { state: local, canProceed: false, remoteChecked: false, err: "缺少支付单号" };
        }
        return { state: "none", canProceed: true, remoteChecked: false };
    }
    const r = await (0, fund_1.payStatus)(String(e.payOrderNo));
    if (!r.ok) {
        logger_1.logger.error({ enrollmentId: e.id, orderNo: e.payOrderNo, code: r.code, err: r.err }, "支付态查单失败，按未付处理");
        return { state: local, canProceed: false, remoteChecked: true, err: r.err };
    }
    const state = r.data.state;
    if (state === "paid") {
        // 幂等回写：只有当前不是 paid 才更新，避免把 refunded 之类覆盖掉
        await (0, db_1.query)("UPDATE enrollment SET pay_status='paid' WHERE id=? AND (pay_status IS NULL OR pay_status<>'paid')", [
            e.id,
        ]).catch((err) => {
            logger_1.logger.error({ enrollmentId: e.id, err: err?.message }, "支付态回写失败");
        });
        return { state: "paid", canProceed: true, remoteChecked: true };
    }
    if (state === "unknown") {
        logger_1.logger.warn({ enrollmentId: e.id, orderNo: e.payOrderNo, raw: r.data?.raw }, "支付态未知，拒单待人工");
        return { state: "unknown", canProceed: false, remoteChecked: true, err: `未知支付态: ${r.data?.raw}` };
    }
    return { state, canProceed: false, remoteChecked: true };
}
/**
 * 拒绝理由（统一文案，避免各调用点各写一句，客服用不同话术解释同一件事）。
 */
function payGuardMessage(g) {
    if (g.err && g.state !== "paid") {
        return "支付状态暂时查不到，请稍后重试或联系客服核对";
    }
    switch (g.state) {
        case "unpaid":
            return "该入渔尚未完成支付，请先支付后再操作";
        case "closed":
            return "该支付单已关闭，请重新下单";
        case "refunded":
            return "该支付单已退款，不可再次操作";
        default:
            return "该入渔当前不可操作";
    }
}
//# sourceMappingURL=pay-guard.js.map