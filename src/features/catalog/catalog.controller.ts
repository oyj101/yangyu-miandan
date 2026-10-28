import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth";
import { ok, created } from "../../lib/http";
import * as svc from "./catalog.service";

const createSchema = z.object({
  merchantId: z.string().min(1),
  name: z.string().min(1).max(120),
  category: z.string().max(32).nullish(),
  coverUrl: z.string().max(512).nullish(),
  spec: z.string().max(255).nullish(),
  originPrice: z.number().nonnegative().nullish(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  category: z.string().max(32).nullable().optional(),
  coverUrl: z.string().max(512).nullable().optional(),
  spec: z.string().max(255).nullable().optional(),
  originPrice: z.number().nonnegative().nullable().optional(),
});

export const catalogRouter = Router();

/** 商户新建自有商品（商品库）。OPERATOR 也可代建。 */
catalogRouter.post("/", auth(["MERCHANT", "OPERATOR"]), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const product = await svc.createProduct(body, {
      role: req.user!.role as "MERCHANT" | "OPERATOR",
      merchantId: req.user!.merchantId,
    });
    created(res, product);
  } catch (e) {
    next(e);
  }
});

/** 列商品：MERCHANT 看自己（:merchantId 即自己）；OPERATOR 可传任意 merchantId 或省略看全部 */
catalogRouter.get("/merchant/:merchantId", auth(["MERCHANT", "OPERATOR"]), async (req, res, next) => {
  try {
    const products = await svc.listProducts(req.params.merchantId, {
      role: req.user!.role,
      merchantId: req.user!.merchantId,
    });
    ok(res, products);
  } catch (e) {
    next(e);
  }
});

catalogRouter.get("/all", auth(["OPERATOR"]), async (_req, res, next) => {
  try {
    ok(res, await svc.listProducts("", { role: "OPERATOR" }));
  } catch (e) {
    next(e);
  }
});

catalogRouter.put("/:id", auth(["MERCHANT", "OPERATOR"]), async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);
    const product = await svc.updateProductById(req.params.id, body, {
      role: req.user!.role,
      merchantId: req.user!.merchantId,
    });
    ok(res, product);
  } catch (e) {
    next(e);
  }
});

catalogRouter.post("/:id/status", auth(["MERCHANT", "OPERATOR"]), async (req, res, next) => {
  try {
    const status = z.enum(["active", "offline"]).parse(req.body.status);
    const product = await svc.setStatus(req.params.id, status, {
      role: req.user!.role,
      merchantId: req.user!.merchantId,
    });
    ok(res, product);
  } catch (e) {
    next(e);
  }
});

export default catalogRouter;
