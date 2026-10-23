"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refund70 = refund70;
exports.refund30 = refund30;
exports.listStuckRefunds = listStuckRefunds;
exports.unlockByBind = unlockByBind;
exports.unlockShareAndBackfill = unlockShareAndBackfill;
const config_1 = require("../../config");
const errors_1 = require("../../lib/errors");
const db_1 = require("../../lib/db");
const fund_1 = require("../../lib/fund");
const period_service_1 = require("../period/period.service");
const period_repo_1 = require("../period/period.repo");
function idemKey(kind, periodId) {
    return `${kind}:${periodId}`;
}
/**
 * 期次退费（70% 即时 / 30% 分享成交）。
 *
 * 幂等三重保险：
 *   1) refund_flow.idem_key 唯一索引 —— 并发下只有一个能 INSERT 成功
 *   2) period.refund70_amount > 0 的短路判断（快路径）
 *   3) 钱包侧的 biz_type + biz_id 对账
 *
 * 顺序刻意是「先落 pending 流水，再调钱包」：
 * 反过来会产生"钱已出账但流水没落"的孤儿账，事后只能靠人工对账。
 * 代价是进程崩溃会留下 pending，需由对账任务扫描（见 §对账）。
 */
async function doRefund(periodId, kind) {
    // 比例从**期次快照**取，不再取全局配置：
    //   每张卡的分成比例不同（「每个商品和服务决定分多少」），且已售期次金额是合同金额，
    //   运营事后调配置不能改变用户已购卡片的返额。
    //   旧数据没有快照列时回落到全局缺省（迁移 006 已回填，这里只是兜底）。
    const globalNow = config_1.config.package.refundRatioNow;
    const globalShare = config_1.config.package.refundRatioShare;
    // ---------- 阶段一：校验 + 占位（短事务，绝不把 HTTP 放进事务里） ----------
    const plan = await (0, db_1.withTx)(async (client) => {
        const p = await (0, period_repo_1.lockById)(client, periodId);
        if (!p)
            throw (0, errors_1.notFound)("期次不存在");
        const already = kind === "refund70" ? p.refund70Amount > 0 : p.refund30Amount > 0;
        if (already) {
            return { skip: true, amount: kind === "refund70" ? p.refund70Amount : p.refund30Amount,
                flowNo: (kind === "refund70" ? p.refund70Flow : p.refund30Flow) || undefined,
                userId: p.userId, payStatus: "", key: idemKey(kind, periodId) };
        }
        if (p.expired)
            throw (0, errors_1.badRequest)("该期次已作废，不可退费");
        if (!p.taskMet)
            throw (0, errors_1.badRequest)("该期未达标，不可退费");
        // 未实付不得退费：历史上曾对 pay_status=none 的入渔发放导致凭空造钱，
        // 只能靠人工反向流水对冲（见 P0-1）。此处 fail-closed。
        const en = await client.query(`SELECT pay_status FROM enrollment WHERE id = ? FOR UPDATE`, [p.enrollmentId]);
        const payStatus = String((en[0][0]?.pay_status) ?? "none");
        if (payStatus !== "paid") {
            throw (0, errors_1.badRequest)("该入渔无实付记录，不可退费");
        }
        const amount = (0, period_service_1.round2)(p.unitPrice *
            (kind === "refund70"
                ? (p.refundNowRatio ?? globalNow)
                : (p.shareRatio ?? globalShare)));
        if (!(amount > 0))
            throw (0, errors_1.badRequest)("退费金额为 0，检查单价与比例配置");
        const key = idemKey(kind, periodId);
        try {
            await client.query(`INSERT INTO refund_flow
           (id, enrollment_id, period_id, user_id, kind, amount, channel, state, idem_key)
         VALUES (?,?,?,?,?,?,'balance','pending',?)`, [(0, db_1.newId)(), p.enrollmentId, p.id, p.userId, kind, amount, key]);
        }
        catch (err) {
            // 已存在（并发或上次失败）：读取现状态决定是否继续重试
            if (err?.code === "ER_DUP_ENTRY" || err?.errno === 1062) {
                const cur = await client.query(`SELECT state FROM refund_flow WHERE idem_key = ?`, [key]);
                const st = String((cur[0][0]?.state) ?? "");
                if (st === "done") {
                    return { skip: true, amount, flowNo: undefined, userId: p.userId,
                        payStatus, key };
                }
                await client.query(`UPDATE refund_flow SET state='pending', err_msg=NULL WHERE idem_key = ?`, [key]);
                return { skip: false, amount, flowNo: undefined, userId: p.userId, payStatus, key };
            }
            throw err;
        }
        return { skip: false, amount, flowNo: undefined, userId: p.userId, payStatus, key };
    });
    if (plan.skip) {
        return {
            periodId,
            kind,
            amount: plan.amount,
            alreadyDone: true,
            flowNo: plan.flowNo,
        };
    }
    // ---------- 阶段二：钱包动账（不可逆动作） ----------
    const aiUid = await (0, fund_1.resolveAiUid)(plan.userId);
    if (!aiUid) {
        await (0, db_1.query)(`UPDATE refund_flow SET state='failed', err_msg=? WHERE idem_key=?`, [
            "缺少 ai_uid",
            plan.key,
        ]);
        return { periodId, kind, amount: plan.amount, alreadyDone: false, err: "缺少 ai_uid 联邦锚点" };
    }
    const label = kind === "refund70" ? "核销即时返还" : "分享返尾款";
    const r = await (0, fund_1.walletChange)({
        aiUid,
        amount: plan.amount,
        bizType: `yangyu:${kind}`,
        remark: `养鱼免单 ${label} 期次 ${periodId}`,
        bizId: 0,
    });
    if (!r.ok) {
        await (0, db_1.query)(`UPDATE refund_flow SET state='failed', err_msg=? WHERE idem_key=?`, [
            (r.err ?? "wallet error").slice(0, 255),
            plan.key,
        ]);
        return { periodId, kind, amount: plan.amount, alreadyDone: false, err: r.err };
    }
    // ---------- 阶段三：回写（流水 + 期次） ----------
    const flowNo = r.flowNo ?? "";
    await (0, db_1.withTx)(async (client) => {
        await client.query(`UPDATE refund_flow SET state='done', wallet_flow_no=?, err_msg=NULL WHERE idem_key=?`, [flowNo, plan.key]);
        if (kind === "refund70")
            await (0, period_repo_1.setRefund70)(client, periodId, plan.amount, flowNo);
        else
            await (0, period_repo_1.setRefund30)(client, periodId, plan.amount, flowNo);
    });
    // 下一期还有 30% 可领 → 回写入渔进度（不阻断主流程）
    try {
        const p = await (0, db_1.query)(`SELECT enrollment_id FROM period WHERE id = ?`, [periodId]);
        const eid = p.rows[0]?.enrollment_id;
        if (eid) {
            await (0, db_1.query)(`UPDATE enrollment e
            SET reward_paid = (
              SELECT COALESCE(SUM(refund70_amount + refund30_amount),0)
                FROM period WHERE enrollment_id = e.id
            )
          WHERE e.id = ?`, [eid]);
        }
    }
    catch {
        // 进度回写失败不影响资金正确性，C 端进度可下次读取时重算
    }
    return { periodId, kind, amount: plan.amount, alreadyDone: false, flowNo };
}
async function refund70(periodId) {
    return doRefund(periodId, "refund70");
}
async function refund30(periodId) {
    return doRefund(periodId, "refund30");
}
/** 对账：扫描长期 pending 的退费流水（进程崩溃残留），返回待人工处理的单据 */
async function listStuckRefunds(minutes = 30) {
    const res = await (0, db_1.query)(`SELECT * FROM refund_flow
      WHERE state = 'pending' AND created_at < (NOW() - INTERVAL ? MINUTE)
      ORDER BY created_at ASC LIMIT 200`, [minutes]);
    return res.rows;
}
/**
 * 分享绑定 → 解锁分享者名下**全部**未解锁套餐卡的尾款。
 *
 * 2026-10-21 PO 口径（覆盖 10-21 早先的「只解锁被成交那张卡」）：
 *   「所有卡的 X%，不管有没有交易，只要有分享都要绑定关系」
 *   ① 范围 = 分享者名下所有套餐卡（不是被成交的那张）
 *   ② 触发 = 绑定动作本身（不是被分享者购卡）
 *   ③ 比例 = 逐卡取值（card.share_ratio 快照到 period），不是统一的 30%
 *
 * 为什么不要求被分享者成交：PO 的模型是「分享即建立关系，关系日后自然产生价值」。
 * 风险由风控承担而不是由流程承担 —— 所以这里保留两个开关：
 *   SHARE_UNLOCK_ON_BIND=false 退回「必须成交」
 *   SHARE_BIND_POLICY=last/first 控制归因口径
 *
 * 幂等：enrollment.share_unlocked 为主判据（已解锁不再补），
 *       refund30 自身 idem_key 兜住并发与重放。
 */
