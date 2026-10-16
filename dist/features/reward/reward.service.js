"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeOnCheckin = computeOnCheckin;
exports.evaluateWeek = evaluateWeek;
exports.listRewards = listRewards;
const db_1 = require("../../lib/db");
const errors_1 = require("../../lib/errors");
const engine_1 = require("./engine");
const enrollment_repo_1 = require("../enrollment/enrollment.repo");
const card_repo_1 = require("../card/card.repo");
/**
 * F5/F6：核销履约时计算奖励。受 4.3 状态机 + 免单上限(coverage_cap) 双重约束。
 */
async function computeOnCheckin(enrollmentId, merchantId) {
    const e = await (0, enrollment_repo_1.findEnrollment)(enrollmentId);
    if (!e)
        throw (0, errors_1.notFound)("入渔记录不存在");
    if (e.merchantId !== merchantId)
        throw (0, errors_1.notFound)("入渔记录不属于该商家");
    const card = await (0, card_repo_1.findCardById)(e.cardId);
    if (!card)
        throw (0, errors_1.notFound)("免单卡不存在");
    const state = (0, enrollment_repo_1.toState)(e);
    const remaining = Math.max(0, e.rewardTotal - e.rewardPaid);
    // 本次奖励 = 卡面单价，但不超过免单剩余额度
    const amount = Math.min(card.rewardPerTime, remaining);
    const { state: ns, reward, rewardAmount } = (0, engine_1.applyCheckin)(state, amount);
    const willIssue = reward && amount > 0;
    return (0, db_1.withTx)(async (client) => {
        let rewardId = null;
        if (willIssue) {
            // 主键应用层生成（CHAR(36)），无需 RETURNING 回读
            rewardId = (0, db_1.newId)();
            await client.query(`INSERT INTO reward (id, enrollment_id, user_id, amount, status)
         VALUES (?,?,?,?,'issued')`, [rewardId, e.id, e.userId, amount]);
        }
        const finalState = willIssue
            ? { ...ns, rewardPaid: ns.rewardPaid }
            : ns;
        // 状态更新走同一事务连接（pool 另开会话会与 FK 共享锁互等，见 enrollment.repo 注释）
        await (0, enrollment_repo_1.updateEnrollState)(client, e.id, finalState);
        // 写核销记录（一人一周一核销：唯一索引 idx_checkin_dedup 兜底同周重复；
        // MariaDB 1062 ER_DUP_ENTRY → 409，整个事务回滚，奖励与状态均不落库）
        try {
            await client.query(`INSERT INTO checkin (id, enrollment_id, user_id, merchant_id, card_id, week, rewarded, reward_id)
         VALUES (?,?,?,?,?,?,?,?)`, [(0, db_1.newId)(), e.id, e.userId, merchantId, e.cardId, currentWeek(), willIssue, rewardId]);
        }
        catch (err) {
            if (err?.errno === 1062 || err?.code === "ER_DUP_ENTRY") {
                throw (0, errors_1.conflict)("本周已核销，请勿重复操作");
            }
            throw err;
        }
        return {
            rewarded: willIssue,
            rewardAmount: willIssue ? amount : 0,
            rewardId,
            status: finalState.status,
            pausedRemaining: finalState.pauseRemaining,
        };
    });
}
/**
 * 周末评估养鱼达标（met 由章鱼仔 AI 养鱼服务传入，P0 先以参数驱动）。
 */
async function evaluateWeek(enrollmentId, met) {
    const e = await (0, enrollment_repo_1.findEnrollment)(enrollmentId);
    if (!e)
        throw (0, errors_1.notFound)("入渔记录不存在");
    const next = (0, engine_1.evaluateWeekly)((0, enrollment_repo_1.toState)(e), met);
    await (0, enrollment_repo_1.updateEnrollState)(db_1.pool, e.id, next);
    return next;
}
async function listRewards(enrollmentId) {
    const res = await (0, db_1.query)(`SELECT * FROM reward WHERE enrollment_id = ? ORDER BY created_at DESC`, [enrollmentId]);
    return res.rows.map((r) => ({
        id: r.id,
        amount: Number(r.amount),
        status: r.status,
        createdAt: r.created_at,
    }));
}
function currentWeek() {
    // UTC+8 自然周编号（YYYYWW）
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const y = now.getUTCFullYear();
    const start = new Date(Date.UTC(y, 0, 1));
    const week = Math.ceil(((now.getTime() - start.getTime()) / 86400000 + start.getUTCDay()) / 7);
    return `${y}W${week}`;
}
//# sourceMappingURL=reward.service.js.map