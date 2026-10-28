/**
 * 关系链分享（唯一的判定入口）
 *
 * 2026-10-21 PO 口径（第三代，覆盖前两代）：
 *   1) 「所有卡的 X%，不管有没有交易」→ 分享者名下全部套餐卡都解锁，
 *      且**绑定动作本身**即触发，不要求被分享者购卡成交；
 *   2) 「谁分享绑定谁的关系」→ share_bind 记录 sharer → viewer，
 *      首触锁定（一个 viewer 只归一任 sharer），不覆盖；
 *   3) 「每个商品和服务决定每个商品和服务分多少」→ 比例取 card.share_ratio，
 *      逐卡独立，不再是全局 0.3。
 *
 * 与主站推荐关系的分工：
 *   - 主站 zy_users 推荐关系 = 账号级归属（谁把人带进平台），注册时确定，长期不变；
 *   - share_bind = 分享级归因（谁把这张卡发给这个人），一次活动一次归因。
 *   两者并存但**不互相替代**：判定尾款归谁用 share_bind，查账号上级仍用主站。
 *   旧口径「只查主站」保留为兜底（SHARE_FALLBACK_REFERRER=true），默认关闭，
 *   避免同一个用户被两套关系判出两个上级、发两份钱。
 */
import { config } from "../../config";
import { newId, query } from "../../lib/db";
import { logger } from "../../lib/logger";
import { resolveAiUid } from "../../lib/fund";
import { unlockByBind, unlockShareAndBackfill, UnlockResult } from "../refund/refund.service";

/** 关系链查询结果：区分「确实没有上级」与「查不到」，否则会把故障当成无关系 */
export type ChainLookup =
  | { state: "ok"; buyerAiUid: string | null; referrerAiUid: string | null }
  | { state: "unavailable"; reason: string };

/**
 * 只读查询某用户的上级。
 * 超时/5xx/解析失败一律返回 unavailable —— 调用方据此把判定挂起（deferred），
 * 由补偿任务重试，绝不因为"没查到"就当作"没上级"去发钱或拒发。
 */
