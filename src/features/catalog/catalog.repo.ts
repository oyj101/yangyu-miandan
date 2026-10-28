import { query, newId } from "../../lib/db";
import { MerchantProduct } from "./catalog.types";

function mapRow(r: any): MerchantProduct {
  return {
    id: r.id,
    merchantId: r.merchant_id,
    name: r.name,
    category: r.category ?? null,
    coverUrl: r.cover_url ?? null,
    spec: r.spec ?? null,
    originPrice: r.origin_price == null ? null : Number(r.origin_price),
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function insertProduct(input: {
  merchantId: string;
  name: string;
  category: string | null;
  coverUrl: string | null;
  spec: string | null;
  originPrice: number | null;
}): Promise<MerchantProduct> {
  const id = newId();
  await query(
    `INSERT INTO merchant_product (id, merchant_id, name, category, cover_url, spec, origin_price)
     VALUES (?,?,?,?,?,?,?)`,
    [id, input.merchantId, input.name, input.category, input.coverUrl, input.spec, input.originPrice]
  );
  const row = await findProductById(id);
  if (!row) throw new Error("insertProduct 回读失败");
  return row;
}

export async function findProductById(id: string): Promise<MerchantProduct | null> {
  const res = await query<any>(`SELECT * FROM merchant_product WHERE id = ?`, [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function listByMerchant(merchantId: string): Promise<MerchantProduct[]> {
  const res = await query<any>(
    `SELECT * FROM merchant_product WHERE merchant_id = ? ORDER BY created_at DESC`,
    [merchantId]
  );
  return res.rows.map(mapRow);
}

export async function listAll(): Promise<MerchantProduct[]> {
  const res = await query<any>(`SELECT * FROM merchant_product ORDER BY created_at DESC`);
  return res.rows.map(mapRow);
}

export async function updateProduct(
  id: string,
  patch: Partial<{
    name: string;
    category: string | null;
    cover_url: string | null;
    spec: string | null;
    origin_price: number | null;
  }>
): Promise<MerchantProduct | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    params.push(v);
  }
  if (!sets.length) return findProductById(id);
  params.push(id);
  await query(`UPDATE merchant_product SET ${sets.join(", ")} WHERE id = ?`, params);
  return findProductById(id);
}

export async function setProductStatus(
  id: string,
  status: "active" | "offline"
): Promise<MerchantProduct | null> {
  await query(`UPDATE merchant_product SET status = ? WHERE id = ?`, [status, id]);
  return findProductById(id);
}
