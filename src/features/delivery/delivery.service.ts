import { conflict, forbidden, notFound } from "../../lib/errors";
import { query, withTx } from "../../lib/db";
import { logger } from "../../lib/logger";
import type { Role } from "../../middleware/auth";
import { findEnrollment } from "../enrollment/enrollment.repo";
import { ensureFreightPaid, freightGuardMessage } from "../enrollment/freight-guard";
import { computeOnCheckinV2, CheckinV2Result } from "../checkin/checkin.service";
import { listByEnrollment as listPeriods } from "../period/period.repo";
import { pushNotice } from "../notify/notify.service";
import * as repo from "./delivery.repo";
import { canTransition, DeliveryStatus, DeliveryTask } from "./delivery.types";

export interface DeliveryActor {
  userId: string;
  role: Role;
  merchantId?: string;
}

/**
 * 按期为配送入渔建任务（幂等）。
 *
 * 调用时机：① 购买时选了配送 ② 购买后切换为配送 ③ 运营补建期次后
 * 已存在的期次不会重复建（INSERT IGNORE + uk_delivery_period）。
 * 待配送任务的收货信息跟随最新地址；已发货的不动（实物已按旧地址在路上）。
 */
export async function attachDeliveryTasks(enrollmentId: string): Promise<number> {
  const e = await findEnrollment(enrollmentId);
  if (!e) return 0;
  if ((e.fulfillMode ?? "pickup") !== "delivery") return 0;

  const periods = await listPeriods(enrollmentId);
  if (periods.length === 0) return 0;

  const rows = periods.map((p) => ({
    periodId: p.id,
    enrollmentId,
    cardId: p.cardId,
    userId: p.userId,
    merchantId: p.merchantId,
    periodNo: p.periodNo,
    weekStart: p.weekStart,
    weekEnd: p.weekEnd,
    mode: "delivery" as const,
    receiverName: e.receiverName ?? null,
    receiverPhone: e.receiverPhone ?? null,
    receiverAddress: e.receiverAddress ?? null,
  }));

  const created = await repo.insertTasks(rows);

  await query(
    `UPDATE delivery_task
        SET receiver_name = ?, receiver_phone = ?, receiver_address = ?
      WHERE enrollment_id = ? AND status = 'pending'`,
    [e.receiverName ?? null, e.receiverPhone ?? null, e.receiverAddress ?? null, enrollmentId]
  ).catch((err: any) => {
    logger.error({ enrollmentId, err: err?.message }, "配送任务地址同步失败");
  });

  return created;
}

function assertMerchantAccess(task: DeliveryTask, actor: DeliveryActor): void {
  if (actor.role === "OPERATOR") return;
  if (actor.role !== "MERCHANT" && actor.role !== "CASHIER") {
    throw forbidden("该操作仅限商户端");
  }
  if (!actor.merchantId || actor.merchantId !== task.merchantId) {
    throw forbidden("无权操作该商户的配送任务");
  }
}

function assertUserOwn(task: DeliveryTask, actor: DeliveryActor): void {
  if (actor.userId !== task.userId) throw forbidden("只能操作自己的配送任务");
}

/**
 * 商户标记「配送上门」（发货）。
 * 运费闸门：应收运费未确认前不发货 —— 否则平台替用户垫了运费。
 */
export async function shipTask(
  taskId: string,
  actor: DeliveryActor,
  input: { courier?: string | null; trackingNo?: string | null; remark?: string | null } = {}
): Promise<DeliveryTask> {
  const task = await repo.findById(taskId);
  if (!task) throw notFound("配送任务不存在");
  assertMerchantAccess(task, actor);

  if (task.status === "shipped") return task; // 幂等：重复点发货不报错
  if (!canTransition(task.status, "shipped")) {
    throw conflict(`当前状态(${task.status})不可发货`);
  }

  const e = await findEnrollment(task.enrollmentId);
  if (e) {
    const g = await ensureFreightPaid(e);
    if (!g.ok) throw conflict(freightGuardMessage(g));
  }

  await repo.markShipped(taskId, {
    courier: input.courier?.trim() || null,
    trackingNo: input.trackingNo?.trim() || null,
    operator: actor.userId,
    remark: input.remark?.trim() || null,
  });

  const updated = await repo.findById(taskId);
  if (!updated) throw notFound("配送任务不存在");

  await pushNotice({
    userId: task.userId,
    type: "delivery_shipped",
    title: `第 ${task.periodNo} 期已配送上门`,
    body: `本期已发货${updated.courier ? `（配送方：${updated.courier}）` : ""}，签收后自动结算本期返还。`,
    refType: "delivery_task",
    refId: task.id,
    bizKey: `delivery_shipped:${task.id}`,
  }).catch(() => undefined);

  return updated;
}

