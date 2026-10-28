import { badRequest, conflict, notFound, validationError } from "../../lib/errors";
import { query, withTx, newId } from "../../lib/db";
import { config } from "../../config";
import { Card } from "../card/card.types";
import { findCardById } from "../card/card.repo";
import {
  firstFullWeek,
  isoWeekKey,
  isoWeekOf,
  parseIsoWeekKey,
  shiftWeek,
  ymd,
} from "./iso-week";
import {
  expirePast,
  findByWeek,
  findById,
  insertPeriods,
  listByEnrollment,
  NewPeriodRow,
} from "./period.repo";
import { Period } from "./period.types";

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 购买前的配置闸门（fail-closed）。
 * 存量卡（v1，未设套餐四要素）一律拒绝生成期次 —— 凭空按 price/times 推算
 * 会让供应价变成 0，等于每期白送商户一次服务。
 */
export function assertPackageCard(card: Card): {
  unitPrice: number;
  periods: number;
  supplyPrice: number;
} {
  if (card.unitPrice == null || card.periods == null || card.supplyPrice == null) {
    throw validationError("该卡尚未完成套餐卡设计（缺少单价/期数/供应价），不可购买", {
      cardId: card.id,
    });
  }
  const unitPrice = Number(card.unitPrice);
  const periods = Number(card.periods);
  const supplyPrice = Number(card.supplyPrice);

  if (!(unitPrice > 0) || !(periods > 0)) {
    throw validationError("套餐卡单价或期数非正数", { unitPrice, periods });
  }
  if (supplyPrice < 0 || supplyPrice > unitPrice) {
    throw validationError("供应价必须在 0 ~ 单价之间", { supplyPrice, unitPrice });
  }
  // 总价一致性：浮点比较留 1 分容差
  if (Math.abs(unitPrice * periods - Number(card.price)) > 0.01) {
    throw validationError("卡价与 单价×期数 不一致，拒绝生成期次", {
      price: Number(card.price),
      unitPrice,
      periods,
    });
  }
  return { unitPrice, periods, supplyPrice };
}

/**
 * 生成该入渔的全部期次。幂等：已存在则直接返回。
 *
 * 首期 = 购买日所在 ISO 周的下一个周一（见 firstFullWeek 注释）。
 * 之所以不顺延到"下一个有 5 天剩余的日子"：规则要可解释，
 * 统一"次完整周起算"对所有人都一致，也让集合页能明确写出首期日期。
 */
export async function createPeriodsForEnrollment(input: {
  enrollmentId: string;
  cardId: string;
  userId: string;
  merchantId: string;
  purchasedAt: Date;
}): Promise<Period[]> {
  const existing = await listByEnrollment(input.enrollmentId);
  if (existing.length > 0) return existing;

  const card = await findCardById(input.cardId);
  if (!card) throw notFound("免单卡不存在");
  const { unitPrice, periods, supplyPrice } = assertPackageCard(card);

  const first = firstFullWeek(input.purchasedAt);
  // 比例快照到每一期：卡上的 share_ratio 之后被运营改，已售期次的金额也不变。
  // 这是合同金额，不能随配置漂移（改比例只影响此后新生成的期次）。
  const shareRatio = Number(card.shareRatio ?? config.package.shareRatioDefault);
  const refundNowRatio = Math.round((1 - shareRatio) * 1000) / 1000;
  const rows: NewPeriodRow[] = [];
  for (let i = 0; i < periods; i++) {
    const w = i === 0 ? first : shiftWeek(first, i);
    rows.push({
      enrollmentId: input.enrollmentId,
      cardId: input.cardId,
      userId: input.userId,
      merchantId: input.merchantId,
      periodNo: i + 1,
      isoYear: w.year,
      isoWeek: w.week,
      weekStart: ymd(w.monday),
      weekEnd: ymd(w.sunday),
      unitPrice,
      supplyPrice,
      shareRatio,
      refundNowRatio,
    });
  }

  try {
    await insertPeriods(rows);
  } catch (err: any) {
    // 并发下另一个请求已建好：1062 视为幂等成功
    if (err?.code === "ER_DUP_ENTRY" || err?.errno === 1062) {
      return listByEnrollment(input.enrollmentId);
    }
    throw err;
  }

  const firstKey = isoWeekKey(first);
  await query(
    `UPDATE enrollment
        SET total_periods = ?, current_period = 1, first_week = ?, card_paid = ?
      WHERE id = ?`,
    [periods, firstKey, round2(unitPrice * periods), input.enrollmentId]
  );

  return listByEnrollment(input.enrollmentId);
}

/** 取某入渔在指定日期所属 ISO 周的期次；无则 null（说明已过期或周期已走完） */
export async function getPeriodAt(enrollmentId: string, at: Date): Promise<Period | null> {
  const w = isoWeekOf(at);
  return findByWeek(enrollmentId, w.year, w.week);
}

/** 扫描并作废逾期未核销的期次（幂等） */
export async function sweepExpired(now: Date = new Date()): Promise<number> {
  const n = await expirePast(ymd(now));
  if (n > 0) {
    // 同步回写入渔的作废计数，供 C 端展示与客服查询
    await query(
      `UPDATE enrollment e
          SET expired_count = (
            SELECT COUNT(*) FROM period p WHERE p.enrollment_id = e.id AND p.expired = 1
          )
        WHERE e.id IN (SELECT DISTINCT enrollment_id FROM period WHERE expired = 1)`,
      []
    );
  }
  return n;
}

/**
 * 运营补期：把某期整体挪到目标 ISO 周。
 * 期次绑自然周的必然代价是"漏一周即永久损失"，没有这个通道，此类投诉无解。
 */
export async function extendPeriod(
  periodId: string,
  targetWeekKey: string,
  operator: string
): Promise<Period> {
  const p = await findById(periodId);
  if (!p) throw notFound("期次不存在");
  if (p.checkinId) throw badRequest("该期已核销，不可补期");

  const target = parseIsoWeekKey(targetWeekKey);
  const occupied = await findByWeek(p.enrollmentId, target.year, target.week);
  if (occupied && occupied.id !== periodId) {
    throw conflict(`目标周 ${targetWeekKey} 已被第 ${occupied.periodNo} 期占用`);
  }

  const fromKey = `${p.isoYear}W${String(p.isoWeek).padStart(2, "0")}`;
  await withTx(async (client) => {
    await client.query(
      `UPDATE period
          SET iso_year = ?, iso_week = ?, week_start = ?, week_end = ?,
              expired = 0, extended_from = COALESCE(extended_from, ?)
        WHERE id = ?`,
      [target.year, target.week, ymd(target.monday), ymd(target.sunday), fromKey, periodId]
    );
    await client.query(
      `INSERT INTO audit (id, operator, action, ref_type, ref_id, \`before\`, \`after\`)
       VALUES (?,?,?,?,?,?,?)`,
      [newId(), operator, "period.extend", "period", periodId, JSON.stringify({ week: fromKey }),
       JSON.stringify({ week: targetWeekKey })]
    );
  });

  const updated = await findById(periodId);
  if (!updated) throw notFound("期次不存在");
  return updated;
}
