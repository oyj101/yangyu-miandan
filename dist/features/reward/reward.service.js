"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeOnCheckin = computeOnCheckin;
exports.issueIntroBonus = issueIntroBonus;
exports.triggerIntroBonus = triggerIntroBonus;
exports.evaluateWeek = evaluateWeek;
exports.evaluateAllWeekly = evaluateAllWeekly;
exports.listRewards = listRewards;
exports.evaluateAllWeeklyV2 = evaluateAllWeeklyV2;
exports.currentWeek = currentWeek;
const db_1 = require("../../lib/db");
const errors_1 = require("../../lib/errors");
const config_1 = require("../../config");
const logger_1 = require("../../lib/logger");
const fund_1 = require("../../lib/fund");
const engine_1 = require("./engine");
const enrollment_repo_1 = require("../enrollment/enrollment.repo");
const card_repo_1 = require("../card/card.repo");
const iso_week_1 = require("../period/iso-week");
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
    // 20261018 P1-3: 已退款/已退出的入渔不得再核销(此前只挡住了发奖, 核销记录与 pauseRemaining 仍被写入, 污染名单与统计)。
    // normal 与停奖态(pause1/pause3)可正常核销 —— 停奖期核销用于消耗 pauseRemaining。
    if (e.status !== "normal" && e.status !== "pause1" && e.status !== "pause3") {
        throw (0, errors_1.conflict)(`该入渔当前状态(${e.status})不可核销`);
    }
    // 20261017 付费模式: 下单未支付的入渔不允许核销(防逃单)。免费领卡模式 pay_status=none, 不受影响。
    if (e.pay_status === "unpaid" || e.payStatus === "unpaid") {
        throw (0, errors_1.conflict)("该入渔尚未完成支付，请先支付后再核销");
    }
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
        const r = await (0, fund_1.walletChangeOfUser)(e.userId, {
            amount,
            bizType: "yangyu:reward",
            remark: `${remark} 转介绍30% 入渔 ${enrollmentId} 奖励 ${rewardId}`,
        });
        if (r.ok) {
            logger_1.logger.info({ aiUid: r.aiUid, amount, flowNo: r.flowNo }, "转介绍30%余额动账成功");
        }
        else {
            (0, fund_1.logFundFailure)("reward.intro_bonus", { refType: "enrollment", refId: enrollmentId, userId: e.userId }, r);
        }
    }
    catch (err) {
        logger_1.logger.error({ enrollmentId, err: err?.message }, "INTRO_CREDIT_ERROR");
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
        const aiUid = await (0, fund_1.resolveAiUid)(buyerUserId);
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
        const aiUid = await (0, fund_1.resolveAiUid)(userId);
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
    // 核销发奖的资金面：奖励记录已在事务里以 issued 落库，这里失败不能回滚那条记录
    // （核销已完成，退回等于允许用户白拿），只能留结构化失败日志供对账补偿。
    // 但「失败」必须带上 code 与 aiUid —— 旧实现只 console.error 一句话，
    // 对账时分不清是配置缺失、未联邦，还是上游拒单。
    const r = await (0, fund_1.walletChangeOfUser)(userId, {
        amount,
        bizType: "yangyu:reward",
        remark: `养鱼免单奖励(余额) 入渔 ${enrollmentId} 奖励 ${rewardId}`,
    });
    if (r.ok) {
        logger_1.logger.info({ aiUid: r.aiUid, amount, flowNo: r.flowNo }, "核销奖励余额动账成功");
    }
    else {
        (0, fund_1.logFundFailure)("reward.checkin_credit", { refType: "reward", refId: rewardId, userId }, r);
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
/**
 * 20261018 P1-2: 批量周评估(原 evaluateWeekly 唯一入口是 OPERATOR 手动单条端点, 惩罚阶梯形同虚设)。
 * 达标真源与核销发奖同源(8100 feed-days >= 阈值), 保证"发奖"与"惩罚"口径一致。
 * 幂等: weekly_eval_log 唯一键 (enrollment_id, week) 保证同一入渔同一周只评估一次。
 * 保守: 养鱼数据不可用时跳过(不评估、不记日志), 避免误罚 —— 下次调度可重试。
 */
async function evaluateAllWeekly() {
    const week = currentWeek();
    const list = await (0, db_1.query)(`SELECT id, user_id FROM enrollment WHERE status IN ('normal','pause1','pause3')`);
    let evaluated = 0, met = 0, missed = 0, skipped = 0;
    for (const r of list.rows) {
        const feed = await fetchFeedDays(r.user_id);
        if (!feed.ok) {
            skipped++;
            continue;
        } // 数据不可用: 不评估不惩罚, 下次重试
        const isMet = feed.days >= feed.threshold;
        try {
            await (0, db_1.query)(`INSERT INTO weekly_eval_log (id, enrollment_id, week, met, days, threshold)
         VALUES (?,?,?,?,?,?)`, [(0, db_1.newId)(), r.id, week, isMet, feed.days, feed.threshold]);
        }
        catch (err) {
            if (err?.errno === 1062 || err?.code === "ER_DUP_ENTRY") {
                skipped++;
                continue;
            }
            throw err;
        }
        await evaluateWeek(r.id, isMet);
        evaluated++;
        if (isMet)
            met++;
        else
            missed++;
    }
    return { week, evaluated, met, missed, skipped };
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
/**
 * v2 周评估（套餐卡）：评估对象是「上一 ISO 周」。
 *
 * 为什么必须是上一周而不是本周：连续 5 天的合法起点只有周一/二/三，
 * 用户最典型的形态是「周三→周日」，第 5 天正好是周日。
 * 若在周日 23:50 评估，23:55 才做的投喂根本还没落库，
 * 最容易达标的人反而被判未达标 —— 这是旧调度最危险的地方。
 *
 * 判据（与核销口径一致，不重复拉数据）：
 *   period.checkin_id IS NULL              → 未完成，met=false（正常惩罚）
 *   checkin_id 非空 且 data_available=0     → 数据不可用，跳过（不惩罚，下次可重试）
 *   checkin_id 非空 且 data_available=1     → met = period.task_met
 */
async function evaluateAllWeeklyV2(now = new Date()) {
    const target = (0, iso_week_1.shiftWeek)((0, iso_week_1.isoWeekOf)(now), -1);
    const week = (0, iso_week_1.isoWeekKey)(target);
    const windowStart = (0, iso_week_1.ymd)(target.monday);
    const windowEnd = (0, iso_week_1.ymd)(target.sunday);
    const list = await (0, db_1.query)(`SELECT p.id AS period_id, p.enrollment_id, p.checkin_id, p.task_met, p.data_available
       FROM period p
       JOIN enrollment e ON e.id = p.enrollment_id
      WHERE p.iso_year = ? AND p.iso_week = ?
        AND e.status IN ('normal','pause1','pause3')`, [target.year, target.week]);
    let evaluated = 0;
    let met = 0;
    let missed = 0;
    let skipped = 0;
    for (const r of list.rows) {
        const hasCheckin = !!r.checkin_id;
        const dataOk = Number(r.data_available) === 1;
        if (hasCheckin && !dataOk) {
            skipped += 1;
            continue;
        }
        const isMet = hasCheckin && Number(r.task_met) === 1;
        try {
            await (0, db_1.query)(`INSERT INTO weekly_eval_log
           (id, enrollment_id, week, met, days, threshold, window_start, window_end, met_method)
         VALUES (?,?,?,?,?,?,?,?,'streak5')`, [(0, db_1.newId)(), r.enrollment_id, week, isMet, isMet ? 5 : 0, 5, windowStart, windowEnd]);
        }
        catch (err) {
            if (err?.errno === 1062 || err?.code === "ER_DUP_ENTRY") {
                skipped += 1;
                continue;
            }
            throw err;
        }
        await evaluateWeek(r.enrollment_id, isMet);
        await (0, db_1.query)(`UPDATE period SET current_period = period_no WHERE id = ?`, [r.period_id]).catch(() => undefined);
        evaluated += 1;
        if (isMet)
            met += 1;
        else
            missed += 1;
    }
    return { week, evaluated, met, missed, skipped };
}
/**
 * 20261018 P1-1 修正: 旧算法以「年内第 N 个 7 天」编号, 与 ISO 周系统性偏移,
 * 且在跨年周/周内翻周处会把同一自然周割裂成两个 week 值
 * → idx_checkin_dedup(enrollment_id, week) 失效(同周可核销两次)。
 * 现改为标准 ISO-8601 周(周四归属法: 本周周四所在年份即 ISO 年, 周一为一周之始),
 * 格式保持 YYYYWnn 不变, 一周恒定 7 天、跨年不再割裂。
 */
function currentWeek() {
    // UTC+8 业务日
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const day = d.getUTCDay() || 7; // 周一=1 ... 周日=7
    d.setUTCDate(d.getUTCDate() + 4 - day); // 移到本周周四 → 决定 ISO 年
    const isoYear = d.getUTCFullYear();
    const yearStart = new Date(Date.UTC(isoYear, 0, 1));
    const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${isoYear}W${week}`;
}
//# sourceMappingURL=reward.service.js.map