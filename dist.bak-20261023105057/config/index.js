"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
function required(name, fallback) {
    const v = process.env[name] ?? fallback;
    if (v === undefined || v === "") {
        throw new Error(`[config] 缺少必需环境变量: ${name}`);
    }
    return v;
}
function num(name, fallback) {
    const v = process.env[name];
    if (v === undefined || v === "")
        return fallback;
    const n = Number(v);
    if (Number.isNaN(n))
        throw new Error(`[config] 环境变量 ${name} 必须为数字`);
    return n;
}
exports.config = {
    port: num("PORT", 8080),
    nodeEnv: required("NODE_ENV", "development"),
    db: {
        host: process.env.DB_HOST ?? "127.0.0.1",
        port: num("DB_PORT", 3306),
        user: process.env.DB_USER ?? "root",
        password: process.env.DB_PASSWORD ?? "",
        database: process.env.DB_NAME ?? "yangyu_miandan",
    },
    jwt: {
        secret: required("JWT_SECRET"),
        accessTtl: num("JWT_ACCESS_TTL", 900),
        refreshTtl: num("JWT_REFRESH_TTL", 604800),
    },
    corsOrigins: (process.env.CORS_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    reward: {
        coverageCap: num("REWARD_COVERAGE_CAP", 1.0),
        perMerchantQuota: num("PER_MERCHANT_QUOTA", 200),
        yangyuWeeklyThreshold: num("YANGYU_WEEKLY_THRESHOLD", 5),
    },
    // 资金动账经主平台 wallet_service（X-Service-Key 服务间鉴权），不裸写表。
    wallet: {
        base: process.env.WALLET_BASE ?? "http://127.0.0.1:8100/api/v2",
        serviceKey: process.env.WALLET_SERVICE_KEY ?? "",
    },
};
//# sourceMappingURL=index.js.map