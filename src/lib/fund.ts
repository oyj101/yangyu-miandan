import { config } from "../config";
import { query } from "./db";
import { logger } from "./logger";

/**
 * 资金域唯一出口（支付 + 兑换豆）
 *
 * ── 唯一性契约 ─────────────────────────────────────────────────────
 * 本文件是养鱼免单调用主站 8100 资金能力的**唯一**位置。两类调用：
 *   ① 支付（收钱）：payCreate 下单 / payStatus 查单
 *   ② 兑换豆（发钱）：walletChange 动账，asset=balance
 *
 * 判据（改完必跑，必须为空）：
 *   grep -rn "wallet/change\|yangyu/pay/" src/ | grep -v "lib/fund.ts"
 *   grep -rn "SELECT ai_uid FROM merchant_user" src/ | grep -v "lib/fund.ts"
 *
 * ── 为什么必须唯一 ─────────────────────────────────────────────────
 * 收敛前的实际事故链（不是假设）：
 *   · 支付态只在 enrollment.purchase 里写成 unpaid，之后**没有任何地方会自动置 paid**
 *     —— 本服务没有支付回调端点（/api/notify 是站内消息，不是支付通知）。
 *   · 唯一会查单回写的是 enrollment.service 的 recheckPayStatus，而它**只在退款里被调用**。
 *   · 核销侧 checkin.service 只读本地 pay_status → 已付款用户首次核销被拒
 *     「该入渔尚未完成支付，请先支付后再核销」。
 *   同一件事（确认到底付没付）在两个业务路径上只有一条路做了，这就是"多份实现"的真实代价：
 *   不是代码丑，是**资金判断不一致**。
 *
 * ── 三条铁律 ───────────────────────────────────────────────────────
 * 1) 支付态唯一真源是 8100 的 payStatus，不是本地 pay_status 字段。
 *    本地字段只是缓存，判定前必须经 pay-guard 查单复核。
 * 2) 下单必须带 bizRef（= enrollment.id）作为幂等键。没有幂等键的下单不允许发出去，
 *    否则一次网络重试就多一张支付单，用户被重复收款。
 * 3) 动账不可逆，本文件**不重试**。失败了返回 code 交给调用方落 failed 单据，
 *    重试会掩盖上游真实状态（8100 侧幂等靠 biz_type+biz_id，不靠客户端重放）。
 */

/** 失败分类：决定「可重试 / 须人工 / 环境故障」，调用方据此选择处置方式 */
export type FundFailCode =
  | "NO_SERVICE_KEY" // 部署缺 WALLET_SERVICE_KEY，环境故障
  | "NO_AI_UID" // 用户未联邦，钱无处可落
  | "BAD_AMOUNT" // 金额为 0 / 负数 / 非整数分
  | "BAD_INPUT" // 缺幂等键、jsapi 缺 openid 等前置条件不满足
  | "UPSTREAM_REJECT" // 8100 明确拒绝（余额不足、单据冲突、状态非法）
  | "TIMEOUT" // 超过分级超时，可重试（下单尤其）
  | "NETWORK"; // 连接失败 / 响应非 JSON

/** 支付态归一。8100 的原始值可能更多，未知值一律落 unknown，绝不当成 paid */
export type PayState = "paid" | "unpaid" | "closed" | "refunded" | "unknown";

export interface FundResult<T = unknown> {
  ok: boolean;
  data?: T;
  err?: string;
  code?: FundFailCode;
  /** 8100 流水号（动账/支付成功时），对账主键。等同于 data.flowNo，平铺方便调用方直接取 */
  flowNo?: string;
  raw?: any;
}

/** 失败透传：只带失败字段，不把内部调用方的 data 结构泄漏给外层签名 */
function failFrom<T>(r: FundResult<unknown>): FundResult<T> {
  return { ok: false, code: r.code, err: r.err, raw: r.raw };
}

/** 分级超时：让「用户在等」和「后台对账」用不同的耐心值 */
export const FUND_TIMEOUT = {
  /** 下单：用户在等，失败可重试，给足时间 */
  payCreate: 8000,
  /** 查单：闸门场景，快速失败优于长时间挂住核销请求 */
  payStatus: 3000,
  /** 动账：不可逆，宁可多等，也不能断在半路 */
  walletChange: 5000,
} as const;

// ───────────────────────────── 底层：唯一 HTTP 通道 ─────────────────────────────

interface Envelope<T> {
  code?: number | string;
  data?: T;
  message?: string;
}

/**
 * 8100 服务间调用的唯一实现。
 *
 * 三件事只在这里做一次：鉴权头、超时中止、信封解析与错误分类。
 * 任何业务模块都不得再自己 fetch 8100 资金端点 —— 否则超时值和错误语义会分叉。
 */
