// 连续 5 天判定（纯函数）
//
// 规则（PO 2026-10-20 拍板）：
//   自然周内「任意连续 5 天」，每天同时满足 投孪生工程聊天 与 投喂。
//   窗口必须完整落在该 ISO 周内 —— 因此合法起点只有周一/周二/周三，
//   周四起算的 5 天必然跨周（三天窗口里最晚起点是周三→周日）。
//
// 这是与旧口径（一周内累计 ≥5 天有记录，不要求连续）的本质差别：
// 旧口径下「周一二三四五 + 周日补一天」也算达标，新口径下断一天就整周作废。

import { dayDiff, addDays, parseYmd, ymd } from "../period/iso-week";

export interface DailyMark {
  date: string; // 'YYYY-MM-DD'
  met: boolean;
}

export interface StreakResult {
  met: boolean;
  longest: number; // 窗口内最长连续达标天数
  windowStart: string | null; // 达标时：该连续段前 needed 天的起点
  windowEnd: string | null;
}

/**
 * 判定周内是否存在长度 >= needed 的连续达标段。
 * @param marks 全部日标记（可含周外日期，内部按 [weekStart, weekEnd] 过滤）
 * @param weekStart 'YYYY-MM-DD' 该 ISO 周周一
 * @param weekEnd   'YYYY-MM-DD' 该 ISO 周周日
 * @param needed    需要连续的天数，默认 5
 */
export function evaluateStreak(
  marks: DailyMark[],
  weekStart: string,
  weekEnd: string,
  needed = 5
): StreakResult {
  if (needed <= 0) return { met: true, longest: 0, windowStart: weekStart, windowEnd: weekStart };

  // 只取周内且达标的日子，去重后按日期升序
  const days = Array.from(
    new Set(
      marks
        .filter((m) => m.met && dayDiff(weekStart, m.date) >= 0 && dayDiff(m.date, weekEnd) >= 0)
        .map((m) => m.date)
    )
  ).sort();

  if (days.length < needed) {
    return { met: false, longest: maxRun(days), windowStart: null, windowEnd: null };
  }

  // 找连续段。必须完整遍历：longest 要反映全周最长连续天数（展示与申诉用），
  // 首个达到 needed 的段只用来确定展示窗口，不能提前 return。
  let runStart = days[0];
  let runLen = 1;
  let longest = 1;
  let hitStart: string | null = null;

  for (let i = 1; i < days.length; i++) {
    if (dayDiff(days[i - 1], days[i]) === 1) {
      runLen += 1;
    } else {
      runStart = days[i];
      runLen = 1;
    }
    if (runLen > longest) longest = runLen;
    if (hitStart === null && runLen >= needed) {
      // 该段已够长；窗口取"最近 needed 天"，即从 runLen-needed 天处开始
      hitStart = ymd(addDays(parseYmd(runStart), runLen - needed));
    }
  }

  if (hitStart === null) {
    return { met: false, longest, windowStart: null, windowEnd: null };
  }
  return {
    met: true,
    longest,
    windowStart: hitStart,
    windowEnd: ymd(addDays(parseYmd(hitStart), needed - 1)),
  };
}

function maxRun(sortedDays: string[]): number {
  if (sortedDays.length === 0) return 0;
  let best = 1;
  let cur = 1;
  for (let i = 1; i < sortedDays.length; i++) {
    if (dayDiff(sortedDays[i - 1], sortedDays[i]) === 1) cur += 1;
    else cur = 1;
    if (cur > best) best = cur;
  }
  return best;
}

/**
 * 该周是否已经完全不可能达标（用于"周四起告知用户本周无望"，避免白做）。
 * 周四之后任何 5 天窗口都跨周。
 */
export function weekNoLongerAchievable(weekEnd: string, today: string, needed = 5): boolean {
  const remainInclusive = dayDiff(today, weekEnd) + 1; // 含今天还剩几天
  return remainInclusive < needed;
}
