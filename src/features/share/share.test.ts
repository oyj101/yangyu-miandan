import { describe, it, expect } from "vitest";
import { buildShareLink } from "./share.service";

describe("分享链接（统一关系链）", () => {
  it("把 ref 填进主站落地页模板，不生成养鱼自有邀请码", () => {
    const url = buildShareLink("12345");
    expect(url).toContain("ref=12345");
    // 链接指向主站落地页，不是养鱼自己的域名
    expect(url).not.toContain("yangyu-api");
  });

  it("附加参数正确拼接（模板已有 query 时用 &）", () => {
    const url = buildShareLink("12345", { from: "mine", cardId: "c1" });
    expect(url).toContain("from=mine");
    expect(url).toContain("cardId=c1");
    expect(url.split("?").length).toBe(2); // 只允许一个 ?
  });

  it("ref 做 URI 编码（防参数注入）", () => {
    const url = buildShareLink("a&b=c");
    expect(url).toContain("ref=a%26b%3Dc");
    expect(url.split("&").length).toBe(1); // & 未逃逸成新参数
  });

  it("空附加参数不产生尾部 ?/&", () => {
    const url = buildShareLink("1", { from: "" });
    expect(url.endsWith("&")).toBe(false);
    expect(url.endsWith("?")).toBe(false);
  });
});
