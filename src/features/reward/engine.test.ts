import { describe, it, expect } from "vitest";
import {
  INITIAL_STATE,
  evaluateWeekly,
  applyCheckin,
  EnrollState,
} from "./engine";

function state(over: Partial<EnrollState> = {}): EnrollState {
  return { ...INITIAL_STATE, ...over };
}

describe("evaluateWeekly · 4.3 状态机", () => {
  it("正常 + 达标 → 正常", () => {
    const s = evaluateWeekly(state(), true);
    expect(s.status).toBe("normal");
    expect(s.consecutiveMiss).toBe(0);
    expect(s.pauseRemaining).toBe(0);
  });

  // 20261018 对齐 PO 20261017 惩罚阶梯: pause1(停1) → pause3(停3) → 累计5次/连续3次 退出
  it("正常 + 未达标首犯 → 停奖1", () => {
    const s = evaluateWeekly(state(), false);
    expect(s.status).toBe("pause1");
    expect(s.pauseRemaining).toBe(1);
    expect(s.consecutiveMiss).toBe(1);
    expect(s.totalMissCount).toBe(1);
  });

  it("停奖1 + 达标 → 恢复正常并清空暂停", () => {
    const s = evaluateWeekly(state({ status: "pause1", consecutiveMiss: 1, pauseRemaining: 1 }), true);
    expect(s.status).toBe("normal");
    expect(s.pauseRemaining).toBe(0);
    expect(s.consecutiveMiss).toBe(0);
  });

  it("停奖1 + 连续未达标第2次 → 停奖3", () => {
    const s = evaluateWeekly(state({ status: "pause1", consecutiveMiss: 1, pauseRemaining: 1 }), false);
    expect(s.status).toBe("pause3");
    expect(s.pauseRemaining).toBe(3);
    expect(s.consecutiveMiss).toBe(2);
  });

  it("停奖3 + 连续未达标第3次 → 退出", () => {
    const s = evaluateWeekly(state({ status: "pause3", consecutiveMiss: 2, pauseRemaining: 3 }), false);
    expect(s.status).toBe("exited");
    expect(s.consecutiveMiss).toBe(3);
  });

  it("累计未达标达5次（非连续）→ 退出，totalMiss=5", () => {
    // 交替 未达标/达标，避免触发连续3次提前退出，验证累计5次路径
    let s = state();
    for (let i = 0; i < 5; i++) {
      s = evaluateWeekly(s, false); // 未达标
      s = evaluateWeekly(s, true); //  达标（打断连续）
    }
    expect(s.status).toBe("exited");
    expect(s.totalMissCount).toBe(5);
  });

  it("退出后状态不可变", () => {
    const exited = state({ status: "exited" });
    const s = evaluateWeekly(exited, true);
    expect(s.status).toBe("exited");
  });
});

describe("applyCheckin · 暂停消费与发奖", () => {
  it("正常状态核销 → 发奖", () => {
    const { state: ns, reward, rewardAmount } = applyCheckin(state(), 10);
    expect(reward).toBe(true);
    expect(rewardAmount).toBe(10);
    expect(ns.rewardPaid).toBe(10);
  });

  it("停奖1 第1次核销不发奖，第2次恢复发奖", () => {
    let s = state({ status: "pause1", pauseRemaining: 1 });
    let r = applyCheckin(s, 10);
    expect(r.reward).toBe(false);
    expect(r.state.pauseRemaining).toBe(0);
    expect(r.state.status).toBe("normal");
    s = r.state;
    r = applyCheckin(s, 10);
    expect(r.reward).toBe(true);
    expect(r.rewardAmount).toBe(10);
  });

  it("退出状态核销 → 不发奖", () => {
    const r = applyCheckin(state({ status: "exited" }), 10);
    expect(r.reward).toBe(false);
    expect(r.rewardAmount).toBe(0);
  });
});
