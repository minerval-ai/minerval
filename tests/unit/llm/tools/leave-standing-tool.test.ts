import { describe, expect, it } from "vitest";
import { executeLeaveStandingTool, getLeaveStandingToolDefinition, LEAVE_STANDING_TOOL_NAME } from "../../../../src/llm/tools/leave-standing-tool.js";
import { TOOL_READS } from "../../../../src/llm/run-visibility.js";
import { leftStandingChangedMessage } from "../../../../src/services/version-upkeep.js";

/**
 * leave_judgment_standing without a database: what the Steward is told the
 * tool does, and that on a graph with one label it records nothing and
 * asks the database nothing. What it records is in
 * tests/db/left-standing.test.ts.
 */
describe("leave_judgment_standing", () => {
  it("says what it does, and makes nothing a condition of a judgment of the Steward's own", () => {
    const tool = getLeaveStandingToolDefinition();
    expect(tool.name).toBe(LEAVE_STANDING_TOOL_NAME);
    expect(tool.description).toBe(
      "On a node that carries another label than this run's: leave the judgment you read there standing for " +
        "readers at this run's label, and record no judgment of your own. The node's page then shows readers at " +
        "this run's label that it was examined at their label on this date and left standing, with your " +
        "reasoning. If this run's label has a judgment of the node, that judgment is retired and stays in the " +
        "node's history. A judgment recorded at this run's label later takes this record's place. When the " +
        "judgment left standing is replaced, a reassessment at this run's label is opened, which runs when it " +
        "is funded."
    );
    expect(tool.description).not.toMatch(/\bmust\b|\bonly\b|\bnever\b|\balways\b|attached|material/);
    expect((tool.input_schema as { required: string[] }).required).toEqual(["claim_id", "reasoning"]);
    expect(TOOL_READS[LEAVE_STANDING_TOOL_NAME]).toBeDefined();
  });

  it("is no other tool's executor", async () => {
    expect(await executeLeaveStandingTool("log_stewardship_decision", {})).toBeNull();
  });

  it("records nothing and asks nothing where the graph has one label", async () => {
    // This process has made no query, so it has no reason to think there is a second label.
    const out = JSON.parse((await executeLeaveStandingTool(LEAVE_STANDING_TOOL_NAME, { claim_id: "5e0f6f5e-0000-4000-8000-000000000001", reasoning: "Looked." }))!);
    expect(out).toEqual({
      success: false,
      message: "Not recorded. This graph has one label, so a node carries one judgment and there is no other to leave standing.",
    });
    expect(JSON.parse((await executeLeaveStandingTool(LEAVE_STANDING_TOOL_NAME, {}))!).success).toBe(false);
  });

  it("tells the Steward, when the judgment it left standing is replaced, what happened and its two outcomes", () => {
    const message = leftStandingChangedMessage("internal", ["public"]);
    expect(message).toContain("left the judgment at `public` standing for readers at `internal`");
    expect(message).toContain("Record your own judgment, or leave the newer one standing with leave_judgment_standing.");
  });
});

describe("the Steward's task on a node judged at a label it reads and not at its own", () => {
  it("names the two outcomes, and neither is the logged decision alone", async () => {
    const { defaultTask } = await import("../../../../src/llm/agents/claim-steward.js");
    const task = defaultTask("The pass note.", "claim", false, true);
    expect(task.text).toContain(
      "The claim carries another label than this run's. The current assessment was\n" +
        "made at a label this run reads, and this run's label has none of its own.\n" +
        "Before the run ends, record your own: the assessment\n" +
        "(update_claim_assessment, with both texts and marginal_yield), an evaluation\n" +
        "of each named argument. Or leave the one you read\n" +
        "standing for readers at this run's label (leave_judgment_standing, with\n" +
        "your reasons). Either is the complete outcome of this pass."
    );
    expect(task.concluding).toBe("your assessment (update_claim_assessment), or leave_judgment_standing");
    expect(task.nudge.when(new Set(["log_stewardship_decision"]))).toBe(true);
    expect(task.nudge.when(new Set(["leave_judgment_standing"]))).toBe(false);
    expect(task.nudge.when(new Set(["update_claim_assessment"]))).toBe(false);
    // Every other pass is told what it was told.
    expect(defaultTask("The pass note.", "claim", false).text).not.toContain("leave_judgment_standing");
    expect(defaultTask("The pass note.", "claim", true).text).not.toContain("leave_judgment_standing");
    // A revisit of its own judgment may also end by leaving the other standing.
    expect(defaultTask("The pass note.", "claim", false).nudge.when(new Set(["leave_judgment_standing"]))).toBe(false);
  });
});
