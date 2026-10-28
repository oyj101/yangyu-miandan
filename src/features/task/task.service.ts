import { config } from "../../config";
import { query, newId } from "../../lib/db";
import { resolveAiUid } from "../../lib/fund";
import { ymdOfOrEmpty } from "../../lib/date";
import { dayDiff, ymd, dateOnly } from "../period/iso-week";
import { evaluateStreak } from "./streak";

export interface TaskDay {
  date: string; // 'YYYY-MM-DD'
  chat: number;
  feed: number;
}

export interface SyncResult {
  ok: boolean; // 8100 是否成功返回日明细
  source: "daily" | "days" | "none";
  upserted: number;
  err?: string;
}

/**
 * 解析 8100 `/yangyu/task-days` 的响应体（纯函数，便于单测）。
 *
 * feed(投喂) 维度的真源就绪校验是**资金安全闸门**，不可省：
 * met 的定义是 chat>0 且 feed>0。若 8100 的 feed 源未接通（feed_source !== 'chat'），
 * 它返回的 feed 恒为 0 → 每一天都会被算成"未达标"；而 judgePeriod 里
 * `dataAvailable = sync.ok || marks.length > 0`，一旦把这种"假成功"当 ok，
 * dataAvailable 就是 true → 全体正常用户被判未达标 → 罚停 → 强制退出。
 *
 * 所以 feed 源未就绪一律视为「数据不可用」：退回与端点缺失时完全一致的保守分支
 * （不惩罚、不发奖、下轮重试）。主站接通 feed 真源并置 feed_source=chat 后自动恢复。
 */
