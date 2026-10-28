import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * 支付态闸门（enrollment/pay-guard.ts）
 *
 * 这组测试锁的是一个真实缺陷的修复：
 * 本项目没有支付回调端点，purchase 只会把 pay_status 写成 unpaid，
 * 之后没有任何地方会自动置 paid。收敛前只有退款流程会查单，
 * 核销流程只读本地字段 → 已付款用户首次核销被拒。
 *
 * 所以断言的核心是「本地 unpaid 但上游已 paid 时必须放行」，
 * 以及「查不到就必须拒」——钱的事不能靠猜。
 */

const mockPayStatus = vi.hoisted(() => vi.fn());
const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("../../lib/fund", () => ({ payStatus: mockPayStatus }));
vi.mock("../../lib/db", () => ({ query: mockQuery }));
vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { ensurePaid, payGuardMessage } = await import("./pay-guard");

beforeEach(() => {
  mockPayStatus.mockReset();
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe("ensurePaid：本地已 paid", () => {
  it("直接放行，不重复打 8100（已确认过的事实不必每次复核）", async () => {
    const g = await ensurePaid({ id: "e1", payStatus: "paid", payOrderNo: "PO1" });
    expect(g.state).toBe("paid");
    expect(g.canProceed).toBe(true);
    expect(g.remoteChecked).toBe(false);
    expect(mockPayStatus).not.toHaveBeenCalled();
  });
});

describe("ensurePaid：免费领卡（无支付单）", () => {
  it("pay_status=none 且无单号 → 放行，视为免费卡", async () => {
    const g = await ensurePaid({ id: "e1", payStatus: "none", payOrderNo: null });
    expect(g.state).toBe("none");
    expect(g.canProceed).toBe(true);
    expect(mockPayStatus).not.toHaveBeenCalled();
  });

  it("pay_status=unpaid 但单号丢了 → 拒（这说明单据存在过，不能当免费卡放过）", async () => {
    const g = await ensurePaid({ id: "e1", payStatus: "unpaid", payOrderNo: null });
    expect(g.canProceed).toBe(false);
    expect(g.err).toContain("支付单号");
  });

  it("pay_status=pending 但单号丢了 → 拒", async () => {
    const g = await ensurePaid({ id: "e1", payStatus: "pending", payOrderNo: null });
    expect(g.canProceed).toBe(false);
  });
});

describe("ensurePaid：本地 unpaid，上游才是真源", () => {
  it("上游已 paid → 放行，并幂等回写（带 pay_status<>'paid' 条件，不覆盖 refunded）", async () => {
    mockPayStatus.mockResolvedValue({ ok: true, data: { state: "paid", raw: "paid" } });

    const g = await ensurePaid({ id: "e1", payStatus: "unpaid", payOrderNo: "PO1" });
    expect(g.state).toBe("paid");
    expect(g.canProceed).toBe(true);
    expect(g.remoteChecked).toBe(true);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, args] = mockQuery.mock.calls[0];
    expect(sql).toContain("UPDATE enrollment SET pay_status='paid'");
    expect(sql).toContain("pay_status<>'paid'");
    expect(args).toEqual(["e1"]);
  });

  it("上游仍 unpaid → 拒", async () => {
    mockPayStatus.mockResolvedValue({ ok: true, data: { state: "unpaid", raw: "unpaid" } });
    const g = await ensurePaid({ id: "e1", payStatus: "unpaid", payOrderNo: "PO1" });
    expect(g.canProceed).toBe(false);
    expect(g.state).toBe("unpaid");
  });

  it("上游 unknown → 拒，不当成已支付", async () => {
    mockPayStatus.mockResolvedValue({ ok: true, data: { state: "unknown", raw: "PARTIAL_REFUND" } });
    const g = await ensurePaid({ id: "e1", payStatus: "unpaid", payOrderNo: "PO1" });
    expect(g.canProceed).toBe(false);
    expect(g.state).toBe("unknown");
  });

  it("上游 closed / refunded → 拒", async () => {
    for (const state of ["closed", "refunded"]) {
      mockPayStatus.mockResolvedValue({ ok: true, data: { state, raw: state } });
      const g = await ensurePaid({ id: "e1", payStatus: "unpaid", payOrderNo: "PO1" });
      expect(g.canProceed).toBe(false);
    }
  });

  it("查单失败（超时/网络）→ 拒，并且不能凭本地状态放行", async () => {
    mockPayStatus.mockResolvedValue({ ok: false, code: "TIMEOUT", err: "超时 3000ms" });
    const g = await ensurePaid({ id: "e1", payStatus: "unpaid", payOrderNo: "PO1" });
    expect(g.canProceed).toBe(false);
    expect(g.remoteChecked).toBe(true);
    expect(g.err).toContain("超时");
  });

  it("回写失败不影响本次放行（查单结果已经确认，不应因写库抖动误拒用户）", async () => {
    mockPayStatus.mockResolvedValue({ ok: true, data: { state: "paid", raw: "paid" } });
    mockQuery.mockRejectedValue(new Error("db busy"));
    const g = await ensurePaid({ id: "e1", payStatus: "unpaid", payOrderNo: "PO1" });
    expect(g.canProceed).toBe(true);
    expect(g.state).toBe("paid");
  });
});

describe("payGuardMessage：同一件事只允许一种客诉话术", () => {
  it("不同状态给出不同文案，且不把「查不到」说成「未支付」", async () => {
    const unpaid = payGuardMessage({ state: "unpaid", canProceed: false, remoteChecked: true });
    const closed = payGuardMessage({ state: "closed", canProceed: false, remoteChecked: true });
    const err = payGuardMessage({
      state: "unpaid",
      canProceed: false,
      remoteChecked: true,
      err: "超时",
    });

    expect(unpaid).toContain("尚未完成支付");
    expect(closed).toContain("已关闭");
    expect(err).toContain("暂时查不到");
    expect(new Set([unpaid, closed, err]).size).toBe(3);
  });
});
