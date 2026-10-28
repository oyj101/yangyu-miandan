import { config } from "../../config";
import { badRequest, conflict, notFound, validationError } from "../../lib/errors";
import {
  insertCard,
  insertDesignedCard,
  findCardById,
  countActiveByMerchant,
  setCardStatus,
  listByMerchant,
  listPending,
  listPublic,
} from "./card.repo";
import { Card, CreateCardInput, DesignCardInput, GlobalParam } from "./card.types";
import { query, newId } from "../../lib/db";
import { findSubmissionById } from "../submission/submission.repo";
import { findProductById } from "../catalog/catalog.repo";

export type ShareRatioCheck =
  | { ok: true; nowRefund: number; retain: number }
  | { ok: false; reason: "OUT_OF_RANGE" | "UNDER_SUPPLY"; nowRefund: number; retain: number };

/**
 * 每卡分享分成的准入判定（纯函数，便于穷举测试）。
 *
 * 先把现金流写清楚（每期收 P、付商户 C）：
 *   达标且分享 → 收 P − 付 C − 退 P        = **−C**（全额返还，必然由平台补贴 C）
 *   达标未分享 → 收 P − 付 C − 退 (1−r)P  = **rP − C**
 *   未达标     → 收 P − 付 C              = P − C
 *
 * 所以 r 的作用**不是**"少退一点省钱"，而是决定「未分享」这一档的留存：
 *   rP < C ⇒ 达标但没分享的人，平台每期净亏 C − rP。
 *   方向因此是 **r ≥ c**（c = C/P），而不是 r ≤ 1−c。
 *   c=0.3、r=0.3 恰好是零毛利线（这也是"供应价 30% 是上限不是安全区"的由来）。
 *
 * 余额平衡达标率：a* = (1−c) / (1 − r(1−s))，r 越高越安全，s 越高越危险。
 */
/**
 * 供应价率三档分界（20261025 PO 拍板）：
 *   c ≤ 0.3（ratioMax）        → 自动通过（核销环节不亏，零毛利线以上）
 *   0.3 < c ≤ 0.8（hardMax）   → 需 OPERATOR 二次确认 + 预算专项审批（forceRisk=true 留审计）
 *   c > 0.8                    → 恒拒绝，不可上架
 * 返回 'ok' | 'confirm' | 'reject'，供 designPackageCard 与单测共用。
 */
export function classifySupplyRatio(
  ratio: number,
  ratioMax: number,
  hardMax: number
): "ok" | "confirm" | "reject" {
  if (ratio > hardMax) return "reject";
  if (ratio > ratioMax) return "confirm";
  return "ok";
}

export function evaluateShareRatio(
  unitPrice: number,
  supplyPrice: number,
  shareRatio: number,
  max: number
): ShareRatioCheck {
  const nowRefund = Math.round(unitPrice * (1 - shareRatio) * 100) / 100;
  const retain = Math.round((unitPrice * shareRatio - supplyPrice) * 100) / 100;

  if (!(shareRatio >= 0) || shareRatio > max) {
    return { ok: false, reason: "OUT_OF_RANGE", nowRefund, retain };
  }
  // rP < C：达标未分享即亏损，运营改一个比例就能造出持续亏损的产品
  if (retain < -1e-9) {
    return { ok: false, reason: "UNDER_SUPPLY", nowRefund, retain };
  }
  return { ok: true, nowRefund, retain };
}

