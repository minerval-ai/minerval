import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The Consistency Checker, the agent that filed #934, #935 and #952, gets
 * the read repair every agent's graph reads share (#934): an id it lists or
 * searches and then mistypes into get_claim is read as the node it meant,
 * marked id_corrected. A flag is a write, so a mistyped id there is refused
 * with the nearest ids the sweep has seen, never corrected. The tool loop
 * is stood in for by the real loops' executor (observed-loop.ts); the graph
 * reads and their repair are real, over mocked services.
 */

const LISTED = "95541f44-3440-4280-be4a-51187ecfd478";
const SEARCHED = "1ea1a55c-1361-4685-991b-3c303c74c323";
const NODES = new Map([
  [LISTED, "An assessed node in the partition."],
  [SEARCHED, "Scheming evaluations use contrived scenarios."],
]);

const { state } = vi.hoisted(() => ({
  state: {
    script: [] as Array<{ name: string; input: Record<string, unknown> }>,
    outputs: [] as string[],
    flags: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ consistencyModel: "openai/gpt-6-luna" }),
}));
vi.mock("../../../src/llm/usage-context.js", () => ({
  budgetRefusal: () => null,
  withAgent: (_a: string, fn: () => unknown) => fn(),
  runWithUsageContext: (_c: unknown, fn: () => unknown) => fn(),
  getUsageContext: () => ({ runId: "run-1" }),
  runBudget: () => null,
}));
vi.mock("../../../src/llm/prompts/consistency-checker.js", () => ({
  getConsistencyCheckerSystemPromptBlocks: () => ["SYSTEM"],
}));
vi.mock("../../../src/llm/tools/report-tools.js", () => ({
  createReportTools: () => ({ definitions: [{ name: "raise_issue" }], execute: async () => null }),
}));
vi.mock("../../../src/llm/tools/finding-tools.js", () => ({
  createFindingTools: () => ({ definitions: [{ name: "note_finding" }], execute: async () => null }),
}));
vi.mock("../../../src/llm/tools/skill-load-tools.js", () => ({
  createSkillLoadTools: () => ({ definitions: [], execute: async () => null, pointed: [], pointerNote: "" }),
}));
vi.mock("../../../src/services/curation-service.js", () => ({
  CURATION_CONCERN_MAX_CHARS: 4_000,
  requestCuration: vi.fn(async () => ({ ok: true, requestId: "r", actionId: "a", repeat: false })),
}));
vi.mock("../../../src/services/claim-view-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/claim-view-service.js")>()),
  getClaimView: vi.fn(async (id: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      throw Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" });
    }
    return NODES.has(id) ? { claim: { id, canonical_form: NODES.get(id) } } : null;
  }),
}));
vi.mock("../../../src/services/graph-read-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/graph-read-service.js")>()),
  runGraphRead: vi.fn(async (name: string) =>
    name === "search_claims"
      ? { ok: true, payload: { count: 1, results: [{ id: SEARCHED, canonical_form: NODES.get(SEARCHED) }] } }
      : name === "get_decomposition" || name === "get_dependents"
        ? { ok: false, code: "NOT_FOUND", message: "Claim not found" }
        : null
  ),
}));
vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (_sql: string, params: unknown[]) => {
    const ids = Array.isArray(params?.[0]) ? (params[0] as string[]) : [];
    return ids.filter((id) => NODES.has(id)).map((id) => ({ id, text: NODES.get(id) }));
  }),
}));
vi.mock("../../../src/services/consistency-service.js", () => ({
  CONSISTENCY_BOUNDS: { maxClaims: 8, noteChars: 4_000, rationaleChars: 2_000, listingTextChars: 300, listingSummaryChars: 500 },
  CONSISTENCY_FLAG_KINDS: ["unweighed_consideration", "reasoning_conflict", "overlooked_evidence", "other"],
  TRACE_EXCERPT_CHARS: 5_000,
  OPEN_FLAG_RATIONALE_CHARS: 200,
  openFlagsInScope: vi.fn(async () => []),
  compareAssessments: vi.fn(async () => ({ claims: [], relations: [], unknown: [] })),
  checkFlagInput: vi.fn(),
  partitionClaims: vi.fn(async () => ({
    total: 1,
    claims: [{ claim_id: LISTED, kind: "claim", text: NODES.get(LISTED), summary: "s", status: "supported" }],
  })),
  // As the service answers a flag naming an id that is not a node's.
  flagInconsistency: vi.fn(async (input: Record<string, unknown>) => {
    state.flags.push(input);
    return NODES.has(String(input.primaryClaimId))
      ? { ok: true, duplicate: false, flag_id: "f", action_id: "a", expected_gain: 0.5, note: "" }
      : { ok: false, code: "CLAIM", problem: "No active node with that primary_claim_id" };
  }),
}));
vi.mock("../../../src/llm/client.js", async () => {
  const { observedExecutor } = await import("./observed-loop.js");
  return {
    toolUseLoop: vi.fn(async (opts: Parameters<typeof observedExecutor>[0]) => {
      const { execute } = observedExecutor(opts);
      for (const step of state.script) state.outputs.push(await execute(step.name, step.input));
      return { content: "closing text" };
    }),
  };
});