export async function readReferrer(userId: string): Promise<ChainLookup> {
  const aiUid = await resolveAiUid(userId);
  if (!aiUid) return { state: "ok", buyerAiUid: null, referrerAiUid: null }; // 未联邦的用户不可能被邀请过

  const url = `${config.wallet.base}/yangyu/referrer?uid=${Number(aiUid)}`;
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), config.share.chainTimeoutMs) : null;
  try {
    const r = await fetch(url, {
      headers: { "X-Service-Key": config.wallet.serviceKey },
      signal: ctrl?.signal,
    });
    if (!r.ok) return { state: "unavailable", reason: `HTTP ${r.status}` };
    const j: any = await r.json().catch(() => null);
    if (!j || (j.code !== 0 && j.code !== "0")) {
      return { state: "unavailable", reason: j?.message || "bad envelope" };
    }
    const ref = Number(j?.data?.referrer) || 0;
    return { state: "ok", buyerAiUid: String(aiUid), referrerAiUid: ref > 0 ? String(ref) : null };
  } catch (err: any) {
    return { state: "unavailable", reason: err?.name === "AbortError" ? "timeout" : err?.message || "network" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 主站 ai_uid → 养鱼域 user_id（联邦锚点反向解析） */
export async function localUserIdOf(aiUid: string): Promise<string | null> {
  const r = await query<any>("SELECT user_id FROM merchant_user WHERE ai_uid = ? LIMIT 1", [String(aiUid)]);
  return r.rows[0]?.user_id ?? null;
}

/**
 * 分享链接：**只带主站关系链的归因参数**，不生成养鱼自己的邀请码。
 * 参数名与落地路径走配置，因为那是主站关系链接口的契约，
 * 硬编码在这里等于把主站的路由写死在养鱼代码里（改一次要发一次版）。
 */
export function buildShareLink(refAiUid: string, extra?: Record<string, string>): string {
  const tpl = config.share.linkTemplate; // 例：https://ai.ws.hi.cn/yangyu?ref={ref}
  const url = tpl.replace("{ref}", encodeURIComponent(refAiUid));
  if (!extra) return url;
  const qs = Object.keys(extra)
    .filter((k) => extra[k] !== undefined && extra[k] !== "")
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(extra[k])}`)
    .join("&");
  if (!qs) return url;
  return url + (url.includes("?") ? "&" : "?") + qs;
}

export interface ShareLinkResult {
  ok: boolean;
  reason?: string;
  aiUid?: string;
  url?: string;
  /** 主站落地页参数名，宿主自拼分享卡片时用得到 */
  refParam: string;
}

/** 当前用户的分享链接（未联邦/主站不可用时不返回链接，不返回假链接） */
export async function shareLinkOf(userId: string, cardId?: string | null): Promise<ShareLinkResult> {
  const aiUid = await resolveAiUid(userId);
  if (!aiUid) return { ok: false, reason: "NO_FEDERATION", refParam: config.share.refParam };
  return {
    ok: true,
    aiUid,
    // 带上 cardId 只用于归因来源，不影响解锁范围（绑定解锁全部卡）
    url: cardId ? buildShareLink(aiUid, { cardId }) : buildShareLink(aiUid),
    refParam: config.share.refParam,
  };
}

/* ------------------------------------------------------------------ *
 * 分享绑定（第三代：绑定即归因，不依赖成交）
 * ------------------------------------------------------------------ */

export type BindReason =
  | "NO_FEDERATION" // 被分享者没有主站身份，无法作为归因主体
  | "BAD_REF" // 链接里的 ref 不是合法 ai_uid
  | "SELF_REFERRAL" // 自己分享给自己
  | "ALREADY_BOUND" // 已被别人绑定（首触锁定）
  | "CYCLE" // 对方是你自己拉来的人，反向绑定会成环
  | "SHARER_NOT_ENROLLED" // 分享者还没进养鱼域（已记账，等他入驻补发）
  | "DISABLED"; // 配置关闭了绑定即解锁

export interface BindResult {
  ok: boolean;
  reason?: BindReason;
  bindId?: string;
  alreadyBound?: boolean;
  viewerAiUid?: string;
  sharerAiUid?: string;
  /** 本次为分享者解锁的结果（金额是他拿到多少，不是被分享者的） */
  unlock?: { cards: number; periods: number; amount: number } | null;
}

const REF_RE = /^[0-9A-Za-z_-]{1,32}$/;

export type BindDecision =
  | { action: "insert" }
  | { action: "same" }
  | { action: "rebind" }
  | { action: "reject"; reason: "SELF_REFERRAL" | "ALREADY_BOUND" | "CYCLE" };

/**
 * 绑定决策（纯函数，无 I/O）。
 *
 * 之所以把判定抽出来：这段规则是"钱归谁"的唯一判据，必须能被穷举测试，
 * 而不是埋在 SQL 之间靠联调验证。分支只有四种：
 *   insert  首次绑定
 *   same    同一对关系重复绑定（幂等，可顺带补解锁）
 *   rebind  改归因（仅 policy=last）
 *   reject  自邀 / 已被别人绑定（首触锁定）/ 成环
 */
export function decideBind(input: {
  viewerAiUid: string;
  refAiUid: string;
  policy: "first" | "last";
  prevSharerAiUid?: string | null;
  cycle?: boolean;
}): BindDecision {
  if (String(input.viewerAiUid) === String(input.refAiUid)) {
    return { action: "reject", reason: "SELF_REFERRAL" };
  }
  if (input.prevSharerAiUid) {
    if (String(input.prevSharerAiUid) === String(input.refAiUid)) return { action: "same" };
    // 首触锁定：群里第二个人再转发不会把人抢走。
    // 末触覆盖（last）会让同一批成交被多个分享者各解锁一次，只在明确接受该成本时启用。
    if (input.policy === "first") return { action: "reject", reason: "ALREADY_BOUND" };
    return { action: "rebind" };
  }
  if (input.cycle) return { action: "reject", reason: "CYCLE" };
  return { action: "insert" };
}

/**
 * 绑定分享关系：viewer（当前登录用户）归因给 ref 对应的分享者。
 *
 * 幂等与竞争：
 *   uk_viewer 保证一个 viewer 只有一条有效绑定；并发插入时后到者拿到 1062，
 *   按「首触锁定」返回 ALREADY_BOUND —— 绝不覆盖，否则同一批成交会被重复计价。
 *
 * 「绑定即解锁」是本轮 PO 的核心口径：只要发生了分享并被对方打开，
 * 分享者立刻拿到他名下**所有卡**的尾款比例。风控开关见 config.share.unlockOnBind。
 */
export async function bindShare(input: {
  viewerUserId: string;
  refAiUid: string;
  cardId?: string | null;
  source?: string;
}): Promise<BindResult> {
  const ref = String(input.refAiUid ?? "").trim();
  if (!REF_RE.test(ref)) return { ok: false, reason: "BAD_REF" };

  const viewerAiUid = await resolveAiUid(input.viewerUserId);
  if (!viewerAiUid) return { ok: false, reason: "NO_FEDERATION" };

  const sharerLocal = await localUserIdOf(ref);
  // 本地 id 相等也要拦：同一个人的 ai_uid 可能因历史数据不一致而不同
  if (sharerLocal && sharerLocal === input.viewerUserId) {
    return { ok: false, reason: "SELF_REFERRAL", viewerAiUid: String(viewerAiUid), sharerAiUid: ref };
  }

  const exist = await query<any>(`SELECT * FROM share_bind WHERE viewer_ai_uid = ? LIMIT 1`, [
    String(viewerAiUid),
  ]);
  const prev = exist.rows[0];

  // 环检测只在"还没有归属"时做：已有归属的人再被绑一定是 reject/rebind，走不到成环
  let cycle = false;
  if (!prev) {
    const c = await query<any>(
      `SELECT id FROM share_bind WHERE sharer_user_id = ? AND viewer_ai_uid = ? LIMIT 1`,
      [input.viewerUserId, ref]
    );
    cycle = !!c.rows[0];
  }

  const decision = decideBind({
    viewerAiUid: String(viewerAiUid),
    refAiUid: ref,
    policy: config.share.bindPolicy,
    prevSharerAiUid: prev ? String(prev.sharer_ai_uid) : null,
    cycle,
  });

  if (decision.action === "reject") {
    if (decision.reason === "SELF_REFERRAL") {
      logger.warn({ viewerUserId: input.viewerUserId }, "[share] 自邀绑定被拒");
    }
    // 被抢占是正常业务分支：把"归了谁"回给前端没有意义，只回原因
    return {
      ok: false,
      reason: decision.reason,
      bindId: prev ? String(prev.id) : undefined,
      viewerAiUid: String(viewerAiUid),
      sharerAiUid: decision.reason === "ALREADY_BOUND" && prev ? String(prev.sharer_ai_uid) : ref,
    };
  }

  if (decision.action === "same") {
    const r = await maybeUnlock(prev, sharerLocal);
    return {
      ok: true,
      alreadyBound: true,
      bindId: String(prev.id),
      viewerAiUid: String(viewerAiUid),
      sharerAiUid: ref,
      unlock: r,
    };
  }

  if (decision.action === "rebind") {
    // last 口径：改归因。历史已发的钱不回收（那是既成事实），新分享者按自己的卡重新解锁。
    await query(
      `UPDATE share_bind
          SET sharer_user_id = ?, sharer_ai_uid = ?, card_id = ?, source = ?,
              state = 'bound', unlocked_cards = 0, unlocked_periods = 0,
              unlocked_amount = 0, unlocked_at = NULL, reject_reason = NULL
        WHERE id = ?`,
      [sharerLocal ?? `ai:${ref}`, ref, input.cardId ?? null, input.source ?? "link", prev.id]
    );
    const r = await maybeUnlock({ id: prev.id, card_id: input.cardId ?? null }, sharerLocal);
    return {
      ok: true,
      bindId: String(prev.id),
      viewerAiUid: String(viewerAiUid),
      sharerAiUid: ref,
      unlock: r,
    };
  }

  const id = newId();
  try {
    await query(
      `INSERT INTO share_bind
         (id, sharer_user_id, sharer_ai_uid, viewer_user_id, viewer_ai_uid, card_id, source, state)
       VALUES (?,?,?,?,?,?,?,'bound')`,
      [
        id,
        sharerLocal ?? `ai:${ref}`,
        ref,
        input.viewerUserId,
        String(viewerAiUid),
        input.cardId ?? null,
        input.source ?? "link",
      ]
    );
  } catch (err: any) {
    if (err?.code === "ER_DUP_ENTRY" || err?.errno === 1062) {
      // 并发首触：另一个人先绑上了
      return { ok: false, reason: "ALREADY_BOUND", viewerAiUid: String(viewerAiUid), sharerAiUid: ref };
    }
    throw err;
  }

  const r = await maybeUnlock({ id, card_id: input.cardId ?? null }, sharerLocal);
  return {
    ok: true,
    bindId: id,
    viewerAiUid: String(viewerAiUid),
    sharerAiUid: ref,
    unlock: r,
  };
}

/**
 * 绑定后的解锁动作（幂等）。
 * 分享者尚未入驻养鱼域（sharerLocal 为空）时**不报错**：绑定已成立，
 * 等他人来了由 sweepPendingBinds 补发 —— 关系成立与资金到账是两件事。
 */
async function maybeUnlock(
  bind: { id: string; card_id?: string | null },
  sharerLocal: string | null
): Promise<{ cards: number; periods: number; amount: number } | null> {
  if (!config.share.unlockOnBind) return null;
  if (!sharerLocal) return null;

  const res = await unlockByBind(sharerLocal, null, String(bind.id), {
    cardId: bind.card_id ?? null,
  });

  const cards = res.unlockedEnrollmentIds?.length ?? 0;
  await query(
    `UPDATE share_bind
        SET unlocked_cards = ?, unlocked_periods = ?, unlocked_amount = ?,
            state = ?, unlocked_at = CASE WHEN ? = 'unlocked' THEN CURRENT_TIMESTAMP(3) ELSE unlocked_at END
      WHERE id = ?`,
    [cards, res.backfilled, res.amount, res.unlocked ? "unlocked" : "bound", res.unlocked ? "unlocked" : "bound", bind.id]
  ).catch((err: any) => logger.error({ err: err?.message }, "[share] 绑定解锁回写失败"));

  return { cards, periods: res.backfilled, amount: res.amount };
}

/** 分享者视角：我邀请了多少人、因此解锁了多少（只给汇总，不给名单身份） */
export async function bindStatsOf(sharerUserId: string): Promise<{
  invited: number;
  unlockedCards: number;
  unlockedAmount: number;
}> {
  const r = await query<any>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(unlocked_cards), 0) AS cards,
            COALESCE(SUM(unlocked_amount), 0) AS amount
       FROM share_bind WHERE sharer_user_id = ?`,
    [sharerUserId]
  );
  return {
    invited: Number(r.rows[0]?.n) || 0,
    unlockedCards: Number(r.rows[0]?.cards) || 0,
    unlockedAmount: Number(r.rows[0]?.amount) || 0,
  };
}

