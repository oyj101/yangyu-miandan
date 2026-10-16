"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeOnCheckin = computeOnCheckin;
exports.issueIntroBonus = issueIntroBonus;
exports.triggerIntroBonus = triggerIntroBonus;
exports.evaluateWeek = evaluateWeek;
exports.listRewards = listRewards;
const db_1 = require("../../lib/db");
const errors_1 = require("../../lib/errors");
const config_1 = require("../../config");
const engine_1 = require("./engine");
const enrollment_repo_1 = require("../enrollment/enrollment.repo");
const card_repo_1 = require("../card/card.repo");
/**
 * F5/F6：核销履约时计算奖励。受 4.3 状态机 + 免单上限(coverage_cap) 双重约束。
 * 资金结算：奖励以「鱼豆(coin)」经主平台 wallet_service 动账，不裸写资金表。
 */
async function computeOnCheckin(enrollmentId, merchantId) {
    const e = await (0, enrollment_repo_1.findEnrollment)(enrollmentId);
    if (!e)
        throw (0, errors_1.notFound)("入渔记录不存在");
    if (e.merchantId !== merchantId)
        throw (0, errors_1.notFound)("入渔记录不属于该商家");
    const card = await (0, card_repo_1.findCardById)(e.cardId);
    if (!card)
        throw (0, errors_1.notFound)("免单卡不存在");
    const state = (0, enrollment_repo_1.toState)(e);
    // 20261017 PO 规则: 常规核销发奖封顶 70% 应发总额; 剩余 30% 须「成功转介绍同等价值项目」后一次性发放(see issueIntroBonus)。
    const rewardableCeil = Math.round(e.rewardTotal * 0.7 * 100) / 100;
    const remaining = Math.max(0, rewardableCeil - e.rewardPaid);
    // 20261016 双条件(PO 规则修正): 本周养鱼(聊天投喂)天数 >= 阈值(global_param yangyu_weekly_threshold) + 到店核销 → 即时发奖(余额)。
    // 数据真源=8100 chat_history, 经 /api/v2/yangyu/feed-days。不达标或数据不可用 → 核销照记但不发奖(资金谨慎)。
    const feed = await fetchFeedDays(e.userId);
    const feedNote = !feed.ok
        ? "养鱼投喂数据不可用, 本期不发奖(待复核)"
        : feed.days < feed.threshold
            ? `本周养鱼${feed.days}天<阈值${feed.threshold}, 不发奖`
            : `本周养鱼${feed.days}天达标`;
    let amount = Math.min(card.rewardPerTime, remaining);
    if (!feed.ok || feed.days < feed.threshold)
        amount = 0;
    const { state: ns, reward, rewardAmount } = (0, engine_1.applyCheckin)(state, amount);
    const willIssue = reward && amount > 0;
    let rewardId = null;
    if (willIssue)
        rewardId = (0, db_1.newId)();
    const finalState = willIssue
        ? { ...ns, rewardPaid: ns.rewardPaid }
        : ns;
    const result = await (0, db_1.withTx)(async (client) => {
        if (willIssue) {
            // 主键应用层生成（CHAR(36)），无需 RETURNING 回读
            await client.query(`INSERT INTO reward (id, enrollment_id, user_id, amount, status)
         VALUES (?,?,?,?,'issued')`, [rewardId, e.id, e.userId, amount]);
        }
        // 状态更新走同一事务连接（pool 另开会话会与 FK 共享锁互等，见 enrollment.repo 注释）
        await (0, enrollment_repo_1.updateEnrollState)(client, e.id, finalState);
        // 写核销记录（一人一周一核销：唯一索引 idx_checkin_dedup 兜底同周重复；
        // MariaDB 1062 ER_DUP_ENTRY → 409，整个事务回滚，奖励与状态均不落库）
        try {
            await client.query(`INSERT INTO checkin (id, enrollment_id, user_id, merchant_id, card_id, week, rewarded, reward_id, note)
         VALUES (?,?,?,?,?,?,?,?,?)`, [(0, db_1.newId)(), e.id, e.userId, merchantId, e.cardId, currentWeek(), willIssue, rewardId, feedNote]);
        }
        catch (err) {
            if (err?.errno === 1062 || err?.code === "ER_DUP_ENTRY") {
                throw (0, errors_1.conflict)("本周已核销，请勿重复操作");
            }
            throw err;
        }
        return {
            rewarded: willIssue,
            rewardAmount: willIssue ? amount : 0,
            rewardId,
            status: finalState.status,
            pausedRemaining: finalState.pauseRemaining,
        };
    });
    // 资金结算：养鱼核销奖励 → 主平台钱包鱼豆(coin)。业务记录已落库后再动账，
    // 失败仅记结构化错误日志（含 enrollmentId/aiUid/amount）供异步对账，不阻断核销主流程。
    if (willIssue && result.rewardId) {
        await creditFishBeans(e.userId, amount, e.id, result.rewardId);
    }
    return result;
}
/** 20261016 双条件数据源: 本周养鱼(聊天投喂)天数 + 达标阈值(global_param)。
 * 聊天互动真源=8100 chat_history, 经 /api/v2/yangyu/feed-days (X-Service-Key)。失败降级为不可用(不发奖)。 */
