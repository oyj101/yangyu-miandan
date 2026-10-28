/**
 * C 端投影（Project View）
 *
 * 铁律：这里用「白名单逐字段列举」，禁止 `{...card}` 展开。
 *   - supply_price 是商户成本，泄露 = 商户被比价 / 平台毛利公开；
 *   - coverage_cap、per_merchant_quota 是风控参数，C 端不需要；
 *   - 展开写法在某次加字段后会静默把新字段漏出去，白名单加字段必须动代码，可 review。
 *
 * 该投影同时是内联 SDK 的渲染契约：字段改名 = 破坏线上宿主页面，
 * 故新增字段只能追加，不能重命名（见 sdk/README.md 契约稳定性）。
 */
import { config } from "../../config";
import { Card } from "../card/card.types";

export interface ProjectView {
  id: string;
  title: string;
  subtitle: string | null;
  merchantName: string | null;
  category: string | null;
  coverUrl: string | null;
  /** 单价（每期实付） */
  unitPrice: number;
  /** 总期数 */
  periods: number;
  /** 总金额 = 单价 × 期数 */
  totalPrice: number;
  freq: string;
  /** 达标核销即时返还比例 = 1 - 该卡分享分成 */
  refundNowRatio: number;
  /** 分享绑定后返还比例（逐卡不同，取 card.shareRatio） */
  refundShareRatio: number;
  /** 连续任务天数（5） */
  streakDays: number;
  /** 已拼人次 */
  soldCount: number;
  listedAt: Date | null;
}

/**
 * 集合页投影（列表专用）—— 2026-10-21 PO 拍板：**集合页不露「每期返多少钱」**。
 *
 * 为什么不能用 ProjectView 直接渲染列表：
 *   列表里有 unitPrice 和 refundNowRatio，前端一次乘法就把「每期返 ¥7」摆在公开页上。
 *   那是补贴强度与平台毛利的公开口径，会被商家拿去比价、被羊毛党当作目标清单。
 *
 * 所以列表只给三样东西：总价（不买无法决策）、期数、以及**不含数字**的定性承诺。
 * 具体返还金额只在「购买确认弹层」出现 —— 那属于交易前的告知义务，
 * 对象是单个即将付钱的用户，不是公开位。
 */
export interface ProjectListView {
  id: string;
  title: string;
  subtitle: string | null;
  merchantName: string | null;
  category: string | null;
  coverUrl: string | null;
  periods: number;
  /** 总价：必须有（否则用户不知道要付多少） */
  totalPrice: number;
  freq: string;
  streakDays: number;
  soldCount: number;
  listedAt: Date | null;
  /** 定性承诺，刻意不含任何金额或百分比 */
  refundClaim: string;
}

export function toProjectListView(card: Card, soldCount = 0): ProjectListView {
  const unitPrice = card.unitPrice ?? 0;
  const periods = card.periods ?? 0;
  return {
    id: card.id,
    title: card.title || card.id.slice(0, 8),
    subtitle: card.subtitle,
    merchantName: card.merchantName,
    category: card.category,
    coverUrl: card.coverUrl,
    periods,
    totalPrice: Math.round(unitPrice * periods * 100) / 100,
    freq: card.freq,
    streakDays: config.package.streakDays,
    soldCount,
    listedAt: card.listedAt,
    refundClaim: `每期连续 ${config.package.streakDays} 天任务 + 到店核销，可全额返还至消费金`,
  };
}

export function toProjectView(card: Card, soldCount = 0): ProjectView {
  const unitPrice = card.unitPrice ?? 0;
  const periods = card.periods ?? 0;
  // 比例逐卡取：每张卡由运营在设计时决定"分多少"，不再统一 30%
  const shareRatio = Number(card.shareRatio ?? config.package.shareRatioDefault);
  return {
    id: card.id,
    // title 为空的存量卡（004 之前设计）用 id 兜底，避免宿主页面出现空标题
    title: card.title || card.id.slice(0, 8),
    subtitle: card.subtitle,
    merchantName: card.merchantName,
    category: card.category,
    coverUrl: card.coverUrl,
    unitPrice,
    periods,
    totalPrice: Math.round(unitPrice * periods * 100) / 100,
    freq: card.freq,
    refundNowRatio: Math.round((1 - shareRatio) * 1000) / 1000,
    refundShareRatio: shareRatio,
    streakDays: config.package.streakDays,
    soldCount,
    listedAt: card.listedAt,
  };
}

/**
 * 购买前的「承诺摘要」：内联 SDK 在确认弹层里必须原样展示这段，
 * 而不是由各宿主页面自己拼文案（各站文案漂移 = 客诉口径不一致 = 合规风险）。
 */
export function promiseOf(v: ProjectView): {
  amount: number;
  refundNow: number;
  refundShare: number;
  refundTotal: number;
  rule: string;
  caveat: string[];
} {
  const refundNow = Math.round(v.unitPrice * v.refundNowRatio * 100) / 100;
  const refundShare = Math.round(v.unitPrice * v.refundShareRatio * 100) / 100;
  return {
    amount: v.totalPrice,
    refundNow,
    refundShare,
    refundTotal: Math.round((refundNow + refundShare) * 100) / 100,
    rule: `每期连续 ${v.streakDays} 天完成「孪生聊天 + 投喂」并到店核销，返还 ${Math.round(
      v.refundNowRatio * 100
    )}%；分享给好友（对方打开链接即绑定，无需下单）再返还 ${Math.round(v.refundShareRatio * 100)}%`,
    caveat: [
      "返还至平台消费金余额，不可提现",
      "一期一周，当期未核销即作废，不累计到下期",
      `连续 ${v.streakDays} 天的最晚开始日为当周周三`,
    ],
  };
}
