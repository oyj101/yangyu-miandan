import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth";
import { ok } from "../../lib/http";
import { listByEnrollment } from "./period.repo";
import { extendPeriod, sweepExpired } from "./period.service";
import { refund30, refund70, listStuckRefunds } from "../refund/refund.service";
import { syncRange } from "../task/task.service";
import { evaluateAllWeeklyV2 } from "../reward/reward.service";

export const periodRouter = Router();

/** 某入渔的全部期次（C 端进度页 / 运营查询共用） */
periodRouter.get("/", auth(), async (req, res, next) => {
  try {
    const enrollmentId = String(req.query.enrollmentId ?? "");
    if (!enrollmentId) {
      return res
        .status(400)
        .json({ ok: false, error: { code: "BAD_REQUEST", message: "缺少 enrollmentId" } });
    }
    ok(res, await listByEnrollment(enrollmentId));
  } catch (e) {
    next(e);
  }
});

/** 运营补期：漏一周即永久损失，没有这个通道投诉无解 */
periodRouter.post("/:id/extend", auth(["OPERATOR"]), async (req, res, next) => {
  try {
    const body = z.object({ week: z.string().regex(/^\d{4}W\d{1,2}$/) }).parse(req.body);
    const p = await extendPeriod(req.params.id, body.week, req.user!.userId);
    ok(res, p);
  } catch (e) {
    next(e);
  }
});

/** 手动补退（自动流程失败后运营重放；幂等，重复调用不会二次出账） */
periodRouter.post("/:id/refund70", auth(["OPERATOR"]), async (req, res, next) => {
  try {
    ok(res, await refund70(req.params.id));
  } catch (e) {
    next(e);
  }
});

periodRouter.post("/:id/refund30", auth(["OPERATOR"]), async (req, res, next) => {
  try {
    ok(res, await refund30(req.params.id));
  } catch (e) {
    next(e);
  }
});

/** 逾期作废扫描（cron 每日 00:10；幂等） */
periodRouter.post("/sweep", auth(["OPERATOR"]), async (_req, res, next) => {
  try {
    const n = await sweepExpired();
    ok(res, { expired: n });
  } catch (e) {
    next(e);
  }
});

/**
 * v2 周评估（cron 周一 00:10 跑上一 ISO 周）。
 * 停奖阶梯 pause1 → pause3 → exited 在这里真正推进；
 * 未核销期次在这里被算作未达标。
 */
periodRouter.post("/evaluate", auth(["OPERATOR"]), async (_req, res, next) => {
  try {
    const r = await evaluateAllWeeklyV2();
    ok(res, r);
  } catch (e) {
    next(e);
  }
});

/** 手动同步某周任务数据（8100 不可达后回补） */
periodRouter.post("/sync-task", auth(["OPERATOR"]), async (req, res, next) => {
  try {
    const body = z
      .object({
        enrollmentId: z.string().min(1),
        userId: z.string().min(1),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(req.body);
    ok(res, await syncRange(body.enrollmentId, body.userId, body.from, body.to));
  } catch (e) {
    next(e);
  }
});

/** 退费对账：扫描长时间 pending 的流水（进程崩溃残留） */
periodRouter.get("/refunds/stuck", auth(["OPERATOR"]), async (req, res, next) => {
  try {
    const minutes = Number(req.query.minutes) || 30;
    ok(res, await listStuckRefunds(minutes));
  } catch (e) {
    next(e);
  }
});

export default periodRouter;
