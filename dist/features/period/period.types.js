"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOTICE = void 0;
/** 通知位图：同一期次同一类提醒只推一次（与 notify_message.biz_key 双重防重） */
exports.NOTICE = {
    START: 1 << 0, // 本期开始
    STREAK_LATE: 1 << 1, // 周三：最后开始机会
    STREAK_DEAD: 1 << 2, // 周四：本期已无法达标（诚实告知，避免白做）
    CHECKIN_T48: 1 << 3, // 还剩 48 小时核销
    CHECKIN_LAST: 1 << 4, // 今天最后一天
    EXPIRED: 1 << 5, // 已作废
    PAUSED: 1 << 6, // 进入停奖
    REFUND_70: 1 << 7,
    REFUND_30: 1 << 8,
};
//# sourceMappingURL=period.types.js.map