import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * 资金唯一出口（lib/fund.ts）：支付 + 兑换豆
 *
 * 这组测试锁两件事：
 *   ① 失败如何表达 —— 必须有 code，不能只有一个 false
 *   ② 前置校验是否真的挡住了不该发出的请求
 *
 * 收敛前的实际状况（不是假设）：
 *   · 动账三套实现：lib/wallet.ts（结构化）/ enrollment 闭包（boolean，丢原因）/
 *     reward 裸 fetch（只打日志，调用方以为成功）→ 后者让 reward 停在 issued 而钱没到账。
 *   · 支付只有下单和查单两个裸 fetch，没有幂等键校验，也不校验 jsapi 的 openid。
 * 所以断言钉的是 code 与「有没有真的发请求」，不是 HTTP 细节。
 */

const mockCfg = vi.hoisted(() => ({
  wallet: { base: "http://8100.test/api/v2", serviceKey: "svc-key" },
}));

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("../config", () => ({ config: mockCfg }));
vi.mock("./db", () => ({ query: mockQuery }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { resolveAiUid, payCreate, payStatus, walletChange, walletChangeOfUser } = await import("./fund");

function okResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ code: 0, data }) } as any;
}

function rejectResponse(message = "余额不足") {
  return { ok: true, status: 200, json: async () => ({ code: 4001, message }) } as any;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as any;
  mockQuery.mockReset();
  mockCfg.wallet.serviceKey = "svc-key";
});

// ───────────────────────────── 身份 ─────────────────────────────

describe("resolveAiUid：唯一身份解析", () => {
  it("空值归一为 null（未联邦是业务事实，不是错误）", async () => {
    mockQuery.mockResolvedValue({ rows: [{ ai_uid: "" }] });
    expect(await resolveAiUid("au_1")).toBeNull();

    mockQuery.mockResolvedValue({ rows: [{}] });
    expect(await resolveAiUid("au_2")).toBeNull();

    mockQuery.mockResolvedValue({ rows: [] });
    expect(await resolveAiUid("au_3")).toBeNull();
  });

  it("数字型 ai_uid 转成字符串（该列是 varchar，仍要防上游返回数字）", async () => {
    mockQuery.mockResolvedValue({ rows: [{ ai_uid: 17 }] });
    expect(await resolveAiUid("au_1")).toBe("17");
  });
});

// ───────────────────────────── ① 支付 ─────────────────────────────

