import { describe, it, expect } from "vitest";
import { evaluateShareRatio, classifySupplyRatio } from "./card.service";

/**
 * 每卡分享分成的准入判定
 *
 * PO 口径「每个商品和服务决定每个商品和服务分多少」→ 比例逐卡可设。
 * 关键方向（易搞反，故写成断言）：
 *   总返还固定 100%，即时退 = (1−r)P。
 *   达标但未分享时平台净留存 = rP − C。
 *   ⇒ r 越低，平台越亏。所以约束是 **r ≥ c**，不是 r ≤ 1−c。
 */
describe("每卡分享分成准入", () => {
  it("P=100 / C=30 / r=0.3 → 通过，净留存 0（零毛利线）", () => {
    const r = evaluateShareRatio(100, 30, 0.3, 0.5);
    expect(r.ok).toBe(true);
    expect(r.nowRefund).toBe(70);
    expect(r.retain).toBe(0);
  });

  it("r 越高越安全：r=0.4 / c=0.3 → 未分享时每期净赚 10", () => {
    const r = evaluateShareRatio(100, 30, 0.4, 0.5);
    expect(r.ok).toBe(true);
    expect(r.retain).toBe(10);
  });

  it("r=0 且 C>0 → 拒绝（UNDER_SUPPLY）：达标未分享每期净亏全部供应价", () => {
    const r = evaluateShareRatio(100, 30, 0, 0.5);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("UNDER_SUPPLY");
      expect(r.retain).toBe(-30);
    }
  });

  it("r=0.2 / c=0.3 → 拒绝：每期净亏 10", () => {
    const r = evaluateShareRatio(100, 30, 0.2, 0.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retain).toBe(-10);
  });

  it("c=0.3 时 r 的保本下限是 0.3（刚好相等即通过）", () => {
    expect(evaluateShareRatio(100, 30, 0.3, 0.9).ok).toBe(true);
    expect(evaluateShareRatio(100, 30, 0.29, 0.9).ok).toBe(false);
  });

  it("供应价为 0 时任意 r 都通过（无成本，无需保本）", () => {
    expect(evaluateShareRatio(100, 0, 0, 0.5).ok).toBe(true);
  });

  it("超过配置上限（0.5）→ OUT_OF_RANGE", () => {
    const r = evaluateShareRatio(100, 10, 0.55, 0.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("OUT_OF_RANGE");
  });

  it("负数 → OUT_OF_RANGE（不允许反向收费）", () => {
    const r = evaluateShareRatio(100, 10, -0.1, 0.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("OUT_OF_RANGE");
  });

  it("浮点边界：P=99.99 / C=29.997 / r=0.3 不应误拒", () => {
    const r = evaluateShareRatio(99.99, 29.997, 0.3, 0.5);
    expect(r.ok).toBe(true);
  });
});

/**
 * 供应价率三档分界（20261025 PO 拍板）
 *   ≤0.3 自动 / 0.3~0.8 需预算专项审批（forceRisk）/ >0.8 恒拒绝
 */
describe("供应价率三档分界", () => {
  const RMAX = 0.3;
  const HARD = 0.8;

  it("c=0.3 → ok（零毛利线上，自动通过）", () => {
    expect(classifySupplyRatio(0.3, RMAX, HARD)).toBe("ok");
  });
  it("c=0.3+ε → confirm（进入预算专项审批区间）", () => {
    expect(classifySupplyRatio(0.3001, RMAX, HARD)).toBe("confirm");
  });
  it("c=0.5（旧硬上限点）→ confirm（20261025 起不再是拒绝区）", () => {
    expect(classifySupplyRatio(0.5, RMAX, HARD)).toBe("confirm");
  });
  it("c=0.8 → confirm（恰好压硬上限线，仍可审批通过）", () => {
    expect(classifySupplyRatio(0.8, RMAX, HARD)).toBe("confirm");
  });
  it("c=0.8+ε → reject（超硬上限不可上架）", () => {
    expect(classifySupplyRatio(0.8001, RMAX, HARD)).toBe("reject");
  });
  it("c=1.0 → reject（等价倒挂前的极限）", () => {
    expect(classifySupplyRatio(1.0, RMAX, HARD)).toBe("reject");
  });
  it("红线可下调：ratioMax=0.2 时 c=0.25 → confirm", () => {
    expect(classifySupplyRatio(0.25, 0.2, HARD)).toBe("confirm");
  });
});
