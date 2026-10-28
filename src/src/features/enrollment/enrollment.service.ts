import { notFound, badRequest, forbidden } from "../../lib/errors";
import {
  insertEnrollment,
  findEnrollment,
  findActiveByUserCard,
  listByMerchant,
  listByUser,
} from "./enrollment.repo";
import { findCardById } from "../card/card.repo";
import { query, withTx, newId } from "../../lib/db";
import { Enrollment } from "./enrollment.types";

/** 20261017 购买接支付(PO): pay=true 时走 8100 统一支付真源下单(NATIVE/JSAPI), 落 pay_order_no + pay_status=unpaid;
 * 支付成功后(统一回调置 paid) 核销才放行。pay=false/缺省=免费领卡模式(pay_status=none), 与既有行为一致。
 * 基础能力不得自实现: 微信下单/查单/退款一律经 8100 /api/v2/yangyu/pay/*。 */
export async function purchase(
  userId: string,
  cardId: string,
  opts: { pay?: boolean; channel?: string; openid?: string } = {}
): Promise<Enrollment> {
  const card = await findCardById(cardId);
  if (!card) throw notFound("免单卡不存在");
  if (card.status !== "active") throw badRequest("该免单卡未上架");

  // PRD 4.4：应发奖励总额 = 卡售价 × 免单覆盖率（受 coverage_cap 封顶）
  const effectiveCoverage = Math.min(card.coverage, card.coverageCap);
  const rewardTotal = Math.round(card.price * effectiveCoverage * 100) / 100;

  const existing = await findActiveByUserCard(userId, cardId);
  const reEnrolled = !!existing;

  const e = await insertEnrollment({
    userId,
    cardId,
    merchantId: card.merchantId,
    rewardTotal,
    reEnrolled,
  });

  if (opts.pay) {
    try {
      const cfg: any = await import("../../config");
      const mu = await query<any>("SELECT ai_uid FROM merchant_user WHERE user_id = ? LIMIT 1", [userId]);
      const aiUid = Number(mu.rows[0]?.ai_uid || 0);
      const amountFen = Math.round(Number(card.price) * 100);
      if (aiUid && amountFen > 0) {
        const resp = await fetch(`${cfg.config.wallet.base}/yangyu/pay/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Service-Key": cfg.config.wallet.serviceKey },
          body: JSON.stringify({
            uid: aiUid, amount_fen: amountFen, channel: opts.channel || "native",
            openid: opts.openid || "", biz_ref: e.id, description: `养鱼免单卡 ${cardId}`,
          }),
        });
        const j: any = await resp.json().catch(() => ({}));
        const orderNo = j?.data?.order_no;
        if (orderNo) {
          await query(
            "UPDATE enrollment SET pay_order_no=?, pay_status='unpaid' WHERE id=?",
            [orderNo, e.id]
          );
          (e as any).payOrderNo = orderNo;
          (e as any).payStatus = "unpaid";
          (e as any).payParams = j?.data?.pay_params || null;
        }
      }
    } catch (err: any) {
      console.error("[purchase] pay create failed", { userId, cardId, err: err?.message });
    }
  }
  return e;
}

export async function getEnrollment(id: string): Promise<Enrollment> {
  const e = await findEnrollment(id);
  if (!e) throw notFound("入渔记录不存在");
  return e;
}

/** 20261017 退款(PO 规则): 进度 30% 前~70% 内且无违规(养鱼零未达标) → 随时可退, 扣除所有已发奖励。
 * 退款额 = 卡价 - 已领奖励; 同步收回已发奖励余额(wallet debit, 失败记 audit 人工处理)。 */
export type RefundChannel = "balance" | "original";

/** 20261018 P0-1 资金闸门辅助: 本地非 paid 且有支付单号时, 向 8100 统一支付真源查单复核
 * (回调可能未回写本地, 避免"已付款却被判无实付")。查单失败返回原状态, 由调用方据此拒绝。
 * 只读优先 + 幂等回写 paid, 与核销侧 syncPayStatus 语义一致。 */
async function recheckPayStatus(e: Enrollment): Promise<string> {
  const st = String(e.payStatus || "none");
  if (st !== "unpaid" || !e.payOrderNo) return st;
  try {
    const cfg: any = await import("../../config");
    const resp = await fetch(
      `${cfg.config.wallet.base}/yangyu/pay/status?order_no=${encodeURIComponent(String(e.payOrderNo))}`,
      { headers: { "X-Service-Key": cfg.config.wallet.serviceKey } }
    );
    if (!resp.ok) return st;
    const j: any = await resp.json().catch(() => null);
    if (j?.data && String(j.data.status) === "paid") {
      await query("UPDATE enrollment SET pay_status='paid' WHERE id=?", [e.id]);
      return "paid";
    }
  } catch (err: any) {
    console.error("[refund] pay status recheck failed", { enrollmentId: e.id, err: err?.message });
  }
  return st;
}

/** 20261017 PO: 退款通道可选 —— balance=退到钱包余额(即时); original=微信原路退(支付接入后执行, 先落 pending 单据)。
 * 运营后台(OPERATOR)可选通道并代退任意入渔; 用户自助退默认 balance。 */
export async function refundEnrollment(
  userId: string,
  enrollmentId: string,
  opts: { channel?: RefundChannel; byOperator?: boolean } = {}
) {
  const channel: RefundChannel = opts.channel === "original" ? "original" : "balance";
  const e = await findEnrollment(enrollmentId);
  if (!e) throw notFound("入渔记录不存在");
  if (!opts.byOperator && e.userId !== userId) throw forbidden("只能退自己的入渔");
  if (e.status !== "normal") throw badRequest("当前状态不可退款");
  const progress = Number(e.rewardTotal) > 0 ? Number(e.rewardPaid) / Number(e.rewardTotal) : 0;
  if (progress >= 0.7) throw badRequest("进度已达70%, 不可退款(完成转介绍可领最后30%)");
  if (Number(e.totalMissCount) > 0) throw badRequest("存在养鱼未达标记录, 不符合退款条件");
  // 20261018 P0-1 资金安全闸门: 仅"已实付(paid)"入渔才产生真实退款资金。
  // 免费领卡(none)/已下单未付(unpaid)均无实付, 走退款即凭空造钱
  // (历史实证: 流水 2519 对 pay_status=none 入渔 +100 发放, 靠人工 -100 对冲)。
  // unpaid 先向统一支付真源查单复核一次, 仍非 paid 才拒。
  const payStatus = await recheckPayStatus(e);
  if (payStatus !== "paid") {
    throw badRequest("该入渔无实付记录, 不涉及资金退回(免费领卡或未完成支付不可退款)");
  }
  const card = await findCardById(e.cardId);
  if (!card) throw notFound("免单卡不存在");
  const refundAmount = Math.round((Number(card.price) - Number(e.rewardPaid)) * 100) / 100;
  const before = JSON.stringify({ status: e.status, rewardPaid: Number(e.rewardPaid) });
  await withTx(async (client) => {
    await client.query("UPDATE enrollment SET status='refunded', pause_remaining=0 WHERE id=?", [enrollmentId]);
    await client.query(
      "INSERT INTO audit (id, operator, action, ref_type, ref_id, `before`, `after`) VALUES (?,?,?,?,?,?,?)",
      [newId(), userId, "enrollment.refund", "enrollment", enrollmentId, before,
       JSON.stringify({ status: "refunded", refundAmount })]);
  });
  // 资金面: ①收回已发奖励(奖励扣除) ②退款按通道执行
  const cfg: any = await import("../../config");
  const svcKey = cfg.config.wallet.serviceKey;
  const base = cfg.config.wallet.base;
  const mu = await query<any>("SELECT ai_uid FROM merchant_user WHERE user_id = ? LIMIT 1", [e.userId]);
  const aiUid = Number(mu.rows[0]?.ai_uid || 0);
  const callWallet = async (amount: number, bizType: string, remark: string): Promise<boolean> => {
    if (!aiUid || !svcKey) return false;
    try {
      const resp = await fetch(`${base}/wallet/change`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Service-Key": svcKey },
        body: JSON.stringify({ uid: aiUid, asset: "balance", amount, biz_type: bizType, ledger: "zy", remark, biz_id: 0 }),
      });
      const j: any = await resp.json().catch(() => ({}));
      return !!(j && (j.code === 0 || j.code === "0") && j.data && j.data.ok);
    } catch (err: any) {
      console.error("[refund] wallet call failed", { enrollmentId, err: err?.message });
      return false;
    }
  };
  let recovered = false;
  if (Number(e.rewardPaid) > 0) {
    recovered = await callWallet(-Number(e.rewardPaid), "yangyu:refund", `退款收回已发奖励 入渔 ${enrollmentId}`);
    if (!recovered) console.error("[refund] reward recovery failed, see audit", { enrollmentId });
  }
  // 退款本金: 当前免费领卡无实付, 接支付后 balance=即时到账 / original=微信原路退。无实付仅记账不发放。
  let refunded = false;
  let refundNote = "";
  if (channel === "balance") {
    refunded = await callWallet(refundAmount, "yangyu:refund_payout", `退款到余额 入渔 ${enrollmentId} 通道:balance`);
    refundNote = refunded ? "已退到余额" : "余额退款失败, 待人工";
  } else {
    refundNote = "原路退通道: 待微信支付退款API接入后执行(pending)";
    await withTx(async (client) => {
      await client.query(
        "INSERT INTO audit (id, operator, action, ref_type, ref_id, `before`, `after`) VALUES (?,?,?,?,?,?,?)",
        [newId(), userId, "enrollment.refund.original_pending", "enrollment", enrollmentId, before,
         JSON.stringify({ channel, refundAmount, state: "pending_wechat_refund_api" })]);
    });
  }
  return { refundAmount, channel, recovered, refunded, refundNote, status: "refunded" };
}

/** 退款权限判定辅助: 返回 enrollment 归属 userId(不存在返回空串) */
export async function getEnrollmentUserId(enrollmentId: string): Promise<string> {
  const e = await findEnrollment(enrollmentId);
  return e ? e.userId : "";
}

/** 20261017 支付状态同步: unpaid 时向 8100 统一支付真源查单; 已付则本地置 paid(打通回调→入渔可用链路)。
 * 幂等; 查单失败或仍未付返回原状态(调用方据此拒绝核销)。 */
export async function syncPayStatus(enrollmentId: string): Promise<string> {
  const e = await findEnrollment(enrollmentId);
  if (!e) return "none";
  if (!e.payOrderNo || e.payStatus === "paid" || e.payStatus === "none") return e.payStatus || "none";
  try {
    const cfg: any = await import("../../config");
    const resp = await fetch(
      `${cfg.config.wallet.base}/yangyu/pay/status?order_no=${encodeURIComponent(e.payOrderNo)}`,
      { headers: { "X-Service-Key": cfg.config.wallet.serviceKey } }
    );
    if (!resp.ok) return e.payStatus || "none";
    const j: any = await resp.json().catch(() => null);
    if (j?.data && String(j.data.status) === "paid") {
      await query("UPDATE enrollment SET pay_status='paid' WHERE id=?", [enrollmentId]);
      return "paid";
    }
  } catch (err: any) {
    console.error("[pay] sync failed", { enrollmentId, err: err?.message });
  }
  return e.payStatus || "none";
}

export const listMerchantEnrollments = listByMerchant;

// [Task-213] C 端「我的免单」：列出当前联邦用户全部入渔记录。
export async function listUserEnrollments(userId: string): Promise<Enrollment[]> {
  return listByUser(userId);
}
