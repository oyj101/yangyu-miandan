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
/** 枚举型配置：非法值直接抛错。静默回落会让 "stict" 这类拼写错误变成「以为开了严格，其实没有」 */
function oneOf(name, allowed, fallback) {
    const v = process.env[name];
    if (v === undefined || v === "")
        return fallback;
    const lv = v.trim().toLowerCase();
    if (!allowed.includes(lv)) {
        throw new Error(`[config] 环境变量 ${name} 只能取 ${allowed.join(" / ")}，收到: ${v}`);
    }
    return lv;
}
/** 域名映射型配置：{"host":"租户码"} 的 JSON。写错直接抛错，不静默吞掉 */
function hostMap(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        throw new Error(`[config] ${name} 不是合法 JSON: ${e.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`[config] ${name} 必须是 {"域名":"租户码"} 形式的对象`);
    }
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== "string" || !v.trim() || !k.trim())
            continue;
        out[k.trim().toLowerCase()] = v.trim();
    }
    return Object.keys(out).length ? out : fallback;
}
/**
 * 租户域名缺省映射（与 8100 `_HOST_TENANT` 同口径，2026-10-20 据 139 nginx 日志采样）。
 * 仅作 007 tenant 表落地前的兜底；表存在时以表为准。
 * ws.hi.cn / www.ws.hi.cn 是平台自用（控制台/运维），不归属任何租户。
 */
const DEFAULT_TENANT_DOMAINS = {
    "ai.ws.hi.cn": "ai",
    "h6.ws.hi.cn": "h6",
    "h9.ws.hi.cn": "h9",
    "octoai.ws.hi.cn": "octoai",
    "h5.ws.hi.cn": "h5",
    "plan.ws.hi.cn": "plan",
    "yx.ws.hi.cn": "yx",
    "octo.ws.hi.cn": "octo",
};
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
    // v2 套餐卡（2026-10-20 PO 拍板）
    package: {
        streakDays: num("YANGYU_STREAK_DAYS", 5),
        refundRatioNow: num("YANGYU_REFUND_RATIO_NOW", 0.7),
        refundRatioShare: num("YANGYU_REFUND_RATIO_SHARE", 0.3),
        // 供应价率红线：c ≤ 0.3 时「达标未分享」净额 = 0.3P − C ≥ 0，
        // 即核销环节不亏，唯一支出是分享退（应按 CAC 立项）。超过此值建卡需二次确认。
        supplyRatioMax: num("YANGYU_SUPPLY_RATIO_MAX", 0.3),
        budgetWarnRatio: num("YANGYU_BUDGET_WARN_RATIO", 1.2),
        /**
         * 分享解锁范围：all（默认，2026-10-21 PO 拍板）= 该分享者名下全部未解锁卡；
         * card = 只解锁被分享的那张卡。比例逐卡取值（card.share_ratio），不是全局 0.3。
         */
        shareUnlockScope: (process.env.SHARE_UNLOCK_SCOPE === "card" ? "card" : "all"),
        /** 新建卡未指定比例时的缺省分享分成（仍会写入 card.share_ratio 快照） */
        shareRatioDefault: num("YANGYU_SHARE_RATIO", 0.3),
        /** 单卡分享分成上限：超过 1-c 时核销即时退部分已不足以覆盖供应价，必然亏损 */
        shareRatioMax: num("YANGYU_SHARE_RATIO_MAX", 0.5),
    },
    /**
     * 分享 / 关系链。
     * 关系真源在主站（8100），这里只有「怎么把用户带到主站落地页」的配置：
     *   链接模板与参数名属于主站路由契约，写死在代码里意味着主站改一次路由要发一次版。
     */
    share: {
        linkTemplate: process.env.SHARE_LINK_TEMPLATE ?? "https://ai.ws.hi.cn/yangyu?ref={ref}",
        refParam: process.env.SHARE_REF_PARAM ?? "ref",
        chainTimeoutMs: num("SHARE_CHAIN_TIMEOUT_MS", 1500),
        /**
         * 绑定即解锁（默认开）：PO 口径「不管有没有交易，只要有分享都要绑定关系」。
         * 关掉后退回旧口径（需被分享人成交才解锁），用于风控期临时收紧，不必改代码。
         */
        unlockOnBind: process.env.SHARE_UNLOCK_ON_BIND !== "false",
        /**
         * 归因策略：first（默认）= 首触锁定，一个被分享者只归一任分享者；
         * last = 末触覆盖（群内多人转发时归最后一位，需自行承担争抢客诉）。
         */
        bindPolicy: (process.env.SHARE_BIND_POLICY === "last" ? "last" : "first"),
        /** 主站推荐关系兜底：关系链数据缺失时，是否仍按 zy_users 判定（默认关，避免双口径打架） */
        fallbackReferrer: process.env.SHARE_FALLBACK_REFERRER === "true",
    },
    /** 埋点保留期（天）；超过由 daily-ops 清理 */
    track: {
        retentionDays: num("SDK_TRACK_RETENTION_DAYS", 90),
    },
    /**
     * 租户上下文（归属判定，非身份判定）。
     *
     * 与 8100 `admin_tenant_gate.py` 的分工必须分清：
     *   8100 gate = 门禁，只管 3 条 admin 前缀，输出 allow/deny，清单硬编码在 py dict；
     *   本服务 tenant = 上下文，给业务面回答「这条数据属于哪个租户」，输出对象。
     *
     * enforce 三档，默认 shadow（只观测不拒绝），与 8100「影子 → 严格」的迁移纪律一致：
     *   off    = 完全不解析（回滚开关，等于回到单租户行为）
     *   shadow = 解析 + 挂 req.tenant + 该拒的只告警不拒（先看命中率再切）
     *   strict = 推导不出 / 来源冲突 / 租户已下线 → 403 fail-closed
     */
    tenant: {
        enforce: oneOf("TENANT_ENFORCE", ["off", "shadow", "strict"], "shadow"),
        /** 内部调用（运维脚本 / 本机 curl）无法从域名推导时的缺省租户；留空则不兜底 */
        defaultCode: process.env.TENANT_DEFAULT_CODE ?? "",
        /** 域名 → 租户码；可用 TENANT_DOMAIN_MAP 覆盖（别名域、自定义域走这里） */
        domainMap: hostMap("TENANT_DOMAIN_MAP", DEFAULT_TENANT_DOMAINS),
        /** 视为平台自用、不归属租户的域名（控制台 / 运维入口） */
        platformHosts: (process.env.TENANT_PLATFORM_HOSTS ?? "ws.hi.cn,www.ws.hi.cn")
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
        /** 一级子域自动推导后缀：<code>.ws.hi.cn → code，新增租户不必改代码 */
        subdomainSuffixes: (process.env.TENANT_SUBDOMAIN_SUFFIXES ?? "ws.hi.cn")
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
        /** tenant 表查询缓存；租户信息变更少，60s 足够，改库后最多延迟一个 TTL */
        cacheTtlMs: num("TENANT_CACHE_TTL_MS", 60_000),
        cacheMax: num("TENANT_CACHE_MAX", 200),
        /** 额外可信代理地址（回环 / 内网段已在代码里内置，这里只补特殊 IP） */
        trustedProxies: (process.env.TENANT_TRUSTED_PROXIES ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    },
    // 资金动账经主平台 wallet_service（X-Service-Key 服务间鉴权），不裸写表。
    wallet: {
        base: process.env.WALLET_BASE ?? "http://127.0.0.1:8100/api/v2",
        serviceKey: process.env.WALLET_SERVICE_KEY ?? "",
    },
};
//# sourceMappingURL=index.js.map