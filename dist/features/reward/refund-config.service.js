"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refundPutSchema = void 0;
exports.getRefundConfig = getRefundConfig;
exports.saveRefundConfig = saveRefundConfig;
exports.refundConfigSync = refundConfigSync;
exports.initRefundConfigCache = initRefundConfigCache;
const zod_1 = require("zod");
const db_1 = require("../../lib/db");
const logger_1 = require("../../lib/logger");
const config_1 = require("../../config");
exports.refundPutSchema = zod_1.z
    .object({
    caliber: zod_1.z.enum(["unit", "total"]),
    refundNowRatio: zod_1.z.number().min(0).max(1),
    refundShareRatio: zod_1.z.number().min(0).max(1),
    streakDays: zod_1.z.number().int().min(1).max(7),
})
    .refine((d) => d.refundNowRatio + d.refundShareRatio <= 1, {
    message: "两路比例之和不得超过 1",
})
    .refine((d) => Math.abs(d.refundNowRatio + d.refundShareRatio - 1) < 1e-9, {
    message: "引擎语义为补数关系：refundNowRatio 必须等于 1 − refundShareRatio（如 0.7/0.3）",
});
function envDefaults() {
    return {
        caliber: "unit",
        refundNowRatio: config_1.config.package.refundRatioNow,
        refundShareRatio: config_1.config.package.refundRatioShare,
        streakDays: config_1.config.package.streakDays,
        updatedBy: null,
        updatedAt: null,
    };
}
function rowToConfig(r) {
    return {
        caliber: r.caliber === "total" ? "total" : "unit",
        refundNowRatio: Number(r.refund_now_ratio),
        refundShareRatio: Number(r.refund_share_ratio),
        streakDays: Number(r.streak_days),
        updatedBy: r.updated_by ?? null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}
async function readFromDb() {
    const res = await (0, db_1.query)(`SELECT caliber, refund_now_ratio, refund_share_ratio, streak_days, updated_by, updated_at
       FROM yangyu_refund_config WHERE id = 1`);
    if (!res.rows.length)
        return envDefaults();
    return rowToConfig(res.rows[0]);
}
const TTL_MS = 60_000;
let cache = null;
async function getRefundConfig() {
    cache = { value: await readFromDb(), at: Date.now() };
    return cache.value;
}
async function saveRefundConfig(input, updatedBy) {
    await (0, db_1.query)(`UPDATE yangyu_refund_config
        SET caliber = ?, refund_now_ratio = ?, refund_share_ratio = ?,
            streak_days = ?, updated_by = ?
      WHERE id = 1`, [input.caliber, input.refundNowRatio, input.refundShareRatio, input.streakDays, updatedBy]);
    // 写后即刷缓存（幂等：同值重复写无副作用，updated_at 由 DB ON UPDATE 维护）
    return getRefundConfig();
}
/** 同步读取器：TTL 内用缓存；过期 fire-and-forget 刷新（本次容忍旧值）；未预热回退 env 缺省 */
function refundConfigSync() {
    if (!cache)
        return envDefaults();
    if (Date.now() - cache.at > TTL_MS) {
        void getRefundConfig().catch((e) => logger_1.logger.warn({ err: e }, "退款配置缓存刷新失败，沿用旧值"));
    }
    return cache.value;
}
/** 启动预热：失败仅告警不阻断启动（env 缺省兜底） */
async function initRefundConfigCache() {
    try {
        await getRefundConfig();
        logger_1.logger.info("退款公式配置缓存已预热");
    }
    catch (e) {
        logger_1.logger.warn({ err: e }, "退款公式配置预热失败，暂用 env 缺省");
    }
}
//# sourceMappingURL=refund-config.service.js.map