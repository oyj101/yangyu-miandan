import { newId, query } from "../../lib/db";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { ymdOfOrEmpty } from "../../lib/date";
import { dayDiff, ymd, dateOnly } from "../period/iso-week";
import { Period, NOTICE } from "../period/period.types";
import { setNoticeFlag } from "../period/period.repo";
import { pushWechatTemplate } from "./wechat";

export interface NoticeSpec {
  flag: number;
  type: string;
  title: string;
  body: string;
}

export interface NoticePeriodLike {
  id: string;
  enrollmentId: string;
  userId: string;
  periodNo: number;
  weekStart: string;
  weekEnd: string;
  taskMet: boolean;
  checkinId: string | null;
  expired: boolean;
  noticeFlags: number;
  /** 该期的分享分成比例（逐卡不同）；缺省按 0.3 兜底 */
  shareRatio?: number;
}

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
export function dueNotices(p: NoticePeriodLike, today: string): NoticeSpec[] {
  const out: NoticeSpec[] = [];
  const d = dayDiff(p.weekStart, today); // 0=周一 … 6=周日

  if (p.expired) {
    out.push({
      flag: NOTICE.EXPIRED,
      type: "expired",
      title: `第 ${p.periodNo} 期已作废`,
      body: `本期未在 ${p.weekEnd} 前完成核销，已自动作废。如需恢复，请联系客服申请补期。`,
    });
    return out;
  }

  if (d < 0 || d > 6) return out;

  if (d === 0 && !p.checkinId) {
    out.push({
      flag: NOTICE.START,
      type: "period_start",
      title: `第 ${p.periodNo} 期养鱼开始`,
      body: `本周任选连续 5 天完成「投孪生聊天 + 投喂」，并在 ${p.weekEnd} 前到店核销一次。核销即返 ${Math.round(
        (1 - (p.shareRatio ?? 0.3)) * 100
      )}%，分享给好友（对方打开链接即绑定）再返 ${Math.round((p.shareRatio ?? 0.3) * 100)}%。`,
    });
  }

  if (d === 2 && !p.taskMet) {
    out.push({
      flag: NOTICE.STREAK_LATE,
      type: "streak_warn",
      title: "今天是最晚开始日",
      body: "连续 5 天必须在本周内完成，今天是最后一天可以开始。错过今天，本期将无法达标。",
    });
  }

  if (d === 3 && !p.taskMet) {
    out.push({
      flag: NOTICE.STREAK_DEAD,
      type: "streak_dead",
      title: "本期已无法达标",
      body: "本周剩余天数不足 5 天，本期任务已无法完成。请不要白跑，下周一会重新开始计算。",
    });
  }

  if (d === 5 && !p.checkinId) {
    out.push({
      flag: NOTICE.CHECKIN_T48,
      type: "checkin_remind",
      title: "核销提醒：还剩 2 天",
      body: `请在 ${p.weekEnd} 前到店核销。${p.taskMet ? "本期的养鱼任务已完成，" : ""}逾期未核销本期作废。`,
    });
  }

  if (d === 6 && !p.checkinId) {
    out.push({
      flag: NOTICE.CHECKIN_LAST,
      type: "checkin_remind",
      title: "今天是核销最后一天",
      body: "今天 24:00 前到店核销，逾期本期作废，且会算作一次未达标。",
    });
  }

  return out.filter((n) => (p.noticeFlags & n.flag) === 0);
}

/** 通知通道：站内信永远在线；微信为附加通道（fail-soft） */
export type NoticeChannel = "inbox" | "wechat";

/**
 * 微信通道总开关（20261026 两线合并统一语义）：
 * 应急杀开关未触发 且 模板 ID 已配置。模板 ID 在 config.wechat 有硬编码缺省，
 * 所以线上默认开启；本地/CI 可用 WECHAT_NOTIFY_ENABLED=false 一键全关。
 */
export function wechatEnabled(): boolean {
  return config.notify.wechat.enabled && Boolean(config.wechat.templateId);
}

