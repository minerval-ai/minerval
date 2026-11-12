import { describe, it, expect } from "vitest";

import {
  composeClaimEvents,
  type ClaimEventsInput,
} from "../../../src/services/claim-events-service.js";

const CLAIM = {
  id: "c0000000-0000-0000-0000-000000000001",
  createdBy: "extractor",
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
};

function emptyInput(): ClaimEventsInput {
  return {
    claim: CLAIM,
    assessments: [],
    contributions: [],
    reviews: [],
    appeals: [],
    arbitrations: [],
    auditEntries: [],
  };
}

function assessment(overrides: Partial<ClaimEventsInput["assessments"][0]> = {}) {
  return {
    id: "a0000000-0000-0000-0000-000000000001",
    status: "unknown",
    confidence: 0.4,
    claimCredence: null,
    summary: "Too early to tell.",
    reasoningTrace: "trace",
    isCurrent: true,
    trigger: "structure_and_assess",
    triggerContext: null,
    assessedAt: new Date("2025-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("composeClaimEvents", () => {
  it("a bare claim yields exactly its creation event", () => {
    const events = composeClaimEvents(emptyInput());
    expect(events).toEqual([
      {
        kind: "created",
        id: `created:${CLAIM.id}`,
        at: "2025-01-01T00:00:00.000Z",
        actor: "extractor",
      },
    ]);
  });

  it("orders newest-first, with creation never sorting after a same-instant assessment", () => {
    const events = composeClaimEvents({
      ...emptyInput(),
      assessments: [
        // Same timestamp as creation — the initial structure_and_assess case.
        assessment({ id: "a1", isCurrent: false }),
        assessment({
          id: "a2",
          status: "supported",
          confidence: 0.8,
          trigger: "steward_reassessment",
          assessedAt: new Date("2025-06-01T00:00:00.000Z"),
        }),
      ],
    });
    expect(events.map((e) => e.kind)).toEqual(["assessment", "assessment", "created"]);
    expect(events[2]!.kind).toBe("created");
  });

  it("computes prev_status/prev_confidence from chronological assessment order", () => {
    const events = composeClaimEvents({
      ...emptyInput(),
      assessments: [
        // Deliberately unsorted input: the composer must sort before diffing.
        assessment({
          id: "a3",
          status: "supported",
          confidence: 0.78,
          assessedAt: new Date("2026-03-01T00:00:00.000Z"),
        }),
        assessment({ id: "a1", isCurrent: false }),
        assessment({
          id: "a2",
          status: "verified",
          confidence: 0.71,
          isCurrent: false,
          assessedAt: new Date("2025-06-01T00:00:00.000Z"),
        }),
      ],
    });
    const byId = Object.fromEntries(
      events.filter((e) => e.kind === "assessment").map((e) => [e.id, e])
    ) as Record<string, Extract<(typeof events)[0], { kind: "assessment" }>>;
    expect(byId["assessment:a1"]!.prev_status).toBeNull();
    expect(byId["assessment:a2"]!.prev_status).toBe("unknown");
    expect(byId["assessment:a2"]!.prev_confidence).toBe(0.4);
    expect(byId["assessment:a3"]!.prev_status).toBe("verified");
  });

  it("falls back to the reasoning trace when an assessment summary is null", () => {
    const events = composeClaimEvents({
      ...emptyInput(),
      assessments: [assessment({ summary: null as unknown as string })],
    });
    const a = events.find((e) => e.kind === "assessment");
    expect(a && a.kind === "assessment" && a.summary).toBe("trace");
  });

  it("interleaves a full contested exchange in causal order", () => {
    const contribution = {
      id: "ct1",
      contributorId: "u1",
      contributionType: "challenge",
      content: "The threshold is arbitrary.",
      evidenceUrls: ["https://example.com/a"],
      reviewStatus: "rejected",
      submittedAt: new Date("2025-08-01T00:00:00.000Z"),
    };
    const events = composeClaimEvents({
      ...emptyInput(),
      contributions: [contribution],
      reviews: [
        {
          id: "rv1",
          contributionId: "ct1",
          decision: "reject",
          reasoning: "Does not engage the cited sources.",
          confidence: 0.8,
          policyCitations: ["§7"],
          suspectedBadFaith: false,
          reviewedAt: new Date("2025-08-01T00:00:00.000Z"),
          reviewedBy: "contribution_reviewer",
        },
      ],
      appeals: [
        {
          id: "ap1",
          contributionId: "ct1",
          appellantId: "u1",
          appealReasoning: "The review missed my second source.",
          status: "resolved",
          submittedAt: new Date("2025-08-05T00:00:00.000Z"),
        },
      ],
      arbitrations: [
        {
          id: "ar1",
          contributionId: "ct1",
          appealId: "ap1",
          outcome: "uphold_original",
          reasoning: "The second source is an opinion piece.",
          consensusAchieved: true,
          humanReviewRecommended: false,
          arbitratedAt: new Date("2025-08-06T00:00:00.000Z"),
          arbitratedBy: "dispute_arbitrator",
        },
      ],
    });
    expect(events.map((e) => e.kind)).toEqual([
      "arbitration",
      "appeal",
      "review",
      "contribution",
      "created",
    ]);
    const review = events.find((e) => e.kind === "review");
    // The review carries its contribution's type so a windowed client can
    // still render "challenge rejected" without the contribution row.
    expect(review && review.kind === "review" && review.contribution_type).toBe("challenge");
  });

  it("carries steward audit entries as steward_note events", () => {
    const events = composeClaimEvents({
      ...emptyInput(),
      auditEntries: [
        {
          id: "au1",
          action: "no_action_needed",
          reasoning: "Dependents unchanged.",
          createdBy: "claim_steward",
          createdAt: new Date("2025-09-01T00:00:00.000Z"),
        },
      ],
    });
    expect(events[0]).toMatchObject({
      kind: "steward_note",
      action: "no_action_needed",
      actor: "claim_steward",
    });
  });
});

describe("composeClaimEvents: the node's lifecycle (#962)", () => {
  it("shows an archive with who, why, cohort and successors, after what happened that instant", () => {
    const at = new Date("2026-10-29T22:07:53.917Z");
    const events = composeClaimEvents({
      ...emptyInput(),
      assessments: [assessment({ assessedAt: at })],
      stateChanges: [
        {
          id: "s1",
          fromState: "active",
          toState: "archived",
          actor: "operator:jackson",
          reason: "minted before #523",
          successorIds: ["c0000000-0000-0000-0000-000000000002"],
          cohort: "2026-10-ai-pre-assessment-as-thinking",
          createdAt: at,
        },
      ],
    });
    expect(events[0]).toEqual({
      kind: "state_change",
      id: "state_change:s1",
      at: at.toISOString(),
      actor: "operator:jackson",
      from_state: "active",
      to_state: "archived",
      reason: "minted before #523",
      successor_ids: ["c0000000-0000-0000-0000-000000000002"],
      cohort: "2026-10-ai-pre-assessment-as-thinking",
    });
    expect(events[1]!.kind).toBe("assessment");
  });
});
