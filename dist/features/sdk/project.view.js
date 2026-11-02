"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toProjectListView = toProjectListView;
exports.toProjectView = toProjectView;
exports.promiseOf = promiseOf;
const refund_config_service_1 = require("../reward/refund-config.service");
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
        streakDays: (0, refund_config_service_1.refundConfigSync)().streakDays,
        soldCount,
        listedAt: card.listedAt,
        refundClaim: `每期连续 ${(0, refund_config_service_1.refundConfigSync)().streakDays} 天任务 + 到店核销，可全额返还至消费金`,
    };
}
function toProjectView(card, soldCount = 0) {
    const unitPrice = card.unitPrice ?? 0;
    const periods = card.periods ?? 0;
    // 比例逐卡取：每张卡由运营在设计时决定"分多少"，不再统一 30%
    const shareRatio = Number(card.shareRatio ?? (0, refund_config_service_1.refundConfigSync)().refundShareRatio);
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
        streakDays: (0, refund_config_service_1.refundConfigSync)().streakDays,
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