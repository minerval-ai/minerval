import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A claim proposed from the extension is followed until it settles: the
 * popup and page ask GET /contributions/:id, and once the proposal is
 * accepted the claim it became is shown as a claim the graph holds, with its
 * own status, instead of leaving the reader on "pending review".
 */

vi.mock("../../../extension/lib/settings", () => ({
  getSettings: async () => ({ apiBaseUrl: "https://api.example", apiKey: "k" }),
  isCustomApiBaseUrl: () => true,
}));

import { getSubmissionProgress } from "../../../extension/lib/api";
import { submissionLabel, submissionSettled } from "../../../extension/lib/submission";

const CONTRIBUTION = "11111111-1111-4111-8111-111111111111";
const CLAIM = "22222222-2222-4222-8222-222222222222";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("getSubmissionProgress", () => {
  it("reports an open review without reading any claim", async () => {
    const fetchMock = vi.fn(async () =>
      json({ contribution: { review_status: "pending", became_claim_id: null, page_url: null } })
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await getSubmissionProgress(CONTRIBUTION)).toEqual({
      review_status: "pending",
      claim: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      `https://api.example/contributions/${CONTRIBUTION}`
    );
  });

  it("returns the claim an accepted proposal became, with its status", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/contributions/")
        ? json({
            contribution: {
              review_status: "accepted",
              became_claim_id: CLAIM,
              page_url: `https://minerval.ai/claims/${CLAIM}`,
            },
          })
        : json({
            claim: { id: CLAIM, text: "Water boils at 100 °C at sea level." },
            assessment: { status: "verified", confidence: 0.9 },
            subclaim_count: 2,
          })
    );
    vi.stubGlobal("fetch", fetchMock);

    const progress = await getSubmissionProgress(CONTRIBUTION);
    expect(progress.claim).toEqual({
      id: CLAIM,
      canonical_form: "Water boils at 100 °C at sea level.",
      status: "verified",
      status_confidence: 0.9,
      subclaim_count: 2,
      url: `https://minerval.ai/claims/${CLAIM}`,
    });
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).toContain(
      `/claims/${CLAIM}?information_depth=cursory`
    );
  });

  it("calls an accepted claim with no assessment yet unassessed, not unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/contributions/")
          ? json({
              contribution: { review_status: "accepted", became_claim_id: CLAIM, page_url: null },
            })
          : json({ claim: { id: CLAIM, text: "x" }, assessment: null })
      )
    );
    const progress = await getSubmissionProgress(CONTRIBUTION);
    expect(progress.claim?.status).toBe("unassessed");
    expect(progress.claim?.url).toBe(`https://minerval.ai/claims/${CLAIM}`);
  });
});

describe("submission progress labels", () => {
  const base = { contribution_id: CONTRIBUTION, submitted_at: "2026-11-01T00:00:00Z" };
  const claim = {
    id: CLAIM,
    canonical_form: "x",
    status: "supported",
    status_confidence: 0.7,
    subclaim_count: 0,
    url: "u",
  };

  it("keeps following a proposal until it is declined or its claim is assessed", () => {
    expect(submissionSettled(base)).toBe(false);
    expect(submissionSettled({ ...base, review_status: "escalated" })).toBe(false);
    expect(submissionSettled({ ...base, review_status: "accepted", claim: null })).toBe(false);
    expect(
      submissionSettled({
        ...base,
        review_status: "accepted",
        claim: { ...claim, status: "unassessed" },
      })
    ).toBe(false);
    expect(submissionSettled({ ...base, review_status: "accepted", claim })).toBe(true);
    expect(submissionSettled({ ...base, review_status: "rejected" })).toBe(true);
  });

  it("says where the proposal stands", () => {
    expect(submissionLabel(base)).toBe("Proposed · pending review");
    expect(submissionLabel({ ...base, review_status: "accepted", claim })).toBe(
      "Accepted · in the graph: supported"
    );
    expect(submissionLabel({ ...base, review_status: "rejected" })).toMatch(/Declined/);
  });
});
