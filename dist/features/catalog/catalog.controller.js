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
exports.catalogRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../../middleware/auth");
const http_1 = require("../../lib/http");
const svc = __importStar(require("./catalog.service"));
const createSchema = zod_1.z.object({
    merchantId: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1).max(120),
    category: zod_1.z.string().max(32).nullish(),
    coverUrl: zod_1.z.string().max(512).nullish(),
    spec: zod_1.z.string().max(255).nullish(),
    originPrice: zod_1.z.number().nonnegative().nullish(),
});
const updateSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(120).optional(),
    category: zod_1.z.string().max(32).nullable().optional(),
    coverUrl: zod_1.z.string().max(512).nullable().optional(),
    spec: zod_1.z.string().max(255).nullable().optional(),
    originPrice: zod_1.z.number().nonnegative().nullable().optional(),
});
exports.catalogRouter = (0, express_1.Router)();
/** 商户新建自有商品（商品库）。OPERATOR 也可代建。 */
exports.catalogRouter.post("/", (0, auth_1.auth)(["MERCHANT", "OPERATOR"]), async (req, res, next) => {
    try {
        const body = createSchema.parse(req.body);
        const product = await svc.createProduct(body, {
            role: req.user.role,
            merchantId: req.user.merchantId,
        });
        (0, http_1.created)(res, product);
    }
    catch (e) {
        next(e);
    }
});
/** 列商品：MERCHANT 看自己（:merchantId 即自己）；OPERATOR 可传任意 merchantId 或省略看全部 */
exports.catalogRouter.get("/merchant/:merchantId", (0, auth_1.auth)(["MERCHANT", "OPERATOR"]), async (req, res, next) => {
    try {
        const products = await svc.listProducts(req.params.merchantId, {
            role: req.user.role,
            merchantId: req.user.merchantId,
        });
        (0, http_1.ok)(res, products);
    }
    catch (e) {
        next(e);
    }
});
exports.catalogRouter.get("/all", (0, auth_1.auth)(["OPERATOR"]), async (_req, res, next) => {
    try {
        (0, http_1.ok)(res, await svc.listProducts("", { role: "OPERATOR" }));
    }
    catch (e) {
        next(e);
    }
});
exports.catalogRouter.put("/:id", (0, auth_1.auth)(["MERCHANT", "OPERATOR"]), async (req, res, next) => {
    try {
        const body = updateSchema.parse(req.body);
        const product = await svc.updateProductById(req.params.id, body, {
            role: req.user.role,
            merchantId: req.user.merchantId,
        });
        (0, http_1.ok)(res, product);
    }
    catch (e) {
        next(e);
    }
});
exports.catalogRouter.post("/:id/status", (0, auth_1.auth)(["MERCHANT", "OPERATOR"]), async (req, res, next) => {
    try {
        const status = zod_1.z.enum(["active", "offline"]).parse(req.body.status);
        const product = await svc.setStatus(req.params.id, status, {
            role: req.user.role,
            merchantId: req.user.merchantId,
        });
        (0, http_1.ok)(res, product);
    }
    catch (e) {
        next(e);
    }
});
exports.default = exports.catalogRouter;
//# sourceMappingURL=catalog.controller.js.map