import { runConsistencyChecker } from "../../../src/llm/agents/consistency-checker.js";

const base = {
  sweepId: "sweep-1",
  partitionLabel: "ai-safety",
  scope: { tagId: "tag-1" },
  claimsInScope: 1,
  lastSweep: null,
};

beforeEach(() => {
  state.script = [];
  state.outputs = [];
  state.flags = [];
});

describe("the Consistency Checker's reads repair a mistyped id (#934, #935, #952)", () => {
  it("reads a searched node it mistyped with one digit too many, and says it corrected it", async () => {
    state.script = [
      { name: "search_claims", input: { query: "contrived scheming evaluations" } },
      { name: "get_claim", input: { claim_id: "1ea1a55c-1361-4685-991b-3c303c74c3236" } },
    ];
    await runConsistencyChecker(base);
    const out = JSON.parse(state.outputs[1]!);
    expect(out.claim.id).toBe(SEARCHED);
    expect(out.id_corrected).toMatchObject({
      requested_id: "1ea1a55c-1361-4685-991b-3c303c74c3236",
      resolved_id: SEARCHED,
    });
  });

  it("reads a listed node it mistyped by one digit (the sightings on #934)", async () => {
    const typo = `${LISTED.slice(0, 30)}0${LISTED.slice(31)}`;
    state.script = [
      { name: "list_partition_claims", input: {} },
      { name: "get_claim", input: { claim_id: typo } },
    ];
    await runConsistencyChecker(base);
    const out = JSON.parse(state.outputs[1]!);
    expect(out.claim.id).toBe(LISTED);
    expect(out.id_corrected.resolved_id).toBe(LISTED);
  });

  it("refuses a flag on a mistyped id and offers the nearest ids, without correcting it", async () => {
    const typo = `${LISTED.slice(0, -1)}0`;
    state.script = [
      { name: "list_partition_claims", input: {} },
      {
        name: "flag_inconsistency",
        input: {
          kind: "reasoning_conflict",
          primary_claim_id: typo,
          claim_ids: [typo, SEARCHED],
          rationale: "These two assessments cannot both stand as written.",
          expected_gain: 0.5,
        },
      },
    ];
    await runConsistencyChecker(base);
    const out = JSON.parse(state.outputs[1]!);
    expect(out).toMatchObject({ ok: false, code: "CLAIM" });
    // The service was asked with the id as given; nothing corrected it.
    expect(state.flags[0]!.primaryClaimId).toBe(typo);
    expect(out.unresolved).toHaveLength(1);
    expect(out.unresolved[0]).toMatchObject({ requested_id: typo });
    expect(out.unresolved[0].nearest_seen_ids[0]).toEqual({ id: LISTED, text: NODES.get(LISTED) });
    expect(out.unresolved[0].correction).toContain("never corrected here");
  });
});
