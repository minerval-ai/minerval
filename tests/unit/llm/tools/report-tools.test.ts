/**
 * The issue tools (#366): attribution comes from the ambient usage context,
 * the per-run cap holds across raise and update (never on a withdrawal), a
 * near match comes back to the agent with the record's status and note and
 * counts for nothing, and every tool acknowledges no matter what.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  raiseIssue: vi.fn(),
  updateReport: vi.fn(),
  searchReports: vi.fn(),
  getReportView: vi.fn(),
  config: { agentReportsPerRun: 2 },
}));

vi.mock("../../../../src/services/report-service.js", () => ({
  raiseIssue: mocks.raiseIssue,
  updateReport: mocks.updateReport,
  searchReports: mocks.searchReports,
  getReportView: mocks.getReportView,
  REPORT_KINDS: ["system_failure", "tool_gap", "improvement"],
  REPORT_SEVERITIES: ["blocking", "degraded", "annoyance", "idea"],
  REPORT_STATUSES: ["new", "triaged", "duplicate", "actioned", "wontfix", "withdrawn"],
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
const OTHER_ID = "d4d4d4d4-4444-4444-8444-444444444444";

const MATCH = {
  id: OTHER_ID,
  title: "no relation type for counterpart claims",
  kind: "tool_gap",
  severity: "degraded",
  status: "wontfix",
  triage_note: "counterparts are instances; use add_instance",
  agent: "curator",
  occurrence_count: 4,
  first_seen_at: "2026-08-01T00:00:00.000Z",
  last_seen_at: "2026-08-02T00:00:00.000Z",
  github_issue_url: "https://github.com/minerval-ai/minerval/issues/41",
  duplicate_of_id: null,
  similarity: 0.9,
  matched_by: "meaning" as const,
};

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
  mocks.updateReport.mockReset().mockResolvedValue({
    acknowledged: true,
    reportId: REPORT_ID,
    status: "new",
    githubIssueUrl: "https://github.com/minerval-ai/minerval/issues/7",
  });
  mocks.searchReports.mockReset().mockResolvedValue({ matches: [] });
  mocks.getReportView.mockReset().mockResolvedValue(null);
  mocks.config.agentReportsPerRun = 2;
});

describe("raise_issue tool", () => {
  it("defines the four issue tools, raise_issue with the kind and severity vocabularies", () => {
    const tools = getReportToolDefinitions();
    expect(tools.map((t) => t.name)).toEqual([
      "raise_issue",
      "update_issue",
      "search_issues",
      "get_issue",
    ]);
    const [tool] = tools;
    const props = tool!.input_schema.properties as Record<string, { enum?: string[] }>;
    expect(props.kind!.enum).toEqual(["system_failure", "tool_gap", "improvement"]);
    expect(props.severity!.enum).toEqual(["blocking", "degraded", "annoyance", "idea"]);
    expect(props.joins).toBeDefined();
    // No write gate (#432): the agent navigates the record with the read
    // tools and says joins when it has found its predecessor.
    expect(props.distinct_from).toBeUndefined();
    expect(tool!.input_schema.required).toEqual(["kind", "severity", "title", "body"]);
    expect(tools[1]!.input_schema.required).toEqual(["report_id"]);
    // A query is optional: without one, search_issues lists recent reports.
    expect(tools[2]!.input_schema.required).toEqual([]);
    const search = tools[2]!.input_schema.properties as Record<string, { enum?: string[] }>;
    expect(search.status!.enum).toContain("wontfix");
    expect(tools[3]!.input_schema.required).toEqual(["report_id"]);
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

  it("reports a deduplicated repeat with its running count and the record's guidance", async () => {
    mocks.raiseIssue.mockResolvedValue({
      acknowledged: true,
      reportId: REPORT_ID,
      occurrenceCount: 4,
      deduplicated: true,
      existing: {
        status: "wontfix",
        triageNote: "use add_instance",
        githubIssueUrl: "https://github.com/minerval-ai/minerval/issues/41",
        reopened: false,
      },
    });
    const tools = createReportTools();
    const out = JSON.parse((await tools.execute("raise_issue", GOOD_INPUT))!);
    expect(out.status).toBe("joined");
    expect(out.occurrence_count).toBe(4);
    expect(out.report_status).toBe("wontfix");
    expect(out.issue_url).toContain("/issues/41");
    expect(out.message).toMatch(/reported 4 time/);
    expect(out.message).toMatch(/maintainers declined it/);
    expect(out.message).toContain("use add_instance");
  });

  it("tells the agent when it collapsed onto a withdrawn report", async () => {
    mocks.raiseIssue.mockResolvedValue({
      acknowledged: true,
      reportId: REPORT_ID,
      occurrenceCount: 2,
      deduplicated: true,
      existing: { status: "withdrawn", triageNote: "my mistake", githubIssueUrl: null, reopened: false },
    });
    const tools = createReportTools();
    const out = JSON.parse((await tools.execute("raise_issue", GOOD_INPUT))!);
    expect(out.message).toMatch(/withdrawn by its reporter/);
    expect(out.message).toContain("my mistake");
  });

  it("says when a sighting reopened an actioned report", async () => {
    mocks.raiseIssue.mockResolvedValue({
      acknowledged: true,
      reportId: REPORT_ID,
      occurrenceCount: 2,
      deduplicated: true,
      existing: { status: "new", triageNote: null, githubIssueUrl: null, reopened: true },
    });
    const tools = createReportTools();
    const out = JSON.parse((await tools.execute("raise_issue", GOOD_INPUT))!);
    expect(out.status).toBe("reopened");
    expect(out.message).toMatch(/regression/);
  });

  it("records, and hands back related reports with their status and note as advice", async () => {
    mocks.raiseIssue.mockResolvedValue({
      acknowledged: true,
      reportId: REPORT_ID,
      occurrenceCount: 1,
      deduplicated: false,
      related: [MATCH],
    });
    const tools = createReportTools();
    const out = JSON.parse((await tools.execute("raise_issue", GOOD_INPUT))!);
    expect(out.success).toBe(true);
    expect(out.status).toBe("recorded");
    expect(out.report_id).toBe(REPORT_ID);
    expect(out.related).toEqual([MATCH]);
    expect(out.message).toContain("1 report(s) on record read like yours");
    expect(out.message).toContain(OTHER_ID);
    expect(out.message).toContain("status wontfix");
    expect(out.message).toContain("Maintainers' note");
    expect(out.message).toMatch(/withdraw this one with update_issue and raise again with joins/);
    expect(tools.raisedCount).toBe(1);
  });

  it("passes joins through and never a distinct_from", async () => {
    const tools = createReportTools();
    await tools.execute("raise_issue", { ...GOOD_INPUT, joins: OTHER_ID });
    expect(mocks.raiseIssue).toHaveBeenLastCalledWith(
      expect.objectContaining({ joins: OTHER_ID })
    );
    await tools.execute("raise_issue", { ...GOOD_INPUT, distinct_from: [OTHER_ID] });
    const last = mocks.raiseIssue.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(last.joins).toBeNull();
    expect("distinctFrom" in last).toBe(false);
  });
});

describe("update_issue tool", () => {
  it("amends with attribution, counts against the cap, and points at the issue", async () => {
    const tools = createReportTools({ model: "claude-x" });
    const out = JSON.parse(
      (await runWithUsageContext(
        { agent: "steward", runId: RUN_ID, jobId: null, claimId: CLAIM_ID },
        () =>
          tools.execute("update_issue", {
            report_id: REPORT_ID,
            severity: "blocking",
            note: "the cause is the missing enum value",
          })
      ))!
    );
    expect(out).toMatchObject({ success: true, status: "updated", report_id: REPORT_ID });
    expect(out.issue_url).toContain("/issues/7");
    expect(mocks.updateReport).toHaveBeenCalledWith(REPORT_ID, {
      severity: "blocking",
      note: "the cause is the missing enum value",
      withdraw: false,
      agent: "steward",
      model: "claude-x",
      runId: RUN_ID,
      jobId: null,
      claimId: CLAIM_ID,
    });
    expect(tools.raisedCount).toBe(1);
  });

  it("withdraws past the cap: a correction is never blocked", async () => {
    mocks.config.agentReportsPerRun = 1;
    const tools = createReportTools();
    await tools.execute("raise_issue", GOOD_INPUT);
    const blocked = JSON.parse(
      (await tools.execute("update_issue", { report_id: REPORT_ID, note: "more" }))!
    );
    expect(blocked.success).toBe(false);
    expect(blocked.message).toMatch(/per-run cap/);
    expect(mocks.updateReport).not.toHaveBeenCalled();

    mocks.updateReport.mockResolvedValue({
      acknowledged: true,
      reportId: REPORT_ID,
      status: "withdrawn",
      githubIssueUrl: null,
    });
    const out = JSON.parse(
      (await tools.execute("update_issue", {
        report_id: REPORT_ID,
        withdraw: true,
        note: "my mistake",
      }))!
    );
    expect(out).toMatchObject({ success: true, status: "withdrawn", report_status: "withdrawn" });
    expect(mocks.updateReport).toHaveBeenCalledWith(
      REPORT_ID,
      expect.objectContaining({ withdraw: true, note: "my mistake" })
    );
    expect(tools.raisedCount).toBe(1);
  });

  it("withholds a note's text inside an untraced context (#356)", async () => {
    const tools = createReportTools();
    await untraced(() =>
      runWithUsageContext({ agent: "extension" }, () =>
        tools.execute("update_issue", { report_id: REPORT_ID, note: "quoted page text" })
      )
    );
    expect(mocks.updateReport).toHaveBeenCalledWith(
      REPORT_ID,
      expect.objectContaining({ note: UNTRACED_BODY_NOTE })
    );
  });

  it("acknowledges a refused update without counting it", async () => {
    mocks.updateReport.mockResolvedValue({
      acknowledged: true,
      reportId: null,
      status: null,
      githubIssueUrl: null,
      problem: "no report on record with id x",
    });
    const tools = createReportTools();
    const out = JSON.parse((await tools.execute("update_issue", { report_id: "x", note: "n" }))!);
    expect(out).toMatchObject({ success: false, acknowledged: true, status: "not_updated" });
    expect(out.message).toContain("no report on record");
    expect(tools.raisedCount).toBe(0);
  });
});

describe("search_issues tool", () => {
  it("searches internal reports, narrowed by surface and status, and describes the matches", async () => {
    mocks.searchReports.mockResolvedValue({ matches: [MATCH] });
    const tools = createReportTools();
    const out = JSON.parse(
      (await tools.execute("search_issues", {
        query: "linking counterpart claims",
        surface: "add_relationship_edge",
        status: "wontfix",
      }))!
    );
    expect(mocks.searchReports).toHaveBeenCalledWith("linking counterpart claims", {
      origin: "internal",
      surface: "add_relationship_edge",
      status: "wontfix",
    });
    expect(out.success).toBe(true);
    expect(out.matches).toEqual([MATCH]);
    expect(out.message).toContain("1 report(s) on record");
    expect(out.message).toContain("use add_instance");
    expect(out.message).toContain("get_issue");
    expect(tools.raisedCount).toBe(0);
  });

  it("lists recent reports when there is no query, and names duplicates' parents", async () => {
    mocks.searchReports.mockResolvedValue({
      matches: [{ ...MATCH, status: "duplicate", duplicate_of_id: REPORT_ID, matched_by: "recent" }],
    });
    const tools = createReportTools();
    const out = JSON.parse((await tools.execute("search_issues", { surface: "add_instance" }))!);
    expect(mocks.searchReports).toHaveBeenCalledWith(null, {
      origin: "internal",
      surface: "add_instance",
      status: null,
    });
    expect(out.message).toContain(`duplicate of ${REPORT_ID}`);
  });

  it("says when nothing matches and when the search is unavailable", async () => {
    const tools = createReportTools();
    const none = JSON.parse((await tools.execute("search_issues", { query: "q" }))!);
    expect(none.matches).toEqual([]);
    expect(none.message).toMatch(/No report on record matches/);
    expect(none.message).toMatch(/Try other words/);

    mocks.searchReports.mockResolvedValue({ matches: [], problem: "the search is unavailable right now" });
    const down = JSON.parse((await tools.execute("search_issues", { query: "q" }))!);
    expect(down.success).toBe(false);
    expect(down.message).toMatch(/unavailable/);
  });
});

describe("get_issue tool", () => {
  it("reads one internal report in full with its sightings, duplicates, and parent", async () => {
    mocks.getReportView.mockResolvedValue({
      report: {
        id: REPORT_ID,
        title: "add_relationship_edge has no relation type for counterparts",
        body: "Tried to link two claims that are counterparts.",
        kind: "tool_gap",
        severity: "degraded",
        status: "duplicate",
        surface: "add_relationship_edge",
        agent: "steward",
        model: "claude-x",
        context_refs: { claim_id: CLAIM_ID },
        triage_note: "same gap as the counterpart report",
        triaged_by: "audit:1",
        duplicate_of_id: OTHER_ID,
        github_issue_url: "https://github.com/minerval-ai/minerval/issues/7",
        occurrence_count: 2,
        first_seen_at: new Date("2026-08-01T00:00:00Z"),
        last_seen_at: new Date("2026-08-02T00:00:00Z"),
      },
      sightings: [
        {
          kind: "sighting",
          agent: "curator",
          body: "met again on a different claim",
          context_refs: {},
          seen_at: new Date("2026-08-02T00:00:00Z"),
        },
      ],
      duplicates: [],
      duplicate_of: {
        id: OTHER_ID,
        title: "no relation type for counterpart claims",
        status: "wontfix",
        triage_note: "counterparts are instances; use add_instance",
        github_issue_url: "https://github.com/minerval-ai/minerval/issues/41",
      },
    });
    const tools = createReportTools();
    const out = JSON.parse((await tools.execute("get_issue", { report_id: REPORT_ID }))!);
    expect(mocks.getReportView).toHaveBeenCalledWith(REPORT_ID, { origin: "internal" });
    expect(out.success).toBe(true);
    expect(out.report).toMatchObject({
      id: REPORT_ID,
      status: "duplicate",
      duplicate_of_id: OTHER_ID,
      triage_note: "same gap as the counterpart report",
      first_seen_at: "2026-08-01T00:00:00.000Z",
    });
    expect(out.sightings).toEqual([
      {
        kind: "sighting",
        agent: "curator",
        body: "met again on a different claim",
        context_refs: {},
        seen_at: "2026-08-02T00:00:00.000Z",
      },
    ]);
    expect(out.duplicate_of).toMatchObject({ id: OTHER_ID, status: "wontfix" });
    expect(tools.raisedCount).toBe(0);
  });

  it("says when there is no such report", async () => {
    const tools = createReportTools();
    const out = JSON.parse((await tools.execute("get_issue", { report_id: "nope" }))!);
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/No report on record/);
  });
});
