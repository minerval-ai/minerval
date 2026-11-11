import { describe, it, expect, vi, beforeEach } from "vitest";

// No node in these tests is a merged alias (#884): ids resolve to themselves.
vi.mock("../../../../src/services/claim-alias-service.js", async (importOriginal) =>
  (await import("../../../../tests/unit/claim-alias-mock.js")).passthroughClaimAlias(importOriginal)
);
vi.mock("../../../../src/services/reconciliation-service.js", () => ({
  mergeClaims: vi.fn(async () => ({
    survivorId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    loserId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    eventId: "evt-merge",
  })),
  createClaim: vi.fn(async () => ({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", eventId: "evt-create" })),
  setQuantityDefinition: vi.fn(async () => ({ eventId: "evt-def" })),
  reclassifyClaim: vi.fn(async () => ({ changed: true, eventId: "evt-reclass" })),
  listReconciliationEvents: vi.fn(async () => [{ id: "evt-merge", operation: "merge" }]),
  reverseReconciliation: vi.fn(async (id: string) =>
    id === "evt-blocked"
      ? { reversed: false, reason: "later operations touched the same nodes", blockedBy: ["evt-later"] }
      : { reversed: true }),
  RECONCILIATION_EVENTS_LIMIT: 30,
  addRelationshipEdge: vi.fn(async () => ({ added: true })),
  removeRelationshipEdge: vi.fn(async () => ({ removed: 1 })),
  reassignInstance: vi.fn(async () => ({ reassigned: true })),
  linkClaims: vi.fn(async () => ({ linked: true, linkId: "dddddddd-dddd-dddd-dddd-dddddddddddd" })),
  unlinkClaims: vi.fn(async () => ({ removed: 1 })),
}));

vi.mock("../../../../src/services/queue-service.js", () => ({
  enqueueSteward: vi.fn(async () => {}),
}));

import { executeCuratorTool, getCuratorToolDefinitions } from "../../../../src/llm/tools/curator-tools.js";
import {
  mergeClaims,
  linkClaims,
  unlinkClaims,
  createClaim,
  setQuantityDefinition,
  reclassifyClaim,
  reverseReconciliation,
  reassignInstance,
} from "../../../../src/services/reconciliation-service.js";
import { enqueueSteward } from "../../../../src/services/queue-service.js";
import { addRelationshipEdge } from "../../../../src/services/reconciliation-service.js";
import { UnknownRelationError } from "../../../../src/services/relationship-service.js";

const NODE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("curator surgery returns event ids, and reverse_reconciliation undoes them (#761)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("merge_claims returns the event id reverse_reconciliation takes", async () => {
    const out = JSON.parse(await executeCuratorTool("merge_claims", {
      survivor_id: "s", loser_id: "l", stance_relation: "same", reasoning: "one claim",
    }));
    expect(out.event_id).toBe("evt-merge");
  });

  it("reverses with reasoning, and names what to reverse first when refused", async () => {
    const ok = JSON.parse(await executeCuratorTool("reverse_reconciliation", { event_id: "evt-merge", reasoning: "wrong" }));
    expect(ok.success).toBe(true);
    expect(reverseReconciliation).toHaveBeenCalledWith("evt-merge", { reasoning: "wrong" });
    const blocked = JSON.parse(await executeCuratorTool("reverse_reconciliation", { event_id: "evt-blocked", reasoning: "wrong" }));
    expect(blocked).toMatchObject({ success: false, reverse_first: ["evt-later"] });
  });

  it("asks why before reversing anything", async () => {
    const out = JSON.parse(await executeCuratorTool("reverse_reconciliation", { event_id: "evt-merge" }));
    expect(out.success).toBe(false);
    expect(reverseReconciliation).not.toHaveBeenCalled();
  });

  it("no longer tells the agent there is no undo", () => {
    const text = JSON.stringify(getCuratorToolDefinitions());
    expect(text).toContain("reverse_reconciliation");
    expect(text).toContain("match_claim first, every time");
  });
});

