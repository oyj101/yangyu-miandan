import { describe, it, expect } from "vitest";
import { createProduct } from "./catalog.service";
import { query } from "../../lib/db";

// 以下用例均命中「校验在 DB 写入之前」的分支，不触达数据库。
describe("createProduct 参数校验（DB 前置分支）", () => {
  it("空商品名抛错", async () => {
    await expect(
      createProduct({ merchantId: "m1", name: "   " }, { role: "MERCHANT", merchantId: "m1" })
    ).rejects.toThrow();
  });

  it("负原价抛错", async () => {
    await expect(
      createProduct({ merchantId: "m1", name: "x", originPrice: -1 }, { role: "MERCHANT", merchantId: "m1" })
    ).rejects.toThrow();
  });

  it("商户不能替别的商家创建商品", async () => {
    await expect(
      createProduct({ merchantId: "m2", name: "x" }, { role: "MERCHANT", merchantId: "m1" })
    ).rejects.toThrow();
  });

  it("OPERATOR 不被「只能为自己」分支拦截（环境无关断言）", async () => {
    // 该用例只验证角色语义：OPERATOR 代任意商家建商品不被权限分支拦截。
    // DB 可用 → 创建成功（清理测试残留）；DB 不可用 → 抛连接错误。
    // 两种环境下都绝不允许命中 FORBIDDEN 角色错误。
    try {
      const p = await createProduct({ merchantId: "m2", name: "x" }, { role: "OPERATOR" });
      await query("DELETE FROM merchant_product WHERE id = ?", [p.id]).catch(() => undefined);
    } catch (e: any) {
      expect(String(e?.message ?? e)).not.toMatch(/只能为自己|forbidden/i);
    }
  });
});
