"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchTaskDays = fetchTaskDays;
exports.upsertTaskDaily = upsertTaskDaily;
exports.syncRange = syncRange;
exports.judgePeriod = judgePeriod;
exports.daysLeftInWeek = daysLeftInWeek;
const config_1 = require("../../config");
const db_1 = require("../../lib/db");
const fund_1 = require("../../lib/fund");
const iso_week_1 = require("../period/iso-week");
const streak_1 = require("./streak");
/**
 * 从主站 8100 拉取「投孪生聊天 + 投喂」的日明细。
 *
 * 关键约束：旧接口 /yangyu/feed-days 只回一个 days 计数，无法判定"连续" ——
 * 宁可返回 ok=false 走保守分支（不惩罚），也不能用计数冒充连续判定。
 */
async function fetchTaskDays(aiUid, from, to) {
    const key = config_1.config.wallet.serviceKey;
    if (!key)
        return { ok: false, daily: [], source: "none", err: "WALLET_SERVICE_KEY 未配置" };
    try {
        const url = `${config_1.config.wallet.base}/yangyu/task-days?uid=${encodeURIComponent(aiUid)}&from=${from}&to=${to}`;
        const resp = await fetch(url, { headers: { "X-Service-Key": key } });
        if (!resp.ok) {
            return { ok: false, daily: [], source: "none", err: `HTTP ${resp.status}` };
        }
        const j = await resp.json().catch(() => null);
        const arr = j?.data?.daily;
        if (!Array.isArray(arr)) {
            return { ok: false, daily: [], source: "daily", err: "响应缺少 data.daily" };
        }
        const daily = [];
        for (const it of arr) {
            const d = String(it?.date ?? "").slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d))
                continue;
            daily.push({
                date: d,
                chat: Number(it?.chat) || 0,
                feed: Number(it?.feed) || 0,
            });
        }
        return { ok: true, daily, source: "daily" };
    }
    catch (err) {
        return { ok: false, daily: [], source: "none", err: err?.message };
    }
}
/** 把日明细落 task_daily。met = chat>0 且 feed>0（双动作缺一不可） */
async function upsertTaskDaily(enrollmentId, userId, daily) {
    if (daily.length === 0)
        return 0;
    const placeholders = daily.map(() => "(?,?,?,?,?,?,?)").join(",");
    const params = [];
    for (const d of daily) {
        params.push((0, db_1.newId)(), enrollmentId, userId, d.date, d.chat, d.feed, d.chat > 0 && d.feed > 0 ? 1 : 0);
    }
    await (0, db_1.query)(`INSERT INTO task_daily (id, enrollment_id, user_id, task_date, chat_cnt, feed_cnt, met)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE
       chat_cnt = VALUES(chat_cnt), feed_cnt = VALUES(feed_cnt), met = VALUES(met)`, params);
    return daily.length;
}
/** 同步一个入渔在 [from, to] 的任务明细（通常传该 ISO 周周一~周日） */
async function syncRange(enrollmentId, userId, from, to) {
    const aiUid = await (0, fund_1.resolveAiUid)(userId);
    if (!aiUid)
        return { ok: false, source: "none", upserted: 0, err: "缺少 ai_uid 联邦锚点" };
    const r = await fetchTaskDays(aiUid, from, to);
    if (!r.ok) {
        return { ok: false, source: r.source, upserted: 0, err: r.err };
    }
    const n = await upsertTaskDaily(enrollmentId, userId, r.daily);
    return { ok: true, source: "daily", upserted: n };
}
/**
 * 判定某期是否达标。
 *
 * dataAvailable 语义（与 P1-2 的保守策略一致）：
 *   - 同步成功（哪怕用户一天没做）→ true，met=false 应正常惩罚
 *   - 同步失败且本地无该周记录 → false，评估跳过，不累加未达标次数
 * 这条区分很重要：把"取不到数据"和"用户没做"混为一谈会误罚用户。
 */
async function judgePeriod(input) {
    const { enrollmentId, userId, weekStart, weekEnd, needed } = input;
    const sync = await syncRange(enrollmentId, userId, weekStart, weekEnd);
    const res = await (0, db_1.query)(`SELECT task_date, met FROM task_daily
      WHERE enrollment_id = ? AND task_date BETWEEN ? AND ?`, [enrollmentId, weekStart, weekEnd]);
    const marks = res.rows.map((r) => ({
        date: String(r.task_date).slice(0, 10),
        met: Number(r.met) === 1,
    }));
    const streak = (0, streak_1.evaluateStreak)(marks, weekStart, weekEnd, needed);
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
function daysLeftInWeek(weekEnd, today = new Date()) {
    return (0, iso_week_1.dayDiff)((0, iso_week_1.ymd)((0, iso_week_1.dateOnly)(today)), weekEnd) + 1;
}
//# sourceMappingURL=task.service.js.map