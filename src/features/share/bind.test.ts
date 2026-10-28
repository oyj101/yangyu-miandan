import { describe, it, expect } from "vitest";
import { decideBind } from "./share.service";

/**
 * 绑定判定矩阵（钱归谁的唯一判据）
 *
 * 这些用例直接对应 PO 口径「谁分享绑定谁的关系」：
 *   谁先分享谁绑定、自己不能绑自己、不能成环、重复绑定幂等。
 */
describe("分享绑定决策", () => {
  const base = { viewerAiUid: "100", refAiUid: "200", policy: "first" as const };

  it("首次绑定 → insert", () => {
    expect(decideBind(base).action).toBe("insert");
  });

  it("自己分享给自己 → SELF_REFERRAL（不留绑定，避免永久占位）", () => {
    const d = decideBind({ ...base, refAiUid: "100" });
    expect(d).toEqual({ action: "reject", reason: "SELF_REFERRAL" });
  });

  it("同一分享者重复绑定 → 幂等（same），可顺带补解锁", () => {
    const d = decideBind({ ...base, prevSharerAiUid: "200" });
    expect(d.action).toBe("same");
  });

  it("已被 A 绑定，B 再分享 → ALREADY_BOUND（首触锁定，不覆盖）", () => {
    const d = decideBind({ ...base, prevSharerAiUid: "300" });
    expect(d).toEqual({ action: "reject", reason: "ALREADY_BOUND" });
  });

  it("policy=last 时允许改归因 → rebind", () => {
    const d = decideBind({ ...base, policy: "last", prevSharerAiUid: "300" });
    expect(d.action).toBe("rebind");
  });

  it("ref 是我自己拉来的人 → CYCLE（反向绑定成环）", () => {
    const d = decideBind({ ...base, cycle: true });
    expect(d).toEqual({ action: "reject", reason: "CYCLE" });
  });

  it("已有归属时不再做成环判定（否则 rebind 永远走不到）", () => {
    const d = decideBind({ ...base, policy: "last", prevSharerAiUid: "300", cycle: true });
    expect(d.action).toBe("rebind");
  });
});
