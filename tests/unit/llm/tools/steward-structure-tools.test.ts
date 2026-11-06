import { describe, it, expect, vi, beforeEach } from "vitest";

// The Steward's structure-correcting tools (#741): each acts only on the
// run's own node and writes an audit_log row with its reasoning.

const OWN = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const CHILD = "33333333-3333-3333-3333-333333333333";
const ARG = "44444444-4444-4444-4444-444444444444";
const EDGE = "55555555-5555-5555-5555-555555555555";

const { audit, usage } = vi.hoisted(() => ({
  audit: [] as Record<string, unknown>[],
  usage: { claimId: "11111111-1111-1111-1111-111111111111" as string | undefined },
}));

vi.mock("../../../../src/db/client.js", () => ({
  getDb: () => ({
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        audit.push(row);
      },
    }),
  }),
  rawQuery: vi.fn(async () => [{ n: 1 }]),
  withTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ query: vi.fn(async () => []) })),
}));

vi.mock("../../../../src/llm/usage-context.js", () => ({
  getUsageContext: () => usage,
}));

vi.mock("../../../../src/services/argument-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/services/argument-service.js")>()),
  getArgument: vi.fn(),
  retireArgument: vi.fn(async () => ({ released: [{ id: CHILD, text: "A premise" }] })),
  reviseArgument: vi.fn(async () => ({ evaluationRetired: true })),
}));

vi.mock("../../../../src/services/relationship-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/services/relationship-service.js")>()),
  getEdgesBetween: vi.fn(),
  deleteEdges: vi.fn(async () => 1),
  retypeEdge: vi.fn(async () => ({ id: EDGE, merged: false })),
  setEdgeReasoning: vi.fn(async () => undefined),
  detachEdgeFromArgument: vi.fn(async () => ({ detached: true })),
}));

import {
  executeStewardStructureTool,
  getStewardStructureToolDefinitions,
  STEWARD_STRUCTURE_TOOL_NAMES,
} from "../../../../src/llm/tools/steward-structure-tools.js";
import { getStewardToolDefinitions } from "../../../../src/llm/tools/steward-tools.js";
import { getArgument, retireArgument, reviseArgument } from "../../../../src/services/argument-service.js";
import {
  deleteEdges,
  detachEdgeFromArgument,
  getEdgesBetween,
  retypeEdge,
  setEdgeReasoning,
} from "../../../../src/services/relationship-service.js";

const edge = (relation: string, argumentIds: string[] = []) => ({
  id: EDGE,
  parent_claim_id: OWN,
  child_claim_id: CHILD,
  relation_type: relation,
  reasoning: "it bears on it",
  argument_ids: argumentIds,
});

const liveArgument = {
  id: ARG,
  claimId: OWN,
  name: "The argument from scale",
  description: "Scale",
  stance: "for",
  content: "Scale",
  retiredAt: null,
  retiredReason: null,
};

async function run(name: string, input: Record<string, unknown>) {
  const out = await executeStewardStructureTool(name, input);
  return JSON.parse(out!) as { success: boolean; message: string };
}