export async function createApplication(input: CreateCardInput): Promise<Card> {  const coverageCap = input.coverageCap ?? config.reward.coverageCap;
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

/**
 * v2：平台（AI 后台 / OPERATOR）选品后设计套餐卡。
 *
 * 三个硬闸门，缺一不可：
 *   1) 单价 × 期数 = 总金额         —— 防"拆价"：先报高价再按低单价卖
 *   2) 供应价 ≤ 单价                —— 防倒挂（DB 也加了 CHECK）
 *   3) 供应价率 ≤ 30%（默认）        —— 资金模型红线：c ≤ 0.3 时
 *      「核销达标但未分享」净额 = 0.3P − C ≥ 0，核销环节不亏钱。
 *      超过 30% 需 forceRisk=true 并留审计，因为达标率一高就亏。
 *
 * 典型：P=100 / C=30 → a* = 100%（s=0）即"全员达标且无人分享"才刚好打平。
 * 所以 30% 是上限，不是目标值。
 */
export async function designPackageCard(
  input: DesignCardInput,
  operator: string,
  opts: { forceRisk?: boolean } = {}
): Promise<Card> {
  const unitPrice = Math.round(Number(input.unitPrice) * 100) / 100;
  const periods = Math.floor(Number(input.periods));

  // ---------- 商品库选品解析（2026-10-25） ----------
  // 优先级：submissionId（已审核通过的提报）→ productId（直接关联商品）→ 无（纯手填）
  // submissionId 模式：从提报取 supplyPrice / quota(→stock) / product，product 名与封面作为缺省。
  let productId: string | null = input.productId ?? null;
  let stock: number | null = input.stock ?? null;
  let supplyPrice = Math.round(Number(input.supplyPrice) * 100) / 100;
  let effectiveTitle = input.title ?? input.suppliesName;
  let effectiveCoverUrl = input.coverUrl ?? null;

  if (input.submissionId) {
    const sub = await findSubmissionById(input.submissionId);
    if (!sub) throw notFound("提报不存在");
    if (sub.status !== "approved") {
      throw badRequest("提报尚未审核通过，不能据此设计套餐卡");
    }
    if (sub.merchantId !== input.merchantId) {
      throw badRequest("提报所属商户与设计卡商户不一致");
    }
    supplyPrice = sub.supplyPrice;
    stock = sub.quota;
    productId = sub.productId;
    const product = await findProductById(sub.productId);
    if (product) {
      if (!input.title) effectiveTitle = product.name;
      if (!input.coverUrl) effectiveCoverUrl = product.coverUrl;
    }
  }

  if (!(unitPrice > 0)) throw validationError("单价必须大于 0", { unitPrice });
  if (!(periods > 0) || periods > 520) throw validationError("期数必须为 1~520 的整数", { periods });
  if (supplyPrice < 0) throw validationError("供应价不能为负", { supplyPrice });
  if (supplyPrice > unitPrice) {
    throw validationError("供应价高于单价，存在倒挂风险", { supplyPrice, unitPrice });
  }

  const ratio = supplyPrice / unitPrice;
  const band = classifySupplyRatio(
    ratio,
    config.package.supplyRatioMax,
    config.package.supplyRatioHardMax
  );
  if (band === "reject") {
    throw validationError(
      `供应价率 ${(ratio * 100).toFixed(1)}% 超过 ${(config.package.supplyRatioHardMax * 100).toFixed(0)}% 硬上限（20261025 PO 拍板：0.3~0.8 需预算专项审批，超 0.8 不可上架）`,
      { supplyPrice, unitPrice, ratio }
    );
  }
  if (band === "confirm" && !opts.forceRisk) {
    throw validationError(
      `供应价率 ${(ratio * 100).toFixed(1)}% 落在 ${(config.package.supplyRatioMax * 100).toFixed(0)}%~${(config.package.supplyRatioHardMax * 100).toFixed(0)}% 预算专项审批区间，需二次确认并留审计（携带 forceRisk=true 重提）`,
      {
        supplyPrice,
        unitPrice,
        ratio,
        ratioMax: config.package.supplyRatioMax,
        hardMax: config.package.supplyRatioHardMax,
        needConfirm: true,
      }
    );
  }

  // ---------- 每卡分享分成（2026-10-21：逐卡可配，不再是全局 0.3） ----------
  const shareRatio = Math.round((input.shareRatio ?? config.package.shareRatioDefault) * 1000) / 1000;
  const check = evaluateShareRatio(unitPrice, supplyPrice, shareRatio, config.package.shareRatioMax);
  const supplyRatio = supplyPrice / unitPrice;
  let underSupplyRisk = false;
  if (!check.ok) {
    if (check.reason === "OUT_OF_RANGE") {
      throw validationError(
        `分享分成必须在 0 ~ ${(config.package.shareRatioMax * 100).toFixed(0)}% 之间`,
        { shareRatio, max: config.package.shareRatioMax }
      );
    }
    // 低于供应价率：达标但未分享时每期净亏 |retain|
    if (!opts.forceRisk) {
      throw validationError(
        `分享分成 ${(shareRatio * 100).toFixed(1)}% 低于供应价率 ${(supplyRatio * 100).toFixed(
          1
        )}%：达标但未分享时每期净亏 ¥${Math.abs(check.retain).toFixed(2)}，需二次确认并留审计`,
        {
          shareRatio,
          supplyRatio,
          netPerPeriod: check.retain,
          needConfirm: true,
        }
      );
    }
    underSupplyRisk = true;
  }
  const nowRefund = check.nowRefund;

  // ---------- 履约能力（配送分支，009）：默认仅自提，与存量卡行为一致 ----------
  const fulfillment = input.fulfillment ?? "pickup";
  if (fulfillment !== "pickup" && fulfillment !== "delivery" && fulfillment !== "both") {
    throw validationError("履约方式只能是 pickup / delivery / both", { fulfillment });
  }
  const deliveryFee = Math.round(Number(input.deliveryFee ?? 0) * 100) / 100;
  if (!Number.isFinite(deliveryFee) || deliveryFee < 0) {
    throw validationError("运费不能为负", { deliveryFee });
  }
  // 仅自提的卡配运费是误配：用户永远用不上，却会出现在运营后台里误导对账
  if (fulfillment === "pickup" && deliveryFee > 0) {
    throw validationError("仅到店自提的卡不应配置运费", { fulfillment, deliveryFee });
  }

  const active = await countActiveByMerchant(input.merchantId);
  const quota = config.reward.perMerchantQuota;
  if (active >= quota) throw conflict(`该商家免单卡已达每店上限 ${quota}`);

  const card = await insertDesignedCard({
    merchantId: input.merchantId,
    unitPrice,
    periods,
    supplyPrice,
    category: input.category ?? null,
    coverUrl: effectiveCoverUrl,
    sortWeight: input.sortWeight ?? 0,
    coverageCap: input.coverageCap ?? 1.0,
    perMerchantQuota: quota,
    // 集合页主标题：缺省回落到 suppliesName / 商品名，避免「设计时填了名、上架后卡片没名」
    title: effectiveTitle.slice(0, 120),
    subtitle: input.subtitle ?? null,
    merchantName: input.merchantName ?? null,
    shareRatio,
    productId,
    stock,
    fulfillment,
    deliveryFee,
  });

  const total = Math.round(unitPrice * periods * 100) / 100;
  await query(
    `INSERT INTO audit (id, operator, action, ref_type, ref_id, \`after\`)
     VALUES (?,?,?,?,?,?)`,
    [
      newId(),
      operator,
      band === "confirm" || underSupplyRisk ? "card.design.override" : "card.design",
      "card",
      card.id,
      JSON.stringify({
        merchantId: input.merchantId,
        unitPrice,
        periods,
        total,
        supplyPrice,
        ratio,
        ratioMax: config.package.supplyRatioMax,
        hardMax: config.package.supplyRatioHardMax,
        shareRatio,
        supplyRatio,
        nowRefund,
        netPerPeriod: check.retain,
        underSupplyRisk,
        forceRisk: !!opts.forceRisk,
        name: effectiveTitle,
        title: card.title,
        submissionId: input.submissionId ?? null,
        productId,
        fulfillment,
        deliveryFee,
        freightTotal: Math.round(deliveryFee * periods * 100) / 100,
      }),
    ]
  );

  return card;
}

/**
 * 预算健康度：剩余额度是否足以覆盖"在办未结算期次全部达标"的最坏情况。
 * 单期最大净流出 = 供应价 C（全达标全分享），故暴露 = Σ 未结算期次的 C。
 */
export async function budgetExposure(): Promise<{
  exposure: number;
  unsettledPeriods: number;
  activeCards: number;
}> {
  const res = await query<any>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(p.supply_price), 0) AS exposure
       FROM period p
       JOIN card c ON c.id = p.card_id
      WHERE p.merchant_settled = 0 AND p.expired = 0 AND c.status = 'active'`
  );
  const r = res.rows[0];
  const cards = await query<any>(`SELECT COUNT(*) AS n FROM card WHERE status='active'`);
  return {
    exposure: Number(r?.exposure) || 0,
    unsettledPeriods: Number(r?.n) || 0,
    activeCards: Number(cards.rows[0]?.n) || 0,
  };
}

/**
 * 当月营销预算水位（平台补贴口径）
 *
 * 用途：运营工作台必须能回答一个具体问题——「现在停售了吗」。
 * 判定不是「预算用完」，而是「预算剩余 < 在办未结算期次的最坏敞口」，
 * 因为已售卡是合同义务，预算耗尽只能停售新卡，不能停兑付。
 */
export async function budgetHeadroom(now: Date = new Date()): Promise<{
  monthKey: string;
  budgetTotal: number;
  used: number;
  remaining: number;
  exposure: number;
  shouldStopSelling: boolean;
}> {
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const res = await query<any>(
    `SELECT budget_total, used FROM marketing_budget
      WHERE scope = 'global' AND card_id IS NULL AND period_key = ? LIMIT 1`,
    [monthKey]
  );
  const row = res.rows[0];
  const budgetTotal = Number(row?.budget_total) || 0;
  const used = Number(row?.used) || 0;
  const remaining = Math.max(0, Math.round((budgetTotal - used) * 100) / 100);
  const exp = await budgetExposure();
  return {
    monthKey,
    budgetTotal,
    used,
    remaining,
    exposure: exp.exposure,
    // 未配置预算时不擅自停售（否则忘了建预算就等于全站下架），但要暴露 remaining=0
    shouldStopSelling: budgetTotal > 0 && exp.exposure > remaining,
  };
}

export const listMerchantCards = listByMerchant;export const listPendingCards = listPending;

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
