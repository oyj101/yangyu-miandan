export interface Period {
  id: string;
  enrollmentId: string;
  cardId: string;
  userId: string;
  merchantId: string;
  periodNo: number;
  isoYear: number;
  isoWeek: number;
  weekStart: string; // 'YYYY-MM-DD'
  weekEnd: string;
  unitPrice: number;
  supplyPrice: number;
  /** 生成期次时从卡快照的分享比例（已售期次金额不随卡变更） */
  shareRatio: number;
  /** 核销即时退比例 = 1 - shareRatio */
  refundNowRatio: number;
  checkinId: string | null;
  taskMet: boolean;
  metDays: number;
  windowStart: string | null;
  refund70Amount: number;
  refund70Flow: string | null;
  refund70At: Date | null;
  refund30Amount: number;
  refund30Flow: string | null;
  refund30At: Date | null;
  merchantSettled: boolean;
  merchantAmount: number;
  expired: boolean;
  extendedFrom: string | null;
  noticeFlags: number;
  createdAt: Date;
  updatedAt: Date;
}

/** 通知位图：同一期次同一类提醒只推一次（与 notify_message.biz_key 双重防重） */
export const NOTICE = {
  START: 1 << 0, // 本期开始
  STREAK_LATE: 1 << 1, // 周三：最后开始机会
  STREAK_DEAD: 1 << 2, // 周四：本期已无法达标（诚实告知，避免白做）
  CHECKIN_T48: 1 << 3, // 还剩 48 小时核销
  CHECKIN_LAST: 1 << 4, // 今天最后一天
  EXPIRED: 1 << 5, // 已作废
  PAUSED: 1 << 6, // 进入停奖
  REFUND_70: 1 << 7,
  REFUND_30: 1 << 8,
} as const;
