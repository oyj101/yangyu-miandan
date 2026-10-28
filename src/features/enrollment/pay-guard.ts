import { query } from "../../lib/db";
import { logger } from "../../lib/logger";
import { payStatus, type PayState } from "../../lib/fund";

/**
 * 支付态闸门（唯一实现）
 *
 * 为什么需要这一层：本服务**没有支付回调端点**（`/api/notify` 是站内消息，不是支付通知），
 * 8100 的支付结果不会主动推过来。所以 `enrollment.pay_status` 永远是"下单那一刻的快照"，
 * 用户付完钱它也不会自己变成 paid。
 *
 * 收敛前的真实后果：
 *   enrollment.service 里有一段 recheckPayStatus（查单+回写），但**只被退款调用**；
 *   核销侧 checkin.service 直接读本地 pay_status，于是
 *   「用户已付款 → 首次核销被拒：该入渔尚未完成支付」。
 *   同一件事两个业务路径，只有一条做了复核 —— 这就是要收敛的原因。
 *
 * 现在的规则：任何要判断"这单付没付"的地方，只准调 ensurePaid()。
 *   · 核销前（computeOnCheckinV2）
 *   · 退款前（refundEnrollment）
 *   · 退款期次前（refund.service 的 pay_status 校验）
 */

export type GuardState = PayState | "none";

export interface PayGuard {
  /** 归一后的支付态；none = 免费领卡（不走支付，无需支付态） */
  state: GuardState;
  /** 是否满足"可核销 / 可退费"的前置条件 */
  canProceed: boolean;
  /** 是否真的向 8100 发起过查单（排查"为什么放行/为什么拒"用） */
  remoteChecked: boolean;
  /** 查单失败原因；有值不代表拒单原因，只是留痕 */
  err?: string;
}

interface EnrollmentPayView {
  id: string;
  payStatus?: string | null;
  payOrderNo?: string | null;
}

/**
 * 确认入渔支付态。幂等、可重复调用。
 *
 * 判定顺序：
 *   1. 本地已是 paid → 直接放行（已确认过的事实，不必每次打 8100）
 *   2. 有 pay_order_no → 向 8100 查单（支付态唯一真源），查到 paid 就回写
 *   3. 没有 pay_order_no → 视为免费领卡，放行（与既有 pay_status='none' 行为一致）
 *
 * 查单失败一律不放行 —— 钱的事宁可拒，也不能"没查到就当付过了"。
 */
export async function ensurePaid(e: EnrollmentPayView): Promise<PayGuard> {
  const local = String(e.payStatus ?? "none");

  if (local === "paid") {
    return { state: "paid", canProceed: true, remoteChecked: false };
  }

  if (!e.payOrderNo) {
    // 免费领卡：没有支付单，也就没有待确认的支付态。
    // 注意这里仍然要区分"从没下过单"和"下过单但单号丢了"：
    // 后者如果本地状态是 unpaid/pending，说明单据存在过，必须当作异常拒掉。
    if (local === "unpaid" || local === "pending") {
      logger.error({ enrollmentId: e.id }, "入渔处于待支付态但缺少 pay_order_no，拒绝放行");
      return { state: local as GuardState, canProceed: false, remoteChecked: false, err: "缺少支付单号" };
    }
    return { state: "none", canProceed: true, remoteChecked: false };
  }

  const r = await payStatus(String(e.payOrderNo));
  if (!r.ok) {
    logger.error(
      { enrollmentId: e.id, orderNo: e.payOrderNo, code: r.code, err: r.err },
      "支付态查单失败，按未付处理"
    );
    return { state: local as GuardState, canProceed: false, remoteChecked: true, err: r.err };
  }

  const state = r.data!.state;

  if (state === "paid") {
    // 幂等回写：只有当前不是 paid 才更新，避免把 refunded 之类覆盖掉
    await query("UPDATE enrollment SET pay_status='paid' WHERE id=? AND (pay_status IS NULL OR pay_status<>'paid')", [
      e.id,
    ]).catch((err: any) => {
      logger.error({ enrollmentId: e.id, err: err?.message }, "支付态回写失败");
    });
    return { state: "paid", canProceed: true, remoteChecked: true };
  }

  if (state === "unknown") {
    logger.warn({ enrollmentId: e.id, orderNo: e.payOrderNo, raw: r.data?.raw }, "支付态未知，拒单待人工");
    return { state: "unknown", canProceed: false, remoteChecked: true, err: `未知支付态: ${r.data?.raw}` };
  }

  return { state, canProceed: false, remoteChecked: true };
}

/**
 * 拒绝理由（统一文案，避免各调用点各写一句，客服用不同话术解释同一件事）。
 */
export function payGuardMessage(g: PayGuard): string {
  if (g.err && g.state !== "paid") {
    return "支付状态暂时查不到，请稍后重试或联系客服核对";
  }
  switch (g.state) {
    case "unpaid":
      return "该入渔尚未完成支付，请先支付后再操作";
    case "closed":
      return "该支付单已关闭，请重新下单";
    case "refunded":
      return "该支付单已退款，不可再次操作";
    default:
      return "该入渔当前不可操作";
  }
}