/**
 * 退出活动通知的通道选择（纯函数，便于单测）。
 * wechat 仅在通道开启时纳入，否则只走 inbox。
 */
export function exitChannels(): NoticeChannel[] {
  return wechatEnabled() ? ["inbox", "wechat"] : ["inbox"];
}

/** 幂等推送：biz_key 唯一，重复调用不产生第二条。channels 缺省按通道开关自动决定。 */
export async function pushNotice(input: {
  userId: string;
  aiUid?: string | null;
  type: string;
  title: string;
  body: string;
  refType?: string;
  refId?: string;
  bizKey: string;
  /** 微信模板附加字段（模板 52850：character_string2=期次号 P{n}、time3=到店截止） */
  fields?: Record<string, string>;
  channels?: NoticeChannel[];
}): Promise<boolean> {
  const channels = input.channels ?? (wechatEnabled() ? ["inbox", "wechat"] : ["inbox"]);
  // 站内信是可靠主通道，永远先落库
  let inboxOk = true;
  if (channels.includes("inbox")) {
    inboxOk = await insertInbox(input);
  }
  // 微信是附加通道，失败不影响主流程（fail-soft）
  if (inboxOk && channels.includes("wechat")) {
    await sendWechat({
      aiUid: input.aiUid,
      type: input.type,
      title: input.title,
      body: input.body,
      fields: input.fields,
    }).catch((e) => logger.warn({ err: e }, "微信通知发送异常(非阻断)"));
  }
  return inboxOk;
}

async function insertInbox(input: {
  userId: string;
  aiUid?: string | null;
  type: string;
  title: string;
  body: string;
  refType?: string;
  refId?: string;
  bizKey: string;
}): Promise<boolean> {
  try {
    await query(
      `INSERT INTO notify_message
         (id, user_id, ai_uid, type, title, body, ref_type, ref_id, channel, state, biz_key)
       VALUES (?,?,?,?,?,?,?,?,'inbox','sent',?)`,
      [
        newId(),
        input.userId,
        input.aiUid ?? null,
        input.type,
        input.title,
        input.body.slice(0, 500),
        input.refType ?? null,
        input.refId ?? null,
        input.bizKey,
      ]
    );
    return true;
  } catch (err: any) {
    if (err?.code === "ER_DUP_ENTRY" || err?.errno === 1062) return false;
    throw err;
  }
}

/**
 * 微信模板消息发送（fail-soft）。
 * 20261026 合并：实现统一收敛到 ./wechat 的 pushWechatTemplate（模板 52850 五字段、
 * 8100 /api/v2/wechat/template/send，经端到端实测）。本函数保留通道开关/跳过语义作为统一出口。
 */
export async function sendWechat(input: {
  aiUid?: string | null;
  type: string;
  title: string;
  body: string;
  /** 模板附加字段（character_string2/time3 等），透传 pushWechatTemplate */
  fields?: Record<string, string>;
}): Promise<{ sent: boolean; skipped: boolean; err?: string }> {
  if (!wechatEnabled()) return { sent: false, skipped: true, err: "wechat 通道未开启" };
  if (!input.aiUid) return { sent: false, skipped: true, err: "缺少 ai_uid" };

  // pushWechatTemplate 入参是养鱼侧 uid（"au_17"）或平台数字 id 字符串，两者都兼容。
  const r = await pushWechatTemplate({
    yangyuUid: String(input.aiUid),
    title: input.title,
    body: input.body,
    scene: input.type,
    fields: input.fields,
  });
  // skipped 判定：配置缺失 / uid 无法解析 / 该用户无 openid 绑定（8100 fail-soft state）
  const skipped =
    !r.sent &&
    (r.state === "no_openid" ||
      r.state === "wx_unconfigured" ||
      /未配置|无法解析/.test(r.error ?? ""));
  if (!r.sent) {
    logger.warn(
      "[notify] 微信推送未送达 uid=%s type=%s state=%s errcode=%s err=%s",
      input.aiUid,
      input.type,
      r.state,
      r.errcode,
      r.error
    );
  }
  return { sent: r.sent, skipped, err: r.error ?? r.state };
}