/** 被分享者视角：我是否已被某人带来（不暴露对方身份） */
export async function viewerBindOf(viewerUserId: string): Promise<{
  bound: boolean;
  boundAt: Date | null;
} | null> {
  const aiUid = await resolveAiUid(viewerUserId);
  if (!aiUid) return { bound: false, boundAt: null };
  const r = await query<any>(`SELECT created_at FROM share_bind WHERE viewer_ai_uid = ? LIMIT 1`, [
    String(aiUid),
  ]);
  return r.rows[0] ? { bound: true, boundAt: r.rows[0].created_at } : { bound: false, boundAt: null };
}

/**
 * 补偿：分享者当时还没入驻 → 现在查得到人了，补解锁。
 * 这类"时序失败"只在绑定发生瞬间判一次的话，用户永远拿不到钱，且客诉无法复现。
 */
export async function sweepPendingBinds(limit = 200): Promise<{ scanned: number; unlocked: number }> {
  const r = await query<any>(
    `SELECT id, sharer_user_id, sharer_ai_uid, card_id
       FROM share_bind
      WHERE state = 'bound'
      ORDER BY created_at ASC LIMIT ?`,
    [limit]
  );
  let unlocked = 0;
  for (const row of r.rows) {
    let local = String(row.sharer_user_id);
    if (local.startsWith("ai:")) {
      local = (await localUserIdOf(String(row.sharer_ai_uid))) ?? "";
      if (!local) continue; // 仍未入驻，下次再试
      await query(`UPDATE share_bind SET sharer_user_id = ? WHERE id = ?`, [local, row.id]);
    }
    const res = await maybeUnlock({ id: String(row.id), card_id: row.card_id }, local || null);
    if (res && res.cards > 0) unlocked += 1;
  }
  return { scanned: r.rows.length, unlocked };
}