describe("curator create_claim and quantities (#764)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("mints a quantity with its definition", async () => {
    const out = JSON.parse(await executeCuratorTool("create_claim", {
      text: "Median rent in Paris in 2025",
      kind: "quantity",
      definition: { measures: "median monthly rent", unit: { kind: "currency", currency: "EUR" } },
    }));
    expect(out).toMatchObject({ success: true, kind: "quantity", event_id: "evt-create" });
    expect(createClaim).toHaveBeenCalledWith(expect.objectContaining({
      kind: "quantity",
      definition: expect.objectContaining({ measures: "median monthly rent" }),
    }));
  });

  it("refuses a quantity without a definition, and an unknown claim_type", async () => {
    expect(JSON.parse(await executeCuratorTool("create_claim", { text: "x", kind: "quantity" })).success).toBe(false);
    expect(JSON.parse(await executeCuratorTool("create_claim", { text: "x", claim_type: "vibes" })).success).toBe(false);
    expect(createClaim).not.toHaveBeenCalled();
  });

  it("completes a quantity's definition and asks its Steward to re-estimate", async () => {
    const out = JSON.parse(await executeCuratorTool("complete_quantity_definition", {
      claim_id: NODE, measures: "median monthly rent", unit: { kind: "currency", currency: "EUR" }, reasoning: "the discourse means rent",
    }));
    expect(out).toMatchObject({ success: true, event_id: "evt-def" });
    expect(setQuantityDefinition).toHaveBeenCalled();
    expect(enqueueSteward).toHaveBeenCalledWith(expect.objectContaining({ claimId: NODE, trigger: "curator_change" }));
  });
});

describe("curator reclassify_claim (#640)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sets a mistyped node's claim_type and tells its Steward", async () => {
    const out = JSON.parse(await executeCuratorTool("reclassify_claim", {
      claim_id: NODE, claim_type: "mathematical", reasoning: "a published theorem",
    }));
    expect(out).toMatchObject({ success: true, changed: true, event_id: "evt-reclass" });
    expect(reclassifyClaim).toHaveBeenCalledWith(expect.objectContaining({ claimId: NODE, claimType: "mathematical" }));
    expect(enqueueSteward).toHaveBeenCalled();
  });

  it("refuses an unknown domain or an empty call", async () => {
    expect(JSON.parse(await executeCuratorTool("reclassify_claim", {
      claim_id: NODE, domains: ["astrology"], reasoning: "r",
    })).success).toBe(false);
    expect(JSON.parse(await executeCuratorTool("reclassify_claim", { claim_id: NODE, reasoning: "r" })).success).toBe(false);
    expect(reclassifyClaim).not.toHaveBeenCalled();
  });
});

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

describe("curator add_relationship_edge (#658)", () => {
  it("answers an off-enum relation with the valid ones, not an error string", async () => {
    vi.mocked(addRelationshipEdge).mockRejectedValueOnce(new UnknownRelationError("causes"));
    const out = JSON.parse(
      await executeCuratorTool("add_relationship_edge", { parent_id: "p", child_id: "c", relation: "causes", reasoning: "r" })
    );
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/Unknown relation "causes"\. Use one of: requires/);
  });
});

