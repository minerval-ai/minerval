import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The read repair every agent's graph reads make (tools/id-repair.ts via
 * executeGraphReadTool, #934), and the write side, which never repairs:
 * a write given an id that names nothing refuses and lists the nearest ids
 * the run has seen.
 */

const NODE = "1ea1a55c-1361-4685-991b-3c303c74c323";
const OTHER_NODE = "36174f8a-ee30-402f-9277-538a8c48a431";
const ARGUMENT = "95541f44-3440-4280-be4a-51187ecfd478";
const ASSESSMENT = "cf1ddaef-ff2e-4dea-8528-7bf43effb3ea";
const NODES = new Map([
  [NODE, "Scheming evaluations use contrived scenarios."],
  [OTHER_NODE, "Another node."],
]);
const ARGUMENTS = new Map([[ARGUMENT, { name: "From the eval design", claim_id: NODE }]]);

const mocks = vi.hoisted(() => ({ dbDown: false }));

vi.mock("../../../../src/services/claim-view-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/services/claim-view-service.js")>()),
  getClaimView: vi.fn(async (id: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      throw Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" });
    }
    return NODES.has(id) ? { claim: { id, canonical_form: NODES.get(id) } } : null;
  }),
}));
vi.mock("../../../../src/services/argument-view-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/services/argument-view-service.js")>()),
  getArgumentView: vi.fn(async (id: string) =>
    ARGUMENTS.has(id) ? { argument: { id, name: ARGUMENTS.get(id)!.name } } : null
  ),
}));
vi.mock("../../../../src/services/graph-read-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/services/graph-read-service.js")>()),
  runGraphRead: vi.fn(async (name: string, input: Record<string, unknown>) => {
    if (name === "search_claims") return { ok: true, payload: { results: [] } };
    const id = String(input.claim_id ?? "");
    return NODES.has(id)
      ? { ok: true, payload: { claim_id: id, dependents: [] } }
      : { ok: false, code: "NOT_FOUND", message: "Claim not found" };
  }),
}));
vi.mock("../../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string, [ids]: [string[]]) => {
    if (mocks.dbDown) throw new Error("connection reset");
    if (sql.includes("FROM arguments")) {
      return ids.filter((id) => ARGUMENTS.has(id)).map((id) => ({ id, text: ARGUMENTS.get(id)!.name, claim_id: ARGUMENTS.get(id)!.claim_id }));
    }
    return ids.filter((id) => NODES.has(id)).map((id) => ({ id, text: NODES.get(id) }));
  }),
}));

import { executeGraphReadTool, getGraphReadToolDefinitions } from "../../../../src/llm/tools/graph-read-tools.js";
import { malformedIdRefusal, unresolvedNodeIds, writeIdCandidates } from "../../../../src/llm/tools/id-repair.js";
import { SeenIds, withSeenIds } from "../../../../src/llm/seen-ids.js";

/** A run that has been shown the two nodes, the argument and an assessment. */
function runRecord(): SeenIds {
  const record = new SeenIds();
  record.addToolOutput(
    JSON.stringify({
      claim: { id: NODE, canonical_form: NODES.get(NODE) },
      assessment: { id: ASSESSMENT, status: "supported" },
      arguments: [{ id: ARGUMENT, name: "From the eval design" }],
    })
  );
  record.addToolOutput(JSON.stringify({ results: [{ id: OTHER_NODE, canonical_form: NODES.get(OTHER_NODE) }] }));
  return record;
}
const inRun = <T>(fn: () => Promise<T>, record = runRecord()) => withSeenIds(record, fn);
const read = async (name: string, input: Record<string, unknown>, record?: SeenIds) =>
  JSON.parse((await inRun(() => executeGraphReadTool(name, input) as Promise<string>, record))!);

beforeEach(() => {
  mocks.dbDown = false;
});

