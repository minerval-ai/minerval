import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Steward's upward structure (#428): add_parent_claim mints the
 * proposition a claim is an argument for, about, or a special case of, and
 * attaches the stewarded claim beneath it; propose_parent_edge hands the same
 * case to an existing parent's Steward instead of writing across the boundary.
 */

const NEW_CLAIM_ID = "11111111-1111-1111-1111-111111111111";
const CHILD_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PARENT_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const EDGE_ID = "22222222-2222-2222-2222-222222222222";

const { insertedValues, selectRows } = vi.hoisted(() => ({
  insertedValues: [] as Record<string, unknown>[],
  // Rows the next select(...).limit() resolves to, consumed in order.
  selectRows: [] as Array<Record<string, unknown>[]>,
}));

vi.mock("../../../../src/db/client.js", () => {
  const values = (row: Record<string, unknown>) => {
    insertedValues.push(row);
    const p = Promise.resolve([{ id: NEW_CLAIM_ID }]);
    return Object.assign(p, { returning: () => Promise.resolve([{ id: NEW_CLAIM_ID }]) });
  };
  const select = () => ({
    from: () => ({
      where: () => ({ limit: async () => selectRows.shift() ?? [] }),
    }),
  });
  return {
    getDb: () => ({ insert: () => ({ values }), select }),
    rawQuery: vi.fn(async () => []),
  };
});

vi.mock("../../../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
}));

vi.mock("../../../../src/services/relationship-service.js", () => ({
  insertRelationshipEdge: vi.fn(async () => ({ id: EDGE_ID, created: true })),
  attachEdgeToArgument: vi.fn(async () => ({ grouped: true })),
  getClaimBasisSubclaims: vi.fn(async () => []),
}));

vi.mock("../../../../src/services/queue-service.js", () => ({
  enqueueClaimPipeline: vi.fn(async () => {}),
  enqueueSteward: vi.fn(async () => {}),
  enqueueCurator: vi.fn(async () => {}),
}));

vi.mock("../../../../src/llm/prompts/skills.js", () => ({
  knownDomains: () => ["mathematics"],
}));

import { executeStewardTool } from "../../../../src/llm/tools/steward-tools.js";
import { insertRelationshipEdge } from "../../../../src/services/relationship-service.js";
import {
  enqueueClaimPipeline,
  enqueueSteward,
} from "../../../../src/services/queue-service.js";

const child = { id: CHILD_ID, claimType: "empirical_derived", domains: ["mathematics"] };

const mint = (over: Record<string, unknown> = {}) =>
  executeStewardTool("add_parent_claim", {
    claim_id: CHILD_ID,
    parent_text: "The abc conjecture is true",
    relation: "supports",
    reasoning: "Every claim in this cluster is about whether IUT proves abc; abc itself has no node.",
    ...over,
  });

