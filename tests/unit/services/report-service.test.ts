/**
 * Agent reports (#366): the write never throws, verbatim repeats collapse on
 * the dedupe key, paraphrases are matched before written and the agent
 * answers with joins or distinct_from, sightings carry the account and
 * reopen an actioned report, update_issue is the reporter's own edit path,
 * content is capped and refs are ids only, external callers are
 * rate-limited, and every write hands off to GitHub without waiting on it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []),
  generateEmbedding: vi.fn(async (_text: string): Promise<number[]> => [0.1, 0.2, 0.3]),
  fileIssueForReport: vi.fn(async () => null),
  syncSightingToIssue: vi.fn(async () => undefined),
  syncTriageToIssue: vi.fn(async () => undefined),
  config: { reportRateLimitPerHour: 2, reportMatchSimilarity: 0.8 },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: mocks.rawQuery,
}));
vi.mock("../../../src/services/embedding-service.js", () => ({
  generateEmbedding: mocks.generateEmbedding,
}));
vi.mock("../../../src/services/github-issue-service.js", () => ({
  fileIssueForReport: mocks.fileIssueForReport,
  syncSightingToIssue: mocks.syncSightingToIssue,
  syncTriageToIssue: mocks.syncTriageToIssue,
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => mocks.config,
}));

import {
  checkReportRateLimit,
  computeDedupeKey,
  formatAgentReport,
  listReportsAwaitingIssue,
  raiseIssue,
  resetReportRateLimiter,
  searchReports,
  triageAgentReport,
  updateReport,
  REPORT_BODY_MAX_CHARS,
  type AgentReportRow,
} from "../../../src/services/report-service.js";

const REPORT_ID = "a1a1a1a1-1111-4111-8111-111111111111";
const CLAIM_ID = "b2b2b2b2-2222-4222-8222-222222222222";
const OTHER_ID = "c3c3c3c3-3333-4333-8333-333333333333";

const ROW: AgentReportRow = {
  id: REPORT_ID,
  kind: "tool_gap",
  severity: "degraded",
  title: "add_relationship_edge has no relation type for counterparts",
  body: "body",
  surface: "add_relationship_edge",
  origin: "internal",
  agent: "steward",
  model: null,
  reporter_contributor_id: null,
  context_refs: {},
  run_id: null,
  job_id: null,
  claim_id: null,
  status: "new",
  triage_note: null,
  triaged_by: null,
  triaged_at: null,
  duplicate_of_id: null,
  github_issue_number: 41,
  github_issue_url: "https://github.com/minerval-ai/minerval/issues/41",
  github_synced_at: null,
  occurrence_count: 1,
  first_seen_at: new Date("2026-08-01T00:00:00Z"),
  last_seen_at: new Date("2026-08-02T00:00:00Z"),
};

const GOOD = {
  kind: "tool_gap",
  severity: "degraded",
  title: "add_relationship_edge has no relation type for counterparts",
  body: "Tried to link two claims that are counterparts under different framings.",
  surface: "add_relationship_edge",
  agent: "steward",
};

function calls(fragment: string): Array<[string, unknown[]]> {
  return mocks.rawQuery.mock.calls
    .filter(([sql]) => String(sql).includes(fragment))
    .map(([sql, params]) => [String(sql), (params ?? []) as unknown[]]);
}

/**
 * Route each SQL the service issues to a canned answer, keyed on the
 * statement's shape: the exact-key lookup, the match search, the insert,
 * the sighting update, and the sighting/note inserts.
 */
