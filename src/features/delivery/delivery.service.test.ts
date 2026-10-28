import { describe, it, expect } from "vitest";
import { canTransition, isTerminal } from "./delivery.types";
import {
  assertFulfillSupported,
  calcFreightTotal,
  normalizeReceiver,
} from "../enrollment/enrollment.service";

/**
 * 配送分支（009）单测：只测纯逻辑。
 * 这些函数是所有写入路径的共同判据（端点 / 批量补建 / 运营代改都走同一份），
 * 一旦漂移，配送与发奖的边界就会各自解释。
 */

describe("delivery 状态机", () => {
  it("只允许单向推进", () => {
    expect(canTransition("pending", "shipped")).toBe(true);
    expect(canTransition("shipped", "delivered")).toBe(true);
    expect(canTransition("delivered", "signed")).toBe(true);
  });

  it("禁止跳级与回退（跳级会绕过运费/签收确认）", () => {
    expect(canTransition("pending", "signed")).toBe(false);
    expect(canTransition("pending", "delivered")).toBe(false);
    expect(canTransition("shipped", "signed")).toBe(false);
    expect(canTransition("signed", "delivered")).toBe(false);
    expect(canTransition("delivered", "shipped")).toBe(false);
  });

  it("终态不再可迁移", () => {
    expect(isTerminal("signed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("delivered")).toBe(false);
  });
});

describe("卡能力闸门 assertFulfillSupported", () => {
  it("仅自提的卡不能选配送", () => {
    expect(() => assertFulfillSupported({ fulfillment: "pickup" }, "delivery")).toThrow(/仅支持到店自提/);
  });

  it("仅配送的卡不能选自提（反向也要拦）", () => {
    expect(() => assertFulfillSupported({ fulfillment: "delivery" }, "pickup")).toThrow(/仅支持配送到家/);
  });

  it("both 两种都放行", () => {
    expect(() => assertFulfillSupported({ fulfillment: "both" }, "pickup")).not.toThrow();
    expect(() => assertFulfillSupported({ fulfillment: "both" }, "delivery")).not.toThrow();
  });

  it("自提永远不受能力限制", () => {
    expect(() => assertFulfillSupported({ fulfillment: "pickup" }, "pickup")).not.toThrow();
  });
});

describe("收货信息 normalizeReceiver", () => {
  it("合法信息原样返回并去空格", () => {
    const r = normalizeReceiver({ name: " 张三 ", phone: "13800138000", address: " 上海市浦东新区某路 1 号 " });
    expect(r.name).toBe("张三");
    expect(r.phone).toBe("13800138000");
    expect(r.address).toBe("上海市浦东新区某路 1 号");
  });

  it("缺姓名必拒", () => {
    expect(() => normalizeReceiver({ name: "  ", phone: "13800138000", address: "上海市某路1号" })).toThrow(
      /收货人姓名/
    );
  });

  it("手机号格式非法必拒", () => {
    expect(() => normalizeReceiver({ name: "张三", phone: "12345", address: "上海市某路1号" })).toThrow(
      /手机号格式/
    );
    expect(() => normalizeReceiver({ name: "张三", phone: "23800138000", address: "上海市某路1号" })).toThrow(
      /手机号格式/
    );
  });

  it("地址过短必拒（避免商户拿到无法配送的地址）", () => {
    expect(() => normalizeReceiver({ name: "张三", phone: "13800138000", address: "上海" })).toThrow(
      /地址过短/
    );
  });

  it("完全不传时按缺姓名拒，不会静默落空地址", () => {
    expect(() => normalizeReceiver(null)).toThrow(/收货人姓名/);
    expect(() => normalizeReceiver(undefined)).toThrow(/收货人姓名/);
  });
});

describe("运费 calcFreightTotal", () => {
  it("每期运费 × 期数", () => {
    expect(calcFreightTotal(5, 10)).toBe(50);
    expect(calcFreightTotal(2.5, 3)).toBe(7.5);
  });

  it("免运费 / 零期数都得 0", () => {
    expect(calcFreightTotal(0, 10)).toBe(0);
    expect(calcFreightTotal(9.9, 0)).toBe(0);
  });

  it("负数与非法值收敛为 0，不产生负运费（负运费=平台倒贴）", () => {
    expect(calcFreightTotal(-5, 10)).toBe(0);
    expect(calcFreightTotal(NaN as unknown as number, 10)).toBe(0);
  });

  it("按分四舍五入，不出现浮点尾差", () => {
    expect(calcFreightTotal(0.1, 3)).toBe(0.3);
    expect(calcFreightTotal(1.005, 1)).toBe(1.01);
  });
});
