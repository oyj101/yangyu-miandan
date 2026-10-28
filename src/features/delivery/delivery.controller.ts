import { Router } from "express";
import { z } from "zod";
import { auth, AuthUser } from "../../middleware/auth";
import { ok, created } from "../../lib/http";
import * as svc from "./delivery.service";
import { DELIVERY_STATUS_TEXT, DeliveryStatus } from "./delivery.types";

const statusEnum = z.enum(["pending", "shipped", "delivered", "signed", "cancelled"]);

const shipSchema = z.object({
  courier: z.string().max(64).nullish(),
  trackingNo: z.string().max(64).nullish(),
  remark: z.string().max(255).nullish(),
});

const deliverSchema = z.object({
  /** 一步到签收（商户代签，适用于当面交付/无需用户点确认） */
  autoSign: z.boolean().optional(),
  remark: z.string().max(255).nullish(),
});

const signSchema = z.object({
  remark: z.string().max(255).nullish(),
});

function actorOf(u: AuthUser): svc.DeliveryActor {
  return { userId: u.userId, role: u.role, merchantId: u.merchantId };
}

export const deliveryRouter = Router();

/** C 端：我的配送进度（可按 enrollmentId 过滤） */
deliveryRouter.get("/mine", auth(), async (req, res, next) => {
  try {
    const enrollmentId = req.query.enrollmentId ? String(req.query.enrollmentId) : undefined;
    const list = await svc.listMine(req.user!.userId, enrollmentId);
    ok(
      res,
      list.map((t) => ({ ...t, statusText: DELIVERY_STATUS_TEXT[t.status] }))
    );
  } catch (e) {
    next(e);
  }
});

/** 商户端：待办配送列表 */
deliveryRouter.get("/merchant", auth(["MERCHANT", "CASHIER", "OPERATOR"]), async (req, res, next) => {
  try {
    const statusRaw = req.query.status ? String(req.query.status) : "";
    const status = statusRaw && statusEnum.safeParse(statusRaw).success
      ? (statusRaw as DeliveryStatus)
      : undefined;
    const merchantId = req.query.merchantId ? String(req.query.merchantId) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const list = await svc.listMerchantTasks(actorOf(req.user!), { status, limit, merchantId });
    ok(
      res,
      list.map((t) => ({ ...t, statusText: DELIVERY_STATUS_TEXT[t.status] }))
    );
  } catch (e) {
    next(e);
  }
});

/** 商户：配送上门（发货）。运费未确认前会被闸门拦住 */
deliveryRouter.post("/:id/ship", auth(["MERCHANT", "CASHIER", "OPERATOR"]), async (req, res, next) => {
  try {
    const body = shipSchema.parse(req.body ?? {});
    const task = await svc.shipTask(req.params.id, actorOf(req.user!), body);
    ok(res, { ...task, statusText: DELIVERY_STATUS_TEXT[task.status] });
  } catch (e) {
    next(e);
  }
});

/** 商户：回传配送完成（可 autoSign 一步到签收） */
deliveryRouter.post("/:id/deliver", auth(["MERCHANT", "CASHIER", "OPERATOR"]), async (req, res, next) => {
  try {
    const body = deliverSchema.parse(req.body ?? {});
    const r = await svc.deliverTask(req.params.id, actorOf(req.user!), body);
    created(res, { ...r.task, statusText: DELIVERY_STATUS_TEXT[r.task.status], checkin: r.checkin });
  } catch (e) {
    next(e);
  }
});

/** 用户本人 / 商户代签：签收确认 = 配送场景的核销 */
deliveryRouter.post("/:id/sign", auth(), async (req, res, next) => {
  try {
    const body = signSchema.parse(req.body ?? {});
    const r = await svc.signTask(req.params.id, actorOf(req.user!), body);
    created(res, { ...r.task, statusText: DELIVERY_STATUS_TEXT[r.task.status], checkin: r.checkin });
  } catch (e) {
    next(e);
  }
});

export default deliveryRouter;
