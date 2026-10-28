/**
 * SDK 聚合层（BFF）
 *
 * 定位：内联 SDK 的**唯一入口**。宿主页面不再各自拼 N 个原子请求，
 * 而是调这里 3~6 个聚合端点完成首屏。
 *
 * 为什么要有这一层（不是"多包一层"）：
 *   1) 内联形态没有自己的站点，首屏等待每多一跳就等于多一次白屏；聚合后首屏 1 次请求。
 *   2) 字段裁剪必须集中：supply_price / coverage_cap 只能在这里被挡住，
 *      分散在各控制器迟早漏（本仓已经有过 spread 漏字段的先例）。
 *   3) 契约稳定：SDK 只依赖 `data` 里的白名单字段，后端重构原子接口不影响宿主。
 *
 * 与原子端点的关系：聚合层只读、只组合，不实现业务规则；
 *   所有写操作（购买/核销/退费/设计卡）仍走原原子端点，避免两套写路径漂移。
 */
import { Router } from "express";
import { z } from "zod";
import { auth, authOptional } from "../../middleware/auth";
import { ok, page } from "../../lib/http";
import { badRequest } from "../../lib/errors";
import { config } from "../../config";
import { query } from "../../lib/db";
import { listCategories, listProjects, findCardById, countSoldByCards, listPending } from "../card/card.repo";
import { promiseOf, toProjectView, toProjectListView } from "./project.view";
import {
  listUserEnrollments,
  purchase as purchaseEnrollment,
  listMerchantEnrollments,
} from "../enrollment/enrollment.service";
import { listByEnrollment } from "../period/period.repo";
import { nextPeriodHint } from "../checkin/checkin.service";
import { countUnread, listMessages, markRead } from "../notify/notify.service";
import { getAccount, listNegativeAccounts } from "../merchant/merchant.service";
import { budgetHeadroom } from "../card/card.service";
import { listStuckRefunds } from "../refund/refund.service";
import { collect, trackStats, purgeOldEvents } from "../track/track.service";
import {
  bindShare,
  bindStatsOf,
  viewerBindOf,
  claimShare,
  shareLinkOf,
  readReferrer,
  sweepPendingBinds,
  sweepShareCompensation,
  retryPendingConversions,
} from "../share/share.service";

export const sdkRouter = Router();

/** SDK 契约版本：字段只增不改。宿主可用它做兼容分支（低于期望值时提示刷新页面换缓存戳） */
const SDK_CONTRACT = "2.0";