describe("steward add_parent_claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues.length = 0;
    selectRows.length = 0;
  });

  it("mints the parent, attaches the stewarded claim beneath it, and onboards the parent", async () => {
    selectRows.push([child]);
    const out = JSON.parse(await mint({ importance: 0.7 }));

    expect(out.success).toBe(true);
    expect(out.parent_claim_id).toBe(NEW_CLAIM_ID);

    // The new node is a real claim: embedded, epoch-stamped, minted by the Steward.
    const claimRow = insertedValues.find((r) => "text" in r);
    expect(claimRow?.text).toBe("The abc conjecture is true");
    expect(claimRow?.pipelineEpoch).toBeTruthy();
    expect(claimRow?.createdBy).toBe("claim_steward");
    expect(claimRow?.embedding).toEqual([0.1, 0.2, 0.3]);

    // Direction is the point: the NEW claim is the parent, the stewarded one the child.
    expect(insertRelationshipEdge).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: NEW_CLAIM_ID,
        childId: CHILD_ID,
        relationType: "supports",
      })
    );

    // The parent is onboarded so its own Steward takes it over; the edge the
    // child's Steward wrote is its starting structure.
    expect(enqueueClaimPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: NEW_CLAIM_ID, jobId: "steward" })
    );
  });

  it("records the mint in the audit trail against the stewarded claim", async () => {
    selectRows.push([child]);
    await mint();
    const audit = insertedValues.find((r) => r.action === "add_parent_claim");
    expect(audit).toBeTruthy();
    expect(audit?.claimId).toBe(CHILD_ID);
    expect(String(audit?.reasoning)).toContain(NEW_CLAIM_ID);
  });

  it("inherits the child's claim type and domains unless told otherwise", async () => {
    selectRows.push([child]);
    await mint();
    const claimRow = insertedValues.find((r) => "text" in r);
    expect(claimRow?.claimType).toBe("empirical_derived");
    expect(claimRow?.domains).toEqual(["mathematics"]);
    expect(claimRow?.domainsSource).toBe("inherited");
  });

  it("takes an explicit claim type, as when a proof dispute sits under a theorem", async () => {
    selectRows.push([child]);
    await mint({ claim_type: "mathematical", domains: ["mathematics"] });
    const claimRow = insertedValues.find((r) => "text" in r);
    expect(claimRow?.claimType).toBe("mathematical");
    expect(claimRow?.domainsSource).toBe("steward");
  });

  it("leaves a low-importance parent a deferred embedded stub (same brake as a subclaim)", async () => {
    selectRows.push([child]);
    const out = JSON.parse(await mint({ importance: 0.1 }));
    expect(out.success).toBe(true);
    const claimRow = insertedValues.find((r) => "text" in r);
    expect(claimRow?.stewardState).toBe("deferred");
    expect(enqueueClaimPipeline).not.toHaveBeenCalled();
    // The edge still exists: a stub above is still structure.
    expect(insertRelationshipEdge).toHaveBeenCalledTimes(1);
  });

  it("bounces a claim id that is not a real claim without minting anything", async () => {
    selectRows.push([]);
    const out = JSON.parse(await mint());
    expect(out.success).toBe(false);
    expect(insertedValues.find((r) => "text" in r)).toBeUndefined();
    expect(insertRelationshipEdge).not.toHaveBeenCalled();
  });

  it("bounces an unknown relation or claim type before touching the graph", async () => {
    selectRows.push([child]);
    expect(JSON.parse(await mint({ relation: "explains" })).success).toBe(false);
    selectRows.push([child]);
    expect(JSON.parse(await mint({ claim_type: "vibe" })).success).toBe(false);
    expect(insertedValues).toHaveLength(0);
  });
});

describe("steward propose_parent_edge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues.length = 0;
    selectRows.length = 0;
  });

  const propose = (over: Record<string, unknown> = {}) =>
    executeStewardTool("propose_parent_edge", {
      claim_id: CHILD_ID,
      parent_id: PARENT_ID,
      relation: "supports",
      reasoning: "This claimed proof is an argument for the conjecture.",
      ...over,
    });

  it("enqueues the parent's Steward with the case and writes no edge itself", async () => {
    selectRows.push([{ id: PARENT_ID }]);
    const out = JSON.parse(await propose());
    expect(out.success).toBe(true);
    expect(insertRelationshipEdge).not.toHaveBeenCalled();
    expect(insertedValues).toHaveLength(0);
    expect(enqueueSteward).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: PARENT_ID,
        trigger: "edge_proposal",
        context: expect.stringContaining(CHILD_ID),
      })
    );
  });

  it("bounces a parent that does not exist and points at add_parent_claim", async () => {
    selectRows.push([]);
    const out = JSON.parse(await propose());
    expect(out.success).toBe(false);
    expect(out.message).toContain("add_parent_claim");
    expect(enqueueSteward).not.toHaveBeenCalled();
  });

  it("refuses a self-parent", async () => {
    const out = JSON.parse(await propose({ parent_id: CHILD_ID }));
    expect(out.success).toBe(false);
    expect(enqueueSteward).not.toHaveBeenCalled();
  });
});