describe("graph reads repair a mistyped id against what the run has seen (#934)", () => {
  it("reads a real id as given", async () => {
    const out = await read("get_claim", { claim_id: NODE });
    expect(out.claim.id).toBe(NODE);
    expect(out.id_corrected).toBeUndefined();
  });

  it("repairs #934's id, one hex digit too long, and says so", async () => {
    const out = await read("get_claim", { claim_id: `${NODE}6` });
    expect(out.claim.id).toBe(NODE);
    expect(out.id_corrected).toMatchObject({ requested_id: `${NODE}6`, resolved_id: NODE, rule: "one_character" });
    expect(out.id_corrected.note).toContain("Writes are never corrected this way");
  });

  it("repairs a changed digit on get_dependents too", async () => {
    const typo = `${OTHER_NODE.slice(0, 20)}0${OTHER_NODE.slice(21)}`;
    const out = await read("get_dependents", { claim_id: typo });
    expect(out.claim_id).toBe(OTHER_NODE);
    expect(out.id_corrected.resolved_id).toBe(OTHER_NODE);
  });

  it("repairs an argument id on get_argument, against the arguments the run has seen", async () => {
    const out = await read("get_argument", { argument_id: ARGUMENT.slice(0, -1) });
    expect(out.argument.id).toBe(ARGUMENT);
    expect(out.id_corrected.resolved_id).toBe(ARGUMENT);
  });

  it("says an id the run saw as an assessment's is not a node's, and does not guess", async () => {
    const out = await read("get_claim", { claim_id: ASSESSMENT });
    expect(out.code).toBe("CLAIM_NOT_FOUND");
    expect(out.error).toContain("as `assessment.id` in an earlier result, but it is not a node's id");
    expect(out.id_corrected).toBeUndefined();
  });

  it("does not take a near id that is not of the kind the read takes", async () => {
    // One character from the argument's id: a node read cannot be repaired to an argument.
    const out = await read("get_claim", { claim_id: `${ARGUMENT.slice(0, -1)}0` });
    expect(out.code).toBe("CLAIM_NOT_FOUND");
    expect(out.error).toContain(`The one id this run has seen that it resembles, ${ARGUMENT}, is not a node's id either`);
    expect(out.nearest_seen_ids.map((n: { id: string }) => n.id)).not.toContain(ARGUMENT);
  });

  it("lists the nearest nodes with their wording when nothing fits", async () => {
    const out = await read("get_claim", { claim_id: "deadbeef-0000-4000-8000-000000000000" });
    expect(out.code).toBe("CLAIM_NOT_FOUND");
    expect(out.nearest_seen_ids).toEqual(
      expect.arrayContaining([{ id: NODE, text: NODES.get(NODE) }, { id: OTHER_NODE, text: NODES.get(OTHER_NODE) }])
    );
    // An assessment's id and an argument's are not nodes, so not listed.
    expect(out.nearest_seen_ids).toHaveLength(2);
  });

  it("falls back to the record's own wording when the graph cannot be asked", async () => {
    mocks.dbDown = true;
    const out = await read("get_claim", { claim_id: "deadbeef-0000-4000-8000-000000000000" });
    expect(out.nearest_seen_ids.map((n: { id: string }) => n.id).sort()).toEqual([NODE, OTHER_NODE].sort());
  });

  it("says what is wrong with a malformed id that resembles nothing", async () => {
    const out = await read("get_claim", { claim_id: "e15a36f4-edf3-45c5-92d9-85fceae5190" });
    expect(out.code).toBe("INVALID_CLAIM_ID");
    expect(out.error).toContain("its last group has 11 hex digits, where a uuid has 12");
  });

  it("outside a tool loop returns the miss as it was", async () => {
    const out = JSON.parse((await executeGraphReadTool("get_claim", { claim_id: `${NODE}6` }))!);
    expect(out.code).toBe("INVALID_CLAIM_ID");
    expect(out.nearest_seen_ids).toBeUndefined();
  });

  it("tells every agent how a misread id is handled, on the reads that take one", () => {
    const defs = getGraphReadToolDefinitions();
    for (const name of ["get_claim", "get_decomposition", "get_dependents", "get_argument"]) {
      expect(defs.find((d) => d.name === name)!.description).toContain("id_corrected");
    }
    expect(defs.find((d) => d.name === "search_claims")!.description).not.toContain("id_corrected");
  });
});

describe("writes never repair", () => {
  it("offers the nearest ids for a write's refused id, and says it was not corrected", async () => {
    const out = await inRun(() => writeIdCandidates(`${NODE}6`));
    expect(out.code).toBe("CLAIM_NOT_FOUND");
    expect(out.requested_id).toBe(`${NODE}6`);
    expect(out.nearest_seen_ids![0]).toEqual({ id: NODE, text: NODES.get(NODE) });
    expect(out.correction).toContain("never corrected here");
    expect(out.correction).toContain("13 hex digits");
  });

  it("offers argument ids for an argument write", async () => {
    const out = await inRun(() => writeIdCandidates(ARGUMENT.slice(0, -1), "argument"));
    expect(out.code).toBe("ARGUMENT_NOT_FOUND");
    expect(out.nearest_seen_ids![0]).toMatchObject({ id: ARGUMENT, claim_id: NODE });
  });

  it("adds nothing outside a tool loop", async () => {
    expect(await writeIdCandidates(`${NODE}6`)).toEqual({});
  });

  it("lists, for a multi-node write, only the ids that name nothing", async () => {
    const out = await inRun(() => unresolvedNodeIds([NODE, `${OTHER_NODE.slice(0, -1)}0`, "", null]));
    expect(out).toHaveLength(1);
    expect(out[0]!.requested_id).toBe(`${OTHER_NODE.slice(0, -1)}0`);
    expect(out[0]!.nearest_seen_ids![0]!.id).toBe(OTHER_NODE);
  });

  it("names the malformed field of a write the database refused", async () => {
    const out = JSON.parse(await inRun(() => malformedIdRefusal({ child_id: `${NODE}6`, parent_id: OTHER_NODE, reasoning: "r" })));
    expect(out).toMatchObject({ success: false, code: "INVALID_CLAIM_ID" });
    expect(out.message).toContain("child_id");
    expect(out.message).not.toContain("parent_id");
    expect(out.unresolved[0]).toMatchObject({ field: "child_id", requested_id: `${NODE}6` });
    expect(out.unresolved[0].nearest_seen_ids[0].id).toBe(NODE);
  });
});
