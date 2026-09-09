import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../src/llm/agents/matcher.js", () => ({
  matchClaim: vi.fn(),
}));

import { executeMatcherTool } from "../../../../src/llm/tools/matcher-tools.js";
import { matchClaim } from "../../../../src/llm/agents/matcher.js";

const mockMatchClaim = vi.mocked(matchClaim);

describe("match_claim tool wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes alternative_matches and relationship_notes through to the caller", async () => {
    // The regression this guards (#100): the wrapper used to strip the
    // near-miss candidates and relationship notes, so the Steward/Curator
    // never saw the alternates the Matcher considered — exactly the signal
    // needed to decide link-vs-escalate.
    mockMatchClaim.mockResolvedValueOnce({
      is_match: false,
      matched_claim_id: null,
      new_canonical_form: "Raising the minimum wage reduces teen employment",
      instance_stance: "affirms",
      confidence: 0.7,
      reasoning: "No exact match; two near-misses considered.",
      alternative_matches: ["aaaaaaaa-0000-0000-0000-000000000001"],
      relationship_notes: "Near-miss is a broader claim about employment effects.",
      direction_note:
        "Stated as the employment-effect thesis the literature argues over, not its denial.",
    });

    const out = JSON.parse(
      await executeMatcherTool("match_claim", { text: "some proposition" })
    );
    expect(out.alternative_matches).toEqual([
      "aaaaaaaa-0000-0000-0000-000000000001",
    ]);
    expect(out.relationship_notes).toBe(
      "Near-miss is a broader claim about employment effects."
    );
    // Why the new form runs in the direction it does (#360) reaches the
    // caller that mints the claim, so the polarity is recorded, not inferred
    // from whichever source arrived first.
    expect(out.direction_note).toBe(
      "Stated as the employment-effect thesis the literature argues over, not its denial."
    );
  });

  it("defaults the pass-through fields when the Matcher omits them", async () => {
    // alternative_matches/relationship_notes are not in the decision schema's
    // required set, so a submission may omit them.
    mockMatchClaim.mockResolvedValueOnce({
      is_match: true,
      matched_claim_id: "bbbbbbbb-0000-0000-0000-000000000002",
      new_canonical_form: null,
      instance_stance: "denies",
      confidence: 0.9,
      reasoning: "Counterpart of an existing claim.",
    } as Awaited<ReturnType<typeof matchClaim>>);

    const out = JSON.parse(
      await executeMatcherTool("match_claim", { text: "some proposition" })
    );
    expect(out.alternative_matches).toEqual([]);
    expect(out.relationship_notes).toBeNull();
    expect(out.direction_note).toBeNull();
  });

  it("still rejects empty text", async () => {
    const out = JSON.parse(await executeMatcherTool("match_claim", { text: " " }));
    expect(out.error).toContain("non-empty");
    expect(mockMatchClaim).not.toHaveBeenCalled();
  });
});
