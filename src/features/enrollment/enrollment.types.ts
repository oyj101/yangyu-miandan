export interface Enrollment {
  id: string;
  userId: string;
  cardId: string;
  merchantId: string;
  // 20261018 对齐 engine.EnrollStatus: PO 20261017 惩罚阶梯为 pause1/pause3(exit@5)，
  // pause2/pause6 为历史遗留值（库中仍可能存在，读路径需兼容）
  status: "normal" | "pause1" | "pause3" | "pause2" | "pause6" | "exited" | "refunded";
  consecutiveMiss: number;
  totalMissCount: number;
  pauseRemaining: number;
  rewardPaid: number;
  rewardTotal: number;
  enrollAt: Date;
  reEnrolled: boolean;
  payOrderNo?: string | null;
  payStatus?: string;
  /** v2：分享成交已解锁整卡剩余 30%（整卡一次，解锁时补齐历史期次） */
  shareUnlocked?: boolean;
  // ---------- 配送分支（009） ----------
  /** 履约方式：pickup=到店自提 / delivery=配送到家。存量行按 pickup 处理 */
  fulfillMode?: "pickup" | "delivery";
  receiverName?: string | null;
  receiverPhone?: string | null;
  receiverAddress?: string | null;
  /** 运费总额（每期×期数）；0=免运费或自提 */
  freightAmount?: number;
  freightPayOrderNo?: string | null;
  /** none=免运费/自提 / unpaid=已下单未付 / paid / refunded */
  freightPayStatus?: string;
  totalPeriods?: number | null;
}
