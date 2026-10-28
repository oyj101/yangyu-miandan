import { query, withTx, newId } from "../../lib/db";
import { Card } from "./card.types";

function mapRow(r: any): Card {
  return {
    id: r.id,
    merchantId: r.merchant_id,
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
    unitPrice: r.unit_price == null ? null : Number(r.unit_price),
    periods: r.periods == null ? null : Number(r.periods),
    supplyPrice: r.supply_price == null ? null : Number(r.supply_price),
    // 006 之前的行没有该列值时视为全局缺省 0.3（迁移已回填，这里只是兜底）
    shareRatio: r.share_ratio == null ? 0.3 : Number(r.share_ratio),
    category: r.category ?? null,
    coverUrl: r.cover_url ?? null,
    sortWeight: Number(r.sort_weight) || 0,
    listedAt: r.listed_at ?? null,
    productId: r.product_id ?? null,
    stock: r.stock == null ? null : Number(r.stock),
    // 009 之前的行没有这两列值时按「仅自提/包邮」兜底，等价于旧行为
    fulfillment: (r.fulfillment ?? "pickup") as Card["fulfillment"],
    deliveryFee: r.delivery_fee == null ? 0 : Number(r.delivery_fee),
    title: r.title ?? "",
    subtitle: r.subtitle ?? null,
    merchantName: r.merchant_name ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// 主键由应用层生成（CHAR(36)），插入后回读拿 DB 默认值（created_at 等）。
// 不用 INSERT..RETURNING：mysql2 对该语法结果集回传无保证，跨版本行为不稳。
export async function insertCard(input: {
  merchantId: string;
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
    `INSERT INTO card (id, merchant_id, type, times, freq, reward_per_time, price, coverage, coverage_cap, per_merchant_quota)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.merchantId,
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

/**
 * v2：平台（OPERATOR）设计套餐卡。
 * card.type/times/freq 仍写值以兼容旧读路径：
 *   times = periods，freq = '每周1次'，reward_per_time = unit_price
 * coverage 固定 1.0（全额退由 70%+30% 两段拼出），coverage_cap 用于防倒挂上限。
 */
export async function insertDesignedCard(input: {
  merchantId: string;
  unitPrice: number;
  periods: number;
  supplyPrice: number;
  category: string | null;
  coverUrl: string | null;
  sortWeight: number;
  coverageCap: number;
  perMerchantQuota: number;
  title: string;
  subtitle: string | null;
  merchantName: string | null;
  shareRatio: number;
  productId: string | null;
  stock: number | null;
  fulfillment: "pickup" | "delivery" | "both";
  deliveryFee: number;
}): Promise<Card> {
  const id = newId();
  const price = Math.round(input.unitPrice * input.periods * 100) / 100;
  await query(
    `INSERT INTO card
       (id, merchant_id, type, times, freq, reward_per_time, price, coverage, coverage_cap,
        per_merchant_quota, status, unit_price, periods, supply_price, category, cover_url, sort_weight,
        title, subtitle, merchant_name, share_ratio, product_id, stock, fulfillment, delivery_fee)
     VALUES (?,?,'times',?,'每周1次',?,?,1.0,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.merchantId,
      input.periods,
      input.unitPrice,
      price,
      input.coverageCap,
      input.perMerchantQuota,
      input.unitPrice,
      input.periods,
      input.supplyPrice,
      input.category,
      input.coverUrl,
      input.sortWeight,
      input.title,
      input.subtitle,
      input.merchantName,
      input.shareRatio,
      input.productId,
      input.stock,
      input.fulfillment,
      input.deliveryFee,
    ]
  );
  const row = await findCardById(id);
  if (!row) throw new Error("insertDesignedCard 回读失败");
  return row;
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
      `UPDATE card
          SET status = ?, reject_reason = ?, updated_at = CURRENT_TIMESTAMP(3),
              listed_at = CASE WHEN ? = 'active' AND listed_at IS NULL
                               THEN CURRENT_TIMESTAMP(3) ELSE listed_at END
        WHERE id = ?`,
      [status, rejectReason, status, id]
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

/**
 * 项目集合页（SDK 内联版首屏数据源）
 *
 * 只出「可售套餐卡」：active + 四要素齐全。存量 v1 卡（无 periods）购买时会 fail-closed，
 * 放进集合页等于给用户挖坑，故在这里就过滤掉。
 * 排序口径：运营置顶权重 → 上架时间新→旧 → id（稳定分页，避免翻页重复）。
 */
export async function listProjects(input: {
  category?: string | null;
  keyword?: string | null;
  sort?: "default" | "price_asc" | "price_desc" | "new" | null;
  page: number;
  pageSize: number;
}): Promise<{ items: Card[]; total: number }> {
  const where: string[] = ["status = 'active'", "periods IS NOT NULL", "unit_price IS NOT NULL"];
  const params: unknown[] = [];

  if (input.category) {
    where.push("category = ?");
    params.push(input.category);
  }
  if (input.keyword) {
    where.push("(title LIKE ? OR subtitle LIKE ? OR merchant_name LIKE ?)");
    const kw = `%${input.keyword}%`;
    params.push(kw, kw, kw);
  }

  let order = "sort_weight DESC, listed_at DESC, created_at DESC, id ASC";
  if (input.sort === "price_asc") order = "price ASC, id ASC";
  else if (input.sort === "price_desc") order = "price DESC, id ASC";
  else if (input.sort === "new") order = "listed_at DESC, created_at DESC, id ASC";

  const offset = (input.page - 1) * input.pageSize;
  const totalRes = await query<any>(`SELECT COUNT(*) AS n FROM card WHERE ${where.join(" AND ")}`, params);
  const res = await query<any>(
    `SELECT * FROM card WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...params, input.pageSize, offset]
  );

  return { items: res.rows.map(mapRow), total: Number(totalRes.rows[0]?.n) || 0 };
}

/** 集合页分类筛选器（空分类归入「其他」） */
export async function listCategories(): Promise<{ key: string; count: number }[]> {
  const res = await query<any>(
    `SELECT COALESCE(category, 'other') AS k, COUNT(*) AS n
       FROM card
      WHERE status = 'active' AND periods IS NOT NULL AND unit_price IS NOT NULL
      GROUP BY COALESCE(category, 'other')
      ORDER BY n DESC`
  );
  return res.rows.map((r: any) => ({ key: r.k, count: Number(r.n) || 0 }));
}

/** 已购人次（集合页「已拼 N 人」；付费成功的入渔计入） */
export async function countSoldByCards(cardIds: string[]): Promise<Record<string, number>> {
  if (!cardIds.length) return {};
  const ph = cardIds.map(() => "?").join(",");
  const res = await query<any>(
    `SELECT card_id, COUNT(*) AS n
       FROM enrollment
      WHERE card_id IN (${ph}) AND (pay_status IS NULL OR pay_status IN ('paid','none'))
      GROUP BY card_id`,
    cardIds
  );
  const out: Record<string, number> = {};
  for (const r of res.rows) out[r.card_id] = Number(r.n) || 0;
  return out;
}
