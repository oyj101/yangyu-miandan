import { conflict, notFound } from "../../lib/errors";
import { newId, withTx } from "../../lib/db";
import { config } from "../../config";
import { isoWeekKey, isoWeekOf, ymd, dateOnly, addDays, parseYmd } from "../period/iso-week";
import { findEnrollment, updateEnrollState, toState } from "../enrollment/enrollment.repo";
import { ensurePaid, payGuardMessage } from "../enrollment/pay-guard";
import { findCardById } from "../card/card.repo";
import { getPeriodAt } from "../period/period.service";
import { setCheckinAndTask, findById as findPeriodById } from "../period/period.repo";
import { judgePeriod } from "../task/task.service";
import { settleMerchant } from "../merchant/merchant.service";
import { refund30, refund70 } from "../refund/refund.service";
import { applyCheckin } from "../reward/engine";
import { pushNotice, toNoticePeriod } from "../notify/notify.service";
import { Period } from "../period/period.types";

export interface CheckinV2Result {
  checkinId: string;
  periodId: string;
  periodNo: number;
  week: string;
  taskMet: boolean;
  metDays: number;
  windowStart: string | null;
  taskDataAvailable: boolean;
  paused: boolean; // 处于停奖期，本次不退费
  refund: { amount: number; flowNo?: string; err?: string } | null;
  refund30: { amount: number; flowNo?: string; err?: string } | null;
  merchant: { payable: number; offset: number; cashOut: number; balanceAfter: number } | null;
  status: string;
  pauseRemaining: number;
}

/**
 * v2 核销：一期限一次 + 判连续 5 天 + 即时结算商户 + 达标退 70%。
 *
 * 与旧 computeOnCheckin 的关键差别：
 *   - 幂等粒度：旧 = (enrollment, 周)；新 = (period_id) 一期限一次
 *   - 发奖判据：旧 = 周内累计天数；新 = 连续 5 天 chat∧feed
 *   - 商户侧：新增即时结算（旧版本商户侧不在这条链上）
 *   - 退费金额：按 unit_price × 70%，不再用"整卡累计封顶"
 *
 * 存量卡（periods 为 null）不走本函数，由调用方回落旧逻辑。
 */
/**
 * 核销来源与目标期次（配送分支 009 引入）
 *
 * periodId：配送可能跨周才签收（用户出差、物流延迟），按"当前周"找期次会错过目标期，
 *   所以签收必须能显式指定期次。到店核销仍走"当前周"的旧路径（不传即可）。
 * source：counter=到店核销 / delivery=配送签收，落 checkin 以便对账分清钱从哪条腿来。
 */
export interface CheckinOpts {
  periodId?: string;
  source?: "counter" | "delivery";
  deliveryTaskId?: string | null;
}