/* ------------------------------------------------------------------ *
 * 旧口径兜底：主站推荐关系 + 成交归因
 *   默认不启用（SHARE_FALLBACK_REFERRER=true 才走），原因见文件头。
 * ------------------------------------------------------------------ */

export interface ClaimResult {
  /** 是否有可执行的判定（false = 关系链不可用，已挂起） */
  judged: boolean;
  /** 是否找到了上级 */
  referrerFound: boolean;
  /** 本次是否新解锁了卡 */
  unlocked: boolean;
  unlockedCardCount: number;
  backfilled: number;
  failed: number;
  reason?: string;
}

const EMPTY_CLAIM: ClaimResult = {
  judged: false,
  referrerFound: false,
  unlocked: false,
  unlockedCardCount: 0,
  backfilled: 0,
  failed: 0,
};

/**
 * 被推荐人成交 → 依据关系链判定是否解锁其上级的 30%。
 *
 * 幂等三层：
 *   1) share_conversion.uk_conv (referrer, buyer, card) —— 同一笔成交只处理一次
 *   2) enrollment.share_unlocked —— 已解锁的卡不重复解锁
 *   3) refund30 自身的 refund_flow.idem_key
 *
 * 关系链不可用时**不做任何写入**，返回 judged=false，交给补偿任务重试。
 * 这里刻意不做「稍后再说」的本地队列：失败重放的可靠性靠 share_conversion
 * 的缺失记录来兜（有成交但无归因记录 = 待重试），不需要第二套队列。
 */
