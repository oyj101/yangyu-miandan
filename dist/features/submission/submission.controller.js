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
exports.submissionRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../../middleware/auth");
const http_1 = require("../../lib/http");
const svc = __importStar(require("./submission.service"));
const createSchema = zod_1.z.object({
    merchantId: zod_1.z.string().min(1),
    productId: zod_1.z.string().min(1),
    supplyPrice: zod_1.z.number().nonnegative(),
    quota: zod_1.z.number().int().positive(),
});
const reviewSchema = zod_1.z.object({
    approve: zod_1.z.boolean(),
    rejectReason: zod_1.z.string().optional(),
});
exports.submissionRouter = (0, express_1.Router)();
/** 商户提报：选商品 + 活动供应价 + 参与数量 */
exports.submissionRouter.post("/", (0, auth_1.auth)(["MERCHANT", "OPERATOR"]), async (req, res, next) => {
    try {
        const body = createSchema.parse(req.body);
        const sub = await svc.createSubmission(body, {
            role: req.user.role,
            merchantId: req.user.merchantId,
        });
        (0, http_1.created)(res, sub);
    }
    catch (e) {
        next(e);
    }
});
/** 列提报：MERCHANT 看自己(:merchantId)；OPERATOR 看待审队列 */
exports.submissionRouter.get("/merchant/:merchantId", (0, auth_1.auth)(["MERCHANT", "OPERATOR"]), async (req, res, next) => {
    try {
        const subs = await svc.listSubmissions(req.params.merchantId, {
            role: req.user.role,
            merchantId: req.user.merchantId,
        });
        (0, http_1.ok)(res, subs);
    }
    catch (e) {
        next(e);
    }
});
exports.submissionRouter.get("/pending", (0, auth_1.auth)(["OPERATOR"]), async (_req, res, next) => {
    try {
        (0, http_1.ok)(res, await svc.listSubmissions("", { role: "OPERATOR" }));
    }
    catch (e) {
        next(e);
    }
});
/** OPERATOR 审核提报 */
exports.submissionRouter.post("/:id/review", (0, auth_1.auth)(["OPERATOR"]), async (req, res, next) => {
    try {
        const body = reviewSchema.parse(req.body);
        const sub = await svc.reviewSubmission(req.params.id, body.approve, req.user.userId, body.rejectReason);
        (0, http_1.ok)(res, sub);
    }
    catch (e) {
        next(e);
    }
});
exports.default = exports.submissionRouter;
//# sourceMappingURL=submission.controller.js.map