const listQuerySchema = z.object({
  category: z.string().max(32).optional(),
  keyword: z.string().max(40).optional(),
  sort: z.enum(["default", "price_asc", "price_desc", "new"]).optional(),
  page: z.coerce.number().int().min(1).max(200).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

/* ------------------------------------------------------------------ *
 * 1) 自检：SDK 启动时校验「宿主引用的 JS 版本」与「后端契约」是否同代
 * ------------------------------------------------------------------ */
sdkRouter.get("/meta", (_req, res) => {
  ok(res, {
    contract: SDK_CONTRACT,
    service: "yangyu-miandan",
    env: config.nodeEnv,
    // 金额口径：比例**逐卡不同**，这里只给缺省值，卡上的实际值见各卡 share.ratio
    rules: {
      refundNowRatio: config.package.refundRatioNow,
      refundShareRatio: config.package.shareRatioDefault,
      streakDays: config.package.streakDays,
      shareBindPolicy: config.share.bindPolicy,
      shareUnlockOnBind: config.share.unlockOnBind,
      refParam: config.share.refParam,
    },
  });
});

/* ------------------------------------------------------------------ *
 * 2) 首屏聚合：登录态 + 未读 + 在办卡数 + 分类
 *    游客可用（authOptional），这是"逛"的入口，不能 401。
 * ------------------------------------------------------------------ */
sdkRouter.get("/bootstrap", authOptional(), async (req, res, next) => {
  try {
    const u = req.user;
    const [cats, unread, mine] = await Promise.all([
      listCategories(),
      u ? countUnread(u.userId) : Promise.resolve(0),
      u ? listUserEnrollments(u.userId) : Promise.resolve([]),
    ]);
    ok(res, {
      contract: SDK_CONTRACT,
      user: u
        ? { loggedIn: true, role: u.role, merchantId: u.merchantId || "" }
        : { loggedIn: false, role: null, merchantId: "" },
      counters: {
        unread,
        // 只有在办（normal/pause*）才叫"在养"，已退出/已退款的卡不该占角标
        activeCards: mine.filter((e) => e.status !== "exited" && e.status !== "refunded").length,
      },
      categories: cats,
      rules: {
        refundNowRatio: config.package.refundRatioNow,
        refundShareRatio: config.package.shareRatioDefault,
        streakDays: config.package.streakDays,
        shareBindPolicy: config.share.bindPolicy,
      },
    });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ *
 * 3) 项目集合页
 * ------------------------------------------------------------------ */
sdkRouter.get("/projects", authOptional(), async (req, res, next) => {
  try {
    const q = listQuerySchema.parse(req.query);
    const { items, total } = await listProjects({
      category: q.category ?? null,
      keyword: q.keyword ?? null,
      sort: q.sort ?? "default",
      page: q.page,
      pageSize: q.pageSize,
    });
    const sold = await countSoldByCards(items.map((c) => c.id));
    // 列表用 lite 投影：不含单价与返还比例（PO 2026-10-21：集合页不露每期返多少钱）
    const views = items.map((c) => toProjectListView(c, sold[c.id] ?? 0));
    page(res, views, total, q.page, q.pageSize);
  } catch (e) {
    next(e);
  }
});

sdkRouter.get("/projects/:id", authOptional(), async (req, res, next) => {
  try {
    const card = await findCardById(req.params.id);
    // 未上架 = 对 C 端不存在（不要回 403，那等于告诉外部"这个 id 存在"）
    if (!card || card.status !== "active" || card.periods == null || card.unitPrice == null) {
      return res.status(404).json({
        code: 404,
        message: "项目不存在或已下架",
        ok: false,
        error: { code: "NOT_FOUND", message: "项目不存在或已下架" },
      });
    }
    const sold = await countSoldByCards([card.id]);
    const view = toProjectView(card, sold[card.id] ?? 0);
    ok(res, { project: view, promise: promiseOf(view) });
  } catch (e) {
    next(e);
  }
});

/**
 * 购买（写）：**纯委托**，不在这层重算任何金额或期次。
 * 存在的意义只是把「下单 + 取支付参数」两步合成内联 SDK 的一次调用，
 * 并把返回值裁剪成前端能直接用的形状（enrollmentId / 应付 / 支付参数）。
 */
sdkRouter.post("/projects/:id/purchase", auth(["USER"]), async (req, res, next) => {
  try {
    const body = z
      .object({
        channel: z.enum(["jsapi", "native"]).optional(),
        openid: z.string().max(64).optional(),
        pay: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const card = await findCardById(req.params.id);
    if (!card || card.status !== "active") throw badRequest("项目未上架");
    const e = await purchaseEnrollment(req.user!.userId, card.id, {
      pay: body.pay !== false,
      channel: body.channel,
      openid: body.openid,
    });
    const view = toProjectView(card);
    ok(res, {
      enrollmentId: e.id,
      cardId: card.id,
      amount: view.totalPrice,
      payOrderNo: (e as any).payOrderNo ?? null,
      payStatus: (e as any).payStatus ?? "none",
      payParams: (e as any).payParams ?? null,
      // 期次已按「下一完整 ISO 周」生成，告诉前端第一期的死线，购买成功页要用
      firstPeriodHint: await nextPeriodHint(e.id).catch(() => null),
    });
  } catch (e) {
    next(e);
  }
});

sdkRouter.post("/notices/:id/read", auth(), async (req, res, next) => {
  try {
    ok(res, { read: await markRead(req.user!.userId, req.params.id) });
  } catch (e) {
    next(e);
  }
});

/**
 * 埋点：落表（2026-10-21 PO 决定）。
 *
 * 三个刻意的设计：
 *   1) 端点**永远返回 200** —— 埋点是宿主的旁路调用，让它因为埋点失败而报错，
 *      等于把我们的可观测性成本转嫁给业务。
 *   2) 写入走内存队列批量落库（track.service），不在这条请求里等 INSERT。
 *   3) 事件名走白名单，未知事件直接丢弃并把原因回给调用方（便于宿主自检打错字）。
 */
sdkRouter.post("/track", authOptional(), (req, res) => {
  const body = (req.body ?? {}) as {
    event_type?: string;
    event?: string;
    view?: string;
    page?: string;
    card_id?: string;
    enrollment_id?: string;
    sdk_version?: string;
    payload?: unknown;
  };
  const r = collect({
    eventType: body.event_type || body.event,
    // 兼容旧字段：宿主早期把视图名放在 page
    view: body.view || body.page,
    userId: req.user?.userId ?? null,
    role: req.user?.role ?? null,
    cardId: body.card_id ?? null,
    enrollmentId: body.enrollment_id ?? null,
    sdkVersion: body.sdk_version ?? null,
    payload: body.payload,
    ip: req.ip,
    ua: req.get("user-agent") ?? undefined,
  });
  ok(res, { accepted: r.queued, reason: r.reason ?? null, stats: trackStats() });
});

/* ------------------------------------------------------------------ *
 * 3.5) 分享（第三代：绑定即归因）
 *
 * 位置：分享按钮在「我的养鱼」，每个持卡人都能发，**不要求已成交**。
 *   集合页仍不放分享按钮——那是转化位，分享会分流注意力。
 *
 * 三个端点分工：
 *   POST /share/bind    被分享者开链接后调 → 绑定 + 立刻解锁分享者所有卡的尾款
 *   GET  /share/link    分享者取链接（带自己的 ai_uid，不生成邀请码）
 *   GET  /share/chain   我的关系状态（我归谁 / 我邀请了几人），不暴露对方身份
 * ------------------------------------------------------------------ */

const bindSchema = z.object({
  ref: z.string().min(1).max(32),
  cardId: z.string().max(36).nullable().optional(),
  source: z.enum(["link", "qr", "manual"]).optional(),
});

/**
 * 绑定分享关系。
 * 被分享者可能是游客打开链接 → 前端先把 ref 存起来，登录后立刻调本端点。
 * 所以这里必须允许「延迟绑定」：ref 的有效期由前端决定，服务端只做归因。
 */
sdkRouter.post("/share/bind", auth(["USER", "MERCHANT", "OPERATOR", "CASHIER"]), async (req, res, next) => {
  try {
    const body = bindSchema.parse(req.body ?? {});
    const r = await bindShare({
      viewerUserId: req.user!.userId,
      refAiUid: body.ref,
      cardId: body.cardId ?? null,
      source: body.source ?? "link",
    });
    // ok=false 大多是"已被别人绑定/自邀"，属于正常业务分支，不回 4xx：
    //   前端拿到 reason 只显示一句人话，不需要错误弹窗。
    ok(res, r);
  } catch (e) {
    next(e);
  }
});

async function assertOwnEnrollment(userId: string, enrollmentId: string): Promise<any> {
  const r = await query<any>(`SELECT id, card_id, user_id, share_unlocked FROM enrollment WHERE id = ?`, [
    enrollmentId,
  ]);
  const row = r.rows[0];
  // 不回 403：那等于告诉对方"这个 id 存在但不是你的"
  if (!row || String(row.user_id) !== String(userId)) throw badRequest("入渔记录不存在");
  return row;
}

sdkRouter.get("/share/link", auth(["USER"]), async (req, res, next) => {
  try {
    const cardId = String(req.query.cardId || "");
    const enrollmentId = String(req.query.enrollmentId || "");
    if (!cardId && !enrollmentId) throw badRequest("缺少 cardId");
    const e = enrollmentId ? await assertOwnEnrollment(req.user!.userId, enrollmentId) : null;
    const targetCardId = cardId || String(e!.card_id);

    const [link, card, stats] = await Promise.all([
      shareLinkOf(req.user!.userId, targetCardId),
      findCardById(targetCardId),
      bindStatsOf(req.user!.userId),
    ]);
    const pending = await query<any>(
      `SELECT COUNT(*) AS n FROM period p
         JOIN enrollment en ON en.id = p.enrollment_id
        WHERE en.user_id = ? AND p.expired = 0
          AND p.refund70_amount > 0 AND p.refund30_amount = 0`,
      [req.user!.userId]
    );

    ok(res, {
      // 未联邦（没绑定主站账号）时 ok=false：不返回假链接，前端提示"请先在主站登录"
      ok: link.ok,
      reason: link.reason ?? null,
      shareUrl: link.url ?? null,
      refParam: link.refParam,
      cardId: targetCardId,
      /** 这张卡的分享分成（逐卡不同，不再统一 30%） */
      ratio: card?.shareRatio ?? config.package.shareRatioDefault,
      unlocked: stats.unlockedCards > 0,
      invited: stats.invited,
      pendingPeriods: Number(pending.rows[0]?.n) || 0,
    });
  } catch (err) {
    next(err);
  }
});

sdkRouter.post("/share/refresh", auth(["USER"]), async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { ref?: string; cardId?: string; enrollmentId?: string };
    // 兼容旧宿主：带 ref 就顺手补绑一次（登录后才拿到身份的场景）
    let bind: Awaited<ReturnType<typeof bindShare>> | null = null;
    if (body.ref) {
      bind = await bindShare({
        viewerUserId: req.user!.userId,
        refAiUid: body.ref,
        cardId: body.cardId ?? null,
        source: "manual",
      });
    }

    const [stats, viewer] = await Promise.all([
      bindStatsOf(req.user!.userId),
      viewerBindOf(req.user!.userId),
    ]);
    const pending = await query<any>(
      `SELECT COUNT(*) AS n FROM period p
         JOIN enrollment en ON en.id = p.enrollment_id
        WHERE en.user_id = ? AND p.expired = 0
          AND p.refund70_amount > 0 AND p.refund30_amount = 0`,
      [req.user!.userId]
    );

    ok(res, {
      bind,
      invited: stats.invited,
      unlockedCards: stats.unlockedCards,
      unlockedAmount: stats.unlockedAmount,
      // 我是不是被别人带来的（不返回是谁）
      boundByOther: viewer?.bound ?? false,
      pendingPeriods: Number(pending.rows[0]?.n) || 0,
    });
  } catch (err) {
    next(err);
  }
});

/** 关系状态（不含上级身份，只回答"我是否已被邀请 / 我邀请了几人"） */
sdkRouter.get("/share/chain", auth(["USER"]), async (req, res, next) => {
  try {
    const [viewer, stats] = await Promise.all([
      viewerBindOf(req.user!.userId),
      bindStatsOf(req.user!.userId),
    ]);
    ok(res, {
      // 主站推荐关系只作为诊断信息，不再作为判据
      referrerSource: config.share.fallbackReferrer ? "referrer_fallback" : "share_bind",
      invitedByOther: viewer?.bound ?? false,
      invitedCount: stats.invited,
      unlockedCards: stats.unlockedCards,
      unlockedAmount: stats.unlockedAmount,
      policy: config.share.bindPolicy,
      canShare: true,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ *
 * 4) 我的养鱼（C 端主视图） *    nextAction 由后端算：宿主页面只负责按 action 显示按钮文案，
 *    避免"该核销了/该打卡了/已作废"三处在三端各写一遍判断。
 * ------------------------------------------------------------------ */
sdkRouter.get("/mine", auth(), async (req, res, next) => {
  try {
    const list = await listUserEnrollments(req.user!.userId);
    // 邀请汇总放到循环外：同一用户所有卡共用一份绑定统计（绑定一次解锁全部卡）
    const bindStats = await bindStatsOf(req.user!.userId);
    const items = [];
    for (const e of list.slice(0, 20)) {
      const [card, periods, hint] = await Promise.all([
        findCardById(e.cardId),
        listByEnrollment(e.id),
        nextPeriodHint(e.id).catch(() => null),
      ]);
      const done = periods.filter((p) => p.checkinId).length;
      const expired = periods.filter((p) => p.expired).length;
      const refundedNow =
        Math.round(
          periods.reduce((s, p) => s + (Number(p.refund70Amount) || 0) + (Number(p.refund30Amount) || 0), 0) * 100
        ) / 100;

      let nextAction: "pay" | "start_task" | "go_checkin" | "wait" | "settled" | "exited" | "refunded";
      if (e.status === "refunded") nextAction = "refunded";
      else if (e.status === "exited") nextAction = "exited";
      else if (e.payStatus && e.payStatus !== "paid" && e.payStatus !== "none") nextAction = "pay";
      else if (!hint || hint.weekClosed) nextAction = "wait";
      else if (!periods.find((p) => p.periodNo === hint.periodNo)?.checkinId) nextAction = "go_checkin";
      else if (done + expired >= (card?.periods ?? 0)) nextAction = "settled";
      else nextAction = "start_task";

      items.push({
        enrollmentId: e.id,
        cardId: e.cardId,
        title: card?.title || "养鱼免单",
        merchantName: card?.merchantName ?? null,
        status: e.status,
        // 停奖期照常可核销但不能退费：这是 PRD 4.6 的口径，必须在 C 端可见
        paused: e.status === "pause1" || e.status === "pause3" || e.status === "pause2" || e.status === "pause6",
        pauseRemaining: e.pauseRemaining,
        shareUnlocked: !!e.shareUnlocked,
        /**
         * 分享态（第三代：绑定即归因，不要求成交）
         *   done  = 已解锁（尾款已补发）
         *   share = 随时可分享，分享给谁就绑谁，一次绑定解锁本人**所有卡**
         * 比例逐卡不同，取 card.shareRatio，写死 0.3 会与后端漂移。
         */
        share: {
          unlocked: !!e.shareUnlocked,
          ratio: card?.shareRatio ?? config.package.shareRatioDefault,
          invited: bindStats.invited,
          pendingPeriods: periods.filter(
            (p) => !p.expired && (Number(p.refund70Amount) || 0) > 0 && (Number(p.refund30Amount) || 0) === 0
          ).length,
          action: e.shareUnlocked ? "done" : "share",
        },
        totalPeriods: card?.periods ?? 0,
        periodsDone: done,
        periodsExpired: expired,
        refunded: refundedNow,
        current: hint
          ? {
              periodNo: hint.periodNo,
              weekStart: hint.weekStart,
              weekEnd: hint.weekEnd,
              lastStartDay: hint.lastStartDay,
              checkinDeadline: hint.checkinDeadline,
              today: hint.today,
              closed: hint.weekClosed,
              checkedIn: !!periods.find((p) => p.periodNo === hint.periodNo)?.checkinId,
            }
          : null,
        nextAction,
      });
    }
    ok(res, { items, total: list.length });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ *
 * 5) 消息中心（铃铛）
 * ------------------------------------------------------------------ */
sdkRouter.get("/notices", auth(), async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const [items, unread] = await Promise.all([
      listMessages(req.user!.userId, limit),
      countUnread(req.user!.userId),
    ]);
    ok(res, { items, unread });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ *
 * 6) 商户工作台：核销台 + 名单 + 结算账户（负余额要显眼）
 *    商户 ID 一律取自身身份，不接受 query 传参 —— 水平越权的最短路径就是"让前端传 id"。
 * ------------------------------------------------------------------ */
sdkRouter.get("/merchant/console", auth(["MERCHANT", "CASHIER"]), async (req, res, next) => {
  try {
    const merchantId = req.user!.merchantId;
    if (!merchantId) throw badRequest("客户端账号未绑定商家");
    const [roster, account] = await Promise.all([
      listMerchantEnrollments(merchantId, undefined),
      getAccount(merchantId),
    ]);
    ok(res, {
      merchantId,
      account,
      roster,
      // 今天能核销的（未核销且本周未关闭）在前：收银员只关心这一屏
      sortedHint: true,
    });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ *
 * 6.5) 运维定时任务入口（cron 用 OPERATOR 令牌调；不放在 /api/periods 下是因为
 *      这两件事都属于 SDK 形态带来的：分享归因补偿、埋点保留策略）
 * ------------------------------------------------------------------ */

/**
 * 分享补偿：
 *   ① sweepShareCompensation —— 有购买但无归因的成交，重跑关系链判定
 *      （关系绑定晚于支付是常态：用户先付后绑、或主站绑定请求失败重试）
 *   ② retryPendingConversions —— 上级当时还没养鱼的成交，等他买卡后补发
 */
sdkRouter.post("/ops/share-sweep", auth(["OPERATOR"]), async (_req, res, next) => {
  try {
    // 第三代主通道：绑定后分享者尚未入驻 / 没卡 → 补解锁
    const binds = await sweepPendingBinds(200);
    // 旧口径兜底（默认配置下不会有数据，保留以兼容历史归因）
    const swept = config.share.fallbackReferrer ? await sweepShareCompensation(30, 200) : null;
    const retried = config.share.fallbackReferrer ? await retryPendingConversions(100) : null;
    ok(res, { binds, swept, retried });
  } catch (e) {
    next(e);
  }
});

/** 埋点保留策略：删除超过保留期的事件（分批，避免一次锁表） */
sdkRouter.post("/ops/purge-events", auth(["OPERATOR"]), async (req, res, next) => {
  try {
    const days = Math.max(7, Number(req.query.days) || config.track.retentionDays);
    const deleted = await purgeOldEvents(days);
    ok(res, { days, deleted, stats: trackStats() });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ *
 * 7) 运营工作台：待办一体化（审核 / 预算 / 欠款 / 卡单）
 * ------------------------------------------------------------------ */
sdkRouter.get("/ops/console", auth(["OPERATOR"]), async (_req, res, next) => {
  try {
    const [pending, budget, negative, stuck] = await Promise.all([
      listPending(),
      budgetHeadroom(),
      listNegativeAccounts(),
      listStuckRefunds(30),
    ]);
    ok(res, {
      pendingCards: pending,
      budget,
      negativeAccounts: negative,
      stuckRefunds: stuck,
      // 预算剩额 < 在办期次最坏敞口 → 必须停售新卡（停售，不停已售卡兑付）
      budgetAlert: budget.shouldStopSelling,
    });
  } catch (e) {
    next(e);
  }
});

export default sdkRouter;