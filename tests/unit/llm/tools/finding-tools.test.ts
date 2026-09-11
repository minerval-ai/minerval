/**
 * note_finding (#394): attribution comes from the ambient usage context, a
 * near match on record comes back as a question rather than a write, and
 * the tool acknowledges no matter what.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  noteFinding: vi.fn(),
}));

vi.mock("../../../../src/services/finding-service.js", () => ({
  noteFinding: mocks.noteFinding,
  FINDING_REF_KINDS: [
    "claim",
    "assessment",
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
  it("defines one tool with typed refs, an importance range, and the two answer fields", () => {
    const [tool] = getFindingToolDefinitions();
    expect(tool!.name).toBe(NOTE_FINDING_TOOL_NAME);
    const props = tool!.input_schema.properties as Record<string, any>;
    expect(props.refs.items.properties.kind.enum).toContain("lean_check");
    expect(props.importance.minimum).toBe(1);
    expect(props.importance.maximum).toBe(10);
    expect(props.joins).toBeDefined();
    expect(props.distinct_from).toBeDefined();
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

  it("returns null for a tool it does not own", async () => {
    const tools = createFindingTools();
    expect(await tools.execute("update_claim_assessment", {})).toBeNull();
    expect(mocks.noteFinding).not.toHaveBeenCalled();
  });

  it("attributes the finding from the usage context and reports it published", async () => {
    const tools = createFindingTools({ model: "claude-fable-5-1" });
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
        model: "claude-fable-5-1",
        runId: RUN_ID,
        skills: ["mathematics"],
      })
    );
    const parsed = JSON.parse(out!);
    expect(parsed).toMatchObject({ success: true, status: "recorded", finding_id: FINDING_ID });
    expect(parsed.message).toMatch(/published on the findings page as written/);
    expect(parsed.message).toMatch(/Continue with your task/);
  });

  it("shows the near matches and asks for joins or distinct_from, writing nothing", async () => {
    mocks.noteFinding.mockResolvedValue({
      outcome: "possible_duplicate",
      matches: [
        {
          id: OTHER_ID,
          headline: "The conjecture is settled by a checked proof.",
          claim_id: CLAIM_ID,
          agent: "steward",
          importance: 7,
          sighting_count: 3,
          first_noted_at: "2026-09-03T00:00:00.000Z",
          similarity: 0.9,
          same_claim: true,
        },
      ],
    });
    const tools = createFindingTools();
    const parsed = JSON.parse((await tools.execute(NOTE_FINDING_TOOL_NAME, INPUT))!);
    expect(parsed).toMatchObject({ success: false, acknowledged: true, status: "possible_duplicate" });
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.message).toContain(OTHER_ID);
    expect(parsed.message).toContain("2026-09-03");
    expect(parsed.message).toContain("on this claim");
    expect(parsed.message).toContain("seen 3 times");
    expect(parsed.message).toMatch(/joins set to its id/);
    expect(parsed.message).toMatch(/distinct_from/);
  });

  it("passes joins and distinct_from through on the second call", async () => {
    mocks.noteFinding.mockResolvedValue({
      outcome: "joined",
      findingId: OTHER_ID,
      sightingCount: 4,
      droppedRefs: [],
    });
    const tools = createFindingTools();
    const parsed = JSON.parse(
      (await tools.execute(NOTE_FINDING_TOOL_NAME, { ...INPUT, joins: OTHER_ID, distinct_from: [FINDING_ID] }))!
    );
    expect(mocks.noteFinding).toHaveBeenCalledWith(
      expect.objectContaining({ joins: OTHER_ID, distinctFrom: [FINDING_ID] })
    );
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
