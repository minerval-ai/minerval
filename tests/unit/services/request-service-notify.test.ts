import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Who hears that work on a request came back (Part VIII; #718, #722): the
 * keeper, to judge it, and the Steward of every node it bears on, to weigh
 * it for that node. A Curator keeper is woken by its request's curate row.
 * Each is told the work as recorded and the research run whose full
 * report get_research_run serves.
 */

const KEEPER = "a1111111-1111-4111-8111-111111111111";
const OTHER = "b2222222-2222-4222-8222-222222222222";
const REQUEST = "d3333333-3333-4333-8333-333333333333";

const { state } = vi.hoisted(() => ({
  state: {
    request: null as null | Record<string, unknown>,
    targets: [] as string[],
    enqueued: [] as Array<{ claimId: string; trigger: string; context: string }>,
    curateRows: [] as string[],
    funded: [] as string[],
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string) => {
    if (q.includes("SELECT keeper_kind, keeper_claim_id, ask FROM requests")) return state.request ? [state.request] : [];
    if (q.includes("FROM request_targets t JOIN claims c")) return state.targets.map((claim_id) => ({ claim_id }));
    return [];
  }),
  withTransaction: vi.fn(),
}));
vi.mock("../../../src/services/queue-service.js", () => ({
  enqueueSteward: vi.fn(async (m: { claimId: string; trigger: string; context: string }) => {
    state.enqueued.push(m);
  }),
}));
vi.mock("../../../src/services/action-service.js", () => ({
  closeRequestActions: vi.fn(),
  COVERAGE_SQL: "0",
  ensureRequestActions: vi.fn(),
  ensureRequestCurateAction: vi.fn(async (id: string) => {
    state.curateRows.push(id);
    return "act-cr";
  }),
}));
vi.mock("../../../src/services/maintenance-funding.js", () => ({
  fundCurationNow: vi.fn(async (id: string) => {
    state.funded.push(id);
  }),
  fundRequestNow: vi.fn(),
}));
vi.mock("../../../src/services/embedding-service.js", () => ({ generateEmbedding: vi.fn() }));
vi.mock("../../../src/services/grant-service.js", () => ({ getFundingLabelForJob: vi.fn() }));

import { notifyRequestKeeper } from "../../../src/services/request-service.js";

beforeEach(() => {
  state.request = null;
  state.targets = [];
  state.enqueued = [];
  state.curateRows = [];
  state.funded = [];
});

const LONG = "x".repeat(3000);

describe("notifyRequestKeeper", () => {
  it("tells a Steward keeper to judge it, with the whole note and the run", async () => {
    state.request = { keeper_kind: "steward", keeper_claim_id: KEEPER, ask: "Find the origin" };
    state.targets = [KEEPER];
    expect(await notifyRequestKeeper(REQUEST, `the Researcher returned met: ${LONG}`, { researchRunId: "run-1" })).toBe(true);
    expect(state.enqueued).toHaveLength(1);
    const [m] = state.enqueued;
    expect(m).toMatchObject({ claimId: KEEPER, trigger: "request_returned" });
    expect(m!.context).toContain(LONG);
    expect(m!.context).toContain("get_research_run run-1");
    expect(m!.context).toContain("which you keep");
    expect(m!.context).toContain("Decide whether it has been met");
    expect(state.curateRows).toEqual([]);
  });

  it("tells the Steward of every other node it bears on to weigh it, not to judge it", async () => {
    state.request = { keeper_kind: "curator", keeper_claim_id: null, ask: "Map the literature" };
    state.targets = [KEEPER, OTHER];
    await notifyRequestKeeper(REQUEST, "the Researcher returned negative: nothing found", { researchRunId: "run-2" });
    expect(state.enqueued.map((m) => m.claimId)).toEqual([KEEPER, OTHER]);
    for (const m of state.enqueued) {
      expect(m.context).toContain("kept by the Curator");
      expect(m.context).toContain("Weigh what it found for this node");
      expect(m.context).toContain("get_research_run run-2");
      expect(m.context).not.toContain("which you keep");
    }
  });

  it("wakes a Curator keeper through its request's curate row, even when the request bears on no node", async () => {
    state.request = { keeper_kind: "curator", keeper_claim_id: null, ask: "Survey what is not yet held" };
    state.targets = [];
    expect(await notifyRequestKeeper(REQUEST, "the Researcher returned partly_met: half")).toBe(true);
    expect(state.enqueued).toEqual([]);
    expect(state.curateRows).toEqual([REQUEST]);
    expect(state.funded).toEqual(["act-cr"]);
  });

  it("tells no one about a request that does not exist", async () => {
    expect(await notifyRequestKeeper(REQUEST, "note")).toBe(false);
    expect(state.enqueued).toEqual([]);
  });
});
