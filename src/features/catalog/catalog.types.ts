export interface MerchantProduct {
  id: string;
  merchantId: string;
  name: string;
  category: string | null;
  coverUrl: string | null;
  spec: string | null;
  originPrice: number | null;
  status: "active" | "offline";
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProductInput {
  merchantId: string;
  name: string;
  category?: string | null;
  coverUrl?: string | null;
  spec?: string | null;
  originPrice?: number | null;
}

export interface UpdateProductInput {
  name?: string;
  category?: string | null;
  coverUrl?: string | null;
  spec?: string | null;
  originPrice?: number | null;
}
