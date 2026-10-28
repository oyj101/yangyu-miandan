import { query, withTx, newId } from "../../lib/db";
import { Card } from "./card.types";

function mapRow(r: any): Card {
  return {
    id: r.id,
    merchantId: r.merchant_id,
    merchantName: r.merchant_name || null,
    type: r.type,
    times: r.times,
    freq: r.freq,
    rewardPerTime: Number(r.reward_per_time),
    price: Number(r.price),
    coverage: Number(r.coverage),
    coverageCap: Number(r.coverage_cap),
    perMerchantQuota: r.per_merchant_quota,
    status: r.status,
    rejectReason: r.reject_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// 主键由应用层生成（CHAR(36)），插入后回读拿 DB 默认值（created_at 等）。
// 不用 INSERT..RETURNING：mysql2 对该语法结果集回传无保证，跨版本行为不稳。
export async function insertCard(input: {
  merchantId: string;
  merchantName?: string;
  type: string;
  times: number;
  freq: string;
  rewardPerTime: number;
  price: number;
  coverage: number;
  coverageCap: number;
  perMerchantQuota: number;
}): Promise<Card> {
  const id = newId();
  await query(
    `INSERT INTO card (id, merchant_id, merchant_name, type, times, freq, reward_per_time, price, coverage, coverage_cap, per_merchant_quota)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.merchantId,
      input.merchantName || null,
      input.type,
      input.times,
      input.freq,
      input.rewardPerTime,
      input.price,
      input.coverage,
      input.coverageCap,
      input.perMerchantQuota,
    ]
  );
  const row = await findCardById(id);
  if (!row) throw new Error("insertCard 回读失败");
  return row;
}

export async function findCardById(id: string): Promise<Card | null> {
  const res = await query<any>(`SELECT * FROM card WHERE id = ?`, [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function countActiveByMerchant(merchantId: string): Promise<number> {
  const res = await query<any>(
    `SELECT COUNT(*) AS c FROM card WHERE merchant_id = ? AND status = 'active'`,
    [merchantId]
  );
  // mysql2 对 COUNT(*) 返回字符串（BIGINT），必须显式数值化；"0" 为 truthy，不可用 ??
  return Number(res.rows[0]?.c) || 0;
}

export async function setCardStatus(
  id: string,
  status: "active" | "offline",
  rejectReason: string | null,
  operator: string
): Promise<Card | null> {
  return withTx(async (client) => {
    await client.query(
      `UPDATE card SET status = ?, reject_reason = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [status, rejectReason, id]
    );
    const sel = await client.query(`SELECT * FROM card WHERE id = ?`, [id]);
    const row = (sel[0] as any[])[0];
    if (!row) return null;
    await client.query(
      `INSERT INTO audit (id, operator, action, ref_type, ref_id, \`after\`) VALUES (?,'review',?,?,?,?)`,
      [newId(), operator, "card", id, JSON.stringify({ status, rejectReason })]
    );
    return mapRow(row);
  });
}

export async function listByMerchant(merchantId: string): Promise<Card[]> {
  const res = await query<any>(`SELECT * FROM card WHERE merchant_id = ? ORDER BY created_at DESC`, [
    merchantId,
  ]);
  return res.rows.map(mapRow);
}

export async function listPending(): Promise<Card[]> {
  const res = await query<any>(`SELECT * FROM card WHERE status = 'pending' ORDER BY created_at ASC`);
  return res.rows.map(mapRow);
}

// [Task-213] 公开免单卡列表（C 端「拼场大厅」）：仅返回已上架(active)卡片。
// 注：merchant_id 锚定主站 zy_merchants.id，商户展示名由 C 端经主平台门店接口解析（后续迭代）。
export async function listPublic(): Promise<Card[]> {
  const res = await query<any>(
    `SELECT * FROM card WHERE status = 'active' ORDER BY created_at DESC`
  );
  return res.rows.map(mapRow);
}
/* ---------- FEDERATION_API · 跨商户聚合查询 ---------- */
export async function listFederationRows(status: string, q: string): Promise<any[]> {
  const where: string[] = [];
  const params: any[] = [];
  if (status && status !== "all") {
    where.push("c.status = ?");
    params.push(status);
  }
  if (q) {
    where.push("(c.merchant_name LIKE ? OR c.type LIKE ? OR c.merchant_id LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const sql =
    `SELECT c.*, (SELECT COUNT(*) FROM enrollment e WHERE e.card_id = c.id) AS enrolled_count ` +
    `FROM card c ` +
    (where.length ? `WHERE ${where.join(" AND ")} ` : "") +
    `ORDER BY c.created_at DESC`;
  const res = await query<any>(sql, params);
  return res.rows;
}
