"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeHost = normalizeHost;
exports.codeFromHost = codeFromHost;
exports.resolveOwner = resolveOwner;
exports.isTrustedAddress = isTrustedAddress;
exports.resolveRequestTenant = resolveRequestTenant;
exports.tenantContext = tenantContext;
exports.requireTenant = requireTenant;
exports.tenantOf = tenantOf;
exports.__resetTenantCache = __resetTenantCache;
const config_1 = require("../config");
const db_1 = require("../lib/db");
const logger_1 = require("../lib/logger");
const errors_1 = require("../lib/errors");
// ─────────────────────────── 纯函数（可单测，无 IO） ───────────────────────────
/**
 * 归一化主机名：去协议、去端口、转小写、去尾部点（`ai.ws.hi.cn.` 是合法 FQDN 写法）。
 * 空值一律返回 ""，由调用方当作「无信号」处理。
 */
function normalizeHost(raw) {
    if (!raw)
        return "";
    let s = String(raw).trim().toLowerCase();
    if (!s)
        return "";
    if (s.includes("://")) {
        try {
            s = new URL(s).hostname.toLowerCase();
        }
        catch {
            return "";
        }
    }
    s = s.replace(/:\d+$/, "");
    s = s.replace(/\.+$/, "");
    return s;
}
/**
 * 域名 → 归属。三级判定，顺序不能换：
 *   1. 精确映射（含别名/自定义域，如 shop.mica178.com → yx）
 *   2. 平台自用域（ws.hi.cn / www.ws.hi.cn）→ platform，不归属任何租户
 *   3. 一级子域推导（xxx.ws.hi.cn → xxx）—— 这一步让**新增租户不必改代码**
 *
 * 第 3 步故意不校验 code 是否已登记：未知 code 会在查表时被判「未知租户」，
 * 比在这里猜「这个子域该不该存在」更准（租户是数据，不是代码常量）。
 */
function codeFromHost(host, reg) {
    const h = normalizeHost(host);
    if (!h)
        return { kind: "unknown" };
    const exact = reg.map[h];
    if (exact)
        return { kind: "tenant", code: exact };
    if (reg.platformHosts.includes(h))
        return { kind: "platform" };
    for (const suffix of reg.subdomainSuffixes) {
        if (!suffix)
            continue;
        if (!h.endsWith("." + suffix))
            continue;
        const label = h.slice(0, h.length - suffix.length - 1);
        // 只认单层子域；多段（a.b.ws.hi.cn）不猜
        if (!label || label.includes("."))
            continue;
        if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(label))
            continue;
        return { kind: "tenant", code: label };
    }
    return { kind: "unknown" };
}
/**
 * 多信号合并。冲突规则：Host 与 Origin 指向**不同租户**时判冲突。
 *
 * 这不是洁癖：CORS 放开了任意 *.ws.hi.cn，所以 h6 页面完全可以向 ai 域名发请求。
 * 若按 Host 记 ai、按 Origin 记 h6，归属就随代码路径漂移，月底对不出账。
 * 冲突交给调用方决定（strict 拒绝 / shadow 告警），这里只负责识别。
 */
function resolveOwner(signals, reg) {
    const hostOwner = codeFromHost(signals.host ?? "", reg);
    const originHost = normalizeHost(signals.origin) || normalizeHost(signals.referer);
    const originBy = normalizeHost(signals.origin) ? "origin" : "referer";
    const originOwner = originHost ? codeFromHost(originHost, reg) : { kind: "unknown" };
    const hostCode = hostOwner.kind === "tenant" ? hostOwner.code : null;
    const originCode = originOwner.kind === "tenant" ? originOwner.code : null;
    if (hostCode && originCode && hostCode !== originCode) {
        return {
            owner: hostOwner,
            decidedBy: "host",
            conflict: `host=${hostCode} ${originBy}=${originCode}`,
        };
    }
    if (hostOwner.kind === "tenant")
        return { owner: hostOwner, decidedBy: "host" };
    if (originOwner.kind === "tenant")
        return { owner: originOwner, decidedBy: originBy };
    if (hostOwner.kind === "platform")
        return { owner: hostOwner, decidedBy: "host" };
    if (originOwner.kind === "platform")
        return { owner: originOwner, decidedBy: originBy };
    return { owner: { kind: "unknown" }, decidedBy: "none" };
}
/**
 * 是否可信代理地址（回环 / 内网 / 显式白名单）。
 *
 * 用途只有一个：判断「没有来源域名」的请求是不是平台自己发的（运维脚本、本机 curl）。
 * 不能拿它放行业务 —— 它只影响 defaultCode 兜底能不能用。
 */
