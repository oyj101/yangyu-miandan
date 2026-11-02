import { z } from "zod";
import { query } from "../../lib/db";
import { logger } from "../../lib/logger";
import { config } from "../../config";

/**
 * 退款公式配置（运营台 /api/reward/refund-config，契约 v1.0 2026-11-02）
 *
 * 语义红线（契约 §2）：
 * - 本配置是「新建卡缺省公式」，不是全局运行时旋钮。
 * - 存量卡按购卡时快照结算，绝不回刷（快照律 = 用户购卡时锁定的承诺）。
 * - 引擎硬约束：refundNowRatio ≡ 1 − refundShareRatio（period.service:89 /
 *   project.view:106 的补数关系）。保存侧用 zod refine 强校验，违反返回 422，
 *   不做静默归一（显式优于隐式，运营立即知道该改哪个值）。
 *
 * 读取模式：
 * - 异步 getRefundConfig()：DB 真源，读后即刷缓存（GET/PUT 用）。
 * - 同步 refundConfigSync()：TTL 缓存，过期后 fire-and-forget 刷新（本次容忍旧值），
 *   未预热回退 env 缺省——供同步函数链（toProjectView 等）零签名变化接入。
 * - caliber 计算接线（period 建期金额按口径取整路径）留 TODO，本轮只落库透出。
 */

export type RefundConfig = {
  caliber: "unit" | "total";
  refundNowRatio: number;
  refundShareRatio: number;
  streakDays: number;
  updatedBy: string | null;
  updatedAt: string | null;
};

export const refundPutSchema = z
  .object({
    caliber: z.enum(["unit", "total"]),
    refundNowRatio: z.number().min(0).max(1),
    refundShareRatio: z.number().min(0).max(1),
    streakDays: z.number().int().min(1).max(7),
  })
  .refine((d) => d.refundNowRatio + d.refundShareRatio <= 1, {
    message: "两路比例之和不得超过 1",
  })
  .refine((d) => Math.abs(d.refundNowRatio + d.refundShareRatio - 1) < 1e-9, {
    message:
      "引擎语义为补数关系：refundNowRatio 必须等于 1 − refundShareRatio（如 0.7/0.3）",
  });

function envDefaults(): RefundConfig {
  return {
    caliber: "unit",
    refundNowRatio: config.package.refundRatioNow,
    refundShareRatio: config.package.refundRatioShare,
    streakDays: config.package.streakDays,
    updatedBy: null,
    updatedAt: null,
  };
}

type Row = {
  caliber: string;
  refund_now_ratio: string | number;
  refund_share_ratio: string | number;
  streak_days: number;
  updated_by: string | null;
  updated_at: Date | string | null;
};

function rowToConfig(r: Row): RefundConfig {
  return {
    caliber: r.caliber === "total" ? "total" : "unit",
    refundNowRatio: Number(r.refund_now_ratio),
    refundShareRatio: Number(r.refund_share_ratio),
    streakDays: Number(r.streak_days),
    updatedBy: r.updated_by ?? null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

async function readFromDb(): Promise<RefundConfig> {
  const res = await query<Row>(
    `SELECT caliber, refund_now_ratio, refund_share_ratio, streak_days, updated_by, updated_at
       FROM yangyu_refund_config WHERE id = 1`
  );
  if (!res.rows.length) return envDefaults();
  return rowToConfig(res.rows[0]);
}

const TTL_MS = 60_000;
let cache: { value: RefundConfig; at: number } | null = null;

export async function getRefundConfig(): Promise<RefundConfig> {
  cache = { value: await readFromDb(), at: Date.now() };
  return cache.value;
}

export async function saveRefundConfig(
  input: z.infer<typeof refundPutSchema>,
  updatedBy: string
): Promise<RefundConfig> {
  await query(
    `UPDATE yangyu_refund_config
        SET caliber = ?, refund_now_ratio = ?, refund_share_ratio = ?,
            streak_days = ?, updated_by = ?
      WHERE id = 1`,
    [input.caliber, input.refundNowRatio, input.refundShareRatio, input.streakDays, updatedBy]
  );
  // 写后即刷缓存（幂等：同值重复写无副作用，updated_at 由 DB ON UPDATE 维护）
  return getRefundConfig();
}

/** 同步读取器：TTL 内用缓存；过期 fire-and-forget 刷新（本次容忍旧值）；未预热回退 env 缺省 */
export function refundConfigSync(): RefundConfig {
  if (!cache) return envDefaults();
  if (Date.now() - cache.at > TTL_MS) {
    void getRefundConfig().catch((e) =>
      logger.warn({ err: e }, "退款配置缓存刷新失败，沿用旧值")
    );
  }
  return cache.value;
}

/** 启动预热：失败仅告警不阻断启动（env 缺省兜底） */
export async function initRefundConfigCache(): Promise<void> {
  try {
    await getRefundConfig();
    logger.info("退款公式配置缓存已预热");
  } catch (e) {
    logger.warn({ err: e }, "退款公式配置预热失败，暂用 env 缺省");
  }
}
