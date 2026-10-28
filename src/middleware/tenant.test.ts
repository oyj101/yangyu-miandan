import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * 租户上下文解析（middleware/tenant.ts）
 *
 * 这组测试锁三件事：
 *   1. 归属只从 Host/Origin 推导，**不认**客户端自报头（ADR-116 的原坑）
 *   2. 表优先、配置兜底 —— 007 前后同一份代码都能跑，且 source 能说清走的哪条路
 *   3. 三档 enforce 的行为：off 不解析 / shadow 只告警 / strict 真拒
 */

const mockCfg = vi.hoisted(() => ({
  nodeEnv: "test",
  tenant: {
    enforce: "shadow" as "off" | "shadow" | "strict",
    defaultCode: "",
    domainMap: {
      "ai.ws.hi.cn": "ai",
      "h6.ws.hi.cn": "h6",
      "shop.mica178.com": "yx",
    } as Record<string, string>,
    platformHosts: ["ws.hi.cn", "www.ws.hi.cn"],
    subdomainSuffixes: ["ws.hi.cn"],
    cacheTtlMs: 60_000,
    cacheMax: 200,
    trustedProxies: [] as string[],
  },
}));

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("../config", () => ({ config: mockCfg }));
vi.mock("../lib/db", () => ({ query: mockQuery }));
vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  normalizeHost,
  codeFromHost,
  resolveOwner,
  resolveRequestTenant,
  tenantContext,
  requireTenant,
  tenantOf,
  __resetTenantCache,
} = await import("./tenant");

const REG = {
  map: mockCfg.tenant.domainMap,
  platformHosts: mockCfg.tenant.platformHosts,
  subdomainSuffixes: mockCfg.tenant.subdomainSuffixes,
};

function fakeReq(over: Record<string, unknown> = {}) {
  return {
    method: "GET",
    path: "/api/cards",
    url: "/api/cards",
    headers: {},
    socket: { remoteAddress: "203.0.113.9" },
    ...over,
  } as any;
}

function fakeRes() {
  const out = { statusCode: 200, body: undefined as any };
  const res: any = {
    status(c: number) {
      out.statusCode = c;
      return res;
    },
    json(b: any) {
      out.body = b;
      return res;
    },
  };
  return { res, out };
}

async function run(req: any) {
  const { res, out } = fakeRes();
  const next = vi.fn();
  await tenantContext(req, res, next);
  return { out, next };
}

beforeEach(() => {
  mockCfg.tenant.enforce = "shadow";
  mockCfg.tenant.defaultCode = "";
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  __resetTenantCache();
});

describe("normalizeHost：主机名归一", () => {
  it("去端口、转小写", () => {
    expect(normalizeHost("AI.WS.HI.CN:443")).toBe("ai.ws.hi.cn");
  });

  it("完整 URL 取 hostname", () => {
    expect(normalizeHost("https://ai.ws.hi.cn/yangyu?ref=x")).toBe("ai.ws.hi.cn");
  });

  it("去尾部点（合法 FQDN 写法）", () => {
    expect(normalizeHost("ai.ws.hi.cn.")).toBe("ai.ws.hi.cn");
  });

  it("空值返回空串，交给调用方当无信号", () => {
    expect(normalizeHost(undefined)).toBe("");
    expect(normalizeHost("  ")).toBe("");
  });
});

describe("codeFromHost：域名 → 归属", () => {
  it("精确映射命中", () => {
    expect(codeFromHost("ai.ws.hi.cn", REG)).toEqual({ kind: "tenant", code: "ai" });
  });

  it("自定义别名域走精确映射（不靠子域推导）", () => {
    expect(codeFromHost("shop.mica178.com", REG)).toEqual({ kind: "tenant", code: "yx" });
  });

  it("平台自用域归 platform，不归属任何租户", () => {
    expect(codeFromHost("ws.hi.cn", REG)).toEqual({ kind: "platform" });
    expect(codeFromHost("www.ws.hi.cn", REG)).toEqual({ kind: "platform" });
  });

  it("未登记的新子域可推导出租户码 —— 新增租户不必改代码", () => {
    expect(codeFromHost("plan.ws.hi.cn", REG)).toEqual({ kind: "tenant", code: "plan" });
  });

  it("多级子域不猜", () => {
    expect(codeFromHost("a.b.ws.hi.cn", REG)).toEqual({ kind: "unknown" });
  });

  it("外部域名不猜", () => {
    expect(codeFromHost("evil.example.com", REG)).toEqual({ kind: "unknown" });
  });
});