function route(opts: {
  existingId?: string | null;
  matches?: unknown[];
  inserted?: (AgentReportRow & { inserted: boolean }) | null;
  sighted?: (AgentReportRow & { previous_status: string }) | null;
  updated?: AgentReportRow | null;
}) {
  mocks.rawQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("WHERE dedupe_key = $1")) {
      return opts.existingId ? [{ id: opts.existingId }] : [];
    }
    if (sql.includes("<=>")) return opts.matches ?? [];
    if (sql.includes("INSERT INTO agent_reports")) {
      return opts.inserted === null ? [] : [opts.inserted ?? { ...ROW, inserted: true }];
    }
    if (sql.includes("occurrence_count = r.occurrence_count + 1")) {
      return opts.sighted === null
        ? []
        : [opts.sighted ?? { ...ROW, occurrence_count: 2, previous_status: "new" }];
    }
    if (sql.includes("INSERT INTO agent_report_sightings")) return [];
    if (sql.includes("SET severity = COALESCE")) {
      return opts.updated === null ? [] : [opts.updated ?? ROW];
    }
    return [];
  });
}

/** Let the fire-and-forget follow-ups run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mocks.rawQuery.mockReset();
  route({});
  mocks.generateEmbedding.mockReset().mockResolvedValue([0.1, 0.2, 0.3]);
  mocks.fileIssueForReport.mockReset().mockResolvedValue(null);
  mocks.syncSightingToIssue.mockReset().mockResolvedValue(undefined);
  mocks.syncTriageToIssue.mockReset().mockResolvedValue(undefined);
  mocks.config.reportRateLimitPerHour = 2;
  mocks.config.reportMatchSimilarity = 0.8;
  resetReportRateLimiter();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("computeDedupeKey", () => {
  it("is stable across case, punctuation, and whitespace in the title", () => {
    const base = {
      origin: "internal",
      agent: "steward",
      kind: "tool_gap",
      surface: "add_relationship_edge",
    };
    const a = computeDedupeKey({
      ...base,
      title: "add_relationship_edge has no relation type for counterparts",
    });
    const b = computeDedupeKey({
      ...base,
      title: "  Add_Relationship_Edge has no relation-type for counterparts! ",
    });
    expect(a).toBe(b);
  });

  it("separates the same title across agents, kinds, surfaces, and origins", () => {
    const base = {
      origin: "internal",
      agent: "steward",
      kind: "tool_gap",
      surface: null,
      title: "the same words",
    };
    const key = computeDedupeKey(base);
    expect(computeDedupeKey({ ...base, agent: "curator" })).not.toBe(key);
    expect(computeDedupeKey({ ...base, kind: "improvement" })).not.toBe(key);
    expect(computeDedupeKey({ ...base, surface: "x" })).not.toBe(key);
    expect(computeDedupeKey({ ...base, origin: "external" })).not.toBe(key);
  });
});

describe("raiseIssue: a new report", () => {
  it("checks the exact key, embeds, searches, inserts with the embedding, and files the issue", async () => {
    const result = await raiseIssue({
      ...GOOD,
      contextRefs: { claim_id: CLAIM_ID, nested: { dropped: true }, n: 3 },
      model: "claude-x",
      runId: null,
      jobId: "not-a-uuid",
      claimId: CLAIM_ID,
    });
    await settle();

    expect(result).toEqual({
      acknowledged: true,
      reportId: REPORT_ID,
      occurrenceCount: 1,
      deduplicated: false,
    });
    // Cost order: key lookup, embedding, match search, insert.
    expect(calls("WHERE dedupe_key = $1")).toHaveLength(1);
    expect(mocks.generateEmbedding).toHaveBeenCalledWith(
      expect.stringContaining(GOOD.title)
    );
    const [searchSql, searchParams] = calls("<=>")[0]!;
    expect(searchSql).toContain("origin = $3");
    expect(searchSql).toContain("status <> 'withdrawn'");
    expect(searchParams[1]).toBe(0.8);
    expect(searchParams[2]).toBe("internal");

    const [sql, params] = calls("INSERT INTO agent_reports")[0]!;
    expect(sql).toContain("ON CONFLICT (dedupe_key) DO UPDATE");
    expect(params[0]).toBe("tool_gap");
    expect(params[1]).toBe("degraded");
    expect(params[4]).toBe("add_relationship_edge");
    expect(params[5]).toBe("internal");
    expect(params[6]).toBe("steward");
    expect(params[7]).toBe("claude-x");
    // Refs are ids only: nested payload dropped, scalars kept.
    expect(JSON.parse(String(params[9]))).toEqual({ claim_id: CLAIM_ID, n: 3 });
    // Malformed attribution is nulled, never an error.
    expect(params[11]).toBeNull();
    expect(params[12]).toBe(CLAIM_ID);
    expect(typeof params[13]).toBe("string");
    expect(params[14]).toBe("[0.1,0.2,0.3]");

    // Filed on first sighting, off the caller's path.
    expect(mocks.fileIssueForReport).toHaveBeenCalledWith(
      expect.objectContaining({ id: REPORT_ID })
    );
    expect(mocks.fileIssueForReport.mock.calls[0]![0]).not.toHaveProperty("inserted");
  });

  it("caps the body and title at write time", async () => {
    await raiseIssue({
      kind: "improvement",
      severity: "idea",
      title: "t".repeat(1000),
      body: "b".repeat(REPORT_BODY_MAX_CHARS + 500),
      agent: "curator",
    });
    const [, params] = calls("INSERT INTO agent_reports")[0]!;
    expect(String(params[2]).length).toBe(200);
    expect(String(params[3]).length).toBe(REPORT_BODY_MAX_CHARS);
  });

  it("records without a match search when embedding fails, and still files", async () => {
    mocks.generateEmbedding.mockRejectedValue(new Error("embeddings down"));
    const result = await raiseIssue(GOOD);
    await settle();
    expect(result.reportId).toBe(REPORT_ID);
    expect(calls("<=>")).toHaveLength(0);
    const [, params] = calls("INSERT INTO agent_reports")[0]!;
    expect(params[14]).toBeNull();
    expect(mocks.fileIssueForReport).toHaveBeenCalledTimes(1);
  });

  it("does not file when the upsert lost a race and collapsed", async () => {
    route({ inserted: { ...ROW, occurrence_count: 2, inserted: false } });
    const result = await raiseIssue(GOOD);
    await settle();
    expect(result.deduplicated).toBe(true);
    expect(result.occurrenceCount).toBe(2);
    expect(mocks.fileIssueForReport).not.toHaveBeenCalled();
  });

  it("acknowledges an invalid kind without writing, naming the legal values", async () => {
    const result = await raiseIssue({
      kind: "complaint",
      severity: "blocking",
      title: "x",
      agent: "steward",
    });
    expect(result.acknowledged).toBe(true);
    expect(result.reportId).toBeNull();
    expect(result.problem).toContain("system_failure, tool_gap, improvement");
    expect(mocks.rawQuery).not.toHaveBeenCalled();
  });

  it("never throws when the database does", async () => {
    mocks.rawQuery.mockRejectedValue(new Error("connection refused"));
    const result = await raiseIssue({
      kind: "system_failure",
      severity: "blocking",
      title: "x",
      agent: "steward",
    });
    expect(result).toMatchObject({
      acknowledged: true,
      reportId: null,
      deduplicated: false,
    });
    expect(result.problem).toBeDefined();
  });

  it("never throws when the GitHub filing rejects", async () => {
    mocks.fileIssueForReport.mockRejectedValue(new Error("github down"));
    const result = await raiseIssue(GOOD);
    await settle();
    expect(result.reportId).toBe(REPORT_ID);
  });
});

describe("raiseIssue: matched before written", () => {
  const MATCH = {
    ...ROW,
    id: OTHER_ID,
    status: "wontfix",
    triage_note: "counterparts are recorded as instances; use add_instance",
    similarity: 0.91,
  };

  it("returns the near matches with status, note, and issue url, and writes nothing", async () => {
    route({ matches: [MATCH] });
    const result = await raiseIssue({ ...GOOD, title: "no way to link counterpart claims" });
    expect(result.reportId).toBeNull();
    expect(result.matches).toHaveLength(1);
    expect(result.matches![0]).toMatchObject({
      id: OTHER_ID,
      status: "wontfix",
      triage_note: "counterparts are recorded as instances; use add_instance",
      github_issue_url: ROW.github_issue_url,
      similarity: 0.91,
    });
    expect(calls("INSERT INTO agent_reports")).toHaveLength(0);
    expect(mocks.fileIssueForReport).not.toHaveBeenCalled();
  });

  it("excludes distinct_from ids from the search and then writes", async () => {
    route({ matches: [] });
    const result = await raiseIssue({
      ...GOOD,
      title: "no way to link counterpart claims",
      distinctFrom: [OTHER_ID, "junk"],
    });
    const [, params] = calls("<=>")[0]!;
    expect(params[3]).toEqual([OTHER_ID]);
    expect(result.reportId).toBe(REPORT_ID);
  });

  it("scopes the search to the report's origin", async () => {
    await raiseIssue({ ...GOOD, origin: "external", agent: "mcp" });
    const [, params] = calls("<=>")[0]!;
    expect(params[2]).toBe("external");
  });
});

describe("raiseIssue: sightings", () => {
  it("collapses a verbatim repeat as a sighting without embedding, carrying the record's status", async () => {
    route({
      existingId: OTHER_ID,
      sighted: {
        ...ROW,
        id: OTHER_ID,
        status: "wontfix",
        triage_note: "by design",
        occurrence_count: 7,
        previous_status: "wontfix",
      },
    });
    const result = await raiseIssue({ ...GOOD, runId: CLAIM_ID });
    await settle();
    expect(result).toMatchObject({
      reportId: OTHER_ID,
      occurrenceCount: 7,
      deduplicated: true,
      existing: {
        status: "wontfix",
        triageNote: "by design",
        githubIssueUrl: ROW.github_issue_url,
        reopened: false,
      },
    });
    expect(mocks.generateEmbedding).not.toHaveBeenCalled();
    const [updateSql, updateParams] = calls("occurrence_count = r.occurrence_count + 1")[0]!;
    expect(updateSql).toContain("WHEN r.status = 'actioned' THEN 'new'");
    expect(updateSql).toContain("AND origin = $8");
    expect(updateParams[0]).toBe(OTHER_ID);
    expect(updateParams[1]).toBe(GOOD.body);
    expect(updateParams[7]).toBe("internal");
    const [, sightingParams] = calls("INSERT INTO agent_report_sightings")[0]!;
    expect(sightingParams[0]).toBe(OTHER_ID);
    expect(sightingParams[1]).toBe(GOOD.body);
    expect(sightingParams[3]).toBe("steward");
    expect(sightingParams[5]).toBe(CLAIM_ID);
    expect(mocks.syncSightingToIssue).toHaveBeenCalledWith(
      expect.objectContaining({ id: OTHER_ID }),
      expect.objectContaining({ reopened: false, explicit: true, agent: "steward" })
    );
    expect(mocks.syncSightingToIssue.mock.calls[0]![0]).not.toHaveProperty("previous_status");
    expect(mocks.fileIssueForReport).not.toHaveBeenCalled();
  });

  it("joins a report the agent was shown, as a sighting", async () => {
    route({ sighted: { ...ROW, id: OTHER_ID, occurrence_count: 3, previous_status: "triaged", status: "triaged" } });
    const result = await raiseIssue({ ...GOOD, joins: OTHER_ID });
    await settle();
    expect(result.deduplicated).toBe(true);
    expect(result.reportId).toBe(OTHER_ID);
    expect(result.occurrenceCount).toBe(3);
    expect(calls("WHERE dedupe_key = $1")).toHaveLength(0);
    expect(mocks.generateEmbedding).not.toHaveBeenCalled();
  });

  it("refuses a joins that names no report, and scopes joins to the caller's origin", async () => {
    route({ sighted: null });
    const result = await raiseIssue({ ...GOOD, joins: OTHER_ID });
    expect(result.reportId).toBeNull();
    expect(result.problem).toMatch(/joins names no report/);

    mocks.rawQuery.mockClear();
    await raiseIssue({ ...GOOD, origin: "external", agent: "mcp", joins: OTHER_ID });
    const [, params] = calls("occurrence_count = r.occurrence_count + 1")[0]!;
    expect(params[7]).toBe("external");
    expect(mocks.generateEmbedding).not.toHaveBeenCalled();
  });

  it("reports a sighting of an actioned report as reopened", async () => {
    route({
      existingId: OTHER_ID,
      sighted: { ...ROW, id: OTHER_ID, status: "new", occurrence_count: 4, previous_status: "actioned" },
    });
    const result = await raiseIssue(GOOD);
    await settle();
    expect(result.existing).toMatchObject({ status: "new", reopened: true });
    expect(mocks.syncSightingToIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reopened: true })
    );
  });
});

describe("updateReport", () => {
  it("re-rates severity and records a note as a non-sighting, syncing both", async () => {
    route({ updated: { ...ROW, severity: "blocking" } });
    const result = await updateReport(REPORT_ID, {
      severity: "blocking",
      note: "the cause is the relation enum missing 'counterpart'",
      agent: "steward",
      runId: CLAIM_ID,
    });
    await settle();
    expect(result).toEqual({
      acknowledged: true,
      reportId: REPORT_ID,
      status: "new",
      githubIssueUrl: ROW.github_issue_url,
    });
    const [updateSql, updateParams] = calls("SET severity = COALESCE")[0]!;
    expect(updateSql).toContain("AND origin = $6");
    expect(updateParams).toEqual([
      REPORT_ID,
      "blocking",
      false,
      "the cause is the relation enum missing 'counterpart'",
      "agent:steward",
      "internal",
    ]);
    const [sightingSql, sightingParams] = calls("INSERT INTO agent_report_sightings")[0]!;
    expect(sightingSql).toContain("'note'");
    expect(sightingParams[1]).toBe("the cause is the relation enum missing 'counterpart'");
    expect(mocks.syncSightingToIssue).toHaveBeenCalledWith(
      expect.objectContaining({ id: REPORT_ID }),
      expect.objectContaining({ note: true, explicit: true, severityChanged: true })
    );
    expect(mocks.syncTriageToIssue).not.toHaveBeenCalled();
  });

  it("withdraws as the reporter's own reversal and closes the issue", async () => {
    route({ updated: { ...ROW, status: "withdrawn" } });
    const result = await updateReport(REPORT_ID, {
      withdraw: true,
      note: "my mistake: the tool works with the right relation type",
      agent: "steward",
    });
    await settle();
    expect(result.status).toBe("withdrawn");
    const [, params] = calls("SET severity = COALESCE")[0]!;
    expect(params[2]).toBe(true);
    expect(params[4]).toBe("agent:steward");
    expect(mocks.syncTriageToIssue).toHaveBeenCalledWith(
      expect.objectContaining({ status: "withdrawn" })
    );
    expect(mocks.syncSightingToIssue).not.toHaveBeenCalled();
  });

  it("rejects an empty update, a bad severity, and a bad id without writing", async () => {
    expect((await updateReport(REPORT_ID, { agent: "steward" })).problem).toMatch(/nothing to update/);
    expect(
      (await updateReport(REPORT_ID, { severity: "huge", agent: "steward" })).problem
    ).toMatch(/severity must be one of/);
    expect((await updateReport("nope", { withdraw: true, agent: "steward" })).problem).toMatch(
      /report_id/
    );
    expect(mocks.rawQuery).not.toHaveBeenCalled();
  });

  it("names an unknown report and never throws on a DB failure", async () => {
    route({ updated: null });
    expect((await updateReport(REPORT_ID, { withdraw: true, agent: "steward" })).problem).toMatch(
      /no report on record/
    );
    mocks.rawQuery.mockRejectedValue(new Error("down"));
    const result = await updateReport(REPORT_ID, { withdraw: true, agent: "steward" });
    expect(result.acknowledged).toBe(true);
    expect(result.reportId).toBeNull();
  });
});

describe("searchReports", () => {
  it("embeds the query and searches with a lower bar, scoped by origin and surface", async () => {
    route({ matches: [{ ...ROW, similarity: 0.7 }] });
    const result = await searchReports("linking counterparts", {
      origin: "internal",
      surface: "add_relationship_edge",
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.similarity).toBe(0.7);
    const [sql, params] = calls("<=>")[0]!;
    expect(params[1]).toBeCloseTo(0.6);
    expect(params[2]).toBe("internal");
    expect(sql).toContain("AND surface = $5");
    expect(params[4]).toBe("add_relationship_edge");
  });

  it("answers an empty query and an embedding failure without throwing", async () => {
    expect((await searchReports("   ")).problem).toBe("query is required");
    mocks.generateEmbedding.mockRejectedValue(new Error("down"));
    const result = await searchReports("anything");
    expect(result.matches).toEqual([]);
    expect(result.problem).toMatch(/unavailable/);
  });
});

describe("checkReportRateLimit", () => {
  it("caps reports per contributor per hour; 0 disables", () => {
    expect(checkReportRateLimit("c-1").limited).toBe(false);
    expect(checkReportRateLimit("c-1").limited).toBe(false);
    expect(checkReportRateLimit("c-1")).toEqual({ limited: true, limitPerHour: 2 });
    // Another contributor has their own window.
    expect(checkReportRateLimit("c-2").limited).toBe(false);

    mocks.config.reportRateLimitPerHour = 0;
    expect(checkReportRateLimit("c-1").limited).toBe(false);
  });
});

describe("triageAgentReport", () => {
  it("requires a target for duplicate and forbids self-duplication", async () => {
    await expect(
      triageAgentReport(REPORT_ID, { status: "duplicate", triagedBy: "t" })
    ).rejects.toThrow(/must name/);
    await expect(
      triageAgentReport(REPORT_ID, {
        status: "duplicate",
        duplicateOfId: REPORT_ID,
        triagedBy: "t",
      })
    ).rejects.toThrow(/itself/);
    expect(mocks.rawQuery).not.toHaveBeenCalled();
  });

  it("updates status, note, and triager; returns null for an unknown id", async () => {
    mocks.rawQuery.mockResolvedValue([]);
    const missing = await triageAgentReport(REPORT_ID, {
      status: "wontfix",
      triageNote: "  not a defect ",
      triagedBy: "audit:run-1",
    });
    expect(missing).toBeNull();
    const [sql, params] = mocks.rawQuery.mock.calls[0]!;
    expect(String(sql)).toContain("UPDATE agent_reports");
    expect(params).toEqual([REPORT_ID, "wontfix", "not a defect", null, "audit:run-1"]);
    expect(mocks.syncTriageToIssue).not.toHaveBeenCalled();
  });

  it("carries the decision to the issue", async () => {
    mocks.rawQuery.mockResolvedValue([{ ...ROW, status: "wontfix" }]);
    const row = await triageAgentReport(REPORT_ID, {
      status: "wontfix",
      triageNote: "by design",
      triagedBy: "audit:run-1",
    });
    await settle();
    expect(row?.status).toBe("wontfix");
    expect(mocks.syncTriageToIssue).toHaveBeenCalledWith(
      expect.objectContaining({ id: REPORT_ID, status: "wontfix" })
    );
  });
});

describe("listReportsAwaitingIssue", () => {
  it("asks for open reports with no issue, internal only unless told otherwise", async () => {
    await listReportsAwaitingIssue(20, { includeExternal: false });
    const [sql, params] = mocks.rawQuery.mock.calls[0]!;
    expect(String(sql)).toContain("github_issue_number IS NULL");
    expect(String(sql)).toContain("status <> 'withdrawn'");
    expect(params).toEqual([20, false]);
  });
});

describe("formatAgentReport", () => {
  it("carries the GitHub issue on the wire", () => {
    const wire = formatAgentReport(ROW);
    expect(wire.github_issue_number).toBe(41);
    expect(wire.github_issue_url).toBe(ROW.github_issue_url);
    expect(wire.github_synced_at).toBeNull();
  });
});
