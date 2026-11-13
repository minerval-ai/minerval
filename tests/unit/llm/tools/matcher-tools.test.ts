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

  it("passes an undecided outcome through with a do-not-create note (#419)", async () => {
    // A Matcher timeout used to arrive as is_match:false, indistinguishable
    // from a genuine no-match, so a trusting caller minted a duplicate.
    mockMatchClaim.mockResolvedValueOnce({
      outcome: "undecided",
      is_match: false,
      matched_claim_id: null,
      new_canonical_form: null,
      instance_stance: "affirms",
      direction_note: null,
      confidence: 0,
      reasoning: "Matcher did not submit a decision within its search budget.",
      alternative_matches: [],
      relationship_notes: null,
    });

    const out = JSON.parse(
      await executeMatcherTool("match_claim", { text: "some proposition" })
    );
    expect(out.outcome).toBe("undecided");
    expect(out.note).toMatch(/Do not create a new claim/);
    expect(out.new_canonical_form).toBeNull();
  });

  it("carries the decided outcome and no note otherwise", async () => {
    mockMatchClaim.mockResolvedValueOnce({
      outcome: "new",
      is_match: false,
      matched_claim_id: null,
      new_canonical_form: "A wording",
      instance_stance: "affirms",
      confidence: 0.7,
      reasoning: "Novel.",
      alternative_matches: [],
      relationship_notes: null,
    });
    const out = JSON.parse(
      await executeMatcherTool("match_claim", { text: "some proposition" })
    );
    expect(out.outcome).toBe("new");
    expect(out).not.toHaveProperty("note");
  });

  it("still rejects empty text", async () => {
    const out = JSON.parse(await executeMatcherTool("match_claim", { text: " " }));
    expect(out.error).toContain("non-empty");
    expect(mockMatchClaim).not.toHaveBeenCalled();
  });
});

// #967, #969: on 2026-11-12 the Matcher's provider refused calls for lack
// of credits and the tool handed the Steward the provider's raw text. A
// Steward with most of its budget left could not tell whose money was
// meant, and minted two subclaims on embedding search alone.
describe("match_claim when a platform fault stops the Matcher", () => {
  const RAW =
    "402 This request's maximum cost exceeds your available credits. Add credits, or lower max_tokens or prompt size.";

  it("says identity was not checked, by the fault's class, with the rule and no provider text", async () => {
    mockMatchClaim.mockRejectedValueOnce(Object.assign(new Error(RAW), { status: 402 }));
    const text = await executeMatcherTool("match_claim", { text: "some proposition" });
    const out = JSON.parse(text);
    expect(out.outcome).toBe("unavailable");
    expect(out.platform_fault).toBe("credits_fault");
    // Not a verdict either way.
    expect(out.is_match).toBeNull();
    expect(out.matched_claim_id).toBeNull();
    expect(out.error).toBeUndefined();
    // What to do, in the result itself: nothing is refused elsewhere.
    expect(out.note).toContain("Identity was NOT checked");
    expect(out.note).toContain("Do not create a node from this result");
    expect(out.note).toContain("search_similar_claims alone");
    expect(out.note).toContain("leave the premise in prose");
    expect(out.note).toContain("not your run's budget");
    expect(out.note).toContain("do not raise_issue");
    // The provider's words stay in the logs.
    expect(text).not.toContain("402");
    expect(text).not.toContain("max_tokens");
    expect(text).not.toContain("Add credits");
  });

  it("does the same for a rejected key and for a provider that stayed down", async () => {
    mockMatchClaim.mockRejectedValueOnce(Object.assign(new Error("401 invalid x-api-key"), { status: 401 }));
    expect(JSON.parse(await executeMatcherTool("match_claim", { text: "p" }))).toMatchObject({
      outcome: "unavailable",
      platform_fault: "credentials_fault",
    });
    mockMatchClaim.mockRejectedValueOnce(Object.assign(new Error("503 upstream"), { status: 503 }));
    const down = JSON.parse(await executeMatcherTool("match_claim", { text: "p" }));
    expect(down).toMatchObject({ outcome: "unavailable", platform_fault: "provider_unavailable" });
    expect(down.note).toContain("One retry is reasonable");
  });

  it("still reports a genuine failure as an error", async () => {
    mockMatchClaim.mockRejectedValueOnce(new Error("submit_match_decision named a claim that does not exist"));
    const out = JSON.parse(await executeMatcherTool("match_claim", { text: "p" }));
    expect(out.error).toContain("does not exist");
    expect(out.outcome).toBeUndefined();
  });
});
