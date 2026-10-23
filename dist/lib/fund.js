"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FUND_TIMEOUT = void 0;
exports.resolveAiUid = resolveAiUid;
exports.payCreate = payCreate;
exports.payStatus = payStatus;
exports.walletChange = walletChange;
exports.walletChangeOfUser = walletChangeOfUser;
exports.logFundFailure = logFundFailure;
const config_1 = require("../config");
const db_1 = require("./db");
const logger_1 = require("./logger");
/** 失败透传：只带失败字段，不把内部调用方的 data 结构泄漏给外层签名 */
function failFrom(r) {
    return { ok: false, code: r.code, err: r.err, raw: r.raw };
}
/** 分级超时：让「用户在等」和「后台对账」用不同的耐心值 */
exports.FUND_TIMEOUT = {
    /** 下单：用户在等，失败可重试，给足时间 */
    payCreate: 8000,
    /** 查单：闸门场景，快速失败优于长时间挂住核销请求 */
    payStatus: 3000,
    /** 动账：不可逆，宁可多等，也不能断在半路 */
    walletChange: 5000,
};
/**
 * 8100 服务间调用的唯一实现。
 *
 * 三件事只在这里做一次：鉴权头、超时中止、信封解析与错误分类。
 * 任何业务模块都不得再自己 fetch 8100 资金端点 —— 否则超时值和错误语义会分叉。
 */
async function call8100(path, opts) {
    const key = config_1.config.wallet.serviceKey;
    if (!key)
        return { ok: false, code: "NO_SERVICE_KEY", err: "WALLET_SERVICE_KEY 未配置" };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
        const resp = await fetch(`${config_1.config.wallet.base}${path}`, {
            method: opts.method ?? "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Service-Key": key,
            },
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
            signal: ctrl.signal,
        });
        const j = (await resp.json().catch(() => null));
        if (!j) {
            // 非 JSON 响应（网关 HTML 错误页、502 等）绝不能被当成成功
            return { ok: false, code: "UPSTREAM_REJECT", err: `HTTP ${resp.status} 响应非 JSON`, raw: { status: resp.status } };
        }
        if (j.code !== 0 && j.code !== "0") {
            return { ok: false, code: "UPSTREAM_REJECT", err: j.message || `code=${j.code}`, raw: j };
        }
        return { ok: true, data: j.data, raw: j };
    }
    catch (err) {
        if (err?.name === "AbortError") {
            return { ok: false, code: "TIMEOUT", err: `8100 ${path} 超时 ${opts.timeoutMs}ms` };
        }
        return { ok: false, code: "NETWORK", err: err?.message ?? "network" };
    }
    finally {
        clearTimeout(timer);
    }
}
// ───────────────────────────── 身份：唯一解析入口 ─────────────────────────────
/**
 * 养鱼域 user_id(au_1) → 主站 ai_uid。
 *
 * `merchant_user.ai_uid` 是联邦身份的单一映射表（该列有唯一索引）。
 * 业务模块禁止再自行 `SELECT ai_uid FROM merchant_user`。
 *
 * 返回 null = 该用户从未联邦，这是业务事实而非错误；
 * 但任何要靠它动账的路径必须 fail-closed。
 */
async function resolveAiUid(userId) {
    const res = await (0, db_1.query)("SELECT ai_uid FROM merchant_user WHERE user_id = ? LIMIT 1", [userId]);
    const v = res.rows[0]?.ai_uid;
    return v == null || v === "" ? null : String(v);
}
/**
 * 下单。返回 orderNo 与前端调起支付所需的 payParams。
 *
 * 注意：下单成功 ≠ 已支付。支付态只能经 payStatus 确认，
 * 本函数不会（也不应该）把本地 pay_status 置为 paid。
 */