export async function computeOnCheckinV2(
  enrollmentId: string,
  merchantId: string,
  now: Date = new Date(),
  opts: CheckinOpts = {}
): Promise<CheckinV2Result> {
  const e = await findEnrollment(enrollmentId);
  if (!e) throw notFound("入渔记录不存在");
  if (e.merchantId !== merchantId) throw notFound("入渔记录不属于该商家");

  if (e.status !== "normal" && e.status !== "pause1" && e.status !== "pause3") {
    throw conflict(`该入渔当前状态(${e.status})不可核销`);
  }
  // 支付态闸门（唯一实现见 enrollment/pay-guard）。
  // 本地 pay_status 只是下单那一刻的快照：本项目没有支付回调端点，用户付完钱
  // 这里也不会自己变成 paid。收敛前只读本地字段的后果是
  // 「已付款用户首次核销被拒：该入渔尚未完成支付」。
  // 闸门内部会向 8100 查单复核并幂等回写；查不到就拒（钱的事宁可拒）。
  const guard = await ensurePaid(e);
  if (!guard.canProceed) {
    throw conflict(payGuardMessage(guard));
  }

  const period = opts.periodId
    ? await findPeriodById(opts.periodId)
    : await getPeriodAt(enrollmentId, now);
  if (!period) {
    const w = isoWeekKey(isoWeekOf(now));
    throw conflict(`本周（${w}）不属于该入渔的任何一期，可能尚未开始或已走完总期数`);
  }
  if (period.enrollmentId !== enrollmentId) throw notFound("期次不属于该入渔记录");
  if (period.expired) throw conflict("该期次已作废，请联系客服申请补期");
  if (period.checkinId) throw conflict("本期已核销，请勿重复操作");

  // ---------- 判连续 5 天（数据不可用时按"跳过不惩罚"处理，但本次不发奖） ----------
  const judge = await judgePeriod({
    enrollmentId,
    userId: e.userId,
    weekStart: period.weekStart,
    weekEnd: period.weekEnd,
    needed: config.package.streakDays,
  });

  const state = toState(e);
  const paused = state.pauseRemaining > 0;
  // 停奖期即便达标也不退费；pause 消耗与状态推进交给 engine，保持与旧阶梯一致
  const eligible = judge.met && !paused;

  const { state: ns } = applyCheckin(state, 0);

  const checkinId = newId();
  const weekKey = `${period.isoYear}W${String(period.isoWeek).padStart(2, "0")}`;

  const settled = await withTx(async (client) => {
    try {
      await client.query(
        `INSERT INTO checkin
           (id, enrollment_id, user_id, merchant_id, card_id, week, rewarded, reward_id, note,
            period_id, unit_price, supply_price, source, delivery_task_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          checkinId,
          e.id,
          e.userId,
          merchantId,
          e.cardId,
          weekKey,
          0,
          null,
          `v2 期次#${period.periodNo} ${judge.met ? "连续" + judge.longest + "天达标" : "未达标(最长" + judge.longest + "天)"}` +
            (paused ? " 停奖期" : "") +
            (judge.dataAvailable ? "" : " 任务数据不可用") +
            (opts.source === "delivery" ? " 配送签收" : ""),
          period.id,
          period.unitPrice,
          period.supplyPrice,
          opts.source ?? "counter",
          opts.deliveryTaskId ?? null,
        ]
      );
    } catch (err: any) {
      if (err?.errno === 1062 || err?.code === "ER_DUP_ENTRY") {
        throw conflict("本期已核销，请勿重复操作");
      }
      throw err;
    }

    await setCheckinAndTask(client, period.id, {
      checkinId,
      taskMet: judge.met,
      metDays: judge.longest,
      windowStart: judge.windowStart,
      dataAvailable: judge.dataAvailable,
    });

    // 商户结算与核销同事务：核销记录必须与"商户拿钱"一致，
    // 否则会出现"有核销无结算"（商户少收）或"有结算无核销"（平台多付）。
    const s = await settleMerchant(client, period, checkinId);

    await updateEnrollState(client, e.id, {
      ...ns,
      rewardTotal: Number(e.rewardTotal),
    });

    return s;
  });

  // ---------- 达标退 70%（独立事务，失败不回滚核销） ----------
  // 若整卡已由分享解锁，则本次同时补退 30%，用户一次拿到 100%。
  let refund: CheckinV2Result["refund"] = null;
  let refund30Part: CheckinV2Result["refund30"] = null;
  if (eligible) {
    const r = await refund70(period.id);
    refund = { amount: r.amount, flowNo: r.flowNo, err: r.err };
    if (e.shareUnlocked) {
      const r2 = await refund30(period.id);
      refund30Part = { amount: r2.amount, flowNo: r2.flowNo, err: r2.err };
    }
  }

  // ---------- 即时通知 ----------
  const updated: Period = { ...period, checkinId, taskMet: judge.met, metDays: judge.longest };
  const np = toNoticePeriod(updated);
  if (judge.met) {
    await pushNotice({
      userId: e.userId,
      type: "checkin_ok",
      title: `第 ${period.periodNo} 期核销成功`,
      body: paused
        ? "本期处于停奖期，服务照常可用，本次不退费。完成一次核销后停奖次数已减少 1 次。"
        : eligible
          ? refund30Part
            ? "本期已全额返还至消费金余额（不可提现，可用于平台内消费）。"
            : `已返 ${Math.round(period.refundNowRatio * 100)}% 至消费金余额（不可提现）。完成一次分享（好友打开链接即绑定，无需下单）后，剩余 ${Math.round(period.shareRatio * 100)}% 将自动补发。`
          : "本期未达标，服务照常可用，但不能退费。",
      refType: "period",
      refId: period.id,
      bizKey: `checkin_ok:${period.id}`,
    }).catch(() => undefined);
  } else if (!judge.dataAvailable) {
    await pushNotice({
      userId: e.userId,
      type: "task_data_missing",
      title: `第 ${period.periodNo} 期任务数据待复核`,
      body: "系统未能取到本周养鱼记录，本次不计为未达标。请保留投喂截图，联系客服复核。",
      refType: "period",
      refId: period.id,
      bizKey: `task_data_missing:${period.id}`,
    }).catch(() => undefined);
  }

  return {
    checkinId,
    periodId: period.id,
    periodNo: period.periodNo,
    week: weekKey,
    taskMet: judge.met,
    metDays: judge.longest,
    windowStart: judge.windowStart,
    taskDataAvailable: judge.dataAvailable,
    paused,
    refund,
    refund30: refund30Part,
    merchant: settled
      ? {
          payable: settled.payable,
          offset: settled.offset,
          cashOut: settled.cashOut,
          balanceAfter: settled.balanceAfter,
        }
      : null,
    status: ns.status,
    pauseRemaining: ns.pauseRemaining,
  };
}

/** 给 C 端展示的下一期信息（含"最晚开始日"，必须让用户看得见） */
export async function nextPeriodHint(enrollmentId: string, now: Date = new Date()) {
  const p = await getPeriodAt(enrollmentId, now);
  const target = p ?? (await getPeriodAt(enrollmentId, addDays(now, 7)));
  if (!target) return null;
  const lastStart = ymd(addDays(parseYmd(target.weekStart), 2));
  return {
    periodNo: target.periodNo,
    weekStart: target.weekStart,
    weekEnd: target.weekEnd,
    lastStartDay: lastStart,
    checkinDeadline: target.weekEnd,
    weekClosed: target.expired,
    today: ymd(dateOnly(now)),
  };
}
