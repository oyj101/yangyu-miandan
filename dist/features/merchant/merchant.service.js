"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settleMerchant = settleMerchant;
exports.clawbackCheckin = clawbackCheckin;
exports.getAccount = getAccount;
exports.listNegativeAccounts = listNegativeAccounts;
const errors_1 = require("../../lib/errors");
const db_1 = require("../../lib/db");
const period_repo_1 = require("../period/period.repo");
const period_service_1 = require("../period/period.service");
/** 确保账户行存在（并发下靠主键冲突兜底） */
async function ensureAccount(client, merchantId) {
    try {
        await client.query(`INSERT INTO merchant_account (merchant_id, balance) VALUES (?, 0)`, [merchantId]);
    }
    catch (err) {
        if (!(err?.code === "ER_DUP_ENTRY" || err?.errno === 1062))
            throw err;
    }
    const r = await client.query(`SELECT balance FROM merchant_account WHERE merchant_id = ? FOR UPDATE`, [merchantId]);
    return { balance: Number((r[0][0]?.balance) ?? 0) };
}
/**
 * 核销时即时结算商户供应价。
 *
 * 抵扣规则（PO 2026-10-20 拍板：追商户负余额、下期抵扣）：
 *   实付 = 应付 − min(欠款, 应付)；欠款超出部分继续挂在负余额上。
 *
 * 幂等：ledger.idem_key = settle:{periodId}，重复回调不产生二次入账。
 */
async function settleMerchant(client, period, checkinId) {
    const key = `settle:${period.id}`;
    const dup = await client.query(`SELECT amount, offset_amount, balance_after FROM merchant_settle_ledger WHERE idem_key = ?`, [key]);
    const existed = dup[0][0];
    if (existed) {
        return {
            merchantId: period.merchantId,
            periodId: period.id,
            payable: Number(existed.amount) + Number(existed.offset_amount),
            offset: Number(existed.offset_amount),
            cashOut: Number(existed.amount),
            balanceAfter: Number(existed.balance_after),
            alreadySettled: true,
        };
    }
    const payable = (0, period_service_1.round2)(period.supplyPrice);
    const { balance } = await ensureAccount(client, period.merchantId);
    const offset = balance < 0 ? (0, period_service_1.round2)(Math.min(-balance, payable)) : 0;
    const cashOut = (0, period_service_1.round2)(payable - offset);
    const balanceAfter = (0, period_service_1.round2)(balance + payable);
    await client.query(`UPDATE merchant_account SET balance = ? WHERE merchant_id = ?`, [balanceAfter, period.merchantId]);
    await client.query(`INSERT INTO merchant_settle_ledger
       (id, merchant_id, period_id, kind, amount, offset_amount, balance_after, biz_ref, idem_key)
     VALUES (?,?,?,'settle',?,?,?,?,?)`, [(0, db_1.newId)(), period.merchantId, period.id, cashOut, offset, balanceAfter, checkinId, key]);
    await (0, period_repo_1.setMerchantSettled)(client, period.id, cashOut);
    return {
        merchantId: period.merchantId,
        periodId: period.id,
        payable,
        offset,
        cashOut,
        balanceAfter,
        alreadySettled: false,
    };
}
/**
 * 撤销核销 → 向商户追回已结的供应价。
 *
 * 语义边界（必须钉死）：只有「核销被撤销 / 判定作弊」才追商户。
 * 用户达标退费是平台补贴，商户已提供服务、钱货两清，绝不向商户追。
 * 混在一起会做出「商户白干还倒欠钱」的错账。
 *
 * 追回方式：直接冲减商户余额；若商户已提现（余额不足），形成负余额，
 * 由下一期结算抵扣 —— 不主动划扣商户现金。
 */
async function clawbackCheckin(periodId, checkinId, reason, operator) {
    return (0, db_1.withTx)(async (client) => {
        const p = await (0, period_repo_1.lockById)(client, periodId);
        if (!p)
            throw (0, errors_1.notFound)("期次不存在");
        const key = `clawback:${checkinId}`;
        const dup = await client.query(`SELECT amount, balance_after FROM merchant_settle_ledger WHERE idem_key = ?`, [key]);
        const existed = dup[0][0];
        if (existed) {
            return {
                merchantId: p.merchantId,
                checkinId,
                amount: Math.abs(Number(existed.amount)),
                balanceAfter: Number(existed.balance_after),
                alreadyDone: true,
            };
        }
        const { balance } = await ensureAccount(client, p.merchantId);
        const amount = (0, period_service_1.round2)(p.supplyPrice);
        const balanceAfter = (0, period_service_1.round2)(balance - amount);
        await client.query(`UPDATE merchant_account SET balance = ? WHERE merchant_id = ?`, [
            balanceAfter,
            p.merchantId,
        ]);
        await client.query(`INSERT INTO merchant_settle_ledger
         (id, merchant_id, period_id, kind, amount, offset_amount, balance_after, biz_ref, idem_key)
       VALUES (?,?,?,'clawback',?,0,?,?,?)`, [(0, db_1.newId)(), p.merchantId, p.id, -amount, balanceAfter, checkinId, key]);
        // 期次回到"未结算"，但 checkin 保留审计痕迹（撤销由 audit 记录）
        await client.query(`UPDATE period SET merchant_settled = 0, merchant_amount = 0 WHERE id = ?`, [periodId]);
        await client.query(`UPDATE checkin SET note = CONCAT(COALESCE(note,''), ?) WHERE id = ?`, [`[撤销核销 ${operator}] ${reason}; `, checkinId]);
        await client.query(`INSERT INTO audit (id, operator, action, ref_type, ref_id, \`after\`)
       VALUES (?,?,?,?,?,?)`, [
            (0, db_1.newId)(),
            operator,
            "checkin.clawback",
            "period",
            periodId,
            JSON.stringify({ checkinId, amount, balanceAfter, reason }),
        ]);
        return {
            merchantId: p.merchantId,
            checkinId,
            amount,
            balanceAfter,
            alreadyDone: false,
        };
    });
}
async function getAccount(merchantId) {
    const res = await (0, db_1.query)(`SELECT merchant_id, balance, state, note, updated_at FROM merchant_account WHERE merchant_id = ?`, [merchantId]);
    // 累计已结算：商户对账时第一个要问的数，不能让他自己拿流水加。
    // amount 语义本身带符号（正=应付，负=追回），直接 SUM，不要再按 kind 取反一次。
    const sum = await (0, db_1.query)(`SELECT COALESCE(SUM(amount), 0) AS total
       FROM merchant_settle_ledger WHERE merchant_id = ?`, [merchantId]);
    const totalSettled = Number(sum.rows[0]?.total) || 0;
    const r = res.rows[0];
    if (!r) {
        return {
            merchantId,
            balance: 0,
            totalSettled,
            state: "active",
            note: null,
            updatedAt: null,
        };
    }
    return {
        merchantId: r.merchant_id,
        balance: Number(r.balance),
        totalSettled,
        state: r.state,
        note: r.note,
        updatedAt: r.updated_at,
    };
}
/** 负余额商户清单（用于运营跟进：欠款持续不还的应先暂停上架） */
async function listNegativeAccounts() {
    const res = await (0, db_1.query)(`SELECT merchant_id, balance, updated_at FROM merchant_account
      WHERE balance < 0 ORDER BY balance ASC`);
    return res.rows;
}
//# sourceMappingURL=merchant.service.js.map