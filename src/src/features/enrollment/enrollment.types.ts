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
}
