import { config } from "../../config";
import { badRequest, conflict, notFound, validationError } from "../../lib/errors";
import {
  insertCard,
  findCardById,
  countActiveByMerchant,
  setCardStatus,
  listByMerchant,
  listPending,
  listPublic,
  listFederationRows,
} from "./card.repo";
import { Card, CreateCardInput, GlobalParam } from "./card.types";
import { query } from "../../lib/db";

export async function createApplication(input: CreateCardInput): Promise<Card> {
  const coverageCap = input.coverageCap ?? config.reward.coverageCap;
  const coverage = input.coverage ?? 1.0;
  const perMerchantQuota = input.perMerchantQuota ?? config.reward.perMerchantQuota;

  // PRD F1.1：单次奖励 × 次数 ≤ 卡售价 × coverage_cap（防倒挂）
  const projectedReward = input.rewardPerTime * input.times;
  const upperBound = input.price * coverageCap;
  if (projectedReward > upperBound + 1e-9) {
    throw validationError("奖励总额超过卡售价×coverage_cap上限，存在倒挂风险", {
      projectedReward,
      upperBound,
    });
  }

  // PRD 十：每店限量发行免单卡
  const active = await countActiveByMerchant(input.merchantId);
  if (active >= perMerchantQuota) {
    throw conflict(`该商家免单卡已达每店上限 ${perMerchantQuota}`);
  }

  return insertCard({
    merchantId: input.merchantId,
    merchantName: input.merchantName,
    type: input.type,
    times: input.times,
    freq: input.freq,
    rewardPerTime: input.rewardPerTime,
    price: input.price,
    coverage,
    coverageCap,
    perMerchantQuota,
  });
}

export async function review(
  cardId: string,
  approve: boolean,
  operator: string,
  rejectReason?: string
): Promise<Card> {
  const card = await findCardById(cardId);
  if (!card) throw notFound("免单卡不存在");
  if (card.status !== "pending") throw badRequest("该卡非待审核状态");
  if (!approve && !rejectReason) throw badRequest("驳回需填写理由");
  const updated = await setCardStatus(
    cardId,
    approve ? "active" : "offline",
    approve ? null : rejectReason ?? "未说明",
    operator
  );
  if (!updated) throw notFound("免单卡不存在");
  return updated;
}

export const listMerchantCards = listByMerchant;
export const listPendingCards = listPending;

// [Task-213] C 端「拼场大厅」：返回所有已上架免单卡。
export async function listPublicCards(): Promise<Card[]> {
  return listPublic();
}

export async function getGlobalParams(): Promise<GlobalParam[]> {
  const res = await query<any>(`SELECT * FROM global_param`);
  return res.rows.map((r: any) => ({
    key: r.key,
    value: Number(r.value),
    operator: r.operator,
    updatedAt: r.updated_at,
  }));
}

export async function setGlobalParam(key: string, value: number, operator: string): Promise<GlobalParam> {
  await query(
    `INSERT INTO global_param (\`key\`, value, operator, updated_at)
     VALUES (?,?,?,CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE value = ?, operator = ?, updated_at = CURRENT_TIMESTAMP(3)`,
    [key, value, operator, value, operator]
  );
  const res = await query<any>(`SELECT * FROM global_param WHERE \`key\` = ?`, [key]);
  const r = res.rows[0];
  return {
    key: r.key,
    value: Number(r.value),
    operator: r.operator,
    updatedAt: r.updated_at,
  };
}
/* ---------- FEDERATION_API · 联邦消费项目集合（跨商户分组） ---------- */
export async function listFederation(status: string, q: string) {
  const allowed = ["active", "pending", "offline", "all"];
  const st = allowed.includes(status) ? status : "active";
  const rows = await listFederationRows(st, (q || "").trim());

  const groupsMap = new Map<string, any>();
  let activeCards = 0;
  let totalEnrollments = 0;

  for (const r of rows) {
    const mid = String(r.merchant_id);
    let g = groupsMap.get(mid);
    if (!g) {
      g = {
        merchantId: mid,
        merchantName: r.merchant_name || mid,
        certified: false, // 认证源未接入（主平台商户认证态），先恒 false
        cards: [],
      };
      groupsMap.set(mid, g);
    }
    const enrolledCount = Number(r.enrolled_count) || 0;
    totalEnrollments += enrolledCount;
    if (r.status === "active") activeCards += 1;
    g.cards.push({
      id: r.id,
      type: r.type,
      times: Number(r.times) || 0,
      freq: r.freq,
      rewardPerTime: Number(r.reward_per_time) || 0,
      price: Number(r.price) || 0,
      coverage: Number(r.coverage) || 0,
      coverageCap: Number(r.coverage_cap) || 0,
      perMerchantQuota: Number(r.per_merchant_quota) || 0,
      status: r.status,
      enrolledCount,
      createdAt: r.created_at,
    });
  }

  const groups = Array.from(groupsMap.values());
  return {
    summary: {
      merchants: groups.length,
      activeCards,
      totalEnrollments,
    },
    groups,
  };
}
