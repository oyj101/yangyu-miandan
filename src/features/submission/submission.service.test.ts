import { describe, it, expect } from "vitest";
import { applySubmissionReview } from "./submission.service";

describe("applySubmissionReview 提报审核状态机", () => {
  it("submitted → approve = approved", () => {
    expect(applySubmissionReview("submitted", "approve")).toBe("approved");
  });

  it("submitted → reject = rejected", () => {
    expect(applySubmissionReview("submitted", "reject")).toBe("rejected");
  });

  it("终态 approved 不可重复审核", () => {
    expect(() => applySubmissionReview("approved", "approve")).toThrow();
  });

  it("终态 rejected 不可重复审核", () => {
    expect(() => applySubmissionReview("rejected", "reject")).toThrow();
  });
});
