import { describe, it, expect } from "vitest";
import { evaluateStreak, weekNoLongerAchievable, type DailyMark } from "./streak";
import { isoWeekOf, ymd, addDays, firstFullWeek, parseIsoWeekKey, isoWeekKey } from "../period/iso-week";

// 固定一周做基准：2026-10-19（周一）~ 2026-10-25（周日）
const W_START = "2026-10-19";
const W_END = "2026-10-25";

function marks(dates: string[]): DailyMark[] {
  return dates.map((d) => ({ date: d, met: true }));
}

describe("evaluateStreak · 连续 5 天", () => {
  it("周一~周五连续 5 天 → 达标", () => {
    const r = evaluateStreak(marks(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]), W_START, W_END);
    expect(r.met).toBe(true);
    expect(r.windowStart).toBe("2026-10-19");
    expect(r.windowEnd).toBe("2026-10-23");
  });

  it("周三~周日连续 5 天（PO 举的例子）→ 达标", () => {
    const r = evaluateStreak(marks(["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]), W_START, W_END);
    expect(r.met).toBe(true);
    expect(r.windowStart).toBe("2026-10-21");
    expect(r.windowEnd).toBe("2026-10-25");
  });

  it("周四起算的 5 天必然跨周 → 不达标", () => {
    const r = evaluateStreak(marks(["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]), W_START, W_END);
    expect(r.met).toBe(false);
    expect(r.longest).toBe(4);
  });

  it("断一天（周一二三四 + 周日）→ 不达标，这是与旧口径的核心差别", () => {
    const r = evaluateStreak(
      marks(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-25"]),
      W_START,
      W_END
    );
    expect(r.met).toBe(false);
    expect(r.longest).toBe(4);
  });

  it("累计 7 天全勤 → 达标且窗口取前 5 天", () => {
    const r = evaluateStreak(
      marks(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]),
      W_START,
      W_END
    );
    expect(r.met).toBe(true);
    expect(r.longest).toBe(7);
    expect(r.windowStart).toBe("2026-10-19");
  });

  it("周外日期不计入", () => {
    const r = evaluateStreak(
      marks(["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"]),
      W_START,
      W_END
    );
    expect(r.met).toBe(false);
    expect(r.longest).toBe(4);
  });

  it("空数据 → 不达标", () => {
    const r = evaluateStreak([], W_START, W_END);
    expect(r.met).toBe(false);
    expect(r.longest).toBe(0);
  });

  it("重复日期去重后仍正确", () => {
    const r = evaluateStreak(
      marks(["2026-10-19", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]),
      W_START,
      W_END
    );
    expect(r.met).toBe(true);
    expect(r.longest).toBe(5);
  });
});

describe("weekNoLongerAchievable · 周四起告知无望", () => {
  it("周三还剩 5 天 → 仍可达标", () => {
    expect(weekNoLongerAchievable(W_END, "2026-10-21")).toBe(false);
  });
  it("周四只剩 4 天 → 已无望", () => {
    expect(weekNoLongerAchievable(W_END, "2026-10-22")).toBe(true);
  });
});

describe("iso-week · 边界", () => {
  it("2026-10-19 是 2026W43 的周一", () => {
    const w = isoWeekOf(new Date(2026, 9, 19));
    expect(isoWeekKey(w)).toBe("2026W43");
    expect(ymd(w.monday)).toBe("2026-10-19");
    expect(ymd(w.sunday)).toBe("2026-10-25");
  });

  it("键值往返一致", () => {
    const w = parseIsoWeekKey("2026W43");
    expect(ymd(w.monday)).toBe("2026-10-19");
    expect(isoWeekKey(w)).toBe("2026W43");
  });

  it("跨年周：2027-01-01 属 2026W53", () => {
    // 2026-12-28(周一) 起的一周到 2027-01-03，含 1 月 4 日前 → 仍属 2026 年第 53 周
    const w = isoWeekOf(new Date(2027, 0, 1));
    expect(w.year).toBe(2026);
    expect(w.week).toBe(53);
    expect(ymd(w.monday)).toBe("2026-12-28");
  });

  it("2027-01-04 是 2027W01 的周一", () => {
    const w = isoWeekOf(new Date(2027, 0, 4));
    expect(isoWeekKey(w)).toBe("2027W01");
    expect(ymd(w.monday)).toBe("2027-01-04");
  });
});

describe("firstFullWeek · 首期顺延", () => {
  it("周一购卡 → 首期是下周一（当周不计期）", () => {
    const w = firstFullWeek(new Date(2026, 9, 19)); // 周一
    expect(ymd(w.monday)).toBe("2026-10-26");
  });

  it("周四购卡 → 首期是下周一，不当周计期（否则注定失败）", () => {
    const w = firstFullWeek(new Date(2026, 9, 22)); // 周四
    expect(ymd(w.monday)).toBe("2026-10-26");
  });

  it("周日购卡 → 首期是次日本周一", () => {
    const w = firstFullWeek(new Date(2026, 9, 25)); // 周日
    expect(ymd(w.monday)).toBe("2026-10-26");
  });

  it("跨年购卡（12-31 周四）→ 首期 2027-01-04", () => {
    const w = firstFullWeek(new Date(2026, 11, 31));
    expect(ymd(w.monday)).toBe("2027-01-04");
  });
});

describe("addDays · 日期运算", () => {
  it("跨月", () => {
    expect(ymd(addDays(new Date(2026, 9, 31), 1))).toBe("2026-11-01");
  });
  it("跨年", () => {
    expect(ymd(addDays(new Date(2026, 11, 31), 1))).toBe("2027-01-01");
  });
});