function isTrustedAddress(ip) {
    const a = String(ip ?? "").trim();
    if (!a)
        return false;
    const bare = a.startsWith("::ffff:") ? a.slice(7) : a;
    if (bare === "127.0.0.1" || bare === "::1" || bare === "localhost")
        return true;
    if (config_1.config.tenant.trustedProxies.includes(bare))
        return true;
    if (/^10\./.test(bare))
        return true;
    if (/^192\.168\./.test(bare))
        return true;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(bare))
        return true;
    return false;
}
/**
 * 表缺失后的重探间隔。
 *
 * 不设这个会有一个静默失效：pre-007 进程启动 → 表不存在 → 永久走配置兜底；
 * 之后补跑 007 也不恢复（要等重启）。而配置兜底的 caps 是 null，
 * 意味着能力开关全部失效 —— 上线顺序一变就变成「以为按表跑，其实按常量跑」。
 */
const TABLE_RETRY_MS = 5 * 60_000;
let _tableState = "unknown";
let _tableRetryAt = 0;
const _cache = new Map();
/** 表缺失只告警一次：每请求打一条会把日志刷爆，真正的告警反而看不见 */
function markTableMissing(err) {
    _tableRetryAt = Date.now() + TABLE_RETRY_MS;
    if (_tableState === "missing")
        return;
    _tableState = "missing";
    logger_1.logger.warn({ err: String(err?.message || err), retryInMs: TABLE_RETRY_MS }, "tenant 表不可用（007 未执行？），回落 config.tenant.domainMap 兜底");
}
function parseCaps(raw) {
    if (raw == null)
        return null;
    if (typeof raw === "object")
        return raw;
    if (typeof raw === "string") {
        const s = raw.trim();
        if (!s)
            return null;
        try {
            const v = JSON.parse(s);
            return v && typeof v === "object" ? v : null;
        }
        catch {
            // caps 是 JSON 列，解析不了说明写入侧坏了；不放行也不抛错，按「无能力」处理
            logger_1.logger.warn({ raw: s.slice(0, 120) }, "tenant.caps 不是合法 JSON，按无能力处理");
            return null;
        }
    }
    return null;
}
function normalizeStatus(raw) {
    const s = String(raw ?? "").trim().toLowerCase();
    if (s === "active" || s === "paused" || s === "retired")
        return s;
    // 未知状态按 paused（不可写）处理：新枚举值上线时，宁可少写一手，不可多写一笔
    return "paused";
}
function fromConfig(code) {
    const registered = Object.values(config_1.config.tenant.domainMap).includes(code) || config_1.config.tenant.defaultCode === code;
    if (!registered)
        return null;
    return {
        id: `cfg:${code}`,
        code,
        name: code,
        status: "active",
        caps: null,
        source: "config",
    };
}
/**
 * 按 code 取租户。负结果同样缓存：未知 code 每个请求都打一次库，等于给攻击者一个放大器。
 * 库不可用时不抛错 —— 抛错会让整站 500；这里退到配置兜底，并把 source 标成 config，
 * 留痕给运维，而不是让业务静默用错租户。
 */
