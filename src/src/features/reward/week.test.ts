import { describe, it, expect, vi, afterEach } from "vitest";
import { currentWeek } from "./reward.service";

// 20261018 P1-1: 周编号必须为 ISO-8601 周(周四归属法)。
// 旧算法按「年内第 N 个 7 天」编号, 与 ISO 周系统性偏移, 并在跨年周把同一自然周
// 割裂成两个 week 值 → idx_checkin_dedup(enrollment_id, week) 失效(同周可核销两次)。
describe("currentWeek · ISO-8601 周编号", () => {
  afterEach(() => vi.useRealTimers());

  const at = (isoLocalPlus8: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(isoLocalPlus8));
    return currentWeek();
  };

  it("2026-10-18(周日) → 2026W42，与本周内 10-16 同周（旧算法 10-18 会翻到 W43）", () => {
    expect(at("2026-10-16T10:00:00+08:00")).toBe("2026W42");
    expect(at("2026-10-18T10:00:00+08:00")).toBe("2026W42");
  });

  it("跨年周连续：2026-12-31 与 2027-01-01 同为 2026W53（旧算法会割裂为 2026W53 / 2027W1）", () => {
    expect(at("2026-12-31T10:00:00+08:00")).toBe("2026W53");
    expect(at("2027-01-01T10:00:00+08:00")).toBe("2026W53");
  });

  it("2025-12-29(周一) → 2026W1（跨年周归属 ISO 年）", () => {
    expect(at("2025-12-29T10:00:00+08:00")).toBe("2026W1");
  });

  it("2026-02-01 → 2026W5", () => {
    expect(at("2026-02-01T10:00:00+08:00")).toBe("2026W5");
  });

  it("一周内 7 天 week 值恒定（周一至周日不翻周）", () => {
    const days = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
    const weeks = days.map((d) => at(d + "T10:00:00+08:00"));
    expect(new Set(weeks).size).toBe(1);
  });
});
