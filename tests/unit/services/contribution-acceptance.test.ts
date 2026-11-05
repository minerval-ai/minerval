/**
 * Accepting a contribution has the same effects whoever accepts it (#724):
 * a proposed request is filed with what it bears on, material for a request
 * is recorded as work on it, an intake proposal is materialized. Refusals
 * come before anything is written.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const CONTRIBUTION_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CLAIM_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const OTHER_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const SOURCE_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const REQUEST_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

const mocks = vi.hoisted(() => ({
  contribution: null as Record<string, unknown> | null,
  fileRequest: vi.fn(async (_input: Record<string, unknown>) => ({ id: "req-1" })),
  getRequest: vi.fn(async (_id: string) => null as unknown),
  recordWork: vi.fn(async () => {}),
  notifyRequestKeeper: vi.fn(async () => {}),
  materializeAcceptedIntake: vi.fn(async () => ({ outcome: "created" })),
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async () => [{ display_name: "Ada" }]),
}));
vi.mock("../../../src/services/request-service.js", () => ({
  fileRequest: mocks.fileRequest,
  getRequest: mocks.getRequest,
  recordWork: mocks.recordWork,
  notifyRequestKeeper: mocks.notifyRequestKeeper,
}));
vi.mock("../../../src/services/intake-service.js", () => ({
  isIntakeContributionType: (t: string) =>
    t === "propose_claim" || t === "propose_question" || t === "propose_source",
  materializeAcceptedIntake: mocks.materializeAcceptedIntake,
}));
vi.mock("../../../src/services/contribution-service.js", () => ({
  getContributionById: vi.fn(async () => mocks.contribution),
  MANDATE_LABEL: "a funded mandate",
}));

import { applyAcceptanceEffects } from "../../../src/services/contribution-acceptance.js";

const REQUEST = { ask: "Find the trial's registration.", why: "It decides whether the outcome was switched.", satisfied_by: "The registry entry." };

function contribution(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTRIBUTION_ID,
    contributionType: "propose_request",
    claimId: CLAIM_ID,
    contributorId: "u-1",
    grantId: null,
    fundedByJobId: null,
    content: "Someone should find the registration of the trial behind both claims.",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.contribution = contribution();
  for (const m of [mocks.fileRequest, mocks.getRequest, mocks.recordWork, mocks.notifyRequestKeeper, mocks.materializeAcceptedIntake]) {
    m.mockClear();
  }
});

describe("a proposed request", () => {
  it("bears on the contribution's target by default", async () => {
    const out = await applyAcceptanceEffects(CONTRIBUTION_ID, { request: REQUEST });
    expect(out).toMatchObject({ ok: true, note: " Request req-1 filed." });
    expect(mocks.fileRequest.mock.calls[0]![0]).toMatchObject({
      claimIds: [CLAIM_ID],
      sourceIds: [],
      bearsOnText: null,
      filer: { kind: "contributor", contributorId: "u-1" },
    });
  });

  it("bears on what the reviewer names: several nodes, sources, and words", async () => {
    await applyAcceptanceEffects(CONTRIBUTION_ID, {
      request: { ...REQUEST, bears_on: { claim_ids: [CLAIM_ID, OTHER_ID], source_ids: [SOURCE_ID], text: "the registry" } },
    });
    expect(mocks.fileRequest.mock.calls[0]![0]).toMatchObject({
      claimIds: [CLAIM_ID, OTHER_ID],
      sourceIds: [SOURCE_ID],
      bearsOnText: "the registry",
    });
  });

  it("with no target and nothing named, says in words what it bears on", async () => {
    mocks.contribution = contribution({ claimId: null, grantId: "g-1" });
    await applyAcceptanceEffects(CONTRIBUTION_ID, { request: REQUEST });
    expect(mocks.fileRequest.mock.calls[0]![0]).toMatchObject({
      claimIds: [],
      bearsOnText: expect.stringContaining("registration of the trial"),
      filer: { kind: "mandate", grantId: "g-1" },
    });
  });

  it("refuses without the request's form, before filing anything", async () => {
    const out = await applyAcceptanceEffects(CONTRIBUTION_ID, { request: { ask: "x" } });
    expect(out.ok).toBe(false);
    expect(mocks.fileRequest).not.toHaveBeenCalled();
  });

  it("reports a filing the request service refuses", async () => {
    mocks.fileRequest.mockRejectedValueOnce(new Error("No active node " + OTHER_ID));
    const out = await applyAcceptanceEffects(CONTRIBUTION_ID, { request: { ...REQUEST, bears_on: { claim_ids: [OTHER_ID] } } });
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("No active node") });
  });
});

describe("material for a request", () => {
  it("is recorded as work on the named request, and its keeper notified", async () => {
    mocks.contribution = contribution({ contributionType: "answer_request" });
    mocks.getRequest.mockResolvedValueOnce({ id: REQUEST_ID });
    const out = await applyAcceptanceEffects(CONTRIBUTION_ID, { request_id: REQUEST_ID });
    expect(out.ok).toBe(true);
    expect(mocks.recordWork).toHaveBeenCalledWith(expect.objectContaining({ requestId: REQUEST_ID, byLabel: "Ada" }));
    expect(mocks.notifyRequestKeeper).toHaveBeenCalled();
  });

  it("refuses without a request_id that exists", async () => {
    mocks.contribution = contribution({ contributionType: "answer_request" });
    const out = await applyAcceptanceEffects(CONTRIBUTION_ID, {});
    expect(out.ok).toBe(false);
    expect(mocks.recordWork).not.toHaveBeenCalled();
  });
});

describe("an intake proposal", () => {
  it("is materialized", async () => {
    mocks.contribution = contribution({ contributionType: "propose_claim", claimId: null });
    const out = await applyAcceptanceEffects(CONTRIBUTION_ID, {});
    expect(out).toMatchObject({ ok: true, materialization: { outcome: "created" } });
  });
});