async function call8100<T>(
  path: string,
  opts: { method?: "GET" | "POST"; body?: unknown; timeoutMs: number }
): Promise<FundResult<T>> {
  const key = config.wallet.serviceKey;
  if (!key) return { ok: false, code: "NO_SERVICE_KEY", err: "WALLET_SERVICE_KEY 未配置" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const resp = await fetch(`${config.wallet.base}${path}`, {
      method: opts.method ?? "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Key": key,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
    });

    const j = (await resp.json().catch(() => null)) as Envelope<T> | null;
    if (!j) {
      // 非 JSON 响应（网关 HTML 错误页、502 等）绝不能被当成成功
      return { ok: false, code: "UPSTREAM_REJECT", err: `HTTP ${resp.status} 响应非 JSON`, raw: { status: resp.status } };
    }
    if (j.code !== 0 && j.code !== "0") {
      return { ok: false, code: "UPSTREAM_REJECT", err: j.message || `code=${j.code}`, raw: j };
    }
    return { ok: true, data: j.data as T, raw: j };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { ok: false, code: "TIMEOUT", err: `8100 ${path} 超时 ${opts.timeoutMs}ms` };
    }
    return { ok: false, code: "NETWORK", err: err?.message ?? "network" };
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────────── 身份：唯一解析入口 ─────────────────────────────

/**
 * 养鱼域 user_id(au_1) → 主站 ai_uid。
 *
 * `merchant_user.ai_uid` 是联邦身份的单一映射表（该列有唯一索引）。
 * 业务模块禁止再自行 `SELECT ai_uid FROM merchant_user`。
 *
 * 返回 null = 该用户从未联邦，这是业务事实而非错误；
 * 但任何要靠它动账的路径必须 fail-closed。
 */
export async function resolveAiUid(userId: string): Promise<string | null> {
  const res = await query<any>(
    "SELECT ai_uid FROM merchant_user WHERE user_id = ? LIMIT 1",
    [userId]
  );
  const v = res.rows[0]?.ai_uid;
  return v == null || v === "" ? null : String(v);
}

// ───────────────────────────── ① 支付（收钱） ─────────────────────────────

export interface PayCreateInput {
  /** 付款人联邦锚点 */
  aiUid: string;
  /** 金额，单位分，必须是正整数 */
  amountFen: number;
  channel: "native" | "jsapi";
  /** jsapi 必传：微信 openid */
  openid?: string;
  /**
   * 幂等键，必须是业务单据 ID（本项目 = enrollment.id）。
   * 8100 侧按它识别"这一单已经下过"，缺它等于放弃去重。
   */
  bizRef: string;
  description: string;
}

export interface PayCreateData {
  orderNo: string;
  payParams: any;
}

/**
 * 下单。返回 orderNo 与前端调起支付所需的 payParams。
 *
 * 注意：下单成功 ≠ 已支付。支付态只能经 payStatus 确认，
 * 本函数不会（也不应该）把本地 pay_status 置为 paid。
 */
export async function payCreate(input: PayCreateInput): Promise<FundResult<PayCreateData>> {
  if (!input.aiUid) return { ok: false, code: "NO_AI_UID", err: "缺少 ai_uid 联邦锚点" };
  if (!Number.isInteger(input.amountFen) || input.amountFen <= 0) {
    return { ok: false, code: "BAD_AMOUNT", err: `金额必须为正整数分，收到 ${input.amountFen}` };
  }
  if (!input.bizRef) {
    // 没有幂等键的下单坚决不发出：一次网络重试就会产生第二张支付单
    return { ok: false, code: "BAD_INPUT", err: "缺少 bizRef 幂等键，拒绝下单" };
  }
  if (input.channel === "jsapi" && !input.openid) {
    // 本地先拦，省一次必失败的跨机调用（8100 侧也会拒）
    return { ok: false, code: "BAD_INPUT", err: "jsapi 缺少 openid" };
  }

  const r = await call8100<{ order_no?: string; pay_params?: any }>("/yangyu/pay/create", {
    body: {
      uid: Number(input.aiUid),
      amount_fen: input.amountFen,
      channel: input.channel,
      openid: input.openid || "",
      biz_ref: input.bizRef,
      description: input.description,
    },
    timeoutMs: FUND_TIMEOUT.payCreate,
  });

  if (!r.ok) return failFrom(r);
  const orderNo = r.data?.order_no;
  if (!orderNo) {
    return { ok: false, code: "UPSTREAM_REJECT", err: "8100 未返回 order_no", raw: r.raw };
  }
  return { ok: true, data: { orderNo: String(orderNo), payParams: r.data?.pay_params ?? null }, raw: r.raw };
}

/**
 * 查单 —— **支付态的唯一真源**。
 *
 * 为什么靠查单而不是回调：本服务没有支付回调端点，
 * 8100 的支付结果不会主动推给养鱼服务。所以任何"这单到底付没付"的判断
 * 都必须落到这里。
 */
export async function payStatus(orderNo: string): Promise<FundResult<{ state: PayState; raw: string }>> {
  if (!orderNo) return { ok: false, code: "BAD_INPUT", err: "缺少 order_no" };

  const r = await call8100<{ status?: string }>(
    `/yangyu/pay/status?order_no=${encodeURIComponent(orderNo)}`,
    { method: "GET", timeoutMs: FUND_TIMEOUT.payStatus }
  );
  if (!r.ok) return failFrom(r);

  const raw = String(r.data?.status ?? "").toLowerCase();
  // 只认白名单值。上游将来加新状态（如 partial_refund）时归 unknown，
  // 绝不能因为"不等于 unpaid"就当成已支付。
  const state: PayState =
    raw === "paid" ? "paid"
      : raw === "unpaid" ? "unpaid"
      : raw === "closed" ? "closed"
      : raw === "refunded" ? "refunded"
      : "unknown";

  if (state === "unknown") {
    logger.warn({ orderNo, raw }, "支付态未知，按未付处理");
  }
  return { ok: true, data: { state, raw }, raw: r.raw };
}

// ───────────────────────────── ② 兑换豆（发钱） ─────────────────────────────

export interface WalletChangeInput {
  aiUid: string;
  /** 正数入账、负数出账；单位元，保留 2 位 */
  amount: number;
  /** 业务类型，`yangyu:xxx` 命名空间；8100 落库会加 `zy:` 前缀 */
  bizType: string;
  remark: string;
  /** 8100 侧 biz_id 为整型，UUID 类单据写进 remark */
  bizId?: number;
}

export interface WalletChangeData {
  flowNo: string;
}

/**
 * 兑换豆 / 动账：asset=balance。
 *
 * 幂等由调用方提供（本项目用 refund_flow.idem_key 唯一索引兜底），
 * 本函数不重试、不吞错 —— 失败必须让调用方知道，才能落 failed 单据供对账。
 */
export async function walletChange(input: WalletChangeInput): Promise<FundResult<WalletChangeData>> {
  if (!input.aiUid) return { ok: false, code: "NO_AI_UID", err: "缺少 ai_uid 联邦锚点" };
  if (!Number.isFinite(input.amount) || input.amount === 0) {
    return { ok: false, code: "BAD_AMOUNT", err: `金额非法: ${input.amount}` };
  }

  const r = await call8100<{ ok?: boolean; flow_no?: string }>("/wallet/change", {
    body: {
      uid: Number(input.aiUid),
      asset: "balance",
      amount: input.amount,
      biz_type: input.bizType,
      ledger: "zy",
      remark: input.remark,
      biz_id: input.bizId ?? 0,
    },
    timeoutMs: FUND_TIMEOUT.walletChange,
  });

  if (!r.ok) return failFrom(r);
  // 信封成功但业务失败（data.ok=false）必须单独判，别被 code=0 骗过去
  if (r.data?.ok !== true) {
    return { ok: false, code: "UPSTREAM_REJECT", err: "8100 data.ok=false", raw: r.raw };
  }
  const flowNo = String(r.data?.flow_no ?? "");
  return { ok: true, data: { flowNo }, flowNo, raw: r.raw };
}

/**
 * 动账 + 身份解析（业务层的标准调用形态）。
 *
 * 用这个而不是自己查 ai_uid 再调 walletChange：
 * 保证「查不到 ai_uid」也返回带 code 的结构化失败，而不是各调用点自行决定 throw 还是静默跳过。
 */
export async function walletChangeOfUser(
  userId: string,
  input: Omit<WalletChangeInput, "aiUid">
): Promise<FundResult<WalletChangeData> & { aiUid?: string }> {
  let aiUid: string | null;
  try {
    aiUid = await resolveAiUid(userId);
  } catch (err: any) {
    return { ok: false, code: "NETWORK", err: `解析 ai_uid 失败: ${err?.message ?? err}` };
  }
  if (!aiUid) return { ok: false, code: "NO_AI_UID", err: `用户 ${userId} 未联邦，钱无处可落` };

  const r = await walletChange({ ...input, aiUid });
  return { ...r, aiUid };
}

// ───────────────────────────── 统一失败记账 ─────────────────────────────

/**
 * 失败的统一日志口径：业务模块不要自己拼字段。
 * refType/refId 传业务单据（enrollment / period / reward），对账时按它聚合。
 */
export function logFundFailure(
  tag: string,
  ctx: { refType: string; refId: string; userId?: string },
  r: FundResult<unknown>
): void {
  logger.error({ tag, code: r.code, err: r.err, ...ctx }, `资金调用失败 ${tag}`);
}
