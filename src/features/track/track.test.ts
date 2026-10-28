import { describe, it, expect } from "vitest";
import { sanitizePayload } from "./track.service";

describe("埋点 payload 裁剪", () => {
  it("只保留白名单键", () => {
    const s = sanitizePayload({ cardId: "c1", amount: 100, openid: "oABC", token: "t" });
    expect(s).not.toBeNull();
    const o = JSON.parse(s!);
    expect(o.cardId).toBe("c1");
    expect(o.amount).toBe(100);
    // 支付凭证/身份凭证绝不允许进埋点表
    expect(o.openid).toBeUndefined();
    expect(o.token).toBeUndefined();
  });

  it("空对象返回 null（不写空 JSON）", () => {
    expect(sanitizePayload({})).toBeNull();
    expect(sanitizePayload(null)).toBeNull();
    expect(sanitizePayload("str")).toBeNull();
  });

  it("只有非法键时返回 null", () => {
    expect(sanitizePayload({ phone: "13800000000" })).toBeNull();
  });

  it("超长字符串按键截断到 120", () => {
    const s = sanitizePayload({ keyword: "x".repeat(500) });
    expect(JSON.parse(s!).keyword.length).toBe(120);
  });

  it("对象/数组值不被接收（埋点不是数据通道）", () => {
    const s = sanitizePayload({ cardId: "c1", payload: { a: 1 }, reason: ["x"] });
    const o = JSON.parse(s!);
    expect(o.cardId).toBe("c1");
    expect(o.payload).toBeUndefined();
    expect(o.reason).toBeUndefined();
  });
});