/** 商户回传「配送完成」（已送达）。autoSign=true 时一步到签收并触发核销 */
export async function deliverTask(
  taskId: string,
  actor: DeliveryActor,
  input: { autoSign?: boolean; remark?: string | null } = {}
): Promise<{ task: DeliveryTask; checkin: CheckinV2Result | null }> {
  const task = await repo.findById(taskId);
  if (!task) throw notFound("配送任务不存在");
  assertMerchantAccess(task, actor);

  if (task.status !== "delivered" && task.status !== "signed") {
    if (!canTransition(task.status, "delivered")) {
      throw conflict(`当前状态(${task.status})不可回传配送完成`);
    }
    await repo.markDelivered(taskId, {
      operator: actor.userId,
      remark: input.remark?.trim() || null,
    });
  }

  if (input.autoSign) {
    return signTask(taskId, actor, { remark: input.remark ?? null });
  }

  const updated = await repo.findById(taskId);
  if (!updated) throw notFound("配送任务不存在");
  return { task: updated, checkin: null };
}

/**
 * 签收确认 —— 配送场景的「核销」。
 *
 * 发奖复用 computeOnCheckinV2（唯一资金链路），本函数只负责：
 *   ① 权限与状态机 ② 把签收事实落库 ③ 回写 checkin_id
 * 绝不在这里另写一份退款/结算逻辑。
 *
 * 已先到店核销过的期次：不重复发奖，但签收事实照样记录（对账要看实物去向）。
 */
export async function signTask(
  taskId: string,
  actor: DeliveryActor,
  input: { remark?: string | null } = {}
): Promise<{ task: DeliveryTask; checkin: CheckinV2Result | null }> {
  const task = await repo.findById(taskId);
  if (!task) throw notFound("配送任务不存在");

  // 权限：本人 or 该商户的员工 or 运营
  if (actor.role === "USER") {
    assertUserOwn(task, actor);
  } else {
    assertMerchantAccess(task, actor);
  }

  if (task.status === "signed") {
    return { task, checkin: null }; // 幂等
  }
  if (!canTransition(task.status, "signed")) {
    throw conflict(`当前状态(${task.status})不可签收，请先回传配送完成`);
  }

  const signedBy = actor.role === "USER" ? "user" : "merchant";

  let checkin: CheckinV2Result | null = null;
  try {
    checkin = await computeOnCheckinV2(task.enrollmentId, task.merchantId, new Date(), {
      periodId: task.periodId,
      source: "delivery",
      deliveryTaskId: task.id,
    });
  } catch (err: any) {
    const msg = String(err?.message ?? "");
    // 已核销（例如先到店核销）：不重复发奖，但仍要把签收落库
    if (!(err?.code === "CONFLICT" && msg.includes("已核销"))) {
      throw err;
    }
    logger.warn({ taskId, msg }, "配送签收时本期已核销，仅记录签收");
  }

  await withTx(async (client) => {
    const locked = await repo.lockById(client, taskId);
    if (!locked) throw notFound("配送任务不存在");
    if (locked.status === "signed") return;
    await repo.markSigned(client, taskId, {
      signedBy,
      operator: actor.userId,
      remark: input.remark?.trim() || null,
      checkinId: checkin?.checkinId ?? null,
    });
  });

  const updated = await repo.findById(taskId);
  if (!updated) throw notFound("配送任务不存在");

  const refundAmount = checkin?.refund?.amount ?? 0;
  await pushNotice({
    userId: task.userId,
    type: "delivery_signed",
    title: `第 ${task.periodNo} 期已签收`,
    body: refundAmount > 0
      ? `本期签收完成，已返 ¥${refundAmount.toFixed(2)} 至消费金余额（不可提现）。`
      : "本期已签收完成。",
    refType: "delivery_task",
    refId: task.id,
    bizKey: `delivery_signed:${task.id}`,
  }).catch(() => undefined);

  return { task: updated, checkin };
}

/** C 端：某个入渔的配送进度 */
export async function listMine(userId: string, enrollmentId?: string): Promise<DeliveryTask[]> {
  const all = await repo.listByUser(userId);
  if (!enrollmentId) return all;
  const e = await findEnrollment(enrollmentId);
  if (!e) throw notFound("入渔记录不存在");
  if (e.userId !== userId) throw forbidden("只能查看自己的配送进度");
  return all.filter((t) => t.enrollmentId === enrollmentId);
}

/** 商户端：待办配送列表（默认全部，可按状态过滤；运营可指定 merchantId 代查） */
export async function listMerchantTasks(
  actor: DeliveryActor,
  opts: { status?: DeliveryStatus; limit?: number; merchantId?: string } = {}
): Promise<DeliveryTask[]> {
  const merchantId = actor.role === "OPERATOR" ? opts.merchantId ?? actor.merchantId : actor.merchantId;
  if (!merchantId) throw forbidden("账号未绑定商家");
  return repo.listByMerchant(merchantId, { status: opts.status, limit: opts.limit });
}
