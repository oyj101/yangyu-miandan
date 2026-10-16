"use strict";
// 养鱼免单 · 奖励惩罚状态机（纯函数，便于单测）
// 对应 PRD 4.3：按周评估养鱼达标，驱动 正常 / 停奖2 / 停奖6 / 退出 四态。
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOTAL_MISS_EXIT = exports.INITIAL_STATE = void 0;
exports.evaluateWeekly = evaluateWeekly;
exports.applyCheckin = applyCheckin;
exports.INITIAL_STATE = {
    status: "normal",
    consecutiveMiss: 0,
    totalMissCount: 0,
    pauseRemaining: 0,
    rewardPaid: 0,
    rewardTotal: 0,
};
exports.TOTAL_MISS_EXIT = 5; // 20261017 PO 规则: 累计未达标达 5 次 → 自动退出(产品服务照常, 仅停奖)
/**
 * 周末评估某一自然周的养鱼达标情况，返回新状态。
 * @param met 本周是否达标（养鱼打卡 ≥ 阈值）
 */
function evaluateWeekly(state, met) {
    if (state.status === "exited" || state.status === "refunded")
        return state;
    const totalMissCount = state.totalMissCount + (met ? 0 : 1);
    const consecutiveMiss = met ? 0 : state.consecutiveMiss + 1;
    let status = state.status;
    let pauseRemaining = state.pauseRemaining;
    // 20261017 PO 惩罚规则: 缺一天(未达标周)罚停 1 次 → 连续 2 次罚停 3 次 → 连续 3 次或累计 5 次自动退出
    if (!met) {
        if (status === "normal" && consecutiveMiss === 1) {
            status = "pause1";
            pauseRemaining = 1;
        }
        else if (status === "pause1" && consecutiveMiss === 2) {
            status = "pause3";
            pauseRemaining = 3;
        }
        else if (status === "pause3" && consecutiveMiss >= 3) {
            status = "exited";
        }
        else if (totalMissCount >= exports.TOTAL_MISS_EXIT) {
            status = "exited";
        }
    }
    else {
        // 达标：清除暂停计数，回到正常
        if (status === "pause1" || status === "pause3" || status === "pause2" || status === "pause6") {
            status = "normal";
            pauseRemaining = 0;
        }
    }
    if (totalMissCount >= exports.TOTAL_MISS_EXIT && status !== "exited") {
        status = "exited";
    }
    return { ...state, status, consecutiveMiss, totalMissCount, pauseRemaining };
}
/**
 * 处理一次到店履约（核销）。根据当前暂停计数决定是否发奖。
 * 返回新状态、是否发奖、本次发奖金额（服务层在调用前已做免单上限裁剪）。
 */
function applyCheckin(state, amount) {
    if (state.status === "exited" || state.status === "refunded") {
        return { state, reward: false, rewardAmount: 0 };
    }
    if (state.pauseRemaining > 0) {
        const pauseRemaining = state.pauseRemaining - 1;
        const status = pauseRemaining === 0 ? "normal" : state.status;
        return { state: { ...state, pauseRemaining, status }, reward: false, rewardAmount: 0 };
    }
    return {
        state: { ...state, rewardPaid: state.rewardPaid + amount },
        reward: true,
        rewardAmount: amount,
    };
}
//# sourceMappingURL=engine.js.map