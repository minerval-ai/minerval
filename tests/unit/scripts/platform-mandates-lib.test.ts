import { describe, it, expect } from "vitest";
import {
  buildRequest,
  checkAgainstConversation,
  renderPullRequestBody,
  serializeRequest,
  validateRequest,
  type PublicPlatformConversation,
} from "../../../scripts/platform-mandates/lib.js";
import { canonicalJson, mandateDraftHash } from "../../../src/services/mandate-draft-hash.js";

/** Funding requests for platform mandates (#529): what a valid one is. */

const CONVO_ID = "c0c0c0c0-0000-4000-8000-000000000001";

const draft = {
  title: "Anthropic safety",
  objective: "Map and assess whether Anthropic operates at an appropriate level of safety.",
  plan: {
    strategy: "Decompose to contested bedrock; ingest the system cards and their critics.",
    items: [
      { action: "ingest", url: "https://example.org/system-card", rationale: "primary source" },
      { action: "assess", claim_id: "a1a1a1a1-0000-4000-8000-000000000001" },
    ],
  },
  expected_cost_owls: 420,
  notes: "Estimate uncertain by about 30%.",
};

function convo(over: Partial<PublicPlatformConversation> = {}): PublicPlatformConversation {
  return {
    id: CONVO_ID,
    status: "proposed",
    messages: [
      { role: "user", content: "Fund work on whether Anthropic operates safely." },
      { role: "assistant", content: "Here is a draft." },
    ],
    draft,
    draft_sha256: mandateDraftHash(draft),
    grant_id: null,
    ...over,
  };
}

const rationale = "A first test of public verification of safety cases (#522).";

describe("mandateDraftHash", () => {
  it("does not depend on key order, which jsonb does not preserve", () => {
    const reordered = {
      plan: { items: draft.plan.items.map((i) => Object.fromEntries(Object.entries(i).reverse())), strategy: draft.plan.strategy },
      notes: draft.notes,
      expected_cost_owls: 420,
      objective: draft.objective,
      title: draft.title,
    };
    expect(mandateDraftHash(reordered)).toBe(mandateDraftHash(draft));
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });

  it("changes with any change to the draft", () => {
    expect(mandateDraftHash({ ...draft, expected_cost_owls: 421 })).not.toBe(mandateDraftHash(draft));
    expect(mandateDraftHash({ ...draft, plan: { ...draft.plan, items: draft.plan.items.slice(1) } })).not.toBe(
      mandateDraftHash(draft)
    );
  });
});

describe("validateRequest", () => {
  const good = () => buildRequest({ convo: convo(), budgetOwls: 500, rationale });

  it("accepts a request built from a proposed conversation", () => {
    const r = good();
    expect(r.mandate_sha256).toBe(mandateDraftHash(draft));
    expect(validateRequest(JSON.parse(serializeRequest(r)), "anthropic-safety")).toEqual({ ok: true, request: r });
  });

  it("refuses an edited snapshot: the file must carry the draft the hash pins", () => {
    const r = good();
    const edited = { ...r, draft: { ...r.draft, objective: "Show that Anthropic is safe." } };
    const v = validateRequest(edited, "anthropic-safety");
    expect(v.ok).toBe(false);
    expect(!v.ok && v.problems.join(" ")).toMatch(/does not hash the draft/);
  });

  it("refuses a budget below the Grantmaker's quote", () => {
    const v = validateRequest({ ...good(), budget_owls: 400 }, "anthropic-safety");
    expect(!v.ok && v.problems.join(" ")).toMatch(/below the Grantmaker's quote/);
  });

  it("refuses a missing rationale, unknown fields, a bad slug, and a budget past the ceiling", () => {
    const v = validateRequest({ ...good(), rationale: "", extra: true, budget_owls: 20_000 }, "Anthropic Safety");
    expect(v.ok).toBe(false);
    const all = !v.ok ? v.problems.join(" | ") : "";
    expect(all).toMatch(/slug/);
    expect(all).toMatch(/unknown field "extra"/);
    expect(all).toMatch(/rationale/);
    expect(all).toMatch(/at most 10000/);
  });

  it("refuses a non-object", () => {
    expect(validateRequest([], "x").ok).toBe(false);
  });
});

describe("buildRequest", () => {
  it("refuses a conversation with no standing draft", () => {
    expect(() => buildRequest({ convo: convo({ status: "declined" }), budgetOwls: 500, rationale })).toThrow(/declined/);
    expect(() => buildRequest({ convo: convo({ draft: null, draft_sha256: null, status: "active" }), budgetOwls: 500, rationale })).toThrow();
  });
});

describe("checkAgainstConversation", () => {
  const req = () => buildRequest({ convo: convo(), budgetOwls: 500, rationale });

  it("is fundable while the conversation still holds the pinned draft", () => {
    expect(checkAgainstConversation(req(), convo())).toEqual({ state: "fundable" });
  });

  it("is refused once the Grantmaker revises the draft", () => {
    const revised = { ...draft, expected_cost_owls: 300 };
    const check = checkAgainstConversation(req(), convo({ draft: revised, draft_sha256: mandateDraftHash(revised) }));
    expect(check.state).toBe("refused");
    expect(check.state === "refused" && check.problem).toMatch(/changed since this file pinned it/);
  });

  it("is refused when the Grantmaker has since declined", () => {
    const check = checkAgainstConversation(req(), convo({ status: "declined" }));
    expect(check.state === "refused" && check.problem).toMatch(/declined, not proposed/);
  });

  it("reports an already-funded conversation as funded, so the workflow skips it", () => {
    expect(checkAgainstConversation(req(), convo({ status: "funded", grant_id: "g1" }))).toEqual({ state: "funded", grantId: "g1" });
  });

  it("is refused for an unknown conversation", () => {
    expect(checkAgainstConversation(req(), null).state).toBe("refused");
  });
});

describe("renderPullRequestBody", () => {
  it("lays out the rationale, the draft, the pin, and the conversation", () => {
    const body = renderPullRequestBody({
      request: buildRequest({ convo: convo(), budgetOwls: 500, rationale }),
      convo: convo(),
      slug: "anthropic-safety",
      conversationUrl: `https://api.example/grant-conversations/platform/${CONVO_ID}`,
    });
    expect(body).toContain("**500 owls**");
    expect(body).toContain(rationale);
    expect(body).toContain(draft.objective);
    expect(body).toContain("`ingest` https://example.org/system-card — primary source");
    expect(body).toContain(mandateDraftHash(draft));
    expect(body).toContain("**Grantmaker:**");
    expect(body).toContain("could have declined it");
  });
});
