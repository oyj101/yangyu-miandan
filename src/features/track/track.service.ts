/**
 * SDK 埋点落表（PO 2026-10-21 决定：从"只落 pino 日志"改为"落表"）
 *
 * 为什么不是「收到就 INSERT」：
 *   内联 SDK 挂在人家的页面上，滚动/切 tab 会连续打点，逐条 INSERT 等于把
 *   埋点写放大直接加在主库上，且一次 DB 抖动就会让埋点端点变慢、拖累宿主页面。
 *
 * 做法：
 *   进程内队列 → 500ms 或满 100 条批量 INSERT → 失败整批丢弃并计数
 *   （埋点可以丢，业务不能慢；丢了多少必须能从 /api/sdk/track 的返回里看到）
 *
 * 隐私：
 *   - 不存原始 IP / UA，只存 sha256 前 16 位（能做去重与"同设备多次"判断，不能反查）
 *   - payload 走键白名单，未列出的键直接丢弃（防止宿主把 openid/token/phone 传上来）
 */
import { createHash } from "crypto";
import { query } from "../../lib/db";
import { logger } from "../../lib/logger";
import { config } from "../../config";

/** 事件白名单：宿主传未知事件名直接丢弃，避免表被任意字符串灌满 */
const ALLOWED_EVENTS = new Set([
  "view_mount",
  "view_error",
  "bootstrap",
  "projects_load",
  "category_switch",
  "project_open",
  "purchase_start",
  "purchase_success",
  "purchase_fail",
  "mine_load",
  "checkin_submit",
  "share_click",
  "share_copied",
  "share_unlocked",
  "notices_open",
  "pay_cancel",
]);

/** payload 允许的键（按用途分类，新用途必须改这里 —— 变化可 review） */
const ALLOWED_PAYLOAD_KEYS = new Set([
  "cardId", "enrollmentId", "amount", "view", "step", "from", "to", "reason",
  "category", "keyword", "sort", "code", "ms", "count", "channel", "sdkVersion",
]);

const MAX_PAYLOAD_BYTES = 2048;
const MAX_QUEUE = 2000;
const FLUSH_EVERY_MS = 500;
const FLUSH_BATCH = 100;

interface EventRow {
  event_type: string;
  view: string | null;
  user_id: string | null;
  role: string | null;
  card_id: string | null;
  enrollment_id: string | null;
  sdk_version: string | null;
  payload: string | null;
  ip_hash: string | null;
  ua_hash: string | null;
}

let queue: EventRow[] = [];
let timer: NodeJS.Timeout | null = null;
let flushing = false;
let stats = { accepted: 0, dropped: 0, written: 0, batchesFailed: 0 };

function shortHash(s: string | undefined | null): string | null {
  if (!s) return null;
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
}

function clip(s: unknown, max: number): string | null {
  if (s === undefined || s === null || s === "") return null;
  const v = String(s);
  return v.length > max ? v.slice(0, max) : v;
}

/** payload 键白名单 + 体积上限；超限直接丢 payload，不做截断（截断会产生半个 JSON） */
export function sanitizePayload(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(input as Record<string, unknown>)) {
    if (!ALLOWED_PAYLOAD_KEYS.has(k)) continue;
    const v = (input as any)[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out[k] = v.length > 120 ? v.slice(0, 120) : v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    // 对象/数组一律不收：埋点不做数据通道，需要结构化内容请新增事件+字段
  }
  const keys = Object.keys(out);
  if (!keys.length) return null;
  const s = JSON.stringify(out);
  if (Buffer.byteLength(s, "utf8") > MAX_PAYLOAD_BYTES) {
    return JSON.stringify({ truncated: true, keys });
  }
  return s;
}

/**
 * 收集一条埋点。**同步返回，永不抛错** —— 埋点失败不能影响宿主页面。
 * @returns 是否已入队（false = 事件名非法或队列已满被丢弃）
 */
export function collect(input: {
  eventType?: string;
  view?: string;
  userId?: string | null;
  role?: string | null;
  cardId?: string | null;
  enrollmentId?: string | null;
  sdkVersion?: string | null;
  payload?: unknown;
  ip?: string;
  ua?: string;
}): { queued: boolean; reason?: string } {
  const eventType = String(input.eventType || "").trim();
  if (!ALLOWED_EVENTS.has(eventType)) {
    stats.dropped += 1;
    return { queued: false, reason: "EVENT_NOT_ALLOWED" };
  }
  if (queue.length >= MAX_QUEUE) {
    stats.dropped += 1;
    return { queued: false, reason: "QUEUE_FULL" };
  }

  queue.push({
    event_type: eventType,
    view: clip(input.view, 32),
    user_id: clip(input.userId, 64),
    role: clip(input.role, 16),
    card_id: clip(input.cardId, 36),
    enrollment_id: clip(input.enrollmentId, 36),
    sdk_version: clip(input.sdkVersion, 16),
    payload: sanitizePayload(input.payload),
    ip_hash: shortHash(input.ip),
    ua_hash: shortHash(input.ua),
  });
  stats.accepted += 1;
  if (queue.length >= FLUSH_BATCH) void flush();
  else schedule();
  return { queued: true };
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_EVERY_MS);
  // 定时器不应阻止进程退出（cron/一次性脚本场景）
  (timer as any).unref?.();
}

/** 批量落库。并发调用由 flushing 合并，不会重复写同一批 */
export async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.splice(0, FLUSH_BATCH);
  try {
    const rows = batch.map((r) => [
      r.event_type, r.view, r.user_id, r.role, r.card_id, r.enrollment_id,
      r.sdk_version, r.payload, r.ip_hash, r.ua_hash,
    ]);
    await query(
      `INSERT INTO sdk_event
         (event_type, view, user_id, role, card_id, enrollment_id, sdk_version, payload, ip_hash, ua_hash)
       VALUES ?`,
      [rows]
    );
    stats.written += batch.length;
  } catch (err: any) {
    stats.batchesFailed += 1;
    stats.dropped += batch.length;
    // 不重试：埋点价值低于可用性，重试会在 DB 故障时形成自我加压
    logger.warn({ err: err?.message, lost: batch.length }, "[track] 批量写入失败，已丢弃该批");
  } finally {
    flushing = false;
    if (queue.length >= FLUSH_BATCH) void flush();
    else if (queue.length > 0) schedule();
  }
}

/** 埋点自身健康度：POST /api/sdk/track 的响应里回传，便于前端/巡检发现"打点但没落库" */
export function trackStats() {
  return {
    queued: queue.length,
    ...stats,
    retentionDays: config.track.retentionDays,
  };
}

/** 保留策略：删除超过保留期的埋点（daily-ops 调用） */
export async function purgeOldEvents(days = config.track.retentionDays): Promise<number> {
  const r = await query(`DELETE FROM sdk_event WHERE created_at < (NOW() - INTERVAL ? DAY) LIMIT 5000`, [days]);
  return r.rowCount ?? 0;
}

/** 进程退出前尽量把队列写掉（best-effort，超时即放弃） */
export async function drain(timeoutMs = 800): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (queue.length > 0 && Date.now() < deadline) {
    await flush();
  }
}
