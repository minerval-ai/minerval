import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []) }));

import { curationSummary } from "../../../src/services/maintenance-funding.js";

describe("curationSummary", () => {
  it("puts each request's concern in front of the officers, not just the anchor's text", () => {
    const s = curationSummary("Claim A", [
      { source: "steward_escalation", concern: "Duplicates claim B, worded differently.", other_claim_id: "b-id", signal: null },
      { source: "reconcile_candidate", concern: "Near neighbour.", other_claim_id: "c-id", signal: 0.963 },
    ]);
    expect(s).toContain("Claim A");
    expect(s).toContain("steward_escalation: Duplicates claim B, worded differently. (other claim b-id)");
    expect(s).toContain("reconcile_candidate: Near neighbour. (other claim c-id) (similarity 0.96)");
    expect(s).toContain("The concerns:");
  });

  it("falls back to the label when no live request is found (a request-keeper curation)", () => {
    expect(curationSummary("Request R", [])).toBe("A curation is wanted: Request R");
  });
});