describe("resolveOwner：多信号合并", () => {
  it("只有 Host 时按 Host", () => {
    const r = resolveOwner({ host: "ai.ws.hi.cn" }, REG);
    expect(r.owner).toEqual({ kind: "tenant", code: "ai" });
    expect(r.decidedBy).toBe("host");
    expect(r.conflict).toBeUndefined();
  });

  it("Host 是平台域、Origin 是租户域时，取 Origin", () => {
    const r = resolveOwner({ host: "ws.hi.cn", origin: "https://h6.ws.hi.cn" }, REG);
    expect(r.owner).toEqual({ kind: "tenant", code: "h6" });
    expect(r.decidedBy).toBe("origin");
  });

  it("Host 与 Origin 指向不同租户 → 判冲突，归属仍按 Host", () => {
    const r = resolveOwner({ host: "ai.ws.hi.cn", origin: "https://h6.ws.hi.cn" }, REG);
    expect(r.owner).toEqual({ kind: "tenant", code: "ai" });
    expect(r.decidedBy).toBe("host");
    expect(r.conflict).toBe("host=ai origin=h6");
  });

  it("没有 Origin 时用 Referer，并如实标注依据", () => {
    const r = resolveOwner({ referer: "https://h6.ws.hi.cn/x" }, REG);
    expect(r.owner).toEqual({ kind: "tenant", code: "h6" });
    expect(r.decidedBy).toBe("referer");
  });

  it("无任何信号 → unknown", () => {
    expect(resolveOwner({}, REG)).toEqual({ owner: { kind: "unknown" }, decidedBy: "none" });
  });
});

