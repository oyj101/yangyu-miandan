import { describe, it, expect } from "vitest";
import { ymdOf, ymdOfOrEmpty, isYmd } from "./date";

/**
 * 这些用例的存在理由：mysql2 把 DATE 列返回成 JS Date 对象，
 * 而单测长期只喂字符串，所以 `String(x).slice(0,10)` 的缺陷从未被测出来，
 * 直到连真库冒烟才暴露（连续 5 天被判定 0 天）。
 * 因此这里**必须**显式覆盖 Date 入参。
 */
describe("ymdOf", () => {
  it("Date 对象 → 本地 YYYY-MM-DD（模拟 mysql2 的 DATE 列）", () => {
    expect(ymdOf(new Date(2026, 10, 3))).toBe("2026-11-03");
  });

  it("跨月/跨年补零", () => {
    expect(ymdOf(new Date(2026, 0, 1))).toBe("2026-01-01");
    expect(ymdOf(new Date(2026, 11, 31))).toBe("2026-12-31");
  });

  it("Date 带时分秒也只取日期（本地视角，不因 UTC 偏移差一天）", () => {
    expect(ymdOf(new Date(2026, 10, 3, 23, 59, 59))).toBe("2026-11-03");
  });

  it("字符串 'YYYY-MM-DD' 原样返回", () => {
    expect(ymdOf("2026-11-03")).toBe("2026-11-03");
  });

  it("字符串带时间 → 截前 10 位", () => {
    expect(ymdOf("2026-11-03 12:34:56")).toBe("2026-11-03");
  });

  it("null / undefined / 空串 → null", () => {
    expect(ymdOf(null)).toBeNull();
    expect(ymdOf(undefined)).toBeNull();
    expect(ymdOf("")).toBeNull();
    expect(ymdOf("   ")).toBeNull();
  });

  it("Invalid Date → null（而不是 'NaN-NaN-NaN'）", () => {
    expect(ymdOf(new Date("not-a-date"))).toBeNull();
  });

  it("ymdOfOrEmpty 拿不到时返回空串", () => {
    expect(ymdOfOrEmpty(null)).toBe("");
    expect(ymdOfOrEmpty(new Date(2026, 10, 3))).toBe("2026-11-03");
  });

  it("产出必须能被 isYmd 认可（喂给 dayDiff 才不会 NaN）", () => {
    expect(isYmd(ymdOf(new Date(2026, 10, 3)))).toBe(true);
    expect(isYmd(ymdOfOrEmpty(new Date(2026, 10, 3)))).toBe(true);
  });
});

describe("回归：旧写法为何是错的", () => {
  it("String(Date).slice(0,10) 得到的是星期几开头，不是日期", () => {
    const legacy = String(new Date(2026, 10, 3)).slice(0, 10);
    // 这就是线上真实拿到的值：'Tue Nov 03'
    expect(legacy).not.toBe("2026-11-03");
    expect(/^[A-Z][a-z]{2} /.test(legacy)).toBe(true);
  });
});
