import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../src/services/reconciliation-service.js", () => ({
  mergeClaims: vi.fn(async () => ({
    survivorId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    loserId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  })),
  createClaim: vi.fn(async () => ({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc" })),
  addRelationshipEdge: vi.fn(async () => ({ added: true })),
  removeRelationshipEdge: vi.fn(async () => ({ removed: 1 })),
  reassignInstance: vi.fn(async () => ({ reassigned: true })),
  linkClaims: vi.fn(async () => ({ linked: true, linkId: "dddddddd-dddd-dddd-dddd-dddddddddddd" })),
  unlinkClaims: vi.fn(async () => ({ removed: 1 })),
}));

vi.mock("../../../../src/services/queue-service.js", () => ({
  enqueueSteward: vi.fn(async () => {}),
}));

import { executeCuratorTool } from "../../../../src/llm/tools/curator-tools.js";
import {
  mergeClaims,
  linkClaims,
  unlinkClaims,
} from "../../../../src/services/reconciliation-service.js";

describe("curator merge_claims stance_relation (#182)", () => {
  const SURVIVOR = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const LOSER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a hedged/misspelled value WITHOUT merging (no silent 'same')", async () => {
    // The regression this guards: anything other than exactly "opposed" was
    // coerced to "same", so a value like "probably opposed" merged a claim
    // into its negation without flipping the moved stances.
    for (const bad of ["probably opposed", "Opposed", "opposite", "", undefined]) {
      const out = await executeCuratorTool("merge_claims", {
        survivor_id: SURVIVOR,
        loser_id: LOSER,
        stance_relation: bad,
        reasoning: "same proposition",
      });
      const parsed = JSON.parse(out);
      expect(parsed.success).toBe(false);
      expect(parsed.message).toContain("stance_relation");
    }
    expect(mergeClaims).not.toHaveBeenCalled();
  });

  it("passes 'opposed' through exactly", async () => {
    const out = await executeCuratorTool("merge_claims", {
      survivor_id: SURVIVOR,
      loser_id: LOSER,
      stance_relation: "opposed",
      reasoning: "loser is the survivor's negation",
    });
    expect(JSON.parse(out).success).toBe(true);
    expect(mergeClaims).toHaveBeenCalledWith(
      expect.objectContaining({ stanceRelation: "opposed" })
    );
  });

  it("passes 'same' through exactly", async () => {
    const out = await executeCuratorTool("merge_claims", {
      survivor_id: SURVIVOR,
      loser_id: LOSER,
      stance_relation: "same",
      reasoning: "duplicate wording",
    });
    expect(JSON.parse(out).success).toBe(true);
    expect(mergeClaims).toHaveBeenCalledWith(
      expect.objectContaining({ stanceRelation: "same" })
    );
  });
});

describe("curator link_claims / unlink_claims (#436)", () => {
  const X = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const Y = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records a lateral link as a logged direct write", async () => {
    const out = JSON.parse(
      await executeCuratorTool("link_claims", {
        claim_id: X,
        other_claim_id: Y,
        kind: "Rival_Explanation",
        reasoning: "competing accounts of the same crisis",
      })
    );
    expect(out).toMatchObject({ success: true, linked: true });
    expect(linkClaims).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: X,
        otherClaimId: Y,
        kind: "rival_explanation", // normalized like the relation tokens
        createdBy: "curator",
      })
    );
  });

  it("reports an existing link rather than claiming a write", async () => {
    vi.mocked(linkClaims).mockResolvedValueOnce({ linked: false, linkId: "l" });
    const out = JSON.parse(
      await executeCuratorTool("link_claims", {
        claim_id: X,
        other_claim_id: Y,
        kind: "related",
        reasoning: "r",
      })
    );
    expect(out).toMatchObject({ success: true, linked: false });
    expect(out.message).toContain("already existed");
  });

  it("bounces an unknown kind and a self-link without writing", async () => {
    for (const bad of [
      { claim_id: X, other_claim_id: Y, kind: "premise", reasoning: "r" },
      { claim_id: X, other_claim_id: X, kind: "related", reasoning: "r" },
    ]) {
      const out = JSON.parse(await executeCuratorTool("link_claims", bad));
      expect(out.success).toBe(false);
    }
    expect(linkClaims).not.toHaveBeenCalled();
  });

  it("unlinks one kind or every kind between the pair", async () => {
    await executeCuratorTool("unlink_claims", {
      claim_id: X,
      other_claim_id: Y,
      kind: "related",
      reasoning: "not actually related",
    });
    expect(unlinkClaims).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: X, otherClaimId: Y, kind: "related" })
    );
    await executeCuratorTool("unlink_claims", { claim_id: X, other_claim_id: Y, reasoning: "none" });
    expect(vi.mocked(unlinkClaims).mock.calls[1]![0]).toMatchObject({ kind: undefined });
  });
});
