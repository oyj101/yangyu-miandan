"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.round2 = round2;
exports.assertPackageCard = assertPackageCard;
exports.createPeriodsForEnrollment = createPeriodsForEnrollment;
exports.getPeriodAt = getPeriodAt;
exports.sweepExpired = sweepExpired;
exports.extendPeriod = extendPeriod;
const errors_1 = require("../../lib/errors");
const db_1 = require("../../lib/db");
const config_1 = require("../../config");
const card_repo_1 = require("../card/card.repo");
const iso_week_1 = require("./iso-week");
const period_repo_1 = require("./period.repo");
function round2(n) {
    return Math.round(n * 100) / 100;
}
/**
 * 购买前的配置闸门（fail-closed）。
 * 存量卡（v1，未设套餐四要素）一律拒绝生成期次 —— 凭空按 price/times 推算
 * 会让供应价变成 0，等于每期白送商户一次服务。
 */
function assertPackageCard(card) {
    if (card.unitPrice == null || card.periods == null || card.supplyPrice == null) {
        throw (0, errors_1.validationError)("该卡尚未完成套餐卡设计（缺少单价/期数/供应价），不可购买", {
            cardId: card.id,
        });
    }
    const unitPrice = Number(card.unitPrice);
    const periods = Number(card.periods);
    const supplyPrice = Number(card.supplyPrice);
    if (!(unitPrice > 0) || !(periods > 0)) {
        throw (0, errors_1.validationError)("套餐卡单价或期数非正数", { unitPrice, periods });
    }
    if (supplyPrice < 0 || supplyPrice > unitPrice) {
        throw (0, errors_1.validationError)("供应价必须在 0 ~ 单价之间", { supplyPrice, unitPrice });
    }
    // 总价一致性：浮点比较留 1 分容差
    if (Math.abs(unitPrice * periods - Number(card.price)) > 0.01) {
        throw (0, errors_1.validationError)("卡价与 单价×期数 不一致，拒绝生成期次", {
            price: Number(card.price),
            unitPrice,
            periods,
        });
    }
    return { unitPrice, periods, supplyPrice };
}
/**
 * 生成该入渔的全部期次。幂等：已存在则直接返回。
 *
 * 首期 = 购买日所在 ISO 周的下一个周一（见 firstFullWeek 注释）。
 * 之所以不顺延到"下一个有 5 天剩余的日子"：规则要可解释，
 * 统一"次完整周起算"对所有人都一致，也让集合页能明确写出首期日期。
 */
async function createPeriodsForEnrollment(input) {
    const existing = await (0, period_repo_1.listByEnrollment)(input.enrollmentId);
    if (existing.length > 0)
        return existing;
    const card = await (0, card_repo_1.findCardById)(input.cardId);
    if (!card)
        throw (0, errors_1.notFound)("免单卡不存在");
    const { unitPrice, periods, supplyPrice } = assertPackageCard(card);
    const first = (0, iso_week_1.firstFullWeek)(input.purchasedAt);
    // 比例快照到每一期：卡上的 share_ratio 之后被运营改，已售期次的金额也不变。
    // 这是合同金额，不能随配置漂移（改比例只影响此后新生成的期次）。
    const shareRatio = Number(card.shareRatio ?? config_1.config.package.shareRatioDefault);
    const refundNowRatio = Math.round((1 - shareRatio) * 1000) / 1000;
    const rows = [];
    for (let i = 0; i < periods; i++) {
        const w = i === 0 ? first : (0, iso_week_1.shiftWeek)(first, i);
        rows.push({
            enrollmentId: input.enrollmentId,
            cardId: input.cardId,
            userId: input.userId,
            merchantId: input.merchantId,
            periodNo: i + 1,
            isoYear: w.year,
            isoWeek: w.week,
            weekStart: (0, iso_week_1.ymd)(w.monday),
            weekEnd: (0, iso_week_1.ymd)(w.sunday),
            unitPrice,
            supplyPrice,
            shareRatio,
            refundNowRatio,
        });
    }
    try {
        await (0, period_repo_1.insertPeriods)(rows);
    }
    catch (err) {
        // 并发下另一个请求已建好：1062 视为幂等成功
        if (err?.code === "ER_DUP_ENTRY" || err?.errno === 1062) {
            return (0, period_repo_1.listByEnrollment)(input.enrollmentId);
        }
        throw err;
    }
    const firstKey = (0, iso_week_1.isoWeekKey)(first);
    await (0, db_1.query)(`UPDATE enrollment
        SET total_periods = ?, current_period = 1, first_week = ?, card_paid = ?
      WHERE id = ?`, [periods, firstKey, round2(unitPrice * periods), input.enrollmentId]);
    return (0, period_repo_1.listByEnrollment)(input.enrollmentId);
}
/** 取某入渔在指定日期所属 ISO 周的期次；无则 null（说明已过期或周期已走完） */
async function getPeriodAt(enrollmentId, at) {
    const w = (0, iso_week_1.isoWeekOf)(at);
    return (0, period_repo_1.findByWeek)(enrollmentId, w.year, w.week);
}
/** 扫描并作废逾期未核销的期次（幂等） */
async function sweepExpired(now = new Date()) {
    const n = await (0, period_repo_1.expirePast)((0, iso_week_1.ymd)(now));
    if (n > 0) {
        // 同步回写入渔的作废计数，供 C 端展示与客服查询
        await (0, db_1.query)(`UPDATE enrollment e
          SET expired_count = (
            SELECT COUNT(*) FROM period p WHERE p.enrollment_id = e.id AND p.expired = 1
          )
        WHERE e.id IN (SELECT DISTINCT enrollment_id FROM period WHERE expired = 1)`, []);
    }
    return n;
}
/**
 * 运营补期：把某期整体挪到目标 ISO 周。
 * 期次绑自然周的必然代价是"漏一周即永久损失"，没有这个通道，此类投诉无解。
 */
async function extendPeriod(periodId, targetWeekKey, operator) {
    const p = await (0, period_repo_1.findById)(periodId);
    if (!p)
        throw (0, errors_1.notFound)("期次不存在");
    if (p.checkinId)
        throw (0, errors_1.badRequest)("该期已核销，不可补期");
    const target = (0, iso_week_1.parseIsoWeekKey)(targetWeekKey);
    const occupied = await (0, period_repo_1.findByWeek)(p.enrollmentId, target.year, target.week);
    if (occupied && occupied.id !== periodId) {
        throw (0, errors_1.conflict)(`目标周 ${targetWeekKey} 已被第 ${occupied.periodNo} 期占用`);
    }
    const fromKey = `${p.isoYear}W${String(p.isoWeek).padStart(2, "0")}`;
    await (0, db_1.withTx)(async (client) => {
        await client.query(`UPDATE period
          SET iso_year = ?, iso_week = ?, week_start = ?, week_end = ?,
              expired = 0, extended_from = COALESCE(extended_from, ?)
        WHERE id = ?`, [target.year, target.week, (0, iso_week_1.ymd)(target.monday), (0, iso_week_1.ymd)(target.sunday), fromKey, periodId]);
        await client.query(`INSERT INTO audit (id, operator, action, ref_type, ref_id, \`before\`, \`after\`)
       VALUES (?,?,?,?,?,?,?)`, [(0, db_1.newId)(), operator, "period.extend", "period", periodId, JSON.stringify({ week: fromKey }),
            JSON.stringify({ week: targetWeekKey })]);
    });
    const updated = await (0, period_repo_1.findById)(periodId);
    if (!updated)
        throw (0, errors_1.notFound)("期次不存在");
    return updated;
}
//# sourceMappingURL=period.service.js.map