/** 20261017 转介绍 30%(PO 规则): 被推荐人成功购买同等价值项目(同价卡)后,
 * 推荐人常规封顶 70% 之外的剩余部分一次性发放 → 100% 免单闭环。
 * 防重: 仅 status=normal 且 rewardPaid<rewardTotal 时发放。 */
async function issueIntroBonus(enrollmentId, introAmount, remark) {
    const e = await (0, enrollment_repo_1.findEnrollment)(enrollmentId);
    if (!e)
        return false;
    if (e.status !== "normal")
        return false;
    const paid = Number(e.rewardPaid);
    const total = Number(e.rewardTotal);
    if (paid >= total)
        return false;
    const amount = Math.min(Number(introAmount), Math.round((total - paid) * 100) / 100);
    if (!(amount > 0))
        return false;
    const rewardId = (0, db_1.newId)();
    const ns = { ...(0, enrollment_repo_1.toState)(e), rewardPaid: Math.round((paid + amount) * 100) / 100 };
    await (0, db_1.withTx)(async (client) => {
        await client.query(`INSERT INTO reward (id, enrollment_id, user_id, amount, status)
       VALUES (?,?,?,?,'issued')`, [rewardId, e.id, e.userId, amount]);
        await (0, enrollment_repo_1.updateEnrollState)(client, e.id, ns);
    });
    // 即时余额动账(与核销发奖同通道; 失败仅日志, 奖励记录已落库可对账)
    try {
        const mu = await (0, db_1.query)("SELECT ai_uid FROM merchant_user WHERE user_id = ? LIMIT 1", [e.userId]);
        const aiUid = mu.rows[0]?.ai_uid;
        if (aiUid) {
            const resp = await fetch(`${config_1.config.wallet.base}/wallet/change`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Service-Key": config_1.config.wallet.serviceKey },
                body: JSON.stringify({
                    uid: Number(aiUid), asset: "balance", amount: Number(amount),
                    biz_type: "yangyu:reward", ledger: "zy",
                    remark: `${remark} 转介绍30% 入渔 ${enrollmentId} 奖励 ${rewardId}`, biz_id: 0,
                }),
            });
            const j = await resp.json().catch(() => ({}));
            if (j && (j.code === 0 || j.code === "0") && j.data && j.data.ok) {
                console.info("[reward] 转介绍30%余额动账成功", { aiUid, amount, flowNo: j.data.flow_no });
            }
            else {
                console.error("[reward] INTRO_CREDIT_FAILED", { userId: e.userId, amount, resp: j });
            }
        }
    }
    catch (err) {
        console.error("[reward] INTRO_CREDIT_ERROR", { enrollmentId, err: err?.message });
    }
    return true;
}
/** 20261017 转介绍触发器(购卡侧): 被推荐人购卡成功后, 查其主站关系链上级 →
 * 上级名下「常规已领≥70% 且未发满 且 同价卡」的入渔 → 一次性发最后 30%。 */
