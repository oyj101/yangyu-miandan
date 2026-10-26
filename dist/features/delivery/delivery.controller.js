"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.deliveryRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../../middleware/auth");
const http_1 = require("../../lib/http");
const svc = __importStar(require("./delivery.service"));
const delivery_types_1 = require("./delivery.types");
const statusEnum = zod_1.z.enum(["pending", "shipped", "delivered", "signed", "cancelled"]);
const shipSchema = zod_1.z.object({
    courier: zod_1.z.string().max(64).nullish(),
    trackingNo: zod_1.z.string().max(64).nullish(),
    remark: zod_1.z.string().max(255).nullish(),
});
const deliverSchema = zod_1.z.object({
    /** 一步到签收（商户代签，适用于当面交付/无需用户点确认） */
    autoSign: zod_1.z.boolean().optional(),
    remark: zod_1.z.string().max(255).nullish(),
});
const signSchema = zod_1.z.object({
    remark: zod_1.z.string().max(255).nullish(),
});
function actorOf(u) {
    return { userId: u.userId, role: u.role, merchantId: u.merchantId };
}
exports.deliveryRouter = (0, express_1.Router)();
/** C 端：我的配送进度（可按 enrollmentId 过滤） */
exports.deliveryRouter.get("/mine", (0, auth_1.auth)(), async (req, res, next) => {
    try {
        const enrollmentId = req.query.enrollmentId ? String(req.query.enrollmentId) : undefined;
        const list = await svc.listMine(req.user.userId, enrollmentId);
        (0, http_1.ok)(res, list.map((t) => ({ ...t, statusText: delivery_types_1.DELIVERY_STATUS_TEXT[t.status] })));
    }
    catch (e) {
        next(e);
    }
});
/** 商户端：待办配送列表 */
exports.deliveryRouter.get("/merchant", (0, auth_1.auth)(["MERCHANT", "CASHIER", "OPERATOR"]), async (req, res, next) => {
    try {
        const statusRaw = req.query.status ? String(req.query.status) : "";
        const status = statusRaw && statusEnum.safeParse(statusRaw).success
            ? statusRaw
            : undefined;
        const merchantId = req.query.merchantId ? String(req.query.merchantId) : undefined;
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        const list = await svc.listMerchantTasks(actorOf(req.user), { status, limit, merchantId });
        (0, http_1.ok)(res, list.map((t) => ({ ...t, statusText: delivery_types_1.DELIVERY_STATUS_TEXT[t.status] })));
    }
    catch (e) {
        next(e);
    }
});
/** 商户：配送上门（发货）。运费未确认前会被闸门拦住 */
exports.deliveryRouter.post("/:id/ship", (0, auth_1.auth)(["MERCHANT", "CASHIER", "OPERATOR"]), async (req, res, next) => {
    try {
        const body = shipSchema.parse(req.body ?? {});
        const task = await svc.shipTask(req.params.id, actorOf(req.user), body);
        (0, http_1.ok)(res, { ...task, statusText: delivery_types_1.DELIVERY_STATUS_TEXT[task.status] });
    }
    catch (e) {
        next(e);
    }
});
/** 商户：回传配送完成（可 autoSign 一步到签收） */
exports.deliveryRouter.post("/:id/deliver", (0, auth_1.auth)(["MERCHANT", "CASHIER", "OPERATOR"]), async (req, res, next) => {
    try {
        const body = deliverSchema.parse(req.body ?? {});
        const r = await svc.deliverTask(req.params.id, actorOf(req.user), body);
        (0, http_1.created)(res, { ...r.task, statusText: delivery_types_1.DELIVERY_STATUS_TEXT[r.task.status], checkin: r.checkin });
    }
    catch (e) {
        next(e);
    }
});
/** 用户本人 / 商户代签：签收确认 = 配送场景的核销 */
exports.deliveryRouter.post("/:id/sign", (0, auth_1.auth)(), async (req, res, next) => {
    try {
        const body = signSchema.parse(req.body ?? {});
        const r = await svc.signTask(req.params.id, actorOf(req.user), body);
        (0, http_1.created)(res, { ...r.task, statusText: delivery_types_1.DELIVERY_STATUS_TEXT[r.task.status], checkin: r.checkin });
    }
    catch (e) {
        next(e);
    }
});
exports.default = exports.deliveryRouter;
//# sourceMappingURL=delivery.controller.js.map