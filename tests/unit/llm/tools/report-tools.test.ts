/**
 * raise_issue (#366): attribution comes from the ambient usage context, the
 * per-run cap holds, and the tool acknowledges no matter what.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  raiseIssue: vi.fn(),
  config: { agentReportsPerRun: 2 },
}));

vi.mock("../../../../src/services/report-service.js", () => ({
  raiseIssue: mocks.raiseIssue,
  REPORT_KINDS: ["system_failure", "tool_gap", "improvement"],
  REPORT_SEVERITIES: ["blocking", "degraded", "annoyance", "idea"],
}));
vi.mock("../../../../src/config.js", () => ({
  loadConfig: () => mocks.config,
}));

import {
  createReportTools,
  getReportToolDefinitions,
  UNTRACED_BODY_NOTE,
} from "../../../../src/llm/tools/report-tools.js";
import {
  runWithUsageContext,
  untraced,
} from "../../../../src/llm/usage-context.js";

const REPORT_ID = "a1a1a1a1-1111-4111-8111-111111111111";
const RUN_ID = "c3c3c3c3-3333-4333-8333-333333333333";
const CLAIM_ID = "b2b2b2b2-2222-4222-8222-222222222222";

const GOOD_INPUT = {
  kind: "tool_gap",
  severity: "degraded",
  title: "add_relationship_edge has no relation type for counterparts",
  body: "Needed to record two claims as counterparts under different framings.",
  surface: "add_relationship_edge",
  context_refs: { claim_id: CLAIM_ID },
};

beforeEach(() => {
  mocks.raiseIssue.mockReset().mockResolvedValue({
    acknowledged: true,
    reportId: REPORT_ID,
    occurrenceCount: 1,
    deduplicated: false,
  });
  mocks.config.agentReportsPerRun = 2;
});

describe("raise_issue tool", () => {
  it("defines one tool with the kind and severity vocabularies", () => {
    const [tool] = getReportToolDefinitions();
    expect(tool!.name).toBe("raise_issue");
    const props = tool!.input_schema.properties as Record<string, { enum?: string[] }>;
    expect(props.kind!.enum).toEqual(["system_failure", "tool_gap", "improvement"]);
    expect(props.severity!.enum).toEqual(["blocking", "degraded", "annoyance", "idea"]);
    expect(tool!.input_schema.required).toEqual(["kind", "severity", "title", "body"]);
  });

  it("returns null for tools it does not own", async () => {
    const tools = createReportTools();
    expect(await tools.execute("add_relationship_edge", {})).toBeNull();
    expect(mocks.raiseIssue).not.toHaveBeenCalled();
  });

  it("records with attribution from the ambient usage context and tells the agent to proceed", async () => {
    const tools = createReportTools({ model: "claude-x" });
    const out = await runWithUsageContext(
      { agent: "steward", runId: RUN_ID, jobId: null, claimId: CLAIM_ID },
      () => tools.execute("raise_issue", GOOD_INPUT)
    );
    const parsed = JSON.parse(out!);
    expect(parsed.success).toBe(true);
    expect(parsed.report_id).toBe(REPORT_ID);
    expect(parsed.message).toMatch(/not a substitute for acting/);
    expect(mocks.raiseIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tool_gap",
        severity: "degraded",
        surface: "add_relationship_edge",
        contextRefs: { claim_id: CLAIM_ID },
        origin: "internal",
        agent: "steward",
        model: "claude-x",
        runId: RUN_ID,
        jobId: null,
        claimId: CLAIM_ID,
      })
    );
    expect(tools.raisedCount).toBe(1);
  });

  it("withholds the body inside an untraced context (#356) but keeps the rest", async () => {
    const tools = createReportTools();
    const out = await untraced(() =>
      runWithUsageContext({ agent: "extension" }, () =>
        tools.execute("raise_issue", GOOD_INPUT)
      )
    );
    expect(JSON.parse(out!).success).toBe(true);
    expect(mocks.raiseIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "extension",
        title: GOOD_INPUT.title,
        surface: GOOD_INPUT.surface,
        contextRefs: GOOD_INPUT.context_refs,
        body: UNTRACED_BODY_NOTE,
        runId: null,
      })
    );
    expect(mocks.raiseIssue.mock.calls[0]![0].body).not.toContain("counterparts under");
  });

  it("falls back to 'unknown' as the agent outside any usage context", async () => {
    const tools = createReportTools();
    await tools.execute("raise_issue", GOOD_INPUT);
    expect(mocks.raiseIssue).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "unknown", runId: null })
    );
  });

  it("enforces the per-run cap without writing past it", async () => {
    const tools = createReportTools();
    expect(JSON.parse((await tools.execute("raise_issue", GOOD_INPUT))!).success).toBe(true);
    expect(JSON.parse((await tools.execute("raise_issue", GOOD_INPUT))!).success).toBe(true);
    const third = JSON.parse((await tools.execute("raise_issue", GOOD_INPUT))!);
    expect(third.success).toBe(false);
    expect(third.acknowledged).toBe(true);
    expect(third.message).toMatch(/per-run cap \(2\)/);
    expect(mocks.raiseIssue).toHaveBeenCalledTimes(2);
    expect(tools.raisedCount).toBe(2);
  });

  it("a rejected (unpersisted) report does not count against the cap", async () => {
    mocks.raiseIssue.mockResolvedValue({
      acknowledged: true,
      reportId: null,
      occurrenceCount: null,
      deduplicated: false,
      problem: "kind must be one of system_failure, tool_gap, improvement",
    });
    const tools = createReportTools();
    const out = JSON.parse(
      (await tools.execute("raise_issue", { ...GOOD_INPUT, kind: "gripe" }))!
    );
    expect(out.success).toBe(false);
    expect(out.acknowledged).toBe(true);
    expect(out.message).toContain("kind must be one of");
    expect(tools.raisedCount).toBe(0);
  });

  it("acknowledges even if the service throws", async () => {
    mocks.raiseIssue.mockRejectedValue(new Error("boom"));
    const tools = createReportTools();
    const out = JSON.parse((await tools.execute("raise_issue", GOOD_INPUT))!);
    expect(out).toMatchObject({ success: false, acknowledged: true });
    expect(out.message).toContain("boom");
  });

  it("reports a deduplicated repeat with its running count", async () => {
    mocks.raiseIssue.mockResolvedValue({
      acknowledged: true,
      reportId: REPORT_ID,
      occurrenceCount: 4,
      deduplicated: true,
    });
    const tools = createReportTools();
    const out = JSON.parse((await tools.execute("raise_issue", GOOD_INPUT))!);
    expect(out.occurrence_count).toBe(4);
    expect(out.message).toMatch(/reported 4 time/);
  });
});