async function triggerIntroBonus(buyerUserId, cardId) {
    try {
        const card0 = await (0, card_repo_1.findCardById)(cardId);
        if (!card0)
            return;
        const cardPrice = Number(card0.price);
        const mu = await (0, db_1.query)("SELECT ai_uid FROM merchant_user WHERE user_id = ? LIMIT 1", [buyerUserId]);
        const aiUid = mu.rows[0]?.ai_uid;
        if (!aiUid)
            return;
        const r = await fetch(`${config_1.config.wallet.base}/yangyu/referrer?uid=${Number(aiUid)}`, { headers: { "X-Service-Key": config_1.config.wallet.serviceKey } });
        if (!r.ok)
            return;
        const j = await r.json().catch(() => null);
        const referrerUid = Number(j?.data?.referrer) || 0;
        if (!referrerUid)
            return;
        const rm = await (0, db_1.query)("SELECT user_id FROM merchant_user WHERE ai_uid = ? LIMIT 1", [String(referrerUid)]);
        const referrerLocal = rm.rows[0]?.user_id;
        if (!referrerLocal || referrerLocal === buyerUserId)
            return;
        const list = await (0, db_1.query)(`SELECT en.id, en.reward_paid, en.reward_total FROM enrollment en
       JOIN card c ON c.id = en.card_id
       WHERE en.user_id = ? AND en.status = 'normal' AND c.price = ?
       AND en.reward_paid >= ROUND(en.reward_total * 0.7, 2)
       AND en.reward_paid < en.reward_total
       LIMIT 1`, [referrerLocal, Number(cardPrice)]);
        const row = list.rows[0];
        if (!row)
            return;
        const bonus = Math.round((Number(row.reward_total) - Number(row.reward_paid)) * 100) / 100;
        const ok = await issueIntroBonus(row.id, bonus, "养鱼免单 70% 后转介绍达成");
        if (ok)
            console.info("[reward] 转介绍30%已发放", { referrer: referrerLocal, enrollmentId: row.id, bonus });
    }
    catch (err) {
        console.error("[reward] INTRO_TRIGGER_ERROR", { buyerUserId, err: err?.message });
    }
}
async function fetchFeedDays(userId) {
    const fallback = { ok: false, days: 0, threshold: 5 };
    try {
        const mu = await (0, db_1.query)("SELECT ai_uid FROM merchant_user WHERE user_id = ? LIMIT 1", [userId]);
        const aiUid = mu.rows[0]?.ai_uid;
        if (!aiUid)
            return fallback;
        const resp = await fetch(`${config_1.config.wallet.base}/yangyu/feed-days?uid=${Number(aiUid)}`, { headers: { "X-Service-Key": config_1.config.wallet.serviceKey } });
        if (!resp.ok)
            return fallback;
        const j = await resp.json().catch(() => null);
        const days = Number(j?.data?.days);
        if (!Number.isFinite(days))
            return fallback;
        const tp = await (0, db_1.query)("SELECT value FROM global_param WHERE `key` = 'yangyu_weekly_threshold' LIMIT 1");
        const threshold = Number(tp.rows[0]?.value) || 5;
        return { ok: true, days, threshold };
    }
    catch {
        return fallback;
    }
}
/**
 * 经主平台 wallet_service 发放余额(PO 20261016 修正: 奖励为余额非鱼豆)。uid 由养鱼域 user_id(au_1) 映射回主平台 ai_uid。
 * 服务间鉴权：X-Service-Key == settings.wallet_service_key。资产 coin=鱼豆。
 */
async function creditFishBeans(userId, amount, enrollmentId, rewardId) {
    const key = config_1.config.wallet.serviceKey;
    if (!key) {
        console.warn("[reward] WALLET_SERVICE_KEY 未配置，跳过余额动账", { userId, amount });
        return;
    }
    try {
        const mu = await (0, db_1.query)("SELECT ai_uid FROM merchant_user WHERE user_id = ? LIMIT 1", [userId]);
        const aiUid = mu.rows[0]?.ai_uid;
        if (!aiUid) {
            console.warn("[reward] 未找到 ai_uid，跳过鱼豆动账", { userId });
            return;
        }
        const resp = await fetch(`${config_1.config.wallet.base}/wallet/change`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Service-Key": key },
            body: JSON.stringify({
                uid: Number(aiUid),
                asset: "balance",
                amount: Number(amount),
                biz_type: "yangyu:reward",
                ledger: "zy",
                remark: `养鱼免单奖励(余额) 入渔 ${enrollmentId} 奖励 ${rewardId}`,
                biz_id: 0,
            }),
        });
        const j = await resp.json().catch(() => ({}));
        if (!(j && (j.code === 0 || j.code === "0") && j.data && j.data.ok)) {
            console.error("[reward] BALANCE_CREDIT_FAILED", { userId, aiUid, amount, resp: j });
        }
        else {
            console.info("[reward] 余额动账成功", { aiUid, amount, flowNo: j.data.flow_no });
        }
    }
    catch (err) {
        console.error("[reward] WALLET_CREDIT_ERROR", { userId, amount, err: err?.message });
    }
}
/**
 * 周末评估养鱼达标（met 由章鱼仔 AI 养鱼服务传入，P0 先以参数驱动）。
 */
async function evaluateWeek(enrollmentId, met) {
    const e = await (0, enrollment_repo_1.findEnrollment)(enrollmentId);
    if (!e)
        throw (0, errors_1.notFound)("入渔记录不存在");
    const next = (0, engine_1.evaluateWeekly)((0, enrollment_repo_1.toState)(e), met);
    await (0, enrollment_repo_1.updateEnrollState)(db_1.pool, e.id, next);
    return next;
}
async function listRewards(enrollmentId) {
    const res = await (0, db_1.query)(`SELECT * FROM reward WHERE enrollment_id = ? ORDER BY created_at DESC`, [enrollmentId]);
    return res.rows.map((r) => ({
        id: r.id,
        amount: Number(r.amount),
        status: r.status,
        createdAt: r.created_at,
    }));
}
function currentWeek() {
    // UTC+8 自然周编号（YYYYWW）
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const y = now.getUTCFullYear();
    const start = new Date(Date.UTC(y, 0, 1));
    const week = Math.ceil(((now.getTime() - start.getTime()) / 86400000 + start.getUTCDay()) / 7);
    return `${y}W${week}`;
}
//# sourceMappingURL=reward.service.js.map