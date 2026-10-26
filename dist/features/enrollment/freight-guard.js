"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureFreightPaid = ensureFreightPaid;
exports.freightGuardMessage = freightGuardMessage;
const db_1 = require("../../lib/db");
const logger_1 = require("../../lib/logger");
const fund_1 = require("../../lib/fund");
/**
 * 幂等确认运费态。
 * 无运费（amount<=0）或本地已 paid 直接放行；有单号则向 8100 查单并回写。
 * 查单失败一律不放行——运费未确认就发货，等于平台垫钱。
 */
async function ensureFreightPaid(f) {
    const amount = Number(f.freightAmount ?? 0);
    if (!(amount > 0)) {
        return { state: "none", ok: true, remoteChecked: false };
    }
    const local = String(f.freightPayStatus ?? "none");
    if (local === "paid") {
        return { state: "paid", ok: true, remoteChecked: false };
    }
    if (!f.freightPayOrderNo) {
        // 有应收运费却没支付单：要么还没下单，要么单号丢了。两种都不能放行。
        logger_1.logger.warn({ enrollmentId: f.id, amount, local }, "运费应收但无支付单，拒绝配送");
        return { state: "unpaid", ok: false, remoteChecked: false, err: "缺少运费支付单号" };
    }
    const r = await (0, fund_1.payStatus)(String(f.freightPayOrderNo));
    if (!r.ok) {
        logger_1.logger.error({ enrollmentId: f.id, orderNo: f.freightPayOrderNo, code: r.code, err: r.err }, "运费支付态查单失败");
        return { state: local, ok: false, remoteChecked: true, err: r.err };
    }
    const state = r.data.state;
    if (state === "paid") {
        await (0, db_1.query)("UPDATE enrollment SET freight_pay_status='paid' WHERE id=? AND (freight_pay_status IS NULL OR freight_pay_status<>'paid')", [f.id]).catch((err) => {
            logger_1.logger.error({ enrollmentId: f.id, err: err?.message }, "运费支付态回写失败");
        });
        return { state: "paid", ok: true, remoteChecked: true };
    }
    if (state === "unknown") {
        return { state: "unknown", ok: false, remoteChecked: true, err: `未知运费支付态: ${r.data?.raw}` };
    }
    return { state: state, ok: false, remoteChecked: true };
}
function freightGuardMessage(g) {
    if (g.err && g.state !== "paid" && g.state !== "none") {
        return "运费支付状态暂时查不到，请稍后重试或联系客服核对";
    }
    switch (g.state) {
        case "unpaid":
            return "运费尚未支付，请先支付运费后再配送";
        case "closed":
            return "运费支付单已关闭，请重新下单";
        case "refunded":
            return "运费已退回，不可继续配送";
        default:
            return "运费状态异常，暂不可配送";
    }
}
//# sourceMappingURL=freight-guard.js.map