import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []) }));

import { curationSummary } from "../../../src/services/maintenance-funding.js";
import type { LiveCurationRequest } from "../../../src/services/curation-service.js";

const req = (over: Partial<LiveCurationRequest>): LiveCurationRequest => ({
  id: "r",
  other_claim_id: null,
  other_claim_text: null,
  source: "steward_escalation",
  defect: "duplicate",
  concern: "x",
  signal: null,
  requested_by_claim_id: null,
  created_at: new Date(),
  ...over,
});

describe("curationSummary (#955)", () => {
  it("says what opened the row: the defect, who raised it, the other node with its text, and the concern", () => {
    const s = curationSummary({ claim_id: "a-id", label: "Curate around: Claim A" }, [
      req({
        concern: "Duplicates claim B, worded differently.",
        other_claim_id: "b-id",
        other_claim_text: "Claim B",
        requested_by_claim_id: "a-id",
      }),
      req({
        source: "reconcile_candidate",
        concern: "Near neighbour.",
        other_claim_id: "c-id",
        other_claim_text: "Claim C",
        signal: 0.963,
      }),
      req({ source: "consistency_sweep", defect: "conflation", concern: "Holds two propositions." }),
      req({ source: "audit", defect: null, concern: "Legacy concern." }),
    ]);
    expect(s).toContain("around node a-id");
    expect(s).toContain("(4 live requests)");
    expect(s).toContain(
      "- suspected duplicate (the same node in other words, or its negation), raised by this node's Steward; " +
        'the other node: b-id ("Claim B"). Concern: Duplicates claim B, worded differently.'
    );
    expect(s).toContain("raised by the reconcile-candidate scan (embedding similarity 0.963; a scan, not a judgment)");
    expect(s).toContain('the other node: c-id ("Claim C")');
    expect(s).toContain("suspected conflation (one node holding distinct propositions), raised by a consistency sweep");
    expect(s).toContain("defect not classified");
  });

  it("names the escalating Steward when it is another node's", () => {
    const s = curationSummary({ claim_id: "a-id", label: "L" }, [req({ requested_by_claim_id: "p-id" })]);
    expect(s).toContain("raised by the Steward of p-id");
  });

  it("says when the other node is no longer active", () => {
    const s = curationSummary({ claim_id: "a-id", label: "L" }, [req({ other_claim_id: "gone" })]);
    expect(s).toContain("the other node: gone (no longer active)");
  });

  it("cuts a long concern for the inbox, saying the Curator reads it whole", () => {
    const s = curationSummary({ claim_id: "a-id", label: "L" }, [req({ concern: "y".repeat(3000) })]);
    expect(s).toContain("(cut here; the Curator reads it whole)");
    expect(s.length).toBeLessThan(1200);
  });

  it("uses the label for a request-keeper curation, which has no anchor", () => {
    expect(curationSummary({ claim_id: null, label: "Judge work returned on a request: R" }, [])).toBe(
      "A curation is wanted: Judge work returned on a request: R"
    );
  });
});
