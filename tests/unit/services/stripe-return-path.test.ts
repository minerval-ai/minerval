import { describe, it, expect } from "vitest";
import { safeReturnPath } from "../../../src/services/stripe-service.js";

// Checkout brings a reader back to what they were funding: only a path on
// this site, never another host.
describe("safeReturnPath", () => {
  it("keeps a same-site path, with its query and fragment", () => {
    expect(safeReturnPath("/claims/abc")).toBe("/claims/abc");
    expect(safeReturnPath("/claims/abc?x=1#fund-decomposition")).toBe("/claims/abc?x=1#fund-decomposition");
  });

  it("refuses anything that could leave the site", () => {
    for (const p of ["//evil.example", "/\\evil.example", "https://evil.example", "evil", "/a\nb", "", null, undefined]) {
      expect(safeReturnPath(p)).toBeNull();
    }
    expect(safeReturnPath(`/${"a".repeat(400)}`)).toBeNull();
  });
});
