export interface Card {
  id: string;
  merchantId: string;
  type: "year" | "times";
  times: number;
  freq: string;
  rewardPerTime: number;
  price: number;
  coverage: number;
  coverageCap: number;
  perMerchantQuota: number;
  status: "pending" | "active" | "offline";
  rejectReason?: string | null;
  // v2 套餐四要素（2026-10-20 PO 拍板）：存量卡这三项为 null，购买时 fail-closed
  unitPrice: number | null;
  periods: number | null;
  supplyPrice: number | null;
  /** 该卡分享返还比例（0~0.5）；即时退比例 = 1 - 本值。存量卡为全局缺省 0.3 */
  shareRatio: number;
  category: string | null;
  coverUrl: string | null;
  sortWeight: number;
  listedAt: Date | null;
  /** 关联商户商品库商品（商品库选品）；存量卡为 NULL */
  productId: string | null;
  /** 可售份数上限（来自提报 quota）；NULL=不限。purchase 软校验售罄 */
  stock: number | null;
  /** 履约能力：pickup=仅到店自提 / delivery=仅配送到家 / both=两者皆可。存量卡默认 pickup */
  fulfillment: "pickup" | "delivery" | "both";
  /** 配送到家每期运费（差价单独收，不并入卡价）；0=包邮 */
  deliveryFee: number;
  // SDK 内联版：集合页渲染必需（此前 name 只写 audit JSON，C 端取不到）
  title: string;
  subtitle: string | null;
  merchantName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCardInput {
  merchantId: string;
  type: "year" | "times";
  times: number;
  freq: string;
  rewardPerTime: number;
  price: number;
  coverage?: number;
  coverageCap?: number;
  perMerchantQuota?: number;
}

/** v2：平台（OPERATOR）设计套餐卡 —— 商户不再定价 */
export interface DesignCardInput {
  merchantId: string;
  unitPrice: number;
  periods: number;
  supplyPrice: number;
  suppliesName: string;
  /** 集合页展示名；缺省与 suppliesName 同值 */
  title?: string;
  subtitle?: string | null;
  merchantName?: string | null;
  freq?: string;
  category?: string | null;
  coverUrl?: string | null;
  sortWeight?: number;
  coverageCap?: number;
  /** 每卡独立分享分成（0~0.5）；缺省取 YANGYU_SHARE_RATIO */
  shareRatio?: number;
  /** 商品库选品：直接关联某商品（与 submissionId 二选一，submissionId 优先） */
  productId?: string | null;
  /** 商品库选品：从某条「已审核通过」的提报取 supplyPrice/quota(product→title/cover)/productId */
  submissionId?: string | null;
  /** 可售份数上限（不传 submissionId 时可直接指定；传 submissionId 时取 quota） */
  stock?: number | null;
  /** 履约能力；缺省 pickup（存量行为完全不变） */
  fulfillment?: "pickup" | "delivery" | "both";
  /** 配送到家每期运费；缺省 0 */
  deliveryFee?: number;
}

export interface GlobalParam {
  key: string;
  value: number;
  operator: string;
  updatedAt: Date;
}
