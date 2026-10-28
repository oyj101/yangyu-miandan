export interface Card {
  id: string;
  merchantId: string;
  merchantName?: string | null;
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
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCardInput {
  merchantId: string;
  merchantName?: string;
  type: "year" | "times";
  times: number;
  freq: string;
  rewardPerTime: number;
  price: number;
  coverage?: number;
  coverageCap?: number;
  perMerchantQuota?: number;
}

export interface GlobalParam {
  key: string;
  value: number;
  operator: string;
  updatedAt: Date;
}
/* ---------- FEDERATION_API · 联邦消费项目集合（GET /api/cards/federation） ---------- */
export interface FederationCard {
  id: string;
  type: string;
  times: number;
  freq: string;
  rewardPerTime: number;
  price: number;
  coverage: number;
  coverageCap: number;
  perMerchantQuota: number;
  status: string;
  enrolledCount: number;
  createdAt: Date;
}

export interface FederationGroup {
  merchantId: string;
  merchantName: string;
  certified: boolean;
  cards: FederationCard[];
}

export interface FederationResult {
  summary: { merchants: number; activeCards: number; totalEnrollments: number };
  groups: FederationGroup[];
}
