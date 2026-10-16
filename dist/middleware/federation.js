"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findByAiUid = findByAiUid;
exports.ensureFederated = ensureFederated;
exports.federate = federate;
const db_1 = require("../lib/db");
const logger_1 = require("../lib/logger");
// 主键用 lib/db 的 newId()（crypto.randomUUID）——勿引 uuid 包：本服务未安装该依赖
// 联邦校验结果短缓存（token -> { aiUid, user, exp }），减少 8100 往返；与 JWT 自身有效期解耦
const _fedCache = new Map();
const FED_TTL_MS = 120 * 1000;
const FED_CACHE_MAX = 2000; // 容量上限：只增不删会无界增长（LoveTable 同款教训）
/** 读主站统一身份令牌：cookie 优先（联邦闭环），其次本地 Bearer */
function aiToken(req) {
    const c = String(req.headers.cookie || "");
    const m = c.match(/(?:^|;\s*)token=([^;]+)/);
    if (m)
        return decodeURIComponent(m[1].trim());
    const h = req.headers.authorization || "";
    const b = h.match(/^Bearer\s+(.+)$/i);
    return b ? b[1].trim() : null;
}
/** 按 ai_uid 查本地档案 */
async function findByAiUid(aiUid) {
    const [rows] = await db_1.pool.query("SELECT id, user_id, merchant_id, role FROM merchant_user WHERE ai_uid = ? LIMIT 1", [aiUid]);
    return rows[0] || null;
}
/**
 * 联邦用户落地：按 ai_uid 复用，否则新建（默认 role=USER）。
 * 商户/收银员角色须经商户端授权流程提升，不在此处臆断。
 */
async function ensureFederated(aiUid, info) {
    const exist = await findByAiUid(aiUid);
    if (exist)
        return exist;
    const localId = "au_" + aiUid;
    await db_1.pool.query("INSERT INTO merchant_user (id, user_id, ai_uid, merchant_id, role) VALUES (?, ?, ?, ?, ?)", [(0, db_1.newId)(), localId, String(aiUid), info?.merchantId || "", "USER"]);
    logger_1.logger.info({ aiUid, localId }, "federated_profile_created");
    return { id: localId, user_id: localId, ai_uid: String(aiUid), merchant_id: "", role: "USER" };
}
async function federate(req, _res, next) {
    try {
        const jwt = aiToken(req);
        // 本地演示令牌不走联邦（tk_* 形态仅历史遗留，生产已禁签发）
        if (!jwt || jwt.startsWith("tk_"))
            return next();
        const now = Date.now();
        const hit = _fedCache.get(jwt);
        if (hit && hit.exp > now) {
            req.fedUser = hit.user;
            return next();
        }
        const base = process.env.FED_BASE || "http://127.0.0.1:8100/api/v2";
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);
        let j = {};
        try {
            const r = await fetch(base + "/auth/me", {
                method: "GET",
                headers: { authorization: "Bearer " + jwt },
                signal: ctrl.signal,
            });
            if (!r.ok)
                return next();
            j = await r.json().catch(() => ({}));
        }
        finally {
            clearTimeout(timer);
        }
        const d = j && j.data;
        if (!d || !d.id)
            return next();
        const aiUid = String(d.id);
        const local = await ensureFederated(aiUid, { merchantId: d.merchantId || "" });
        const fedUser = {
            userId: local.user_id,
            role: local.role,
            merchantId: local.merchant_id || "",
            aiUid,
        };
        if (_fedCache.size >= FED_CACHE_MAX) {
            const nowMs = Date.now();
            for (const [k, v] of _fedCache) {
                if (v.exp <= nowMs)
                    _fedCache.delete(k);
            }
            if (_fedCache.size >= FED_CACHE_MAX) {
                let drop = 0;
                for (const k of _fedCache.keys()) {
                    _fedCache.delete(k);
                    if (++drop >= FED_CACHE_MAX / 2)
                        break;
                }
            }
        }
        _fedCache.set(jwt, { aiUid, user: fedUser, exp: now + FED_TTL_MS });
        req.fedUser = fedUser;
        return next();
    }
    catch (e) {
        // 联邦链路异常绝不阻塞主流程（降级到本地 JWT 演示路径）
        logger_1.logger.warn({ err: String(e?.message || e) }, "federate_failed_silent");
        return next();
    }
}
//# sourceMappingURL=federation.js.map