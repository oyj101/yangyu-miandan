/**
 * 租户上下文解析（本服务唯一实现）
 *
 * 为什么写这个：8100 的 `services/admin_tenant_gate.py` 是**门禁**，不是**上下文**。
 *   · 作用域只有 `/api/v2/admin/`、`/api/v2/safety/admin/`、`/api/v2/dao/admin/` 三条前缀；
 *   · 输出只有 allow / deny 布尔值，不产出对象、不注入 tenant_id、不进业务 SQL；
 *   · 租户清单 `TENANT_ALLOW` 硬编码在 Python dict 里（8 个租户写死）；
 *   · 它跑在 8100（Python），本服务是 Node 独立进程 —— 就算那边做满了，这边也调不到。
 *
 * 所以业务面（卡、入渔、核销、分账、商户）此前**没有任何租户归属**，
 * `grep tenant src/` 在 007 之前命中 0 处。这一层补的就是这个空。
 *
 * 三条铁律：
 *   1. 租户身份只从**服务端可校验的来源**推导（Host / Origin / Referer）。
 *      绝不读客户端自报的 `X-Tenant-*` 头 —— ADR-116 的原坑正是「去掉头即可绕过全部限制」。
 *   2. 租户只决定**归属与可见范围**，绝不决定**身份**。谁是谁仍归 federation.ts / auth.ts。
 *   3. 推导不出就 fail-closed（strict）。但默认 shadow：先只观测不拒绝，
 *      与 8100「影子 → 严格」的迁移纪律一致 —— 一上线就 403 等于拿生产做灰度。
 *
 * 数据源：表优先（007 `tenant` 表）、配置兜底。
 *   007 未执行时表不存在（ER_NO_SUCH_TABLE 1146）→ 回落 config.tenant.domainMap，
 *   同一份代码在 007 前后都能跑，不需要二次改代码，也不需要在迁移窗口停服。
 */
import { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { query } from "../lib/db";
import { logger } from "../lib/logger";
import { forbidden } from "../lib/errors";

export type TenantStatus = "active" | "paused" | "retired";

export interface Tenant {
  id: string;
  code: string;
  name: string;
  status: TenantStatus;
  /** 能力开关（原样透传 tenant.caps JSON；与 nav[]/live[]/TENANT_ALLOW 同源） */
  caps: Record<string, unknown> | null;
  /** table = 007 已落地；config = 表缺失时的兜底。排查「为什么这个租户显示成这样」必看 */
  source: "table" | "config";
}

/** 判定依据：host=访问域名，origin/referer=来源页，default=内部调用兜底 */
export type TenantSignal = "host" | "origin" | "referer" | "default" | "none";

export type HostOwner =
  | { kind: "tenant"; code: string }
  | { kind: "platform" }
  | { kind: "unknown" };

export interface DomainRegistry {
  map: Record<string, string>;
  platformHosts: string[];
  subdomainSuffixes: string[];
}

declare module "express-serve-static-core" {
  interface Request {
    /** 解析出的租户；undefined = 未解析出（shadow 放行 / off 模式） */
    tenant?: Tenant;
    /** 判定依据，写日志与审计用 */
    tenantDecidedBy?: TenantSignal;
  }
}

// ─────────────────────────── 纯函数（可单测，无 IO） ───────────────────────────

/**
 * 归一化主机名：去协议、去端口、转小写、去尾部点（`ai.ws.hi.cn.` 是合法 FQDN 写法）。
 * 空值一律返回 ""，由调用方当作「无信号」处理。
 */
export function normalizeHost(raw: string | undefined | null): string {
  if (!raw) return "";
  let s = String(raw).trim().toLowerCase();
  if (!s) return "";
  if (s.includes("://")) {
    try {
      s = new URL(s).hostname.toLowerCase();
    } catch {
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
export function codeFromHost(host: string, reg: DomainRegistry): HostOwner {
  const h = normalizeHost(host);
  if (!h) return { kind: "unknown" };

  const exact = reg.map[h];
  if (exact) return { kind: "tenant", code: exact };

  if (reg.platformHosts.includes(h)) return { kind: "platform" };

  for (const suffix of reg.subdomainSuffixes) {
    if (!suffix) continue;
    if (!h.endsWith("." + suffix)) continue;
    const label = h.slice(0, h.length - suffix.length - 1);
    // 只认单层子域；多段（a.b.ws.hi.cn）不猜
    if (!label || label.includes(".")) continue;
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(label)) continue;
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
export function resolveOwner(
  signals: { host?: string; origin?: string; referer?: string },
  reg: DomainRegistry
): { owner: HostOwner; decidedBy: TenantSignal; conflict?: string } {
  const hostOwner = codeFromHost(signals.host ?? "", reg);

  const originHost = normalizeHost(signals.origin) || normalizeHost(signals.referer);
  const originBy: TenantSignal = normalizeHost(signals.origin) ? "origin" : "referer";
  const originOwner = originHost ? codeFromHost(originHost, reg) : ({ kind: "unknown" } as HostOwner);

  const hostCode = hostOwner.kind === "tenant" ? hostOwner.code : null;
  const originCode = originOwner.kind === "tenant" ? originOwner.code : null;

  if (hostCode && originCode && hostCode !== originCode) {
    return {
      owner: hostOwner,
      decidedBy: "host",
      conflict: `host=${hostCode} ${originBy}=${originCode}`,
    };
  }

  if (hostOwner.kind === "tenant") return { owner: hostOwner, decidedBy: "host" };
  if (originOwner.kind === "tenant") return { owner: originOwner, decidedBy: originBy };
  if (hostOwner.kind === "platform") return { owner: hostOwner, decidedBy: "host" };
  if (originOwner.kind === "platform") return { owner: originOwner, decidedBy: originBy };
  return { owner: { kind: "unknown" }, decidedBy: "none" };
}

/**
 * 是否可信代理地址（回环 / 内网 / 显式白名单）。
 *
 * 用途只有一个：判断「没有来源域名」的请求是不是平台自己发的（运维脚本、本机 curl）。
 * 不能拿它放行业务 —— 它只影响 defaultCode 兜底能不能用。
 */
export function isTrustedAddress(ip: string | undefined | null): boolean {
  const a = String(ip ?? "").trim();
  if (!a) return false;
  const bare = a.startsWith("::ffff:") ? a.slice(7) : a;
  if (bare === "127.0.0.1" || bare === "::1" || bare === "localhost") return true;
  if (config.tenant.trustedProxies.includes(bare)) return true;
  if (/^10\./.test(bare)) return true;
  if (/^192\.168\./.test(bare)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(bare)) return true;
  return false;
}

// ─────────────────────────── 数据源（表优先 / 配置兜底） ───────────────────────────

interface TenantRow {
  id: string;
  code: string;
  name: string;
  status: string;
  caps: unknown;
}

type TableState = "unknown" | "ok" | "missing";

/**
 * 表缺失后的重探间隔。
 *
 * 不设这个会有一个静默失效：pre-007 进程启动 → 表不存在 → 永久走配置兜底；
 * 之后补跑 007 也不恢复（要等重启）。而配置兜底的 caps 是 null，
 * 意味着能力开关全部失效 —— 上线顺序一变就变成「以为按表跑，其实按常量跑」。
 */
const TABLE_RETRY_MS = 5 * 60_000;

let _tableState: TableState = "unknown";
let _tableRetryAt = 0;
const _cache = new Map<string, { value: Tenant | null; exp: number }>();

/** 表缺失只告警一次：每请求打一条会把日志刷爆，真正的告警反而看不见 */
function markTableMissing(err: unknown): void {
  _tableRetryAt = Date.now() + TABLE_RETRY_MS;
  if (_tableState === "missing") return;
  _tableState = "missing";
  logger.warn(
    { err: String((err as Error)?.message || err), retryInMs: TABLE_RETRY_MS },
    "tenant 表不可用（007 未执行？），回落 config.tenant.domainMap 兜底"
  );
}

function parseCaps(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
    } catch {
      // caps 是 JSON 列，解析不了说明写入侧坏了；不放行也不抛错，按「无能力」处理
      logger.warn({ raw: s.slice(0, 120) }, "tenant.caps 不是合法 JSON，按无能力处理");
      return null;
    }
  }
  return null;
}

function normalizeStatus(raw: unknown): TenantStatus {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "active" || s === "paused" || s === "retired") return s;
  // 未知状态按 paused（不可写）处理：新枚举值上线时，宁可少写一手，不可多写一笔
  return "paused";
}

function fromConfig(code: string): Tenant | null {
  const registered =
    Object.values(config.tenant.domainMap).includes(code) || config.tenant.defaultCode === code;
  if (!registered) return null;
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
async function loadTenant(code: string): Promise<Tenant | null> {
  const now = Date.now();
  const hit = _cache.get(code);
  if (hit && hit.exp > now) return hit.value;

  let value: Tenant | null = null;

  // 命中过「表缺失」也不永久关闭：过一个重探窗口再试，免得 007 补跑后进程还按常量跑
  const tableUsable = _tableState !== "missing" || now >= _tableRetryAt;
  if (tableUsable) {
    if (_tableState === "missing") _tableState = "unknown";
    try {
      const res = await query<TenantRow>(
        "SELECT id, code, name, status, caps FROM tenant WHERE code = ? LIMIT 1",
        [code]
      );
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
    } catch (err: any) {
      const msg = String(err?.message || err);
      // 1146 = ER_NO_SUCH_TABLE；兼容 mysql2 的 code 字段
      if (err?.code === "ER_NO_SUCH_TABLE" || /1146|doesn't exist|does not exist/i.test(msg)) {
        markTableMissing(err);
      } else {
        logger.error({ code, err: msg }, "tenant 表查询失败，本次走配置兜底");
      }
      value = fromConfig(code);
    }
  } else {
    value = fromConfig(code);
  }

  if (_cache.size >= config.tenant.cacheMax) {
    for (const [k, v] of _cache) if (v.exp <= now) _cache.delete(k);
    if (_cache.size >= config.tenant.cacheMax) {
      let drop = 0;
      for (const k of _cache.keys()) {
        _cache.delete(k);
        if (++drop >= Math.ceil(config.tenant.cacheMax / 2)) break;
      }
    }
  }

  _cache.set(code, { value, exp: now + config.tenant.cacheTtlMs });
  return value;
}

function registry(): DomainRegistry {
  return {
    map: config.tenant.domainMap,
    platformHosts: config.tenant.platformHosts,
    subdomainSuffixes: config.tenant.subdomainSuffixes,
  };
}

// ─────────────────────────── 中间件 ───────────────────────────

/** 不过租户链路的路径：健康检查由负载均衡/隧道每分钟打一次，不该受租户判定影响 */
const EXEMPT = new Set(["/health", "/ready"]);

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface ResolveOutcome {
  tenant: Tenant | null;
  decidedBy: TenantSignal;
  /** 有值即「本次本该拒绝」，strict 真拒、shadow 只告警 */
  rejectReason?: string;
  rejectCode?: number;
  conflict?: string;
}

/**
 * 把 req 解析成一笔「归属结论」。拆出来是为了能单测，
 * 也是为了以后在 SDK 聚合层、脚本里复用同一套口径（不许各写一份）。
 */
export async function resolveRequestTenant(req: {
  method: string;
  headers: Record<string, unknown>;
  socket?: { remoteAddress?: string };
}): Promise<ResolveOutcome> {
  const reg = registry();
  const h = req.headers as Record<string, string | undefined>;
  const { owner, decidedBy, conflict } = resolveOwner(
    { host: h.host, origin: h.origin, referer: h.referer },
    reg
  );

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
  if (isTrustedAddress(req.socket?.remoteAddress) && config.tenant.defaultCode) {
    const t = await loadTenant(config.tenant.defaultCode);
    if (t) return { tenant: t, decidedBy: "default" };
  }

  return {
    tenant: null,
    decidedBy,
    rejectReason: "无法判定租户归属",
    rejectCode: 403,
  };
}

export async function tenantContext(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const mode = config.tenant.enforce;
  if (mode === "off") return next();
  if (EXEMPT.has(req.path ?? req.url)) return next();

  let outcome: ResolveOutcome;
  try {
    outcome = await resolveRequestTenant(req);
  } catch (err: any) {
    // 解析器自身异常绝不 500：strict 下拒绝，shadow/off 下放行并告警
    logger.error({ err: String(err?.message || err), path: req.path }, "tenant 解析异常");
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
      logger.warn(detail, "tenant_rejected");
      res.status(outcome.rejectCode ?? 403).json({ code: outcome.rejectCode ?? 403, message: outcome.rejectReason });
      return;
    }
    logger.warn(detail, "tenant_shadow_would_reject");
  }

  return next();
}

/**
 * 业务侧取租户（唯一入口）。
 * 写路径必须用它，不要直接读 req.tenant —— 直接读会漏掉 status 校验，
 * 已暂停的租户照样能下单。
 */
export function requireTenant(req: Request): Tenant {
  const t = req.tenant;
  if (!t) throw forbidden("无法判定租户归属，拒绝写入");
  if (t.status === "retired") throw forbidden("该租户已下线");
  if (t.status === "paused") throw forbidden("该租户已暂停");
  return t;
}

/** 只读路径取租户：无租户就返回 null，由查询层决定是否按「全部」或不返回 */
export function tenantOf(req: Request): Tenant | null {
  return req.tenant ?? null;
}

/** @internal 仅供单测重置模块级缓存与表状态；生产代码不得调用 */
export function __resetTenantCache(): void {
  _cache.clear();
  _tableState = "unknown";
  _tableRetryAt = 0;
}
