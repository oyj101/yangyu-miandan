import { describe, it, expect } from "vitest";
import { toProjectListView, toProjectView, promiseOf } from "./project.view";
import { Card } from "../card/card.types";

const card = {
  id: "11111111-2222-3333-4444-555555555555",
  merchantId: "m-1",
  type: "times",
  times: 10,
  freq: "每周1次",
  rewardPerTime: 7,
  price: 100,
  coverage: 1,
  coverageCap: 1,
  perMerchantQuota: 200,
  status: "active",
  unitPrice: 10,
  periods: 10,
  supplyPrice: 3,
  title: "招牌鱼火锅",
  subtitle: "10 期套餐",
  merchantName: "老李鱼庄",
  category: "food",
  coverUrl: null,
  sortWeight: 0,
  listedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Card;

describe("集合页投影（PO: 不露每期返多少钱）", () => {
  const v = toProjectListView(card, 23);

  it("不含单价 —— 单价 × 返还比例就是每期返多少", () => {
    expect("unitPrice" in (v as any)).toBe(false);
  });

  it("不含返还比例 —— 任何人都不能拿总价除期数再乘比例", () => {
    expect("refundNowRatio" in (v as any)).toBe(false);
    expect("refundShareRatio" in (v as any)).toBe(false);
  });

  it("不含购买承诺摘要（promise 只在详情/弹层给）", () => {
    expect("promise" in (v as any)).toBe(false);
  });

  it("必须保留总价与期数，否则用户无法决策", () => {
    expect(v.totalPrice).toBe(100);
    expect(v.periods).toBe(10);
  });

  it("承诺文案不含数字金额与百分比", () => {
    expect(v.refundClaim).not.toMatch(/¥|\d+\s*%/);
    expect(v.refundClaim).toContain("全额返还");
  });

  it("详情投影仍给单价与比例（购买弹层要算每期返还额）", () => {
    const detail = toProjectView(card, 23);
    expect(detail.unitPrice).toBe(10);
    expect(detail.refundNowRatio).toBe(0.7);
    const p = promiseOf(detail);
    // 每期返 7 = 10 × 0.7，这是交易告知义务，必须在弹层里能算出来
    expect(p.refundNow).toBe(7);
    expect(p.refundShare).toBe(3);
  });
});

describe("每卡独立分成（PO：每个商品和服务决定分多少）", () => {
  const cardWith = (shareRatio: number) => ({ ...card, shareRatio } as unknown as Card);

  it("比例取自卡本身，而不是全局 0.3", () => {
    const v = toProjectView(cardWith(0.5), 0);
    expect(v.refundShareRatio).toBe(0.5);
    expect(v.refundNowRatio).toBe(0.5);
  });

  it("即时退 + 分享退 恒等于 100%（不能出现退不满或退超）", () => {
    for (const r of [0, 0.2, 0.3, 0.45, 0.5]) {
      const v = toProjectView(cardWith(r), 0);
      expect(Math.round((v.refundNowRatio + v.refundShareRatio) * 100)).toBe(100);
    }
  });

  it("购买弹层文案说明「打开链接即绑定」，不再写「成交」", () => {
    const p = promiseOf(toProjectView(cardWith(0.3), 0));
    expect(p.rule).toContain("打开链接即绑定");
    expect(p.rule).not.toContain("成交");
  });
});