async function payCreate(input) {
    if (!input.aiUid)
        return { ok: false, code: "NO_AI_UID", err: "缺少 ai_uid 联邦锚点" };
    if (!Number.isInteger(input.amountFen) || input.amountFen <= 0) {
        return { ok: false, code: "BAD_AMOUNT", err: `金额必须为正整数分，收到 ${input.amountFen}` };
    }
    if (!input.bizRef) {
        // 没有幂等键的下单坚决不发出：一次网络重试就会产生第二张支付单
        return { ok: false, code: "BAD_INPUT", err: "缺少 bizRef 幂等键，拒绝下单" };
    }
    if (input.channel === "jsapi" && !input.openid) {
        // 本地先拦，省一次必失败的跨机调用（8100 侧也会拒）
        return { ok: false, code: "BAD_INPUT", err: "jsapi 缺少 openid" };
    }
    const r = await call8100("/yangyu/pay/create", {
        body: {
            uid: Number(input.aiUid),
            amount_fen: input.amountFen,
            channel: input.channel,
            openid: input.openid || "",
            biz_ref: input.bizRef,
            description: input.description,
        },
        timeoutMs: exports.FUND_TIMEOUT.payCreate,
    });
    if (!r.ok)
        return failFrom(r);
    const orderNo = r.data?.order_no;
    if (!orderNo) {
        return { ok: false, code: "UPSTREAM_REJECT", err: "8100 未返回 order_no", raw: r.raw };
    }
    return { ok: true, data: { orderNo: String(orderNo), payParams: r.data?.pay_params ?? null }, raw: r.raw };
}
/**
 * 查单 —— **支付态的唯一真源**。
 *
 * 为什么靠查单而不是回调：本服务没有支付回调端点，
 * 8100 的支付结果不会主动推给养鱼服务。所以任何"这单到底付没付"的判断
 * 都必须落到这里。
 */
async function payStatus(orderNo) {
    if (!orderNo)
        return { ok: false, code: "BAD_INPUT", err: "缺少 order_no" };
    const r = await call8100(`/yangyu/pay/status?order_no=${encodeURIComponent(orderNo)}`, { method: "GET", timeoutMs: exports.FUND_TIMEOUT.payStatus });
    if (!r.ok)
        return failFrom(r);
    const raw = String(r.data?.status ?? "").toLowerCase();
    // 只认白名单值。上游将来加新状态（如 partial_refund）时归 unknown，
    // 绝不能因为"不等于 unpaid"就当成已支付。
    const state = raw === "paid" ? "paid"
        : raw === "unpaid" ? "unpaid"
            : raw === "closed" ? "closed"
                : raw === "refunded" ? "refunded"
                    : "unknown";
    if (state === "unknown") {
        logger_1.logger.warn({ orderNo, raw }, "支付态未知，按未付处理");
    }
    return { ok: true, data: { state, raw }, raw: r.raw };
}
/**
 * 兑换豆 / 动账：asset=balance。
 *
 * 幂等由调用方提供（本项目用 refund_flow.idem_key 唯一索引兜底），
 * 本函数不重试、不吞错 —— 失败必须让调用方知道，才能落 failed 单据供对账。
 */
async function walletChange(input) {
    if (!input.aiUid)
        return { ok: false, code: "NO_AI_UID", err: "缺少 ai_uid 联邦锚点" };
    if (!Number.isFinite(input.amount) || input.amount === 0) {
        return { ok: false, code: "BAD_AMOUNT", err: `金额非法: ${input.amount}` };
    }
    const r = await call8100("/wallet/change", {
        body: {
            uid: Number(input.aiUid),
            asset: "balance",
            amount: input.amount,
            biz_type: input.bizType,
            ledger: "zy",
            remark: input.remark,
            biz_id: input.bizId ?? 0,
        },
        timeoutMs: exports.FUND_TIMEOUT.walletChange,
    });
    if (!r.ok)
        return failFrom(r);
    // 信封成功但业务失败（data.ok=false）必须单独判，别被 code=0 骗过去
    if (r.data?.ok !== true) {
        return { ok: false, code: "UPSTREAM_REJECT", err: "8100 data.ok=false", raw: r.raw };
    }
    const flowNo = String(r.data?.flow_no ?? "");
    return { ok: true, data: { flowNo }, flowNo, raw: r.raw };
}
/**
 * 动账 + 身份解析（业务层的标准调用形态）。
 *
 * 用这个而不是自己查 ai_uid 再调 walletChange：
 * 保证「查不到 ai_uid」也返回带 code 的结构化失败，而不是各调用点自行决定 throw 还是静默跳过。
 */
async function walletChangeOfUser(userId, input) {
    let aiUid;
    try {
        aiUid = await resolveAiUid(userId);
    }
    catch (err) {
        return { ok: false, code: "NETWORK", err: `解析 ai_uid 失败: ${err?.message ?? err}` };
    }
    if (!aiUid)
        return { ok: false, code: "NO_AI_UID", err: `用户 ${userId} 未联邦，钱无处可落` };
    const r = await walletChange({ ...input, aiUid });
    return { ...r, aiUid };
}
// ───────────────────────────── 统一失败记账 ─────────────────────────────
/**
 * 失败的统一日志口径：业务模块不要自己拼字段。
 * refType/refId 传业务单据（enrollment / period / reward），对账时按它聚合。
 */
function logFundFailure(tag, ctx, r) {
    logger_1.logger.error({ tag, code: r.code, err: r.err, ...ctx }, `资金调用失败 ${tag}`);
}
//# sourceMappingURL=fund.js.map