async function unlockByBind(userId, viewerUserId, bindId, opts) {
    const scopeAll = config_1.config.package.shareUnlockScope === "all";
    // 只看「套餐卡」：存量 v1 卡没有期次，其尾款走旧 reward.triggerIntroBonus，
    // 若在这里一并置 share_unlocked，等于给了它一个永远发不出的承诺。
    const where = ["e.user_id = ?", "c.periods IS NOT NULL"];
    const args = [userId];
    if (!scopeAll && opts?.cardId) {
        where.push("e.card_id = ?");
        args.push(opts.cardId);
    }
    const en = await (0, db_1.query)(`SELECT e.id, e.share_unlocked, c.share_ratio
       FROM enrollment e
       JOIN card c ON c.id = e.card_id
      WHERE ${where.join(" AND ")}
      ORDER BY e.enroll_at DESC`, args);
    if (en.rows.length === 0) {
        return { unlocked: false, alreadyUnlocked: false, backfilled: 0, failed: 0, amount: 0, unlockedEnrollmentIds: [] };
    }
    let alreadyUnlocked = false;
    const unlockedIds = [];
    for (const row of en.rows) {
        if (Number(row.share_unlocked) === 1) {
            alreadyUnlocked = true;
            continue;
        }
        unlockedIds.push(String(row.id));
        await (0, db_1.query)(`UPDATE enrollment
          SET share_unlocked = 1,
              share_unlocked_at = COALESCE(share_unlocked_at, CURRENT_TIMESTAMP(3)),
              share_ref_user = COALESCE(share_ref_user, ?),
              share_unlocked_by = COALESCE(share_unlocked_by, ?)
        WHERE id = ?`, [viewerUserId, bindId, row.id]);
    }
    // 补齐：已核销 + 达标 + 已退即时部分 + 未退尾款的期次（范围与上面的解锁范围一致）
    const pendWhere = [
        "e.user_id = ?",
        "c.periods IS NOT NULL",
        "p.expired = 0",
        "p.refund70_amount > 0",
        "p.refund30_amount = 0",
    ];
    const pendArgs = [userId];
    if (!scopeAll && opts?.cardId) {
        pendWhere.push("e.card_id = ?");
        pendArgs.push(opts.cardId);
    }
    const pend = await (0, db_1.query)(`SELECT p.id FROM period p
       JOIN enrollment e ON e.id = p.enrollment_id
       JOIN card c ON c.id = e.card_id
      WHERE ${pendWhere.join(" AND ")}
      ORDER BY p.period_no ASC`, pendArgs);
    let backfilled = 0;
    let failed = 0;
    let amount = 0;
    for (const r of pend.rows) {
        const res = await refund30(String(r.id));
        if (res.alreadyDone || res.flowNo) {
            backfilled += 1;
            if (!res.alreadyDone)
                amount = (0, period_service_1.round2)(amount + Number(res.amount || 0));
        }
        else
            failed += 1;
    }
    return { unlocked: true, alreadyUnlocked, backfilled, failed, amount, unlockedEnrollmentIds: unlockedIds };
}
/**
 * 兼容入口：旧调用方（主站推荐关系兜底）仍按「指定卡/指定入渔」解锁。
 */
async function unlockShareAndBackfill(userId, refUserId, opts) {
    if (opts?.enrollmentId) {
        const r = await (0, db_1.query)(`SELECT card_id FROM enrollment WHERE id = ?`, [opts.enrollmentId]);
        const cardId = r.rows[0]?.card_id ?? null;
        return unlockByBind(userId, refUserId, null, { cardId: cardId ?? undefined });
    }
    return unlockByBind(userId, refUserId, null, { cardId: opts?.cardId ?? undefined });
}
/**
 * 说明：关系链相关的判定已上移到 `features/share/share.service.ts`。
 *   refund.service 只负责「钱怎么出、怎么幂等」，不再自己查主站关系链——
 *   否则资金层与关系层互相依赖，改关系链口径要动资金代码（历史上真出过这种耦合）。
 */
//# sourceMappingURL=refund.service.js.map