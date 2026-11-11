/**
 * note_finding and search_findings (#394): attribution comes from the
 * ambient usage context, joins adds a sighting, search returns the closest
 * findings on record, and note_finding acknowledges no matter what.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  noteFinding: vi.fn(),
  searchFindings: vi.fn(),
}));

vi.mock("../../../../src/services/finding-service.js", () => ({
  noteFinding: mocks.noteFinding,
  searchFindings: mocks.searchFindings,
  FINDING_SEARCH_MAX_LIMIT: 20,
  FINDING_REF_KINDS: [
    "claim",
    "assessment",
    "question_assessment",
    "quantity_estimate",
    "argument",
    "contribution",
    "lean_check",
    "proof_attempt",
    "formalization",
  ],
}));

import {
  createFindingTools,
  getFindingToolDefinitions,
  NOTE_FINDING_TOOL_NAME,
  SEARCH_FINDINGS_TOOL_NAME,
} from "../../../../src/llm/tools/finding-tools.js";
import { runWithUsageContext } from "../../../../src/llm/usage-context.js";

const FINDING_ID = "d4d4d4d4-4444-4444-8444-444444444444";
const OTHER_ID = "e5e5e5e5-5555-4555-8555-555555555555";
const CLAIM_ID = "b2b2b2b2-2222-4222-8222-222222222222";
const ASSESSMENT_ID = "a1a1a1a1-1111-4111-8111-111111111111";
const RUN_ID = "c3c3c3c3-3333-4333-8333-333333333333";

const INPUT = {
  headline: "The conjecture has a machine-checked proof.",
  account: "The published statement was proved by the platform's solver and the check was accepted.",
  claim_id: CLAIM_ID,
  refs: [{ kind: "assessment", id: ASSESSMENT_ID }],
  importance: 7,
};

beforeEach(() => {
  mocks.noteFinding.mockReset().mockResolvedValue({
    outcome: "recorded",
    findingId: FINDING_ID,
    droppedRefs: [],
  });
});

describe("note_finding tool", () => {
  it("defines note_finding with typed refs, an importance range, and joins", () => {
    const [tool] = getFindingToolDefinitions();
    expect(tool!.name).toBe(NOTE_FINDING_TOOL_NAME);
    const props = tool!.input_schema.properties as Record<string, any>;
    expect(props.refs.items.properties.kind.enum).toContain("lean_check");
    // A question's standing and a quantity's estimate are cited as a
    // claim's assessment is, by the id get_claim serves (#890).
    expect(props.refs.items.properties.kind.enum).toEqual(
      expect.arrayContaining(["assessment", "question_assessment", "quantity_estimate"])
    );
    expect(props.refs.description).toContain("`question.assessment.id`");
    expect(props.refs.description).toContain("`quantity.assessed.id`");
    expect(props.importance.minimum).toBe(1);
    expect(props.importance.maximum).toBe(10);
    expect(props.joins).toBeDefined();
    expect(props.distinct_from).toBeUndefined();
    expect(tool!.input_schema.required).toEqual([
      "headline",
      "account",
      "claim_id",
      "refs",
      "importance",
    ]);
    // No kind, no confidence, no cap: the bar is in the prompt block.
    expect(props.kind).toBeUndefined();
    expect(props.confidence).toBeUndefined();
    expect(tool!.description).not.toMatch(/cap/i);
  });

  it("tells a mandate's agent to cite recorded work, never to make it, and never to name the mandate (§19)", () => {
    const admin = getFindingToolDefinitions()[0]!.description!;
    const mandate = getFindingToolDefinitions({ mandate: true })[0]!.description!;
    expect(admin).toContain("with its own tool first");
    expect(mandate).not.toContain("with its own tool first");
    expect(mandate).toContain("you make no assessment, argument, or merge");
    expect(mandate).toContain("no mention of the mandate, its funder");
    expect(mandate).toContain("in the graph's voice");
  });

  it("returns null for a tool it does not own", async () => {
    const tools = createFindingTools();
    expect(await tools.execute("update_claim_assessment", {})).toBeNull();
    expect(mocks.noteFinding).not.toHaveBeenCalled();
  });

  it("attributes the finding from the usage context and reports it published", async () => {
    const tools = createFindingTools({ model: "claude-opus-5-5" });
    const out = await runWithUsageContext(
      { agent: "steward", runId: RUN_ID, jobId: null, skills: ["mathematics"] },
      () => tools.execute(NOTE_FINDING_TOOL_NAME, INPUT)
    );
    expect(mocks.noteFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        headline: INPUT.headline,
        claimId: CLAIM_ID,
        refs: INPUT.refs,
        importance: 7,
        joins: null,
        agent: "steward",
        model: "claude-opus-5-5",
        runId: RUN_ID,
        skills: ["mathematics"],
      })
    );
    const parsed = JSON.parse(out!);
    expect(parsed).toMatchObject({ success: true, status: "recorded", finding_id: FINDING_ID });
    expect(parsed.message).toMatch(/published on the findings page as written/);
    expect(parsed.message).toMatch(/Continue with your task/);
  });

  it("passes joins through and reports the sighting", async () => {
    mocks.noteFinding.mockResolvedValue({
      outcome: "joined",
      findingId: OTHER_ID,
      sightingCount: 4,
      droppedRefs: [],
    });
    const tools = createFindingTools();
    const parsed = JSON.parse(
      (await tools.execute(NOTE_FINDING_TOOL_NAME, { ...INPUT, joins: OTHER_ID }))!
    );
    expect(mocks.noteFinding).toHaveBeenCalledWith(expect.objectContaining({ joins: OTHER_ID }));
    expect(parsed).toMatchObject({ success: true, status: "joined", finding_id: OTHER_ID, sighting_count: 4 });
    expect(parsed.message).toMatch(/now seen 4 times/);
  });

  it("names dropped refs in the acknowledgment", async () => {
    mocks.noteFinding.mockResolvedValue({
      outcome: "recorded",
      findingId: FINDING_ID,
      droppedRefs: [{ kind: "assessment", id: ASSESSMENT_ID }],
    });
    const tools = createFindingTools();
    const parsed = JSON.parse((await tools.execute(NOTE_FINDING_TOOL_NAME, INPUT))!);
    expect(parsed.dropped_refs).toEqual([{ kind: "assessment", id: ASSESSMENT_ID }]);
    expect(parsed.message).toContain(`assessment ${ASSESSMENT_ID}`);
    expect(parsed.message).toMatch(/record them through their own tools first/);
  });

  it("relays a validation problem in the agent's terms", async () => {
    mocks.noteFinding.mockResolvedValue({
      outcome: "not_recorded",
      problem: "importance must be an integer from 1 to 10",
    });
    const tools = createFindingTools();
    const parsed = JSON.parse((await tools.execute(NOTE_FINDING_TOOL_NAME, { ...INPUT, importance: 12 }))!);
    expect(parsed).toMatchObject({ success: false, acknowledged: true, status: "not_recorded" });
    expect(parsed.message).toBe(
      "Not recorded: importance must be an integer from 1 to 10. Continue with your task."
    );
  });

  it("acknowledges even when the service throws", async () => {
    mocks.noteFinding.mockRejectedValue(new Error("boom"));
    const tools = createFindingTools();
    const parsed = JSON.parse((await tools.execute(NOTE_FINDING_TOOL_NAME, INPUT))!);
    expect(parsed).toMatchObject({ success: false, acknowledged: true, status: "not_recorded" });
    expect(parsed.message).toContain("boom");
    expect(parsed.message).toMatch(/Continue with your task/);
  });
});

describe("search_findings tool", () => {
  it("is defined beside note_finding with a required query", () => {
    const tool = getFindingToolDefinitions().find((t) => t.name === SEARCH_FINDINGS_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool!.input_schema.required).toEqual(["query"]);
  });

  it("passes the query, node, and limit through and lists what it found", async () => {
    mocks.searchFindings.mockResolvedValue([
      {
        id: OTHER_ID,
        headline: "The conjecture is settled by a checked proof.",
        claim_id: CLAIM_ID,
        agent: "steward",
        importance: 7,
        sighting_count: 3,
        first_noted_at: "2026-09-03T00:00:00.000Z",
        similarity: 0.9,
      },
    ]);
    const tools = createFindingTools();
    const parsed = JSON.parse(
      (await tools.execute(SEARCH_FINDINGS_TOOL_NAME, { query: "proof of the conjecture", claim_id: CLAIM_ID, limit: 3 }))!
    );
    expect(mocks.searchFindings).toHaveBeenCalledWith({ query: "proof of the conjecture", claimId: CLAIM_ID, limit: 3 });
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.message).toContain(OTHER_ID);
    expect(parsed.message).toContain("seen 3 times");
  });

  it("says so when nothing matches, and reports a failed search without throwing", async () => {
    const tools = createFindingTools();
    mocks.searchFindings.mockResolvedValue([]);
    expect(JSON.parse((await tools.execute(SEARCH_FINDINGS_TOOL_NAME, { query: "x" }))!).message).toBe(
      "No published findings match."
    );
    mocks.searchFindings.mockRejectedValue(new Error("embedding down"));
    expect(JSON.parse((await tools.execute(SEARCH_FINDINGS_TOOL_NAME, { query: "x" }))!).message).toContain(
      "embedding down"
    );
  });
});