describe("payCreate：下单的前置校验", () => {
  it("缺 bizRef（幂等键）→ BAD_INPUT，且一个请求都不发", async () => {
    // 没有幂等键就发出去，一次网络重试会产生第二张支付单，用户被重复收款
    const r = await payCreate({
      aiUid: "17",
      amountFen: 10000,
      channel: "native",
      bizRef: "",
      description: "测试卡",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("BAD_INPUT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("jsapi 缺 openid → BAD_INPUT，本地先拦（8100 侧也会拒，省一次跨机调用）", async () => {
    const r = await payCreate({
      aiUid: "17",
      amountFen: 10000,
      channel: "jsapi",
      bizRef: "enr_1",
      description: "测试卡",
    });
    expect(r.code).toBe("BAD_INPUT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("金额须为正整数分：0 / 负数 / 小数一律拦", async () => {
    for (const amountFen of [0, -100, 99.5]) {
      const r = await payCreate({
        aiUid: "17",
        amountFen,
        channel: "native",
        bizRef: "enr_1",
        description: "x",
      });
      expect(r.code).toBe("BAD_AMOUNT");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("缺 aiUid → NO_AI_UID", async () => {
    const r = await payCreate({
      aiUid: "",
      amountFen: 10000,
      channel: "native",
      bizRef: "enr_1",
      description: "x",
    });
    expect(r.code).toBe("NO_AI_UID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("成功 → 返回 orderNo 与 payParams，请求体带 biz_ref 与分单位金额", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ order_no: "PO123", pay_params: { timeStamp: "1", nonceStr: "n" } })
    );
    const r = await payCreate({
      aiUid: "17",
      amountFen: 10000,
      channel: "jsapi",
      openid: "o_abc",
      bizRef: "enr_1",
      description: "养鱼免单卡 c1",
    });
    expect(r.ok).toBe(true);
    expect(r.data!.orderNo).toBe("PO123");
    expect(r.data!.payParams).toEqual({ timeStamp: "1", nonceStr: "n" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://8100.test/api/v2/yangyu/pay/create");
    expect(init.headers["X-Service-Key"]).toBe("svc-key");
    expect(JSON.parse(init.body)).toMatchObject({
      uid: 17,
      amount_fen: 10000,
      channel: "jsapi",
      openid: "o_abc",
      biz_ref: "enr_1",
    });
  });

  it("信封成功但没有 order_no → 不能当成下单成功", async () => {
    fetchMock.mockResolvedValue(okResponse({ pay_params: {} }));
    const r = await payCreate({
      aiUid: "17",
      amountFen: 10000,
      channel: "native",
      bizRef: "enr_1",
      description: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("UPSTREAM_REJECT");
  });
});

describe("payStatus：支付态的唯一真源", () => {
  it("只认白名单值；未知状态归 unknown，绝不当成 paid", async () => {
    const cases: Array<[string, string]> = [
      ["paid", "paid"],
      ["unpaid", "unpaid"],
      ["closed", "closed"],
      ["refunded", "refunded"],
      ["PARTIAL_REFUND", "unknown"],
      ["", "unknown"],
    ];
    for (const [raw, expectState] of cases) {
      fetchMock.mockResolvedValue(okResponse({ status: raw }));
      const r = await payStatus("PO123");
      expect(r.ok).toBe(true);
      expect(r.data!.state).toBe(expectState);
    }
  });

  it("大小写归一（8100 可能回 PAID）", async () => {
    fetchMock.mockResolvedValue(okResponse({ status: "PAID" }));
    const r = await payStatus("PO123");
    expect(r.data!.state).toBe("paid");
  });

  it("缺 orderNo → BAD_INPUT，不发请求", async () => {
    const r = await payStatus("");
    expect(r.code).toBe("BAD_INPUT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("用 GET 且 order_no 做 URL 编码", async () => {
    fetchMock.mockResolvedValue(okResponse({ status: "paid" }));
    await payStatus("PO/1 23");
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(url).toContain("order_no=PO%2F1%2023");
    expect(init.body).toBeUndefined();
  });

  it("查单超时 → TIMEOUT（与上游拒绝区分开，前者可重试）", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const r = await payStatus("PO123");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("TIMEOUT");
  });
});

// ───────────────────────────── ② 兑换豆 ─────────────────────────────

describe("walletChange：兑换豆，失败必须带 code", () => {
  it("缺 serviceKey → NO_SERVICE_KEY，且不发起网络请求", async () => {
    mockCfg.wallet.serviceKey = "";
    const r = await walletChange({ aiUid: "17", amount: 10, bizType: "yangyu:test", remark: "x" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("NO_SERVICE_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("金额为 0 / NaN / Infinity → BAD_AMOUNT", async () => {
    for (const amount of [0, NaN, Infinity]) {
      const r = await walletChange({ aiUid: "17", amount, bizType: "yangyu:test", remark: "x" });
      expect(r.code).toBe("BAD_AMOUNT");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("缺 aiUid → NO_AI_UID", async () => {
    const r = await walletChange({ aiUid: "", amount: 10, bizType: "yangyu:test", remark: "x" });
    expect(r.code).toBe("NO_AI_UID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("成功 → 返回 flowNo，请求体带 ledger=zy 与数字型 uid", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true, flow_no: "FLOW999" }));
    const r = await walletChange({
      aiUid: "17",
      amount: 12.34,
      bizType: "yangyu:refund70",
      remark: "期次 abc",
      bizId: 0,
    });
    expect(r.ok).toBe(true);
    expect(r.data!.flowNo).toBe("FLOW999");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://8100.test/api/v2/wallet/change");
    expect(JSON.parse(init.body)).toMatchObject({
      uid: 17,
      asset: "balance",
      amount: 12.34,
      biz_type: "yangyu:refund70",
      ledger: "zy",
    });
  });

  it("上游明确拒绝 → UPSTREAM_REJECT，保留原始 message", async () => {
    fetchMock.mockResolvedValue(rejectResponse("余额不足"));
    const r = await walletChange({ aiUid: "17", amount: -100, bizType: "yangyu:test", remark: "x" });
    expect(r.code).toBe("UPSTREAM_REJECT");
    expect(r.err).toBe("余额不足");
  });

  it("网络异常 → NETWORK", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await walletChange({ aiUid: "17", amount: 10, bizType: "yangyu:test", remark: "x" });
    expect(r.code).toBe("NETWORK");
    expect(r.err).toContain("ECONNREFUSED");
  });

  it("响应非 JSON → 不能当成成功", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    } as any);
    const r = await walletChange({ aiUid: "17", amount: 10, bizType: "yangyu:test", remark: "x" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("UPSTREAM_REJECT");
  });

  it("code 为字符串 \"0\" 也算成功（8100 存在两种序列化）", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: "0", data: { ok: true, flow_no: "F1" } }),
    } as any);
    const r = await walletChange({ aiUid: "17", amount: 1, bizType: "yangyu:test", remark: "x" });
    expect(r.ok).toBe(true);
  });

  it("信封成功但 data.ok=false 不算成功（这是最容易漏的一种失败）", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: false }));
    const r = await walletChange({ aiUid: "17", amount: 1, bizType: "yangyu:test", remark: "x" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("UPSTREAM_REJECT");
  });
});

describe("walletChangeOfUser：业务模块唯一调用形态", () => {
  it("用户未联邦 → NO_AI_UID，且绝不调钱包", async () => {
    mockQuery.mockResolvedValue({ rows: [{ ai_uid: null }] });
    const r = await walletChangeOfUser("au_9", { amount: 10, bizType: "yangyu:reward", remark: "x" });
    expect(r.code).toBe("NO_AI_UID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("已联邦 → 自动解析并回填 aiUid（对账要知道打给了谁）", async () => {
    mockQuery.mockResolvedValue({ rows: [{ ai_uid: "42" }] });
    fetchMock.mockResolvedValue(okResponse({ ok: true, flow_no: "F42" }));
    const r = await walletChangeOfUser("au_9", { amount: 10, bizType: "yangyu:reward", remark: "x" });
    expect(r.ok).toBe(true);
    expect(r.aiUid).toBe("42");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).uid).toBe(42);
  });

  it("身份查询抛错 → 归为 NETWORK 并带原因，不冒泡成 500", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    const r = await walletChangeOfUser("au_9", { amount: 10, bizType: "yangyu:reward", remark: "x" });
    expect(r.code).toBe("NETWORK");
    expect(r.err).toContain("db down");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
