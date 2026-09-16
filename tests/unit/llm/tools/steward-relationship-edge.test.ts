import { describe, it, expect, vi, beforeEach } from "vitest";

const PARENT_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CHILD_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ARG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const EDGE_ID = "22222222-2222-2222-2222-222222222222";

const { childRows } = vi.hoisted(() => ({
  childRows: [] as { id: string; state: string }[],
}));

// The child-existence lookup is the only query-builder call this handler
// makes; everything else goes through the mocked services below.
vi.mock("../../../../src/db/client.js", () => {
  const select = () => ({
    from: () => ({ where: () => ({ limit: async () => childRows }) }),
  });
  return {
    getDb: () => ({ select }),
    rawQuery: vi.fn(async () => []),
  };
});

vi.mock("../../../../src/services/relationship-service.js", () => ({
  insertRelationshipEdge: vi.fn(async () => ({ id: EDGE_ID, created: true })),
  attachEdgeToArgument: vi.fn(async () => ({ grouped: true })),
  getClaimBasisSubclaims: vi.fn(async () => []),
}));

vi.mock("../../../../src/services/argument-service.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../src/services/argument-service.js")
  >();
  return { ...actual, getArgument: vi.fn() };
});

vi.mock("../../../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
}));

vi.mock("../../../../src/services/queue-service.js", () => ({
  enqueueClaimPipeline: vi.fn(async () => {}),
  enqueueSteward: vi.fn(async () => {}),
  enqueueCurator: vi.fn(async () => {}),
}));

import { executeStewardTool } from "../../../../src/llm/tools/steward-tools.js";
import {
  attachEdgeToArgument,
  insertRelationshipEdge,
} from "../../../../src/services/relationship-service.js";
import { getArgument } from "../../../../src/services/argument-service.js";

const argument = {
  id: ARG_ID,
  claimId: PARENT_ID,
  name: "Cosmological argument",
  description: null,
  stance: "for",
  content: "Cosmological argument",
  evidenceUrls: [],
  createdBy: "claim_steward",
  createdAt: new Date(),
};

const call = (over: Record<string, unknown> = {}) =>
  executeStewardTool("add_relationship_edge", {
    parent_id: PARENT_ID,
    child_id: CHILD_ID,
    relation: "REQUIRES",
    reasoning: "load-bearing",
    ...over,
  });

describe("steward add_relationship_edge (#437)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    childRows.length = 0;
    childRows.push({ id: CHILD_ID, state: "active" });
    vi.mocked(getArgument).mockResolvedValue(argument as never);
    vi.mocked(insertRelationshipEdge).mockResolvedValue({ id: EDGE_ID, created: true });
    vi.mocked(attachEdgeToArgument).mockResolvedValue({ grouped: true });
  });

  it("links an existing claim and groups the edge under the argument", async () => {
    const parsed = JSON.parse(await call({ argument_id: ARG_ID }));
    expect(parsed).toMatchObject({
      success: true,
      created: true,
      grouped: true,
      relationship_id: EDGE_ID,
      child_claim_id: CHILD_ID,
      argument_id: ARG_ID,
    });
    expect(parsed.message).toContain("Grouped it under");
    expect(insertRelationshipEdge).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: PARENT_ID,
        childId: CHILD_ID,
        relationType: "requires", // prose-cased input normalized
        createdBy: "claim_steward",
      })
    );
    expect(attachEdgeToArgument).toHaveBeenCalledWith(ARG_ID, EDGE_ID);
  });

  it("groups an edge that already exists under a second argument, and says so", async () => {
    vi.mocked(insertRelationshipEdge).mockResolvedValue({ id: EDGE_ID, created: false });
    const parsed = JSON.parse(await call({ argument_id: ARG_ID }));
    expect(parsed).toMatchObject({ success: true, created: false, grouped: true });
    expect(parsed.message).toContain("already existed");
    expect(parsed.message).toContain("Grouped it under");
    expect(attachEdgeToArgument).toHaveBeenCalledWith(ARG_ID, EDGE_ID);
  });

  it("reports an edge that was already in the argument rather than claiming a fresh write", async () => {
    vi.mocked(insertRelationshipEdge).mockResolvedValue({ id: EDGE_ID, created: false });
    vi.mocked(attachEdgeToArgument).mockResolvedValue({ grouped: false });
    const parsed = JSON.parse(await call({ argument_id: ARG_ID }));
    expect(parsed).toMatchObject({ success: true, created: false, grouped: false });
    expect(parsed.message).toContain("already grouped under");
  });

  it("reports a duplicate edge honestly when no argument is given", async () => {
    vi.mocked(insertRelationshipEdge).mockResolvedValue({ id: EDGE_ID, created: false });
    const parsed = JSON.parse(await call());
    expect(parsed).toMatchObject({ success: true, created: false });
    expect(parsed.grouped).toBeUndefined();
    expect(parsed.message).toContain("already existed");
    expect(attachEdgeToArgument).not.toHaveBeenCalled();
  });

  it("refuses an argument that belongs to another claim, before touching the graph", async () => {
    vi.mocked(getArgument).mockResolvedValue({
      ...argument,
      claimId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    } as never);
    const parsed = JSON.parse(await call({ argument_id: ARG_ID }));
    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain("belongs to claim");
    expect(insertRelationshipEdge).not.toHaveBeenCalled();
  });

  it("refuses an unknown argument id", async () => {
    vi.mocked(getArgument).mockResolvedValue(null as never);
    const parsed = JSON.parse(await call({ argument_id: ARG_ID }));
    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain("Argument not found");
    expect(insertRelationshipEdge).not.toHaveBeenCalled();
  });

  it("bounces a hallucinated child id with a readable message", async () => {
    childRows.length = 0;
    const parsed = JSON.parse(await call());
    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain("Claim not found");
    expect(insertRelationshipEdge).not.toHaveBeenCalled();
  });

  it("refuses a self-edge", async () => {
    const parsed = JSON.parse(await call({ child_id: PARENT_ID }));
    expect(parsed.success).toBe(false);
    expect(insertRelationshipEdge).not.toHaveBeenCalled();
  });

  it("surfaces a write failure instead of reporting success", async () => {
    vi.mocked(insertRelationshipEdge).mockRejectedValue(new Error("connection reset"));
    const out = await call();
    expect(out.startsWith("Error:")).toBe(true);
    expect(out).toContain("connection reset");
  });
});