/**
 * 活动退出通知（时序图「24 活动退出通知」）。
 * 触达：站内信（永远）+ 微信（开启时）；幂等键 biz_key=exit:{enrollmentId} 防重发。
 * 文案明确「已达标期次返现不受影响」，避免用户误以为钱没了。
 */
export async function pushExitNotice(input: {
  userId: string;
  aiUid?: string | null;
  enrollmentId: string;
  cardTitle: string;
}): Promise<{ inbox: boolean; wechat: { sent: boolean; skipped: boolean } }> {
  const channels = exitChannels();
  const title = "养鱼免单活动已退出";
  const body =
    `您参与的「${input.cardTitle || "免单项目"}」因连续或累计未达标已达退出条件，系统已自动退出活动。` +
    `已核销达标期次的返现不受影响，感谢参与。`;

  const inbox = await pushNotice({
    userId: input.userId,
    aiUid: input.aiUid,
    type: "exit",
    title,
    body,
    refType: "enrollment",
    refId: input.enrollmentId,
    bizKey: `exit:${input.enrollmentId}`,
    channels,
  });

  let wechat: { sent: boolean; skipped: boolean } = { sent: false, skipped: true };
  if (channels.includes("wechat")) {
    wechat = await sendWechat({ aiUid: input.aiUid, type: "exit", title, body });
  }
  return { inbox, wechat };
}

/**
 * 每日扫描（cron 建议 09:00 + 20:00 各一次）。
 * 只扫"在办且本周内"的期次，历史期次不重复打扰。
 */
export async function runNoticeScan(now: Date = new Date()): Promise<{ scanned: number; sent: number }> {
  const today = ymd(dateOnly(now));
  const res = await query<any>(
    `SELECT * FROM period
      WHERE week_start <= ? AND week_end >= ?
        AND (expired = 0 OR (expired = 1 AND week_end = ?))
      ORDER BY week_start ASC
      LIMIT 5000`,
    [today, today, today]
  );

  let sent = 0;
  for (const r of res.rows) {
    const p: NoticePeriodLike = {
      id: r.id,
      enrollmentId: r.enrollment_id,
      userId: r.user_id,
      periodNo: Number(r.period_no),
      // DATE 列：归一成 'YYYY-MM-DD'，否则 String(Date).slice(0,10) = 'Tue Nov 03'
      weekStart: ymdOfOrEmpty(r.week_start),
      weekEnd: ymdOfOrEmpty(r.week_end),
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
        // 模板 52850：character_string2 只收字母/数字/符号（中文非法，20261026 实测），
        // 用期次号 P{n}；time3=本周核销截止时间。
        fields: {
          character_string2: `P${p.periodNo}`,
          time3: `${p.weekEnd} 23:59`,
        },
      });
      if (ok) {
        sent += 1;
        await setNoticeFlag(p.id, n.flag);
      }
    }
  }
  return { scanned: res.rows.length, sent };
}

/** C 端消息列表 */
export async function listMessages(userId: string, limit = 50) {
  const res = await query<any>(
    `SELECT id, type, title, body, ref_type, ref_id, state, created_at
       FROM notify_message WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, Math.min(limit, 100)]
  );
  return res.rows;
}

/** 未读数（SDK 铃铛角标；一次 COUNT 比拉全量列表便宜得多） */
export async function countUnread(userId: string): Promise<number> {
  const res = await query<any>(
    `SELECT COUNT(*) AS n FROM notify_message WHERE user_id = ? AND state = 'sent'`,
    [userId]
  );
  return Number(res.rows[0]?.n) || 0;
}

export async function markRead(userId: string, id: string): Promise<boolean> {
  const res = await query<any>(
    `UPDATE notify_message SET state='read' WHERE id = ? AND user_id = ?`,
    [id, userId]
  );
  return (Number(res.rowCount) || 0) > 0;
}

/** 组装期次（Period）→ 通知视图，供核销/退费后即时推送使用 */
export function toNoticePeriod(p: Period): NoticePeriodLike {
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
