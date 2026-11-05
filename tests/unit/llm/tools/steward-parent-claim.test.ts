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
  const rawQuery = vi.fn(async () => []);
  const db = { insert: () => ({ values }), select };
  return {
    getDb: () => db,
    rawQuery,
    // The parent row, a quantity's definition, and the edge are one
    // transaction; here the callback runs against the same stubs.
    withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ query: rawQuery, db })),
  };
});

// A question parent's edge is the one the question tools write (§7a).
vi.mock("../../../../src/services/question-service.js", () => ({
  addAnswer: vi.fn(async () => ({ id: EDGE_ID })),
  addSubquestion: vi.fn(async () => ({ id: EDGE_ID })),
}));

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
import { rawQuery, withTransaction } from "../../../../src/db/client.js";
import { addAnswer, addSubquestion } from "../../../../src/services/question-service.js";

const child = { id: CHILD_ID, claimType: "empirical_derived", domains: ["mathematics"], kind: "claim" };
const questionChild = { ...child, kind: "question" };

const DEFINITION = {
  measures: "Share of US adults who smoke cigarettes daily",
  population: "US adults",
  conditions: "2020",
  unit: { kind: "proportion" },
};

/** The quantity_definitions insert, if the call wrote one. */
const definitionInsert = () =>
  vi
    .mocked(rawQuery)
    .mock.calls.find((c) => String((c as unknown[])[0]).includes("quantity_definitions")) as
    | [string, unknown[]]
    | undefined;

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
      }),
      // ...inside the transaction that writes the parent row.
      expect.anything()
    );
    expect(insertedValues.find((r) => "text" in r)?.kind).toBe("claim");

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

