import { query, newId } from "../../lib/db";
import { MerchantSubmission } from "./submission.types";

function mapRow(r: any): MerchantSubmission {
  return {
    id: r.id,
    merchantId: r.merchant_id,
    productId: r.product_id,
    supplyPrice: Number(r.supply_price),
    quota: Number(r.quota),
    status: r.status,
    rejectReason: r.reject_reason ?? null,
    operator: r.operator ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function insertSubmission(input: {
  merchantId: string;
  productId: string;
  supplyPrice: number;
  quota: number;
}): Promise<MerchantSubmission> {
  const id = newId();
  await query(
    `INSERT INTO merchant_submission (id, merchant_id, product_id, supply_price, quota)
     VALUES (?,?,?,?,?)`,
    [id, input.merchantId, input.productId, input.supplyPrice, input.quota]
  );
  const row = await findSubmissionById(id);
  if (!row) throw new Error("insertSubmission 回读失败");
  return row;
}

export async function findSubmissionById(id: string): Promise<MerchantSubmission | null> {
  const res = await query<any>(`SELECT * FROM merchant_submission WHERE id = ?`, [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function listByMerchant(merchantId: string): Promise<MerchantSubmission[]> {
  const res = await query<any>(
    `SELECT * FROM merchant_submission WHERE merchant_id = ? ORDER BY created_at DESC`,
    [merchantId]
  );
  return res.rows.map(mapRow);
}

export async function listPending(): Promise<MerchantSubmission[]> {
  const res = await query<any>(
    `SELECT * FROM merchant_submission WHERE status = 'submitted' ORDER BY created_at ASC`
  );
  return res.rows.map(mapRow);
}

export async function setSubmissionStatus(
  id: string,
  status: "approved" | "rejected",
  operator: string,
  rejectReason: string | null
): Promise<MerchantSubmission | null> {
  await query(
    `UPDATE merchant_submission SET status = ?, operator = ?, reject_reason = ? WHERE id = ?`,
    [status, operator, status === "rejected" ? rejectReason ?? "未说明" : null, id]
  );
  return findSubmissionById(id);
}
