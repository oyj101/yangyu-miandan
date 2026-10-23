"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveAiUid = resolveAiUid;
exports.walletChange = walletChange;
exports.walletChangeOfUser = walletChangeOfUser;
exports.logWalletFailure = logWalletFailure;
const config_1 = require("../config");
const db_1 = require("./db");
const logger_1 = require("./logger");
function fail(code, err, extra) {
    return { ok: false, code, err, ...extra };
}
/**
 * 养鱼域 user_id(au_1) → 主站 ai_uid。
 *
 * 唯一实现：`merchant_user.ai_uid` 上已有唯一索引，是联邦身份的单一映射表。
 * 调用方禁止再自行 `SELECT ai_uid FROM merchant_user`（曾有 8 处各自实现，
 * 其中 task.service 还重复定义了一个同名私有函数）。
 *
 * 返回 null 表示「该用户从未联邦」——这是业务事实，不是错误；
 * 但任何要靠它动账的路径都必须 fail-closed，不得降级为"记个日志继续"。
 */
async function resolveAiUid(userId) {
    const res = await (0, db_1.query)("SELECT ai_uid FROM merchant_user WHERE user_id = ? LIMIT 1", [userId]);
    const v = res.rows[0]?.ai_uid;
    return v == null || v === "" ? null : String(v);
}
/** 已持有 ai_uid 时的动账入口（如退款流程里已解析过一次，避免重复查库） */
async function walletChange(input) {
    const key = config_1.config.wallet.serviceKey;
    if (!key)
        return fail("NO_SERVICE_KEY", "WALLET_SERVICE_KEY 未配置");
    if (!input.aiUid)
        return fail("NO_AI_UID", "缺少 ai_uid 联邦锚点");
    if (!Number.isFinite(input.amount) || input.amount === 0) {
        return fail("BAD_AMOUNT", `金额非法: ${input.amount}`);
    }
    try {
        const resp = await fetch(`${config_1.config.wallet.base}/wallet/change`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Service-Key": key },
            body: JSON.stringify({
                uid: Number(input.aiUid),
                asset: "balance",
                amount: input.amount,
                biz_type: input.bizType,
                ledger: "zy",
                remark: input.remark,
                biz_id: input.bizId ?? 0,
            }),
        });
        const j = await resp.json().catch(() => null);
        if (j && (j.code === 0 || j.code === "0") && j.data && j.data.ok) {
            return { ok: true, flowNo: String(j.data.flow_no ?? ""), aiUid: input.aiUid, raw: j };
        }
        return fail("UPSTREAM_REJECT", j?.message || `HTTP ${resp.status}`, {
            aiUid: input.aiUid,
            raw: j ?? { status: resp.status },
        });
    }
    catch (err) {
        return fail("NETWORK", err?.message ?? "network", { aiUid: input.aiUid });
    }
}
/**
 * 动账 + 身份解析（业务模块的唯一调用形态）。
 *
 * 用这个而不是自己去查 ai_uid 再调 walletChange —— 省一次样板代码，
 * 更重要的是保证「查不到 ai_uid」也返回带 code 的结构化失败，
 * 避免各调用点各自决定是 throw 还是静默跳过。
 */
async function walletChangeOfUser(userId, input) {
    let aiUid;
    try {
        aiUid = await resolveAiUid(userId);
    }
    catch (err) {
        return fail("NETWORK", `解析 ai_uid 失败: ${err?.message ?? err}`);
    }
    if (!aiUid)
        return fail("NO_AI_UID", `用户 ${userId} 未联邦，钱无处可落`, { raw: { userId } });
    const r = await walletChange({ ...input, aiUid });
    return { ...r, aiUid };
}
/**
 * 失败的统一记账口径：业务模块不要自己拼日志字段。
 * `refType/refId` 传业务单据（enrollment / period / reward），对账时按它聚合。
 */
function logWalletFailure(tag, ctx, r) {
    logger_1.logger.error({
        tag,
        code: r.code,
        err: r.err,
        aiUid: r.aiUid,
        ...ctx,
    }, `钱包动账失败 ${tag}`);
}
//# sourceMappingURL=wallet.js.map