export async function claimShare(input: {
  buyerUserId: string;
  cardId: string;
  enrollmentId?: string | null;
  source?: "purchase" | "manual" | "sweep";
}): Promise<ClaimResult> {
  const { buyerUserId, cardId } = input;
  const source = input.source ?? "purchase";

  const chain = await readReferrer(buyerUserId);
  if (chain.state === "unavailable") {
    logger.warn({ buyerUserId, reason: chain.reason }, "[share] 关系链不可用，判定挂起");
    return { ...EMPTY_CLAIM, reason: "CHAIN_UNAVAILABLE" };
  }
  if (!chain.referrerAiUid) {
    return { ...EMPTY_CLAIM, judged: true, referrerFound: false, reason: "NO_REFERRER" };
  }

  const referrerLocal = await localUserIdOf(chain.referrerAiUid);
  const buyerAiUid = chain.buyerAiUid ?? chain.referrerAiUid;
  if (!referrerLocal) {
    // 上级存在主站、但从未登录过养鱼域 → 现在没有卡可解锁。
    // 刻意不写归因记录：一旦写了，sweep 的 LEFT JOIN 会认为这笔成交已处理，
    // 上级以后注册/买卡就再也不会被补发。等他进养鱼域，sweep 自然会重新判定。
    return { ...EMPTY_CLAIM, judged: true, referrerFound: true, reason: "REFERRER_NOT_ENROLLED" };
  }
  if (referrerLocal === buyerUserId) {
    // 自邀：不发放，且必须留痕，否则"自己拉自己"会变成静默通过的刷单路径
    logger.warn({ buyerUserId, cardId }, "[share] 检测到自邀，已拒绝");
    return { ...EMPTY_CLAIM, judged: true, referrerFound: true, reason: "SELF_REFERRAL" };
  }

  // ---------- 判定解锁目标：优先「被买的这张卡」，否则「上级最早一张未解锁卡」 ----------
  const target = await pickUnlockTarget(referrerLocal, cardId);
  if (!target) {
    await recordConversion({
      referrerUserId: referrerLocal,
      buyerUserId,
      buyerAiUid,
      cardId,
      enrollmentId: input.enrollmentId ?? null,
      unlockedEnrollmentId: null,
      backfilled: 0,
      source,
    });
    return { ...EMPTY_CLAIM, judged: true, referrerFound: true, reason: "REFERRER_HAS_NO_CARD" };
  }

  const res: UnlockResult = await unlockShareAndBackfill(referrerLocal, buyerUserId, target);

  await recordConversion({
    referrerUserId: referrerLocal,
    buyerUserId,
    buyerAiUid,
    cardId,
    enrollmentId: input.enrollmentId ?? null,
    unlockedEnrollmentId: target.enrollmentId ?? null,
    backfilled: res.backfilled,
    source,
  });

  return {
    judged: true,
    referrerFound: true,
    unlocked: !!res.unlocked,
    unlockedCardCount: res.unlockedEnrollmentIds?.length ?? 0,
    backfilled: res.backfilled,
    failed: res.failed,
  };
}

/**
 * 解锁目标选择：
 *   ① 上级持有「被成交的那张卡」→ 解锁该卡全部期次（与分享的项目对齐）
 *   ② 否则取上级最早一张尚未解锁的卡（他分享的不是自己持有的卡时，也要有产出）
 * 返回 cardId 或 enrollmentId，交给 unlockShareAndBackfill 决定范围。
 */