describe("steward add_parent_claim: parents of every kind (§2, §7a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues.length = 0;
    selectRows.length = 0;
  });

  it("mints a quantity parent with its definition, in one transaction with the edge", async () => {
    selectRows.push([child]);
    const out = JSON.parse(
      await mint({
        kind: "quantity",
        parent_text: "Share of US adults who smoke cigarettes daily, 2020",
        definition: DEFINITION,
        relation: "supports",
        importance: 0.6,
      })
    );
    expect(out.success).toBe(true);
    expect(out.parent_kind).toBe("quantity");

    const claimRow = insertedValues.find((r) => "text" in r);
    expect(claimRow?.kind).toBe("quantity");
    expect(withTransaction).toHaveBeenCalledTimes(1);

    // The definition is stored against the new node.
    const insert = definitionInsert();
    expect(insert).toBeTruthy();
    expect(insert![1][0]).toBe(NEW_CLAIM_ID);
    expect(insert![1][1]).toBe(DEFINITION.measures);
    expect(JSON.parse(String(insert![1][4]))).toEqual({ kind: "proportion" });

    expect(insertRelationshipEdge).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: NEW_CLAIM_ID, childId: CHILD_ID, relationType: "supports" }),
      expect.anything()
    );
    expect(enqueueClaimPipeline).toHaveBeenCalledWith(expect.objectContaining({ claimId: NEW_CLAIM_ID }));
  });

  it("refuses a quantity parent without a valid definition before writing anything", async () => {
    selectRows.push([child]);
    const out = JSON.parse(await mint({ kind: "quantity", definition: { measures: "x" } }));
    expect(out.success).toBe(false);
    expect(out.message).toContain("definition");
    expect(insertedValues).toHaveLength(0);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("refuses an unknown kind", async () => {
    selectRows.push([child]);
    const out = JSON.parse(await mint({ kind: "hunch" }));
    expect(out.success).toBe(false);
    expect(insertedValues).toHaveLength(0);
  });

  it("leaves a low-importance quantity parent a deferred stub, definition and edge still written", async () => {
    selectRows.push([child]);
    const out = JSON.parse(await mint({ kind: "quantity", definition: DEFINITION, importance: 0.1 }));
    expect(out.success).toBe(true);
    const claimRow = insertedValues.find((r) => "text" in r);
    expect(claimRow?.kind).toBe("quantity");
    expect(claimRow?.stewardState).toBe("deferred");
    expect(definitionInsert()).toBeTruthy();
    expect(insertRelationshipEdge).toHaveBeenCalledTimes(1);
    expect(enqueueClaimPipeline).not.toHaveBeenCalled();
  });

  it("leaves a low-importance question parent a deferred stub too", async () => {
    selectRows.push([child]);
    const out = JSON.parse(
      await mint({ kind: "question", relation: "answers", basis: "quality", importance: 0.1 })
    );
    expect(out.success).toBe(true);
    const claimRow = insertedValues.find((r) => "text" in r);
    expect(claimRow?.kind).toBe("question");
    expect(claimRow?.stewardState).toBe("deferred");
    expect(enqueueClaimPipeline).not.toHaveBeenCalled();
  });

  it("attaches a claim under a new question as a candidate answer, with its basis, as add_answer does", async () => {
    selectRows.push([child]);
    const out = JSON.parse(
      await mint({
        kind: "question",
        parent_text: "What explains the decline in US smoking since 1965?",
        relation: "answers",
        basis: "prominence",
      })
    );
    expect(out.success).toBe(true);
    expect(out.parent_kind).toBe("question");
    expect(out.relationship_id).toBe(EDGE_ID);
    expect(insertedValues.find((r) => "text" in r)?.kind).toBe("question");
    expect(addAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: NEW_CLAIM_ID, answerId: CHILD_ID, basis: "prominence" }),
      expect.anything()
    );
    // Not a plain decomposition edge, and no definition for a question.
    expect(insertRelationshipEdge).not.toHaveBeenCalled();
    expect(definitionInsert()).toBeUndefined();
    expect(enqueueClaimPipeline).toHaveBeenCalledWith(expect.objectContaining({ claimId: NEW_CLAIM_ID }));
  });

  it("needs a basis for an answer", async () => {
    selectRows.push([child]);
    const out = JSON.parse(await mint({ kind: "question", relation: "answers" }));
    expect(out.success).toBe(false);
    expect(out.message).toContain("basis");
    expect(insertedValues).toHaveLength(0);
    expect(addAnswer).not.toHaveBeenCalled();
  });

  it("attaches a stewarded question under a new question as its subquestion", async () => {
    selectRows.push([questionChild]);
    const out = JSON.parse(
      await mint({ kind: "question", parent_text: "Why did smoking decline?", relation: "part_of" })
    );
    expect(out.success).toBe(true);
    expect(addSubquestion).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: NEW_CLAIM_ID, subquestionId: CHILD_ID }),
      expect.anything()
    );
    expect(addAnswer).not.toHaveBeenCalled();
  });

  it("records a presupposition of a new question as the ordinary assumes edge", async () => {
    selectRows.push([child]);
    const out = JSON.parse(await mint({ kind: "question", relation: "assumes" }));
    expect(out.success).toBe(true);
    expect(insertRelationshipEdge).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: NEW_CLAIM_ID, childId: CHILD_ID, relationType: "assumes" }),
      expect.anything()
    );
  });

  it("refuses relations that do not fit the kinds, before writing anything", async () => {
    // A question is answered, not supported.
    selectRows.push([child]);
    expect(JSON.parse(await mint({ kind: "question", relation: "supports" })).success).toBe(false);
    // A question answers no question.
    selectRows.push([questionChild]);
    expect(
      JSON.parse(await mint({ kind: "question", relation: "answers", basis: "quality" })).success
    ).toBe(false);
    // Only a question is part of a question.
    selectRows.push([child]);
    expect(JSON.parse(await mint({ kind: "question", relation: "part_of" })).success).toBe(false);
    // answers and part_of join a node to a question only.
    selectRows.push([child]);
    expect(JSON.parse(await mint({ relation: "answers", basis: "quality" })).success).toBe(false);
    selectRows.push([child]);
    expect(
      JSON.parse(await mint({ kind: "quantity", definition: DEFINITION, relation: "part_of" })).success
    ).toBe(false);
    expect(insertedValues).toHaveLength(0);
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

describe("steward propose_parent_edge into other kinds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues.length = 0;
    selectRows.length = 0;
  });

  const propose = (over: Record<string, unknown> = {}) =>
    executeStewardTool("propose_parent_edge", {
      claim_id: CHILD_ID,
      parent_id: PARENT_ID,
      relation: "answers",
      reasoning: "This is a serious candidate answer the question lacks.",
      ...over,
    });

  it("proposes a candidate answer and names add_answer for the question's Steward", async () => {
    selectRows.push([{ id: PARENT_ID, kind: "question" }], [{ kind: "claim" }]);
    const out = JSON.parse(await propose());
    expect(out.success).toBe(true);
    expect(enqueueSteward).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: PARENT_ID,
        trigger: "edge_proposal",
        context: expect.stringContaining("add_answer"),
      })
    );
  });

  it("proposes a subquestion and names add_subquestion", async () => {
    selectRows.push([{ id: PARENT_ID, kind: "question" }], [{ kind: "question" }]);
    const out = JSON.parse(await propose({ relation: "part_of" }));
    expect(out.success).toBe(true);
    expect(enqueueSteward).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.stringContaining("add_subquestion") })
    );
  });

  it("refuses a relation a question cannot take, or a question-only relation elsewhere", async () => {
    selectRows.push([{ id: PARENT_ID, kind: "question" }], [{ kind: "claim" }]);
    expect(JSON.parse(await propose({ relation: "supports" })).success).toBe(false);
    selectRows.push([{ id: PARENT_ID, kind: "claim" }], [{ kind: "claim" }]);
    expect(JSON.parse(await propose({ relation: "answers" })).success).toBe(false);
    expect(enqueueSteward).not.toHaveBeenCalled();
  });

  it("proposes into a quantity with the ordinary edge tool", async () => {
    selectRows.push([{ id: PARENT_ID, kind: "quantity" }], [{ kind: "claim" }]);
    const out = JSON.parse(await propose({ relation: "supports" }));
    expect(out.success).toBe(true);
    expect(enqueueSteward).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.stringContaining("add_relationship_edge") })
    );
  });
});
