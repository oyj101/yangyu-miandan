"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toProjectListView = toProjectListView;
exports.toProjectView = toProjectView;
exports.promiseOf = promiseOf;
/**
 * C 端投影（Project View）
 *
 * 铁律：这里用「白名单逐字段列举」，禁止 `{...card}` 展开。
 *   - supply_price 是商户成本，泄露 = 商户被比价 / 平台毛利公开；
 *   - coverage_cap、per_merchant_quota 是风控参数，C 端不需要；
 *   - 展开写法在某次加字段后会静默把新字段漏出去，白名单加字段必须动代码，可 review。
 *
 * 该投影同时是内联 SDK 的渲染契约：字段改名 = 破坏线上宿主页面，
 * 故新增字段只能追加，不能重命名（见 sdk/README.md 契约稳定性）。
 */
const config_1 = require("../../config");
function toProjectListView(card, soldCount = 0) {
    const unitPrice = card.unitPrice ?? 0;
    const periods = card.periods ?? 0;
    return {
        id: card.id,
        title: card.title || card.id.slice(0, 8),
        subtitle: card.subtitle,
        merchantName: card.merchantName,
        category: card.category,
        coverUrl: card.coverUrl,
        periods,
        totalPrice: Math.round(unitPrice * periods * 100) / 100,
        freq: card.freq,
        streakDays: config_1.config.package.streakDays,
        soldCount,
        listedAt: card.listedAt,
        refundClaim: `每期连续 ${config_1.config.package.streakDays} 天任务 + 到店核销，可全额返还至消费金`,
    };
}
function toProjectView(card, soldCount = 0) {
    const unitPrice = card.unitPrice ?? 0;
    const periods = card.periods ?? 0;
    // 比例逐卡取：每张卡由运营在设计时决定"分多少"，不再统一 30%
    const shareRatio = Number(card.shareRatio ?? config_1.config.package.shareRatioDefault);
    return {
        id: card.id,
        // title 为空的存量卡（004 之前设计）用 id 兜底，避免宿主页面出现空标题
        title: card.title || card.id.slice(0, 8),
        subtitle: card.subtitle,
        merchantName: card.merchantName,
        category: card.category,
        coverUrl: card.coverUrl,
        unitPrice,
        periods,
        totalPrice: Math.round(unitPrice * periods * 100) / 100,
        freq: card.freq,
        refundNowRatio: Math.round((1 - shareRatio) * 1000) / 1000,
        refundShareRatio: shareRatio,
        streakDays: config_1.config.package.streakDays,
        soldCount,
        listedAt: card.listedAt,
    };
}
/**
 * 购买前的「承诺摘要」：内联 SDK 在确认弹层里必须原样展示这段，
 * 而不是由各宿主页面自己拼文案（各站文案漂移 = 客诉口径不一致 = 合规风险）。
 */
function promiseOf(v) {
    const refundNow = Math.round(v.unitPrice * v.refundNowRatio * 100) / 100;
    const refundShare = Math.round(v.unitPrice * v.refundShareRatio * 100) / 100;
    return {
        amount: v.totalPrice,
        refundNow,
        refundShare,
        refundTotal: Math.round((refundNow + refundShare) * 100) / 100,
        rule: `每期连续 ${v.streakDays} 天完成「孪生聊天 + 投喂」并到店核销，返还 ${Math.round(v.refundNowRatio * 100)}%；分享给好友（对方打开链接即绑定，无需下单）再返还 ${Math.round(v.refundShareRatio * 100)}%`,
        caveat: [
            "返还至平台消费金余额，不可提现",
            "一期一周，当期未核销即作废，不累计到下期",
            `连续 ${v.streakDays} 天的最晚开始日为当周周三`,
        ],
    };
}
//# sourceMappingURL=project.view.js.map