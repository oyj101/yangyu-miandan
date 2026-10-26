"use strict";
/**
 * 配送任务（配送分支，009）
 *
 * 一条 delivery_task = 某一期的一次配送。与 period 一一对应（DB 唯一键保证），
 * 状态机只允许单向推进：pending → shipped → delivered → signed。
 *
 * 为什么单独建表而不复用 checkin：
 *   checkin 是「到店核销」的凭证，语义是"用户到店、商户确认服务发生"；
 *   配送是"商户发货、用户签收"。两者的操作者、时间线、所需字段都不同，
 *   混在一张表里会让两边都塞满对方用不上的 NULL 列。
 *   签收后再写一条 checkin（source=delivery），让发奖链路保持唯一。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DELIVERY_STATUS_TEXT = exports.DELIVERY_NEXT = void 0;
exports.canTransition = canTransition;
exports.isTerminal = isTerminal;
/** 允许的状态迁移。服务层是唯一判据，DB 只做枚举约束 */
exports.DELIVERY_NEXT = {
    pending: ["shipped", "cancelled"],
    shipped: ["delivered", "cancelled"],
    delivered: ["signed"],
    signed: [],
    cancelled: [],
};
function canTransition(from, to) {
    return (exports.DELIVERY_NEXT[from] ?? []).includes(to);
}
function isTerminal(s) {
    return s === "signed" || s === "cancelled";
}
/** 状态中文名（通知与后台列表共用，避免各写一套） */
exports.DELIVERY_STATUS_TEXT = {
    pending: "待配送",
    shipped: "配送中",
    delivered: "已送达待签收",
    signed: "已签收",
    cancelled: "已取消",
};
//# sourceMappingURL=delivery.types.js.map