import { describe, it, expect } from "vitest";
import { parseTaskDaysPayload } from "./task.service";

/**
 * 8100 `/yangyu/task-days` 响应解析。
 *
 * 这里最要紧的不是"字段能不能读到"，而是 **feed 真源闸门**：
 * 一旦把 feed_source=undefined/none 的响应当成 ok=true，met 会恒为 0 →
 * judgePeriod 的 dataAvailable 变成 true → 全体正常用户被判未达标 → 罚停 → 强制退出。
 * 所以下面第 1、2 条用例是资金安全回归，改动此处必须重新跑。
 */

const okPayload = (feedSource: string | undefined, daily: unknown[]) => ({
  code: 0,
  message: "ok",
  data: {
    uid: 17,
    from: "2026-10-18",
    to: "2026-10-25",
    chat_source: "chat_history",
    ...(feedSource === undefined ? {} : { feed_source: feedSource }),
    daily,
  },
});

describe("parseTaskDaysPayload · feed 真源闸门（资金安全）", () => {
  it("feed_source 缺失 → 视为数据不可用（不可默认通过）", () => {
    const r = parseTaskDaysPayload(okPayload(undefined, [{ date: "2026-10-19", chat: 3, feed: 0 }]));
    expect(r.ok).toBe(false);
    expect(r.daily).toEqual([]);
    expect(r.err).toContain("feed 真源未就绪");
  });

  it("feed_source=none → 视为数据不可用（即使有 chat 数据）", () => {
    const r = parseTaskDaysPayload(
      okPayload("none", [
        { date: "2026-10-19", chat: 3, feed: 0 },
        { date: "2026-10-20", chat: 5, feed: 0 },
      ])
    );
    expect(r.ok).toBe(false);
    expect(r.daily).toEqual([]);
    expect(r.err).toContain("none");
  });

  it("feed_source=chat → 正常解析（打通后自动恢复）", () => {
    const r = parseTaskDaysPayload(
      okPayload("chat", [
        { date: "2026-10-19", chat: 3, feed: 3 },
        { date: "2026-10-20", chat: 1, feed: 1 },
      ])
    );
    expect(r.ok).toBe(true);
    expect(r.source).toBe("daily");
    expect(r.daily).toEqual([
      { date: "2026-10-19", chat: 3, feed: 3 },
      { date: "2026-10-20", chat: 1, feed: 1 },
    ]);
  });
});

describe("parseTaskDaysPayload · 异常与边界", () => {
  it("code 非 0 → 失败（不能因为 HTTP 200 就当成功）", () => {
    const r = parseTaskDaysPayload({ code: 403, message: "服务鉴权失败", data: null });
    expect(r.ok).toBe(false);
    expect(r.err).toContain("403");
  });

  it("code 为字符串 '0' → 仍算成功（8100 ApiResponse 序列化差异）", () => {
    const p: any = okPayload("chat", [{ date: "2026-10-19", chat: 1, feed: 1 }]);
    p.code = "0";
    expect(parseTaskDaysPayload(p).ok).toBe(true);
  });

  it("daily 不是数组 → 失败（回落到保守分支）", () => {
    expect(parseTaskDaysPayload({ code: 0, data: { daily: null } }).ok).toBe(false);
    expect(parseTaskDaysPayload({ code: 0, data: {} }).ok).toBe(false);
  });

  it("空 daily + feed_source=chat → 成功但零条目（用户本周真没做）", () => {
    const r = parseTaskDaysPayload(okPayload("chat", []));
    expect(r.ok).toBe(true);
    expect(r.daily).toEqual([]);
  });

  it("非法日期被剔除，不污染连续判定", () => {
    const r = parseTaskDaysPayload(
      okPayload("chat", [
        { date: "2026-10-19", chat: 2, feed: 2 },
        { date: "", chat: 9, feed: 9 },
        { date: "Tue Nov 03", chat: 9, feed: 9 },
        null,
      ])
    );
    expect(r.ok).toBe(true);
    expect(r.daily).toHaveLength(1);
    expect(r.daily[0].date).toBe("2026-10-19");
  });

  it("chat/feed 缺失或非数字 → 归零，不产生 NaN", () => {
    const r = parseTaskDaysPayload(okPayload("chat", [{ date: "2026-10-19" }]));
    expect(r.daily[0].chat).toBe(0);
    expect(r.daily[0].feed).toBe(0);
    expect(Number.isNaN(r.daily[0].chat)).toBe(false);
  });

  it("响应为 null / 非对象 → 失败", () => {
    expect(parseTaskDaysPayload(null).ok).toBe(false);
    expect(parseTaskDaysPayload(undefined).ok).toBe(false);
    expect(parseTaskDaysPayload("oops").ok).toBe(false);
  });

  it("Date 对象形式的 date 也能归一（8100 若直出 DATE 列）", () => {
    const r = parseTaskDaysPayload(
      okPayload("chat", [{ date: new Date(2026, 9, 19), chat: 1, feed: 1 }])
    );
    expect(r.daily[0].date).toBe("2026-10-19");
  });
});