async function loadTenant(code) {
    const now = Date.now();
    const hit = _cache.get(code);
    if (hit && hit.exp > now)
        return hit.value;
    let value = null;
    // 命中过「表缺失」也不永久关闭：过一个重探窗口再试，免得 007 补跑后进程还按常量跑
    const tableUsable = _tableState !== "missing" || now >= _tableRetryAt;
    if (tableUsable) {
        if (_tableState === "missing")
            _tableState = "unknown";
        try {
            const res = await (0, db_1.query)("SELECT id, code, name, status, caps FROM tenant WHERE code = ? LIMIT 1", [code]);
            _tableState = "ok";
            const row = res.rows[0];
            value = row
                ? {
                    id: String(row.id),
                    code: String(row.code),
                    name: String(row.name),
                    status: normalizeStatus(row.status),
                    caps: parseCaps(row.caps),
                    source: "table",
                }
                : fromConfig(code);
        }
        catch (err) {
            const msg = String(err?.message || err);
            // 1146 = ER_NO_SUCH_TABLE；兼容 mysql2 的 code 字段
            if (err?.code === "ER_NO_SUCH_TABLE" || /1146|doesn't exist|does not exist/i.test(msg)) {
                markTableMissing(err);
            }
            else {
                logger_1.logger.error({ code, err: msg }, "tenant 表查询失败，本次走配置兜底");
            }
            value = fromConfig(code);
        }
    }
    else {
        value = fromConfig(code);
    }
    if (_cache.size >= config_1.config.tenant.cacheMax) {
        for (const [k, v] of _cache)
            if (v.exp <= now)
                _cache.delete(k);
        if (_cache.size >= config_1.config.tenant.cacheMax) {
            let drop = 0;
            for (const k of _cache.keys()) {
                _cache.delete(k);
                if (++drop >= Math.ceil(config_1.config.tenant.cacheMax / 2))
                    break;
            }
        }
    }
    _cache.set(code, { value, exp: now + config_1.config.tenant.cacheTtlMs });
    return value;
}
function registry() {
    return {
        map: config_1.config.tenant.domainMap,
        platformHosts: config_1.config.tenant.platformHosts,
        subdomainSuffixes: config_1.config.tenant.subdomainSuffixes,
    };
}
// ─────────────────────────── 中间件 ───────────────────────────
/** 不过租户链路的路径：健康检查由负载均衡/隧道每分钟打一次，不该受租户判定影响 */
const EXEMPT = new Set(["/health", "/ready"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/**
 * 把 req 解析成一笔「归属结论」。拆出来是为了能单测，
 * 也是为了以后在 SDK 聚合层、脚本里复用同一套口径（不许各写一份）。
 */
async function resolveRequestTenant(req) {
    const reg = registry();
    const h = req.headers;
    const { owner, decidedBy, conflict } = resolveOwner({ host: h.host, origin: h.origin, referer: h.referer }, reg);
    if (conflict) {
        // 冲突时仍按 Host 归属（Host 才是被访问的站点），但把结论标成应拒绝
        const t = owner.kind === "tenant" ? await loadTenant(owner.code) : null;
        return {
            tenant: t,
            decidedBy,
            conflict,
            rejectReason: "请求来源与访问域名不属于同一租户",
            rejectCode: 403,
        };
    }
    if (owner.kind === "tenant") {
        const t = await loadTenant(owner.code);
        if (!t) {
            return {
                tenant: null,
                decidedBy,
                rejectReason: `未知租户：${owner.code}`,
                rejectCode: 403,
            };
        }
        if (t.status === "retired") {
            return { tenant: t, decidedBy, rejectReason: `租户已下线：${t.code}`, rejectCode: 403 };
        }
        if (t.status === "paused" && WRITE_METHODS.has(String(req.method).toUpperCase())) {
            return { tenant: t, decidedBy, rejectReason: `租户已暂停，暂不可写：${t.code}`, rejectCode: 403 };
        }
        return { tenant: t, decidedBy };
    }
    if (owner.kind === "platform") {
        // 平台自用域（控制台/运维）：不归属任何租户，放行但 req.tenant 留空
        return { tenant: null, decidedBy };
    }
    // 无来源域名：只有可信来源 + 配了 defaultCode 才兜底
    if (isTrustedAddress(req.socket?.remoteAddress) && config_1.config.tenant.defaultCode) {
        const t = await loadTenant(config_1.config.tenant.defaultCode);
        if (t)
            return { tenant: t, decidedBy: "default" };
    }
    return {
        tenant: null,
        decidedBy,
        rejectReason: "无法判定租户归属",
        rejectCode: 403,
    };
}
async function tenantContext(req, res, next) {
    const mode = config_1.config.tenant.enforce;
    if (mode === "off")
        return next();
    if (EXEMPT.has(req.path ?? req.url))
        return next();
    let outcome;
    try {
        outcome = await resolveRequestTenant(req);
    }
    catch (err) {
        // 解析器自身异常绝不 500：strict 下拒绝，shadow/off 下放行并告警
        logger_1.logger.error({ err: String(err?.message || err), path: req.path }, "tenant 解析异常");
        if (mode === "strict") {
            res.status(403).json({ code: 403, message: "无法判定租户归属" });
            return;
        }
        return next();
    }
    if (outcome.tenant) {
        req.tenant = outcome.tenant;
        req.tenantDecidedBy = outcome.decidedBy;
    }
    if (outcome.rejectReason) {
        const detail = {
            path: req.path,
            method: req.method,
            host: normalizeHost(String(req.headers.host ?? "")),
            origin: normalizeHost(String(req.headers.origin ?? "")),
            code: outcome.tenant?.code ?? "",
            decidedBy: outcome.decidedBy,
            conflict: outcome.conflict ?? "",
            reason: outcome.rejectReason,
        };
        if (mode === "strict") {
            logger_1.logger.warn(detail, "tenant_rejected");
            res.status(outcome.rejectCode ?? 403).json({ code: outcome.rejectCode ?? 403, message: outcome.rejectReason });
            return;
        }
        logger_1.logger.warn(detail, "tenant_shadow_would_reject");
    }
    return next();
}
/**
 * 业务侧取租户（唯一入口）。
 * 写路径必须用它，不要直接读 req.tenant —— 直接读会漏掉 status 校验，
 * 已暂停的租户照样能下单。
 */
function requireTenant(req) {
    const t = req.tenant;
    if (!t)
        throw (0, errors_1.forbidden)("无法判定租户归属，拒绝写入");
    if (t.status === "retired")
        throw (0, errors_1.forbidden)("该租户已下线");
    if (t.status === "paused")
        throw (0, errors_1.forbidden)("该租户已暂停");
    return t;
}
/** 只读路径取租户：无租户就返回 null，由查询层决定是否按「全部」或不返回 */
function tenantOf(req) {
    return req.tenant ?? null;
}
/** @internal 仅供单测重置模块级缓存与表状态；生产代码不得调用 */
function __resetTenantCache() {
    _cache.clear();
    _tableState = "unknown";
    _tableRetryAt = 0;
}
//# sourceMappingURL=tenant.js.map