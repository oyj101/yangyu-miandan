/**
 * 日期归一（YYYY-MM-DD）
 *
 * ── 为什么必须有这个文件 ─────────────────────────────────────────────
 * mysql2 会把 `DATE` / `DATETIME` 列**返回成 JS Date 对象**（本项目 db.ts 未开 dateStrings）。
 * 于是 `String(r.week_start).slice(0, 10)` 得到的是 `'Tue Nov 03'`，
 * 而不是 `'2026-11-03'`。
 *
 * 这个错误在单测里看不出来（单测喂的是字符串），只有连真库才暴露：
 * `dayDiff('2026-11-02', 'Tue Nov 03')` → split('-').map(Number) → NaN
 * → `NaN >= 0` 为 false → **所有日标记被过滤掉** → 连续天数恒为 0。
 *
 * 实际后果（2026-10-25 隔离库冒烟实测）：
 *   · 用户真实连续投喂 5 天，核销仍判定"未达标" → 70%/30% 一分不退
 *   · 更严重：engine 把每次核销都记成未达标 → 正确履约的用户被罚停 1 次、
 *     再罚停 3 次，直至"连续 3 次或累计 5 次"被强制退出活动
 * 这是把好用户判成违约，比不发钱更伤。
 *
 * ── 用法铁律 ────────────────────────────────────────────────────────
 * 凡是 DATE / DATETIME 列要当"日期字符串"用的地方，一律走 ymdOf()；
 * 禁止再写 `String(row.xxx).slice(0, 10)`。
 * 判据：grep -rn "slice(0, *10)" src/ | grep -v test 必须只剩本文件。
 */

/** 本地时区补零 */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 把 DB 读出的日期值归一成 'YYYY-MM-DD'。
 *
 * - Date 对象：取**本地**年月日（db.ts 设 timezone:'local'，DATE 列被解释为本地零点，
 *   用 getFullYear/getMonth/getDate 取值必然回落原值；不能用 toISOString，会因时区差一天）
 * - 已是字符串：截前 10 位（容忍 'YYYY-MM-DD HH:mm:ss'）
 * - null / undefined / 空串：返回 null，交由调用方决定兜底
 */
export function ymdOf(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
  }
  const s = String(v).trim();
  if (!s) return null;
  return s.length > 10 ? s.slice(0, 10) : s;
}

/** 必填场景的便捷版：拿不到就返回 ''（供后续正则校验兜底，不会变成 'Invalid Date'） */
export function ymdOfOrEmpty(v: unknown): string {
  return ymdOf(v) ?? "";
}

/** 是否为合法 'YYYY-MM-DD' */
export function isYmd(s: unknown): boolean {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
