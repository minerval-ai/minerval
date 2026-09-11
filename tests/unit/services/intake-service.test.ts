/**
 * Intake service (#157): suggestions, not writes. Proposals are stored as
 * pending contributions; only an accepted review materializes them — through
 * the Matcher for claims, into the extraction pipeline for sources.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { claims, arguments_, contributions } from "../../../src/db/schema.js";

type Row = Record<string, unknown>;

const state = {
  selectResults: [] as Row[][],
  inserts: [] as { table: unknown; values: Row }[],
  updates: [] as { table: unknown; values: Row }[],
};

function fakeDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => state.selectResults.shift() ?? [],
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: async () => {
          state.updates.push({ table, values });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        const row: Row = {
          id: `row-${state.inserts.length + 1}`,
          submittedAt: new Date("2026-07-16T00:00:00.000Z"),
          reviewStatus: "pending",
          ...values,
        };
        state.inserts.push({ table, values });
        const promise = Promise.resolve([row]);
        return Object.assign(promise, {
          returning: () => Promise.resolve([row]),
        });
      },
    }),
  };
}

const mocks = vi.hoisted(() => ({
  matchClaim: vi.fn(),
  generateEmbedding: vi.fn(async () => [0.1, 0.2]),
  createJob: vi.fn(async () => ({ id: "job-1" })),
  enqueueClaimPipeline: vi.fn(),
  enqueueContribution: vi.fn(),
  enqueueSteward: vi.fn(),
  enqueueUrlExtraction: vi.fn(),
  getOrCreateSource: vi.fn(async () => ({ id: "source-1" })),
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => fakeDb(),
}));
vi.mock("../../../src/llm/agents/matcher.js", () => ({
  matchClaim: mocks.matchClaim,
}));
vi.mock("../../../src/services/embedding-service.js", () => ({
  generateEmbedding: mocks.generateEmbedding,
}));
vi.mock("../../../src/services/job-service.js", () => ({
  createJob: mocks.createJob,
}));
vi.mock("../../../src/services/queue-service.js", () => ({
  enqueueClaimPipeline: mocks.enqueueClaimPipeline,
  enqueueContribution: mocks.enqueueContribution,
  enqueueSteward: mocks.enqueueSteward,
  enqueueUrlExtraction: mocks.enqueueUrlExtraction,
}));
vi.mock("../../../src/services/source-service.js", () => ({
  getOrCreateSource: mocks.getOrCreateSource,
}));

import {
  createClaimProposal,
  createSourceProposal,
  materializeAcceptedIntake,
  isIntakeContributionType,
} from "../../../src/services/intake-service.js";

function pendingContribution(overrides: Row = {}): Row {
  return {
    id: "contrib-1",
    claimId: null,
    contributorId: "user-1",
    contributionType: "propose_claim",
    content: "Because of X and Y.",
    proposedCanonicalForm: "The sky is blue",
    sourceId: null,
    reviewStatus: "pending",
    ...overrides,
  };
}

beforeEach(() => {
  state.selectResults = [];
  state.inserts = [];
  state.updates = [];
  mocks.matchClaim.mockReset();
  mocks.createJob.mockReset().mockResolvedValue({ id: "job-1" });
  mocks.enqueueClaimPipeline.mockReset();
  mocks.enqueueContribution.mockReset();
  mocks.enqueueSteward.mockReset();
  mocks.enqueueUrlExtraction.mockReset();
  mocks.getOrCreateSource.mockReset().mockResolvedValue({ id: "source-1" });
});

describe("isIntakeContributionType", () => {
  it("recognizes only the intake types", () => {
    expect(isIntakeContributionType("propose_claim")).toBe(true);
    expect(isIntakeContributionType("propose_source")).toBe(true);
    expect(isIntakeContributionType("challenge")).toBe(false);
    expect(isIntakeContributionType("propose_edit")).toBe(false);
  });
});

describe("createClaimProposal", () => {
  it("stores a pending contribution — no claim row — and enqueues review", async () => {
    const contribution = await createClaimProposal({
      claimText: "The sky is blue",
      argumentText: "Look up.",
      contributorId: "user-1",
    });

    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]!.table).toBe(contributions);
    expect(state.inserts[0]!.values).toMatchObject({
      claimId: null,
      contributionType: "propose_claim",
      content: "Look up.",
      proposedCanonicalForm: "The sky is blue",
    });
    expect(mocks.enqueueContribution).toHaveBeenCalledWith({
      contributionId: contribution.id,
    });
    // Nothing else moved: no claim, no pipeline, no steward.
    expect(mocks.enqueueClaimPipeline).not.toHaveBeenCalled();
    expect(mocks.enqueueSteward).not.toHaveBeenCalled();
  });
});

describe("createSourceProposal", () => {
  it("stores the source verbatim but enqueues only review, not extraction", async () => {
    const { contribution, sourceId } = await createSourceProposal({
      url: "https://example.com/a",
      contributorId: "user-1",
    });

    expect(sourceId).toBe("source-1");
    expect(state.inserts[0]!.values).toMatchObject({
      contributionType: "propose_source",
      sourceId: "source-1",
    });
    expect(mocks.enqueueContribution).toHaveBeenCalledWith({
      contributionId: contribution.id,
    });
    expect(mocks.enqueueUrlExtraction).not.toHaveBeenCalled();
    expect(mocks.createJob).not.toHaveBeenCalled();
  });
});

describe("materializeAcceptedIntake — propose_claim", () => {
  it("creates a live claim via the Matcher when novel, with the conservative importance prior", async () => {
    state.selectResults.push([pendingContribution()]);
    mocks.matchClaim.mockResolvedValue({
      is_match: false,
      matched_claim_id: null,
      new_canonical_form: "The daytime clear sky appears blue",
      instance_stance: "affirms",
    });

    const result = await materializeAcceptedIntake("contrib-1");

    expect(result.action).toBe("created_claim");
    expect(result.canonicalText).toBe("The daytime clear sky appears blue");

    const claimInsert = state.inserts.find((i) => i.table === claims)!;
    expect(claimInsert.values).toMatchObject({
      text: "The daytime clear sky appears blue",
      createdBy: "user",
      importance: 0.3,
    });
    const argumentInsert = state.inserts.find((i) => i.table === arguments_)!;
    expect(argumentInsert.values).toMatchObject({
      stance: "for",
      content: "Because of X and Y.",
      createdBy: "user",
    });
    // The contribution now points at what it became.
    expect(state.updates[0]!.values).toMatchObject({ claimId: result.claimId });
    // Only now is the Steward pipeline engaged.
    expect(mocks.enqueueClaimPipeline).toHaveBeenCalledWith({
      claimId: result.claimId,
      jobId: "job-1",
    });
    // No direction note from the Matcher: the column stays unset, never "".
    expect(claimInsert.values).not.toHaveProperty("canonicalDirectionNote");
  });

  it("stores the Matcher's direction note on a novel claim (#360)", async () => {
    // The proposal argued AGAINST the proposition as the discourse poses it;
    // the Matcher keeps the discourse direction and records why, and the
    // first instance's stance follows from the comparison rather than
    // flipping the form to make the first source affirm.
    state.selectResults.push([pendingContribution()]);
    mocks.matchClaim.mockResolvedValue({
      is_match: false,
      matched_claim_id: null,
      new_canonical_form: "The daytime clear sky appears blue",
      instance_stance: "denies",
      direction_note:
        "  Posed as the positive observation; the proposal denies it.  ",
    });

    const result = await materializeAcceptedIntake("contrib-1");
    expect(result.action).toBe("created_claim");

    const claimInsert = state.inserts.find((i) => i.table === claims)!;
    expect(claimInsert.values).toMatchObject({
      text: "The daytime clear sky appears blue",
      canonicalDirectionNote:
        "Posed as the positive observation; the proposal denies it.",
    });
  });

  it("attaches to the existing claim when the Matcher finds a match (no new claim)", async () => {
    state.selectResults.push([pendingContribution()]);
    mocks.matchClaim.mockResolvedValue({
      is_match: true,
      matched_claim_id: "existing-9",
      new_canonical_form: null,
      instance_stance: "denies",
    });

    const result = await materializeAcceptedIntake("contrib-1");

    expect(result).toMatchObject({
      action: "matched_existing_claim",
      claimId: "existing-9",
      stance: "denies",
    });
    expect(state.inserts.find((i) => i.table === claims)).toBeUndefined();
    expect(state.updates[0]!.values).toMatchObject({ claimId: "existing-9" });
    // The existing claim's Steward integrates the proposal.
    expect(mocks.enqueueSteward).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: "existing-9",
        trigger: "contribution_accepted",
      })
    );
    expect(mocks.enqueueClaimPipeline).not.toHaveBeenCalled();
  });

  it("is idempotent once the contribution has a claim", async () => {
    state.selectResults.push([pendingContribution({ claimId: "done-1" })]);
    const result = await materializeAcceptedIntake("contrib-1");
    expect(result).toEqual({
      action: "already_materialized",
      claimId: "done-1",
    });
    expect(mocks.matchClaim).not.toHaveBeenCalled();
  });

  it("refuses non-intake contribution types", async () => {
    state.selectResults.push([
      pendingContribution({ contributionType: "challenge" }),
    ]);
    await expect(materializeAcceptedIntake("contrib-1")).rejects.toThrow(
      /not an intake type/
    );
  });
});

describe("materializeAcceptedIntake — propose_source", () => {
  it("enqueues extraction attributed to the contributor", async () => {
    state.selectResults.push([
      pendingContribution({
        contributionType: "propose_source",
        content: "https://example.com/a",
        sourceId: "source-1",
        proposedCanonicalForm: null,
      }),
    ]);

    const result = await materializeAcceptedIntake("contrib-1");

    expect(result).toMatchObject({
      action: "enqueued_extraction",
      jobId: "job-1",
    });
    expect(mocks.createJob).toHaveBeenCalledWith(
      "url_extraction",
      { sourceId: "source-1", url: "https://example.com/a" },
      { userId: "user-1", apiKeyId: null }
    );
    expect(mocks.enqueueUrlExtraction).toHaveBeenCalledWith({
      sourceId: "source-1",
      jobId: "job-1",
      url: "https://example.com/a",
    });
  });

  it("is idempotent once the contribution is accepted", async () => {
    state.selectResults.push([
      pendingContribution({
        contributionType: "propose_source",
        sourceId: "source-1",
        reviewStatus: "accepted",
      }),
    ]);
    const result = await materializeAcceptedIntake("contrib-1");
    expect(result).toEqual({ action: "already_materialized" });
    expect(mocks.enqueueUrlExtraction).not.toHaveBeenCalled();
  });
});
