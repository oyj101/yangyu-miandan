export type SubmissionStatus = "submitted" | "approved" | "rejected";

export interface MerchantSubmission {
  id: string;
  merchantId: string;
  productId: string;
  supplyPrice: number;
  quota: number;
  status: SubmissionStatus;
  rejectReason: string | null;
  operator: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSubmissionInput {
  merchantId: string;
  productId: string;
  supplyPrice: number;
  quota: number;
}
