// 养鱼免单 · 奖励惩罚状态机（纯函数，便于单测）
// 对应 PRD 4.3：按周评估养鱼达标，驱动 正常 / 停奖2 / 停奖6 / 退出 四态。

export type EnrollStatus = "normal" | "pause1" | "pause3" | "pause2" | "pause6" | "exited" | "refunded";

export interface EnrollState {
  status: EnrollStatus;
  consecutiveMiss: number; // 连续未达标周数
  totalMissCount: number; // 累计未达标周数
  pauseRemaining: number; // 剩余暂停发奖的履约次数
  rewardPaid: number; // 已发奖励累计
  rewardTotal: number; // 应发奖励总额（免单终点）
}

export const INITIAL_STATE: EnrollState = {
  status: "normal",
  consecutiveMiss: 0,
  totalMissCount: 0,
  pauseRemaining: 0,
  rewardPaid: 0,
  rewardTotal: 0,
};

export const TOTAL_MISS_EXIT = 5; // 20261017 PO 规则: 累计未达标达 5 次 → 自动退出(产品服务照常, 仅停奖)

/**
 * 周末评估某一自然周的养鱼达标情况，返回新状态。
 * @param met 本周是否达标（养鱼打卡 ≥ 阈值）
 */
export function evaluateWeekly(state: EnrollState, met: boolean): EnrollState {
  if (state.status === "exited" || state.status === "refunded") return state;

  const totalMissCount = state.totalMissCount + (met ? 0 : 1);
  const consecutiveMiss = met ? 0 : state.consecutiveMiss + 1;
  let status: EnrollStatus = state.status;
  let pauseRemaining = state.pauseRemaining;

  // 20261017 PO 惩罚规则: 缺一天(未达标周)罚停 1 次 → 连续 2 次罚停 3 次 → 连续 3 次或累计 5 次自动退出
  if (!met) {
    if (status === "normal" && consecutiveMiss === 1) {
      status = "pause1";
      pauseRemaining = 1;
    } else if (status === "pause1" && consecutiveMiss === 2) {
      status = "pause3";
      pauseRemaining = 3;
    } else if (status === "pause3" && consecutiveMiss >= 3) {
      status = "exited";
    } else if (totalMissCount >= TOTAL_MISS_EXIT) {
      status = "exited";
    }
  } else {
    // 达标：清除暂停计数，回到正常
    if (status === "pause1" || status === "pause3" || status === "pause2" || status === "pause6") {
      status = "normal";
      pauseRemaining = 0;
    }
  }

  if (totalMissCount >= TOTAL_MISS_EXIT && status !== "exited") {
    status = "exited";
  }

  return { ...state, status, consecutiveMiss, totalMissCount, pauseRemaining };
}

/**
 * 处理一次到店履约（核销）。根据当前暂停计数决定是否发奖。
 * 返回新状态、是否发奖、本次发奖金额（服务层在调用前已做免单上限裁剪）。
 */
export function applyCheckin(
  state: EnrollState,
  amount: number
): { state: EnrollState; reward: boolean; rewardAmount: number } {
  if (state.status === "exited" || state.status === "refunded") {
    return { state, reward: false, rewardAmount: 0 };
  }
  if (state.pauseRemaining > 0) {
    const pauseRemaining = state.pauseRemaining - 1;
    const status: EnrollStatus = pauseRemaining === 0 ? "normal" : state.status;
    return { state: { ...state, pauseRemaining, status }, reward: false, rewardAmount: 0 };
  }
  return {
    state: { ...state, rewardPaid: state.rewardPaid + amount },
    reward: true,
    rewardAmount: amount,
  };
}
