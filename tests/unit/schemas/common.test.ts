import { describe, it, expect } from "vitest";
import {
  claimTypeEnum,
  contributionTypeEnum,
  intakeContributionTypeEnum,
  prizeContributionTypeEnum,
  anyContributionTypeEnum,
} from "../../../src/schemas/common.js";

// The shared enums the mathematics program widens (docs/mathematics.md
// Appendix E): `mathematical` as a claim type, and `claim_prize` as a
// contribution type that display and filters know but POST /contributions
// must keep refusing.

describe("claimTypeEnum", () => {
  it("admits `mathematical` beside the original types", () => {
    expect(claimTypeEnum.safeParse("mathematical").success).toBe(true);
    expect(claimTypeEnum.options).toEqual([
      "empirical_verifiable",
      "empirical_derived",
      "definitional",
      "evaluative",
      "causal",
      "normative",
      "mathematical",
    ]);
  });
});

describe("contribution type enums", () => {
  it("claim_prize is a prize type folded into anyContributionTypeEnum", () => {
    expect(prizeContributionTypeEnum.options).toEqual(["claim_prize"]);
    expect(anyContributionTypeEnum.safeParse("claim_prize").success).toBe(true);
    expect(anyContributionTypeEnum.options).toEqual([
      ...contributionTypeEnum.options,
      ...intakeContributionTypeEnum.options,
      ...prizeContributionTypeEnum.options,
    ]);
  });

  it("claim_prize is NOT a type POST /contributions accepts", () => {
    expect(contributionTypeEnum.safeParse("claim_prize").success).toBe(false);
    expect(contributionTypeEnum.options).not.toContain("claim_prize");
    expect(intakeContributionTypeEnum.options).not.toContain("claim_prize");
  });

  it("every type in anyContributionTypeEnum belongs to exactly one family", () => {
    const families = [
      contributionTypeEnum.options,
      intakeContributionTypeEnum.options,
      prizeContributionTypeEnum.options,
    ];
    for (const type of anyContributionTypeEnum.options) {
      const n = families.filter((f) => (f as readonly string[]).includes(type)).length;
      expect(n).toBe(1);
    }
  });
});