describe("curator reassign_instance (#828, #815)", () => {
  beforeEach(() => vi.clearAllMocks());
  const I = "11111111-1111-4111-8111-111111111111";

  it("offers copy, stance_relation, the figure for a quantity, and an answer, and requires reasoning", () => {
    const tool = getCuratorToolDefinitions().find((t) => t.name === "reassign_instance")!;
    const schema = tool.input_schema as unknown as {
      properties: Record<string, { enum?: string[]; required?: string[] }>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["instance_id", "to_claim_id", "copy", "stance_relation", "stated", "answer_claim_id", "reasoning"])
    );
    expect(schema.properties.stance_relation!.enum).toEqual(["same", "opposed"]);
    // The figure takes the shape record_estimate takes.
    expect(schema.properties.stated!.required).toEqual(["form"]);
    expect(schema.required).toEqual(["instance_id", "to_claim_id", "reasoning"]);
  });

  it("passes the whole call through and reports where the passage now is", async () => {
    vi.mocked(reassignInstance).mockResolvedValueOnce({
      reassigned: true,
      mode: "copy",
      instanceId: "new-instance",
      stance: "states",
      eventId: "evt-copy",
    });
    const out = JSON.parse(
      await executeCuratorTool("reassign_instance", {
        instance_id: I,
        to_claim_id: NODE,
        copy: true,
        stated: { form: "point", central: 42 },
        reasoning: "the sentence gives game two as 42",
      })
    );
    expect(reassignInstance).toHaveBeenCalledWith({
      instanceId: I,
      toClaimId: NODE,
      copy: true,
      reasoning: "the sentence gives game two as 42",
      stanceRelation: "same",
      stated: { form: "point", central: 42 },
      answerClaimId: null,
    });
    expect(out).toMatchObject({
      success: true,
      mode: "copy",
      instance_id: "new-instance",
      stance: "states",
      event_id: "evt-copy",
    });
  });

  it("defaults to a move, and passes 'opposed' through", async () => {
    vi.mocked(reassignInstance).mockResolvedValueOnce({
      reassigned: true,
      mode: "move",
      instanceId: I,
      stance: "denies",
      eventId: "evt-move",
    });
    const out = JSON.parse(
      await executeCuratorTool("reassign_instance", {
        instance_id: I,
        to_claim_id: NODE,
        stance_relation: "opposed",
        answer_claim_id: " ",
        reasoning: "worded as the denial",
      })
    );
    expect(vi.mocked(reassignInstance).mock.calls[0]![0]).toMatchObject({
      copy: false,
      stanceRelation: "opposed",
      answerClaimId: null,
    });
    expect(out).toMatchObject({ success: true, mode: "move", stance: "denies" });
  });

  it("the Curator is told to copy a passage several nodes share, and that an argument's stance is its Steward's", async () => {
    const { getCuratorSystemPrompt } = await import("../../../../src/llm/prompts/curator.js");
    const prompt = getCuratorSystemPrompt().replace(/\s+/g, " ");
    expect(prompt).toContain("copy it (copy: true) to each of the others");
    expect(prompt).toContain("you do not flip it: notify_steward that node, naming the argument and asking for revise_argument");
    const { getStewardToolDefinitions } = await import("../../../../src/llm/tools/steward-tools.js");
    const escalate = getStewardToolDefinitions().find((t) => t.name === "escalate_to_curator")!;
    expect(escalate.description).toContain("yours to correct with revise_argument");
  });

  it("asks for reasoning and a valid stance_relation before writing, and relays a refusal", async () => {
    const noReason = JSON.parse(await executeCuratorTool("reassign_instance", { instance_id: I, to_claim_id: NODE }));
    expect(noReason.success).toBe(false);
    const hedged = JSON.parse(
      await executeCuratorTool("reassign_instance", {
        instance_id: I,
        to_claim_id: NODE,
        stance_relation: "mostly opposed",
        reasoning: "r",
      })
    );
    expect(hedged.success).toBe(false);
    expect(reassignInstance).not.toHaveBeenCalled();

    vi.mocked(reassignInstance).mockResolvedValueOnce({
      reassigned: false,
      reason: "claim X already has an instance from this source: abc",
    });
    const refused = JSON.parse(
      await executeCuratorTool("reassign_instance", { instance_id: I, to_claim_id: NODE, copy: true, reasoning: "r" })
    );
    expect(refused).toMatchObject({ success: false, reassigned: false });
    expect(refused.message).toContain("already has an instance from this source: abc");
  });
});
