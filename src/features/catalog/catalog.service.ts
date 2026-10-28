import { badRequest, notFound, forbidden } from "../../lib/errors";
import { Role } from "../../middleware/auth";
import {
  insertProduct,
  findProductById,
  listByMerchant,
  listAll,
  updateProduct,
  setProductStatus,
} from "./catalog.repo";
import { CreateProductInput, UpdateProductInput, MerchantProduct } from "./catalog.types";

/**
 * 商户新建自有商品（商品库）。
 * 商户只能给自己建；OPERATOR 代建也允许（运营帮商户录入）。
 */
export async function createProduct(
  input: CreateProductInput,
  actor: { role: Role; merchantId?: string }
): Promise<MerchantProduct> {
  if (!input.name || !input.name.trim()) throw badRequest("商品名不能为空");
  if (actor.role === "MERCHANT" && actor.merchantId && actor.merchantId !== input.merchantId) {
    throw forbidden("只能为自己的商家创建商品");
  }
  if (input.originPrice != null && input.originPrice < 0) {
    throw badRequest("原价不能为负");
  }
  return insertProduct({
    merchantId: input.merchantId,
    name: input.name.trim().slice(0, 120),
    category: input.category ?? null,
    coverUrl: input.coverUrl ?? null,
    spec: input.spec ?? null,
    originPrice: input.originPrice ?? null,
  });
}

/** 列商品：MERCHANT 只看自己的；OPERATOR 看全部 */
export async function listProducts(
  merchantId: string,
  actor: { role: Role; merchantId?: string }
): Promise<MerchantProduct[]> {
  if (actor.role === "MERCHANT") {
    if (actor.merchantId && actor.merchantId !== merchantId) {
      throw forbidden("只能查看自己商家的商品");
    }
    return listByMerchant(merchantId);
  }
  return listAll();
}

async function assertOwned(productId: string, actor: { role: string; merchantId?: string }) {
  const p = await findProductById(productId);
  if (!p) throw notFound("商品不存在");
  if (actor.role === "MERCHANT" && actor.merchantId && actor.merchantId !== p.merchantId) {
    throw forbidden("只能修改自己商家的商品");
  }
  return p;
}

export async function updateProductById(
  productId: string,
  patch: UpdateProductInput,
  actor: { role: string; merchantId?: string }
): Promise<MerchantProduct> {
  await assertOwned(productId, actor);
  if (patch.name !== undefined && !patch.name.trim()) throw badRequest("商品名不能为空");
  const normalized: Record<string, unknown> = {};
  if (patch.name !== undefined) normalized.name = patch.name.trim().slice(0, 120);
  if (patch.category !== undefined) normalized.category = patch.category;
  if (patch.coverUrl !== undefined) normalized.cover_url = patch.coverUrl;
  if (patch.spec !== undefined) normalized.spec = patch.spec;
  if (patch.originPrice != null) {
    if (patch.originPrice < 0) throw badRequest("原价不能为负");
    normalized.origin_price = patch.originPrice;
  }
  const updated = await updateProduct(productId, normalized);
  if (!updated) throw notFound("商品不存在");
  return updated;
}

export async function setStatus(
  productId: string,
  status: "active" | "offline",
  actor: { role: string; merchantId?: string }
): Promise<MerchantProduct> {
  await assertOwned(productId, actor);
  const updated = await setProductStatus(productId, status);
  if (!updated) throw notFound("商品不存在");
  return updated;
}