describe("steward structure tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    audit.length = 0;
    usage.claimId = OWN;
    vi.mocked(getArgument).mockResolvedValue(liveArgument as never);
  });

  it("are offered among the Steward's tools", () => {
    const names = getStewardToolDefinitions().map((t) => t.name);
    for (const n of STEWARD_STRUCTURE_TOOL_NAMES) expect(names).toContain(n);
    expect(getStewardStructureToolDefinitions()).toHaveLength(STEWARD_STRUCTURE_TOOL_NAMES.length);
  });

  it("return null for a tool they do not own", async () => {
    expect(await executeStewardStructureTool("update_claim_assessment", {})).toBeNull();
  });

  it("remove an edge of the Steward's own node and log why", async () => {
    vi.mocked(getEdgesBetween).mockResolvedValue([edge("requires")]);
    const out = await run("remove_subclaim_edge", { parent_id: OWN, child_id: CHILD, reasoning: "not a premise" });
    expect(out.success).toBe(true);
    expect(deleteEdges).toHaveBeenCalledWith([EDGE]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ claimId: OWN, action: "remove_subclaim_edge" });
    expect(String(audit[0]!.reasoning)).toContain("not a premise");
  });

  it("refuse to touch another node's edges", async () => {
    const out = await run("remove_subclaim_edge", { parent_id: OTHER, child_id: CHILD, reasoning: "x" });
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/escalate_to_curator/);
    expect(deleteEdges).not.toHaveBeenCalled();
    expect(audit).toHaveLength(0);
  });

  it("ask which edge when the child is joined by more than one", async () => {
    vi.mocked(getEdgesBetween).mockResolvedValue([edge("requires"), { ...edge("supports"), id: "e2" }]);
    const out = await run("remove_subclaim_edge", { parent_id: OWN, child_id: CHILD, reasoning: "x" });
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/pass relation/);
  });

  it("send answers to remove_answer", async () => {
    const out = await run("remove_subclaim_edge", {
      parent_id: OWN,
      child_id: CHILD,
      relation: "answers",
      reasoning: "x",
    });
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/remove_answer/);
  });

  it("require reasoning", async () => {
    const out = await run("remove_subclaim_edge", { parent_id: OWN, child_id: CHILD, reasoning: " " });
    expect(out.success).toBe(false);
  });

  it("retype an edge in place rather than adding a second one", async () => {
    vi.mocked(getEdgesBetween).mockResolvedValue([edge("requires", [ARG])]);
    const out = await run("set_edge_relation", {
      parent_id: OWN,
      child_id: CHILD,
      relation: "SUPPORTS",
      reasoning: "the parent survives without it",
    });
    expect(out.success).toBe(true);
    expect(retypeEdge).toHaveBeenCalledWith(EDGE, "supports", "the parent survives without it", expect.anything());
    expect(audit[0]).toMatchObject({ action: "set_edge_relation" });
  });

  it("rewrite an edge's reasoning when the relation is unchanged (#833)", async () => {
    vi.mocked(getEdgesBetween).mockResolvedValue([edge("supports", [ARG])]);
    const out = await run("set_edge_relation", {
      parent_id: OWN,
      child_id: CHILD,
      relation: "supports",
      reasoning: "it is the access question, not capability",
    });
    expect(out.success).toBe(true);
    expect(out.message).toMatch(/stays supports/);
    expect(setEdgeReasoning).toHaveBeenCalledWith(EDGE, "it is the access question, not capability");
    expect(retypeEdge).not.toHaveBeenCalled();
    expect(audit[0]).toMatchObject({ claimId: OWN, action: "set_edge_relation" });
    expect(String(audit[0]!.reasoning)).toContain('old edge reasoning: "it bears on it"');
  });

  it("change nothing when the relation and reasoning are both unchanged", async () => {
    vi.mocked(getEdgesBetween).mockResolvedValue([edge("supports")]);
    const out = await run("set_edge_relation", {
      parent_id: OWN,
      child_id: CHILD,
      relation: "supports",
      reasoning: "it bears on it",
    });
    expect(out.success).toBe(true);
    expect(out.message).toMatch(/nothing changed/);
    expect(setEdgeReasoning).not.toHaveBeenCalled();
    expect(audit).toHaveLength(0);
  });

  it("refuse an unknown relation", async () => {
    const out = await run("set_edge_relation", { parent_id: OWN, child_id: CHILD, relation: "related", reasoning: "x" });
    expect(out.success).toBe(false);
    expect(retypeEdge).not.toHaveBeenCalled();
  });

  it("take a subclaim out of one argument, keeping the edge", async () => {
    vi.mocked(getEdgesBetween).mockResolvedValue([edge("supports", [ARG])]);
    const out = await run("ungroup_subclaim", { argument_id: ARG, child_id: CHILD, reasoning: "another line" });
    expect(out.success).toBe(true);
    expect(detachEdgeFromArgument).toHaveBeenCalledWith(ARG, EDGE, expect.anything());
    expect(deleteEdges).not.toHaveBeenCalled();
  });

  it("flip an argument's stance and say its evaluation was retired (#670)", async () => {
    const out = await run("revise_argument", { argument_id: ARG, stance: "against", reasoning: "it is evidence against" });
    expect(out.success).toBe(true);
    expect(reviseArgument).toHaveBeenCalledWith({ argumentId: ARG, name: undefined, stance: "against" });
    expect(out.message).toMatch(/evaluation was retired/);
    expect(audit[0]).toMatchObject({ action: "revise_argument" });
  });

  it("give a quantity's argument no stance", async () => {
    vi.mocked(getArgument).mockResolvedValue({ ...liveArgument, stance: "neutral" } as never);
    const out = await run("revise_argument", { argument_id: ARG, stance: "for", reasoning: "x" });
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/set_argument_shows/);
  });

  it("refuse an argument on another node", async () => {
    vi.mocked(getArgument).mockResolvedValue({ ...liveArgument, claimId: OTHER } as never);
    const out = await run("retire_argument", { argument_id: ARG, reasoning: "x" });
    expect(out.success).toBe(false);
    expect(retireArgument).not.toHaveBeenCalled();
  });

  it("retire an argument, keeping its reason, and name the released subclaims", async () => {
    const out = await run("retire_argument", { argument_id: ARG, reasoning: "a poor argument, better left out" });
    expect(out.success).toBe(true);
    expect(retireArgument).toHaveBeenCalledWith({ argumentId: ARG, reason: "a poor argument, better left out" });
    expect(out.message).toContain(CHILD);
    expect(audit[0]).toMatchObject({ claimId: OWN, action: "retire_argument" });
  });

  it("refuse an argument already retired", async () => {
    vi.mocked(getArgument).mockResolvedValue({ ...liveArgument, retiredAt: new Date() } as never);
    const out = await run("retire_argument", { argument_id: ARG, reasoning: "x" });
    expect(out.success).toBe(false);
  });
});
