/**
 * A request may bear on several nodes, sources, or something the graph does
 * not hold yet, so a propose_request may name no claim (#724); every other
 * contribution is about one existing node.
 */
import { describe, it, expect } from "vitest";
import { createContributionBody } from "../../../src/schemas/governance.js";

const base = { content: "Someone should find the trial's registration." };

describe("createContributionBody", () => {
  it("takes a propose_request with no claim_id", () => {
    expect(createContributionBody.safeParse({ ...base, contribution_type: "propose_request" }).success).toBe(true);
  });

  it("still requires claim_id for every other type", () => {
    const out = createContributionBody.safeParse({ ...base, contribution_type: "challenge" });
    expect(out.success).toBe(false);
    expect(out.error?.issues[0]?.path).toEqual(["claim_id"]);
  });

  it("takes a claim_id on a propose_request too", () => {
    expect(
      createContributionBody.safeParse({
        ...base,
        contribution_type: "propose_request",
        claim_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }).success
    ).toBe(true);
  });
});
