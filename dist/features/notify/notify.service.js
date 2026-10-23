"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dueNotices = dueNotices;
exports.pushNotice = pushNotice;
exports.runNoticeScan = runNoticeScan;
exports.listMessages = listMessages;
exports.countUnread = countUnread;
exports.markRead = markRead;
exports.toNoticePeriod = toNoticePeriod;
const db_1 = require("../../lib/db");
const iso_week_1 = require("../period/iso-week");
const period_types_1 = require("../period/period.types");
const period_repo_1 = require("../period/period.repo");
/**
 * 计算某期次在今天应该发哪些提醒。
 *
 * 时点设计（与"连续 5 天"强耦合，与传统打卡产品完全不同）：
 *   周一     本期开始
 *   周三     最晚开始日 —— 连续 5 天的合法起点只有周一/二/三，
 *            周四起算必然跨周。所以真正的"死线"是周三 24:00，不是周日。
 *   周四     本期已无法达标 —— 主动告知，避免用户白做 4 天。
 *            多数产品不会告诉用户失败，但让他继续做才是更贵的错误。
 *   周六     核销还剩 2 天
 *   周日     核销最后一天
 *   逾期次日 已作废 + 补期入口
 */
function dueNotices(p, today) {
    const out = [];
    const d = (0, iso_week_1.dayDiff)(p.weekStart, today); // 0=周一 … 6=周日
    if (p.expired) {
        out.push({
            flag: period_types_1.NOTICE.EXPIRED,
            type: "expired",
            title: `第 ${p.periodNo} 期已作废`,
            body: `本期未在 ${p.weekEnd} 前完成核销，已自动作废。如需恢复，请联系客服申请补期。`,
        });
        return out;
    }
    if (d < 0 || d > 6)
        return out;
    if (d === 0 && !p.checkinId) {
        out.push({
            flag: period_types_1.NOTICE.START,
            type: "period_start",
            title: `第 ${p.periodNo} 期养鱼开始`,
            body: `本周任选连续 5 天完成「投孪生聊天 + 投喂」，并在 ${p.weekEnd} 前到店核销一次。核销即返 ${Math.round((1 - (p.shareRatio ?? 0.3)) * 100)}%，分享给好友（对方打开链接即绑定）再返 ${Math.round((p.shareRatio ?? 0.3) * 100)}%。`,
        });
    }
    if (d === 2 && !p.taskMet) {
        out.push({
            flag: period_types_1.NOTICE.STREAK_LATE,
            type: "streak_warn",
            title: "今天是最晚开始日",
            body: "连续 5 天必须在本周内完成，今天是最后一天可以开始。错过今天，本期将无法达标。",
        });
    }
    if (d === 3 && !p.taskMet) {
        out.push({
            flag: period_types_1.NOTICE.STREAK_DEAD,
            type: "streak_dead",
            title: "本期已无法达标",
            body: "本周剩余天数不足 5 天，本期任务已无法完成。请不要白跑，下周一会重新开始计算。",
        });
    }
    if (d === 5 && !p.checkinId) {
        out.push({
            flag: period_types_1.NOTICE.CHECKIN_T48,
            type: "checkin_remind",
            title: "核销提醒：还剩 2 天",
            body: `请在 ${p.weekEnd} 前到店核销。${p.taskMet ? "本期的养鱼任务已完成，" : ""}逾期未核销本期作废。`,
        });
    }
    if (d === 6 && !p.checkinId) {
        out.push({
            flag: period_types_1.NOTICE.CHECKIN_LAST,
            type: "checkin_remind",
            title: "今天是核销最后一天",
            body: "今天 24:00 前到店核销，逾期本期作废，且会算作一次未达标。",
        });
    }
    return out.filter((n) => (p.noticeFlags & n.flag) === 0);
}
/** 幂等推送：biz_key = {type}:{periodId}，重复调用不产生第二条 */
async function pushNotice(input) {
    try {
        await (0, db_1.query)(`INSERT INTO notify_message
         (id, user_id, ai_uid, type, title, body, ref_type, ref_id, channel, state, biz_key)
       VALUES (?,?,?,?,?,?,?,?,'inbox','sent',?)`, [
            (0, db_1.newId)(),
            input.userId,
            input.aiUid ?? null,
            input.type,
            input.title,
            input.body.slice(0, 500),
            input.refType ?? null,
            input.refId ?? null,
            input.bizKey,
        ]);
        return true;
    }
    catch (err) {
        if (err?.code === "ER_DUP_ENTRY" || err?.errno === 1062)
            return false;
        throw err;
    }
}
/**
 * 每日扫描（cron 建议 09:00 + 20:00 各一次）。
 * 只扫"在办且本周内"的期次，历史期次不重复打扰。
 */
async function runNoticeScan(now = new Date()) {
    const today = (0, iso_week_1.ymd)((0, iso_week_1.dateOnly)(now));
    const res = await (0, db_1.query)(`SELECT * FROM period
      WHERE week_start <= ? AND week_end >= ?
        AND (expired = 0 OR (expired = 1 AND week_end = ?))
      ORDER BY week_start ASC
      LIMIT 5000`, [today, today, today]);
    let sent = 0;
    for (const r of res.rows) {
        const p = {
            id: r.id,
            enrollmentId: r.enrollment_id,
            userId: r.user_id,
            periodNo: Number(r.period_no),
            weekStart: String(r.week_start).slice(0, 10),
            weekEnd: String(r.week_end).slice(0, 10),
            taskMet: Number(r.task_met) === 1,
            checkinId: r.checkin_id || null,
            expired: Number(r.expired) === 1,
            noticeFlags: Number(r.notice_flags) || 0,
        };
        const list = dueNotices(p, today);
        for (const n of list) {
            const ok = await pushNotice({
                userId: p.userId,
                type: n.type,
                title: n.title,
                body: n.body,
                refType: "period",
                refId: p.id,
                bizKey: `${n.type}:${p.id}`,
            });
            if (ok) {
                sent += 1;
                await (0, period_repo_1.setNoticeFlag)(p.id, n.flag);
            }
        }
    }
    return { scanned: res.rows.length, sent };
}
/** C 端消息列表 */
async function listMessages(userId, limit = 50) {
    const res = await (0, db_1.query)(`SELECT id, type, title, body, ref_type, ref_id, state, created_at
       FROM notify_message WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, [userId, Math.min(limit, 100)]);
    return res.rows;
}
/** 未读数（SDK 铃铛角标；一次 COUNT 比拉全量列表便宜得多） */
async function countUnread(userId) {
    const res = await (0, db_1.query)(`SELECT COUNT(*) AS n FROM notify_message WHERE user_id = ? AND state = 'sent'`, [userId]);
    return Number(res.rows[0]?.n) || 0;
}
async function markRead(userId, id) {
    const res = await (0, db_1.query)(`UPDATE notify_message SET state='read' WHERE id = ? AND user_id = ?`, [id, userId]);
    return (Number(res.rowCount) || 0) > 0;
}
/** 组装期次（Period）→ 通知视图，供核销/退费后即时推送使用 */
function toNoticePeriod(p) {
    return {
        id: p.id,
        enrollmentId: p.enrollmentId,
        userId: p.userId,
        periodNo: p.periodNo,
        weekStart: p.weekStart,
        weekEnd: p.weekEnd,
        taskMet: p.taskMet,
        checkinId: p.checkinId,
        expired: p.expired,
        noticeFlags: p.noticeFlags,
        shareRatio: p.shareRatio,
    };
}
//# sourceMappingURL=notify.service.js.map