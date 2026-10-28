// ISO 8601 周工具（纯函数，无外部依赖，便于单测）
//
// 为什么不用 moment/dayjs：本服务只依赖 5 个日期函数，为它引一个库不划算；
// 且 ISO 周跨年规则（1 月 4 日所在周为第 1 周）必须自己写清楚才好审。

export interface IsoWeek {
  year: number;
  week: number;
  monday: Date; // 该 ISO 周的周一 00:00:00（服务器本地时区，CST）
  sunday: Date; // 该 ISO 周的周日 00:00:00
}

/** 去掉时分秒，只保留本地日期 */
export function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 本地日期加减天数（用 setDate 而非毫秒加法，避免任何 DST 陷阱） */
export function addDays(d: Date, n: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() + n);
  return r;
}

/** 'YYYY-MM-DD'（本地时区，不经过 toISOString，避免 UTC 偏移导致差一天） */
export function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 'YYYY-MM-DD' → 本地零点的 Date */
export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** 两个 'YYYY-MM-DD' 之间的整天差（b - a），用 UTC 归一避开夏令时 */
export function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/**
 * 给定日期，返回其所属 ISO 周。
 * 规则：周一为一周首日；含 1 月 4 日的那一周为第 1 周（故 12/29-1/4 可能属上一年 W53）。
 */
export function isoWeekOf(input: Date): IsoWeek {
  const d = dateOnly(input);
  // getDay(): 0=周日 … 6=周六；转成 ISO 的 1=周一 … 7=周日
  const isoDow = d.getDay() || 7;
  const monday = addDays(d, 1 - isoDow);
  // 该周的周四是确定 ISO 年份的锚点（周四必落在本 ISO 年内）
  const thursday = addDays(monday, 3);
  const year = thursday.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const jan4IsoDow = jan4.getDay() || 7;
  const firstMonday = addDays(jan4, 1 - jan4IsoDow);
  const week = Math.floor(dayDiff(ymd(firstMonday), ymd(monday)) / 7) + 1;
  return { year, week, monday, sunday: addDays(monday, 6) };
}

/** 与 checkin.week / weekly_eval_log.week 同口径：'YYYYWnn'（如 2026W43） */
export function isoWeekKey(w: IsoWeek): string {
  return `${w.year}W${String(w.week).padStart(2, "0")}`;
}

/** 'YYYYWnn' → 该周信息 */
export function parseIsoWeekKey(key: string): IsoWeek {
  const m = /^(\d{4})W(\d{1,2})$/.exec(key);
  if (!m) throw new Error(`非法 ISO 周键: ${key}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  // 以 1 月 4 日为锚点回推该周周一
  const jan4 = new Date(year, 0, 4);
  const jan4IsoDow = jan4.getDay() || 7;
  const firstMonday = addDays(jan4, 1 - jan4IsoDow);
  const monday = addDays(firstMonday, (week - 1) * 7);
  return { year, week, monday, sunday: addDays(monday, 6) };
}

/** 以某个 ISO 周为基准，前后移动 n 周 */
export function shiftWeek(w: IsoWeek, n: number): IsoWeek {
  return isoWeekOf(addDays(w.monday, n * 7));
}

/**
 * 首个可计的完整 ISO 周：购买日所在周的下一个周一。
 *
 * 为什么必须顺延：连续 5 天窗口的合法起点只有周一/周二/周三。
 * 用户周四买卡，本周只剩 4 天，物理上不可能达标 →
 * 若当周计期，等于系统批量制造失败者，买卡即被罚 pause1。
 */
export function firstFullWeek(purchasedAt: Date): IsoWeek {
  const cur = isoWeekOf(purchasedAt);
  return shiftWeek(cur, 1);
}

/** 本期是否已不可达标：周四 00:00 之后，剩余天数 < 5，任何窗口都跨周 */
export function isStreakWindowClosed(now: Date): boolean {
  const w = isoWeekOf(now);
  const today = ymd(dateOnly(now));
  // 合法起点只有 week_start / +1 / +2；最后一个起点是周三
  const lastStart = ymd(addDays(w.monday, 2));
  return dayDiff(today, lastStart) > 0;
}
