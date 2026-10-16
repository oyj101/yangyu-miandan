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
exports.enrollmentRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../../middleware/auth");
const http_1 = require("../../lib/http");
const svc = __importStar(require("./enrollment.service"));
const purchaseSchema = zod_1.z.object({ cardId: zod_1.z.string().min(1) });
exports.enrollmentRouter = (0, express_1.Router)();
exports.enrollmentRouter.post("/purchase", (0, auth_1.auth)(["USER"]), async (req, res, next) => {
    try {
        const { cardId } = purchaseSchema.parse(req.body);
        const e = await svc.purchase(req.user.userId, cardId);
        (0, http_1.created)(res, e);
    }
    catch (e2) {
        next(e2);
    }
});
exports.enrollmentRouter.get("/:id", (0, auth_1.auth)(["USER", "MERCHANT", "OPERATOR", "CASHIER"]), async (req, res, next) => {
    try {
        const e = await svc.getEnrollment(req.params.id);
        (0, http_1.ok)(res, e);
    }
    catch (e2) {
        next(e2);
    }
});
// F7 任务名单集合页（商户侧）
exports.enrollmentRouter.get("/merchant/:merchantId", (0, auth_1.auth)(["MERCHANT", "OPERATOR", "CASHIER"]), async (req, res, next) => {
    try {
        const statusFilter = req.query.status;
        const list = await svc.listMerchantEnrollments(req.params.merchantId, statusFilter);
        (0, http_1.ok)(res, list);
    }
    catch (e2) {
        next(e2);
    }
});
exports.default = exports.enrollmentRouter;
//# sourceMappingURL=enrollment.controller.js.map