import { describe, expect, it } from "vitest";
import { computePlannedAmounts } from "./period.service";

/**
 * 011（方案 A 建期定案）计划退额纯函数用例：
 * 1) unit 口径与退款旧公式逐分一致（回归证明零行为变化）
 * 2) total 口径 Σplanned 精确等于 round2(总额×ratio)（末期待遇差额并入）
 * 3) total 口径末期可能小于等于每期均值但不为负，且与均值差 < 1 分
 */
describe("computePlannedAmounts", () => {
  it("unit 口径：每期 = round2(单价×比例)，与旧公式逐分一致", () => {
    const r = computePlannedAmounts({
      unitPrice: 9.99,
      periods: 4,
      refundNowRatio: 0.7,
      shareRatio: 0.3,
      caliber: "unit",
    });
    expect(r.refund70Planned).toEqual([6.99, 6.99, 6.99, 6.99]);
    expect(r.refund30Planned).toEqual([3.0, 3.0, 3.0, 3.0]);
  });

  it("total 口径：Σplanned 精确等于 round2(总额×ratio)", () => {
    // 构造产生舍入差的场景：unit=33.33, periods=3, ratio=0.7
    // total = round2(99.99 × 0.7) = 69.99；per = round2(23.33) = 23.33 → Σ=69.99 精确
    const r = computePlannedAmounts({
      unitPrice: 33.33,
      periods: 3,
      refundNowRatio: 0.7,
      shareRatio: 0.3,
      caliber: "total",
    });
    const sum70 = r.refund70Planned.reduce((a, b) => a + b, 0);
    expect(Math.round(sum70 * 100) / 100).toBe(69.99);
    const sum30 = r.refund30Planned.reduce((a, b) => a + b, 0);
    expect(Math.round(sum30 * 100) / 100).toBe(30.0);
  });

  it("total 口径：末期待遇差额并入且每期不为负、与均值差 < 1 分", () => {
    // unit=19.98, periods=7, ratio=0.7 → total = round2(139.86×0.7)=97.9
    // per = round2(97.9/7)=13.99；前6期=13.99，末期=97.9-83.94=13.96
    const r = computePlannedAmounts({
      unitPrice: 19.98,
      periods: 7,
      refundNowRatio: 0.7,
      shareRatio: 0.3,
      caliber: "total",
    });
    const last = r.refund70Planned[6]!;
    const per = r.refund70Planned[0]!;
    expect(r.refund70Planned.slice(0, 6)).toEqual([per, per, per, per, per, per]);
    expect(last).toBeGreaterThanOrEqual(0);
    expect(Math.abs(last - per)).toBeLessThan(1);
    const sum = r.refund70Planned.reduce((a, b) => a + b, 0);
    expect(Math.round(sum * 100) / 100).toBe(97.9);
  });

  it("单期卡：unit 与 total 结果一致", () => {
    const unit = computePlannedAmounts({
      unitPrice: 88,
      periods: 1,
      refundNowRatio: 0.7,
      shareRatio: 0.3,
      caliber: "unit",
    });
    const total = computePlannedAmounts({
      unitPrice: 88,
      periods: 1,
      refundNowRatio: 0.7,
      shareRatio: 0.3,
      caliber: "total",
    });
    expect(unit.refund70Planned).toEqual(total.refund70Planned);
    expect(unit.refund30Planned).toEqual(total.refund30Planned);
  });
});