async function pickUnlockTarget(
  referrerUserId: string,
  boughtCardId: string
): Promise<{ cardId?: string | null; enrollmentId?: string | null } | null> {
  const own = await query<any>(
    `SELECT id FROM enrollment WHERE user_id = ? AND card_id = ? ORDER BY enroll_at DESC LIMIT 1`,
    [referrerUserId, boughtCardId]
  );
  if (own.rows[0]) return { cardId: boughtCardId };

  const any = await query<any>(
    `SELECT id, card_id FROM enrollment
      WHERE user_id = ? AND share_unlocked = 0
      ORDER BY enroll_at ASC LIMIT 1`,
    [referrerUserId]
  );
  if (any.rows[0]) return { enrollmentId: String(any.rows[0].id) };

  // 全部已解锁：仍要记账（幂等表），但不产生新的资金动作
  const exists = await query<any>(`SELECT id FROM enrollment WHERE user_id = ? LIMIT 1`, [referrerUserId]);
  return exists.rows[0] ? { enrollmentId: String(exists.rows[0].id) } : null;
}

async function recordConversion(input: {
  referrerUserId: string;
  buyerUserId: string;
  buyerAiUid: string;
  cardId: string;
  enrollmentId: string | null;
  unlockedEnrollmentId: string | null;
  backfilled: number;
  source: string;
}): Promise<void> {
  try {
    await query(
      `INSERT IGNORE INTO share_conversion
         (id, referrer_user_id, buyer_user_id, buyer_ai_uid, card_id, enrollment_id,
          unlocked_enrollment_id, backfilled, source)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        newId(),
        input.referrerUserId,
        input.buyerUserId,
        input.buyerAiUid,
        input.cardId,
        input.enrollmentId,
        input.unlockedEnrollmentId,
        input.backfilled,
        input.source,
      ]
    );
  } catch (err: any) {
    // 归因写失败不能影响资金正确性（钱已经按幂等规则发过了），但要能被日志发现
    logger.error({ err: err?.message, input }, "[share] 归因记录写入失败");
  }
}

/* ------------------------------------------------------------------ *
 * 补偿：关系链绑定晚于成交、上级后补卡
 * ------------------------------------------------------------------ */

/**
 * 扫描「有购买记录但还没有分享归因」的近 N 天成交，重跑判定。
 *
 * 为什么必须有这条：关系绑定发生在主站落地页，可能晚于支付（用户先付后绑、
 * 或者绑定请求失败重试）。只在购买时判定一次，这批人永远拿不到 30%，
 * 而客诉进来时又无法复现——这类"时序失败"只能靠定时重试兜。
 */
export async function sweepShareCompensation(days = 30, limit = 200): Promise<{
  scanned: number;
  claimed: number;
  deferred: number;
}> {
  const res = await query<any>(
    `SELECT e.id, e.card_id, e.user_id
       FROM enrollment e
       LEFT JOIN share_conversion c
              ON c.buyer_user_id = e.user_id AND c.card_id = e.card_id
      WHERE e.enroll_at >= (NOW() - INTERVAL ? DAY)
        AND e.status <> 'refunded'
        AND c.id IS NULL
      ORDER BY e.enroll_at DESC
      LIMIT ?`,
    [days, limit]
  );

  let claimed = 0;
  let deferred = 0;
  for (const row of res.rows) {
    const r = await claimShare({
      buyerUserId: String(row.user_id),
      cardId: String(row.card_id),
      enrollmentId: String(row.id),
      source: "sweep",
    });
    if (!r.judged) deferred += 1;
    else if (r.unlocked) claimed += 1;
  }
  return { scanned: res.rows.length, claimed, deferred };
}

/** 上级当时还没养鱼（无卡）的成交：等他买卡后补发 */
export async function retryPendingConversions(limit = 100): Promise<{ retried: number; unlocked: number }> {
  const res = await query<any>(
    `SELECT id, buyer_user_id, card_id FROM share_conversion
      WHERE unlocked_enrollment_id IS NULL
      ORDER BY created_at ASC LIMIT ?`,
    [limit]
  );
  let unlocked = 0;
  let retried = 0;
  for (const row of res.rows) {
    const u = await query<any>(`SELECT id FROM enrollment WHERE user_id = ? LIMIT 1`, [row.referrer_user_id]);
    if (!u.rows[0]) continue; // 上级仍未养鱼，下次再试
    retried += 1;
    const r = await claimShare({
      buyerUserId: String(row.buyer_user_id),
      cardId: String(row.card_id),
      source: "sweep",
    });
    if (r.unlocked) unlocked += 1;
  }
  return { retried, unlocked };
}