export function parseTaskDaysPayload(j: any): {
  ok: boolean;
  daily: TaskDay[];
  source: "daily" | "days" | "none";
  err?: string;
} {
  if (!j || typeof j !== "object") {
    return { ok: false, daily: [], source: "none", err: "响应非 JSON" };
  }
  const code = j.code;
  if (code !== 0 && code !== "0") {
    return { ok: false, daily: [], source: "none", err: `8100 code=${code ?? "?"}` };
  }
  const arr = j?.data?.daily;
  if (!Array.isArray(arr)) {
    return { ok: false, daily: [], source: "daily", err: "响应缺少 data.daily" };
  }
  const feedSource = String(j?.data?.feed_source ?? "");
  if (feedSource !== "chat") {
    return {
      ok: false,
      daily: [],
      source: "daily",
      err: `feed 真源未就绪(feed_source=${feedSource || "未声明"})`,
    };
  }
  const daily: TaskDay[] = [];
  for (const it of arr) {
    const d = ymdOfOrEmpty(it?.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    daily.push({
      date: d,
      chat: Number(it?.chat) || 0,
      feed: Number(it?.feed) || 0,
    });
  }
  return { ok: true, daily, source: "daily" };
}

/**
 * 从主站 8100 拉取「投孪生聊天 + 投喂」的日明细。
 *
 * 关键约束：旧接口 /yangyu/feed-days 只回一个 days 计数，无法判定"连续" ——
 * 宁可返回 ok=false 走保守分支（不惩罚），也不能用计数冒充连续判定。
 */
export async function fetchTaskDays(
  aiUid: string,
  from: string,
  to: string
): Promise<{ ok: boolean; daily: TaskDay[]; source: "daily" | "days" | "none"; err?: string }> {
  const key = config.wallet.serviceKey;
  if (!key) return { ok: false, daily: [], source: "none", err: "WALLET_SERVICE_KEY 未配置" };

  try {
    const url = `${config.wallet.base}/yangyu/task-days?uid=${encodeURIComponent(aiUid)}&from=${from}&to=${to}`;
    const resp = await fetch(url, { headers: { "X-Service-Key": key } });
    if (!resp.ok) {
      return { ok: false, daily: [], source: "none", err: `HTTP ${resp.status}` };
    }
    const j: any = await resp.json().catch(() => null);
    return parseTaskDaysPayload(j);
  } catch (err: any) {
    return { ok: false, daily: [], source: "none", err: err?.message };
  }
}

/** 把日明细落 task_daily。met = chat>0 且 feed>0（双动作缺一不可） */
export async function upsertTaskDaily(
  enrollmentId: string,
  userId: string,
  daily: TaskDay[]
): Promise<number> {
  if (daily.length === 0) return 0;
  const placeholders = daily.map(() => "(?,?,?,?,?,?,?)").join(",");
  const params: unknown[] = [];
  for (const d of daily) {
    params.push(
      newId(),
      enrollmentId,
      userId,
      d.date,
      d.chat,
      d.feed,
      d.chat > 0 && d.feed > 0 ? 1 : 0
    );
  }
  await query(
    `INSERT INTO task_daily (id, enrollment_id, user_id, task_date, chat_cnt, feed_cnt, met)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE
       chat_cnt = VALUES(chat_cnt), feed_cnt = VALUES(feed_cnt), met = VALUES(met)`,
    params
  );
  return daily.length;
}

/** 同步一个入渔在 [from, to] 的任务明细（通常传该 ISO 周周一~周日） */
export async function syncRange(
  enrollmentId: string,
  userId: string,
  from: string,
  to: string
): Promise<SyncResult> {
  const aiUid = await resolveAiUid(userId);
  if (!aiUid) return { ok: false, source: "none", upserted: 0, err: "缺少 ai_uid 联邦锚点" };

  const r = await fetchTaskDays(aiUid, from, to);
  if (!r.ok) {
    return { ok: false, source: r.source, upserted: 0, err: r.err };
  }
  const n = await upsertTaskDaily(enrollmentId, userId, r.daily);
  return { ok: true, source: "daily", upserted: n };
}

export interface JudgeResult {
  met: boolean;
  longest: number;
  windowStart: string | null;
  windowEnd: string | null;
  /** false = 数据不可用（8100 不可达 / 无 ai_uid），此时评估必须跳过惩罚 */
  dataAvailable: boolean;
}

/**
 * 判定某期是否达标。
 *
 * dataAvailable 语义（与 P1-2 的保守策略一致）：
 *   - 同步成功（哪怕用户一天没做）→ true，met=false 应正常惩罚
 *   - 同步失败且本地无该周记录 → false，评估跳过，不累加未达标次数
 * 这条区分很重要：把"取不到数据"和"用户没做"混为一谈会误罚用户。
 */
export async function judgePeriod(input: {
  enrollmentId: string;
  userId: string;
  weekStart: string;
  weekEnd: string;
  needed: number;
}): Promise<JudgeResult> {
  const { enrollmentId, userId, weekStart, weekEnd, needed } = input;

  const sync = await syncRange(enrollmentId, userId, weekStart, weekEnd);

  const res = await query<any>(
    `SELECT task_date, met FROM task_daily
      WHERE enrollment_id = ? AND task_date BETWEEN ? AND ?`,
    [enrollmentId, weekStart, weekEnd]
  );
  const marks = res.rows.map((r: any) => ({
    // task_date 是 DATE 列：mysql2 给的是 Date 对象。
    // 这里曾写成 String(r.task_date).slice(0,10) → 'Tue Nov 03' → 周内过滤全部失效，
    // 导致「连续 5 天」恒判 0 天、好用户被误罚。统一走 ymdOfOrEmpty。
    date: ymdOfOrEmpty(r.task_date),
    met: Number(r.met) === 1,
  }));

  const streak = evaluateStreak(marks, weekStart, weekEnd, needed);
  const dataAvailable = sync.ok || marks.length > 0;

  return {
    met: streak.met,
    longest: streak.longest,
    windowStart: streak.windowStart,
    windowEnd: streak.windowEnd,
    dataAvailable,
  };
}

/** 距周结束还剩几天（含当天）；用于提醒时点计算 */
export function daysLeftInWeek(weekEnd: string, today: Date = new Date()): number {
  return dayDiff(ymd(dateOnly(today)), weekEnd) + 1;
}
