import { badRequest, forbidden, notFound } from "../../lib/errors";
import { Role } from "../../middleware/auth";
import {
  insertSubmission,
  findSubmissionById,
  listByMerchant,
  listPending,
  setSubmissionStatus,
} from "./submission.repo";
import { findProductById } from "../catalog/catalog.repo";
import { CreateSubmissionInput, MerchantSubmission, SubmissionStatus } from "./submission.types";

/**
 * 提报审核状态机（纯函数，便于穷举测试）。
 * 只有 submitted 可被审核；approved/rejected 终态不可逆（重提请新建提报）。
 */
export function applySubmissionReview(
  current: SubmissionStatus,
  action: "approve" | "reject"
): "approved" | "rejected" {
  if (current !== "submitted") {
    throw badRequest(`提报当前为 ${current}，已是终态，不可重复审核`);
  }
  return action === "approve" ? "approved" : "rejected";
}

/**
 * 商户提报：从自有商品库选品 + 设活动供应价 + 参与数量（份数）。
 * 校验：商品存在、属于该商户、且为 active（下架商品不可提报）。
 */
export async function createSubmission(
  input: CreateSubmissionInput,
  actor: { role: Role; merchantId?: string }
): Promise<MerchantSubmission> {
  if (actor.role === "MERCHANT" && actor.merchantId && actor.merchantId !== input.merchantId) {
    throw forbidden("只能为自己的商家提报");
  }
  if (input.supplyPrice < 0) throw badRequest("活动供应价不能为负");
  if (!(input.quota > 0)) throw badRequest("参与数量必须为正整数");

  const product = await findProductById(input.productId);
  if (!product) throw notFound("所选商品不存在");
  if (product.merchantId !== input.merchantId) {
    throw forbidden("只能提报自己商家的商品");
  }
  if (product.status !== "active") {
    throw badRequest("该商品已下架，请先上架再提报");
  }

  return insertSubmission({
    merchantId: input.merchantId,
    productId: input.productId,
    supplyPrice: Math.round(input.supplyPrice * 100) / 100,
    quota: Math.floor(input.quota),
  });
}

/** 列提报：MERCHANT 看自己；OPERATOR 看全部 */
export async function listSubmissions(
  merchantId: string,
  actor: { role: Role; merchantId?: string }
): Promise<MerchantSubmission[]> {
  if (actor.role === "MERCHANT") {
    if (actor.merchantId && actor.merchantId !== merchantId) {
      throw forbidden("只能查看自己商家的提报");
    }
    return listByMerchant(merchantId);
  }
  return listPending();
}

/**
 * OPERATOR 审核提报。通过后由「据此设计套餐卡」(card.designPackageCard + submissionId) 落地。
 * 此处只改提报状态，不耦合卡设计，职责单一。
 */
export async function reviewSubmission(
  submissionId: string,
  approve: boolean,
  operator: string,
  rejectReason?: string
): Promise<MerchantSubmission> {
  const sub = await findSubmissionById(submissionId);
  if (!sub) throw notFound("提报不存在");
  const next = applySubmissionReview(sub.status, approve ? "approve" : "reject");
  if (approve && !rejectReason) {
    // 通过无需理由；仅占位
  } else if (!approve && !rejectReason) {
    throw badRequest("驳回需填写理由");
  }
  const updated = await setSubmissionStatus(
    submissionId,
    next,
    operator,
    approve ? null : rejectReason ?? "未说明"
  );
  if (!updated) throw notFound("提报不存在");
  return updated;
}