describe("tenantContext：off 档", () => {
  it("完全不解析，一次库都不打", async () => {
    mockCfg.tenant.enforce = "off";
    const { next } = await run(fakeReq({ headers: { host: "ai.ws.hi.cn" } }));
    expect(next).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("tenantContext：shadow 档", () => {
  it("推导不出也只告警，不拒绝", async () => {
    const req = fakeReq({ headers: { host: "evil.example.com" } });
    const { next, out } = await run(req);
    expect(next).toHaveBeenCalled();
    expect(out.statusCode).toBe(200);
    expect(req.tenant).toBeUndefined();
  });

  it("来源冲突时仍挂上 Host 归属，只是不拒", async () => {
    const req = fakeReq({ headers: { host: "ai.ws.hi.cn", origin: "https://h6.ws.hi.cn" } });
    const { next } = await run(req);
    expect(next).toHaveBeenCalled();
    expect(req.tenant?.code).toBe("ai");
    expect(req.tenantDecidedBy).toBe("host");
  });
});

describe("tenantContext：strict 档", () => {
  it("推导不出 → 403 fail-closed", async () => {
    mockCfg.tenant.enforce = "strict";
    const { next, out } = await run(fakeReq({ headers: { host: "evil.example.com" } }));
    expect(next).not.toHaveBeenCalled();
    expect(out.statusCode).toBe(403);
    expect(out.body.message).toBe("无法判定租户归属");
  });

  it("来源冲突 → 403，不按任何一侧记账", async () => {
    mockCfg.tenant.enforce = "strict";
    const { out } = await run(fakeReq({ headers: { host: "ai.ws.hi.cn", origin: "https://h6.ws.hi.cn" } }));
    expect(out.statusCode).toBe(403);
    expect(out.body.message).toBe("请求来源与访问域名不属于同一租户");
  });

  it("未登记的租户码 → 403 未知租户", async () => {
    mockCfg.tenant.enforce = "strict";
    const { out } = await run(fakeReq({ headers: { host: "newbrand.ws.hi.cn" } }));
    expect(out.statusCode).toBe(403);
    expect(out.body.message).toBe("未知租户：newbrand");
  });

  it("retired 租户 → 403 已下线（读也不放）", async () => {
    mockCfg.tenant.enforce = "strict";
    mockQuery.mockResolvedValue({
      rows: [{ id: "t1", code: "ai", name: "AI站", status: "retired", caps: null }],
      rowCount: 1,
    });
    const { out } = await run(fakeReq({ headers: { host: "ai.ws.hi.cn" } }));
    expect(out.statusCode).toBe(403);
    expect(out.body.message).toBe("租户已下线：ai");
  });

  it("paused 租户：写被拒、读放行", async () => {
    mockCfg.tenant.enforce = "strict";
    mockQuery.mockResolvedValue({
      rows: [{ id: "t1", code: "ai", name: "AI站", status: "paused", caps: null }],
      rowCount: 1,
    });

    const write = fakeReq({ method: "POST", headers: { host: "ai.ws.hi.cn" } });
    const w = await run(write);
    expect(w.out.statusCode).toBe(403);
    expect(w.out.body.message).toContain("暂不可写");

    __resetTenantCache();
    const read = fakeReq({ method: "GET", headers: { host: "ai.ws.hi.cn" } });
    const r = await run(read);
    expect(r.next).toHaveBeenCalled();
    expect(read.tenant?.status).toBe("paused");
  });

  it("未知状态按 paused 处理（少写一手，不多写一笔）", async () => {
    mockCfg.tenant.enforce = "strict";
    mockQuery.mockResolvedValue({
      rows: [{ id: "t1", code: "ai", name: "AI站", status: "suspended", caps: null }],
      rowCount: 1,
    });
    const { out } = await run(fakeReq({ method: "POST", headers: { host: "ai.ws.hi.cn" } }));
    expect(out.statusCode).toBe(403);
  });
});

describe("数据源：表优先、配置兜底", () => {
  it("表不可用（1146）→ 回落配置，source 标 config，不 500", async () => {
    mockCfg.tenant.enforce = "strict";
    mockQuery.mockRejectedValue(
      Object.assign(new Error("Table 'yangyu_miandan.tenant' doesn't exist"), { code: "ER_NO_SUCH_TABLE" })
    );
    const req = fakeReq({ headers: { host: "ai.ws.hi.cn" } });
    const { next, out } = await run(req);
    expect(next).toHaveBeenCalled();
    expect(out.statusCode).toBe(200);
    expect(req.tenant).toMatchObject({ code: "ai", source: "config", status: "active" });
  });

  it("表里有行 → source 标 table，caps JSON 字符串解析成对象", async () => {
    mockCfg.tenant.enforce = "strict";
    mockQuery.mockResolvedValue({
      rows: [{ id: "t1", code: "ai", name: "AI站", status: "active", caps: '{"mall":true}' }],
      rowCount: 1,
    });
    const req = fakeReq({ headers: { host: "ai.ws.hi.cn" } });
    await run(req);
    expect(req.tenant).toMatchObject({ code: "ai", source: "table", name: "AI站" });
    expect(req.tenant?.caps).toEqual({ mall: true });
  });

  it("caps 非法 JSON 不抛错，按无能力处理", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: "t1", code: "ai", name: "AI站", status: "active", caps: "{oops" }],
      rowCount: 1,
    });
    const req = fakeReq({ headers: { host: "ai.ws.hi.cn" } });
    const { next } = await run(req);
    expect(next).toHaveBeenCalled();
    expect(req.tenant?.caps).toBeNull();
  });

  it("同一租户两次请求只打一次库（TTL 内缓存）", async () => {
    await run(fakeReq({ headers: { host: "ai.ws.hi.cn" } }));
    await run(fakeReq({ headers: { host: "ai.ws.hi.cn" } }));
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("负结果同样缓存：未知租户不重复打库", async () => {
    await run(fakeReq({ headers: { host: "ghost.ws.hi.cn" } }));
    await run(fakeReq({ headers: { host: "ghost.ws.hi.cn" } }));
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("库查询异常（非缺表）退到配置兜底并留痕，不 500", async () => {
    mockCfg.tenant.enforce = "strict";
    mockQuery.mockRejectedValue(new Error("ER_LOCK_WAIT_TIMEOUT"));
    const req = fakeReq({ headers: { host: "ai.ws.hi.cn" } });
    const { next } = await run(req);
    expect(next).toHaveBeenCalled();
    expect(req.tenant?.source).toBe("config");
  });

  it("表缺失后过一个重探窗口会重新查表（防 007 补跑后进程仍按常量跑）", async () => {
    mockCfg.tenant.enforce = "strict";
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-10-21T12:00:00Z");
      vi.setSystemTime(t0);
      mockQuery.mockReset();
      mockQuery.mockRejectedValueOnce(
        Object.assign(new Error("Table 'yangyu_miandan.tenant' doesn't exist"), {
          code: "ER_NO_SUCH_TABLE",
        })
      );

      const r1 = fakeReq({ headers: { host: "ai.ws.hi.cn" } });
      await run(r1);
      expect(r1.tenant?.source).toBe("config");
      expect(mockQuery).toHaveBeenCalledTimes(1);

      // 过了缓存 TTL、但还在重探窗口内：只走配置，不再打库
      vi.setSystemTime(new Date(t0.getTime() + 61_000));
      const r2 = fakeReq({ headers: { host: "ai.ws.hi.cn" } });
      await run(r2);
      expect(r2.tenant?.source).toBe("config");
      expect(mockQuery).toHaveBeenCalledTimes(1);

      // 过了 5 分钟重探窗口：重新查表，拿到行后切回 table
      vi.setSystemTime(new Date(t0.getTime() + 5 * 60_000 + 1_000));
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: "t1", code: "ai", name: "AI站", status: "active", caps: '{"mall":true}' }],
        rowCount: 1,
      });
      const r3 = fakeReq({ headers: { host: "ai.ws.hi.cn" } });
      await run(r3);
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(r3.tenant?.source).toBe("table");
      expect(r3.tenant?.caps).toEqual({ mall: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("内部调用兜底", () => {
  it("可信来源 + 配了 defaultCode → 兜底租户，依据标 default", async () => {
    mockCfg.tenant.enforce = "strict";
    mockCfg.tenant.defaultCode = "ai";
    const req = fakeReq({ headers: { host: "127.0.0.1:8080" }, socket: { remoteAddress: "127.0.0.1" } });
    const { next } = await run(req);
    expect(next).toHaveBeenCalled();
    expect(req.tenant?.code).toBe("ai");
    expect(req.tenantDecidedBy).toBe("default");
  });

  it("公网来源 + 配了 defaultCode 也不兜底（防伪造 Host 冒充内部）", async () => {
    mockCfg.tenant.enforce = "strict";
    mockCfg.tenant.defaultCode = "ai";
    const { out } = await run(
      fakeReq({ headers: { host: "127.0.0.1:8080" }, socket: { remoteAddress: "203.0.113.9" } })
    );
    expect(out.statusCode).toBe(403);
  });
});

describe("豁免与访问器", () => {
  it("/health 不进租户链路", async () => {
    mockCfg.tenant.enforce = "strict";
    const { next } = await run(fakeReq({ path: "/health", headers: { host: "evil.example.com" } }));
    expect(next).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("requireTenant 无租户时抛 403", () => {
    expect(() => requireTenant(fakeReq())).toThrow();
  });

  it("requireTenant 对 paused 租户抛错（写路径必须拦）", () => {
    const req = fakeReq();
    req.tenant = { id: "t", code: "ai", name: "AI站", status: "paused", caps: null, source: "table" };
    expect(() => requireTenant(req)).toThrow();
  });

  it("tenantOf 无租户返回 null，不抛错", () => {
    expect(tenantOf(fakeReq())).toBeNull();
  });
});
