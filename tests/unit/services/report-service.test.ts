/**
 * Agent reports (#366): the write never throws, repeats collapse on the
 * dedupe key, content is capped and refs are ids only, and external callers
 * are rate-limited.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []),
  config: { reportRateLimitPerHour: 2 },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: mocks.rawQuery,
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => mocks.config,
}));

import {
  checkReportRateLimit,
  computeDedupeKey,
  raiseIssue,
  resetReportRateLimiter,
  triageAgentReport,
  REPORT_BODY_MAX_CHARS,
} from "../../../src/services/report-service.js";

const REPORT_ID = "a1a1a1a1-1111-4111-8111-111111111111";
const CLAIM_ID = "b2b2b2b2-2222-4222-8222-222222222222";

function insertCall(): unknown[] | undefined {
  return mocks.rawQuery.mock.calls.find(([sql]) =>
    String(sql).includes("INSERT INTO agent_reports")
  )?.[1] as unknown[] | undefined;
}

beforeEach(() => {
  mocks.rawQuery.mockReset();
  mocks.rawQuery.mockResolvedValue([
    { id: REPORT_ID, occurrence_count: 1, inserted: true },
  ]);
  mocks.config.reportRateLimitPerHour = 2;
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

describe("raiseIssue", () => {
  it("upserts on the dedupe key with attribution snapshotted as plain columns", async () => {
    const result = await raiseIssue({
      kind: "tool_gap",
      severity: "degraded",
      title: "add_relationship_edge has no relation type for counterparts",
      body: "Tried to link two claims that are counterparts under different framings.",
      surface: "add_relationship_edge",
      contextRefs: { claim_id: CLAIM_ID, nested: { dropped: true }, n: 3 },
      agent: "steward",
      model: "claude-x",
      runId: null,
      jobId: "not-a-uuid",
      claimId: CLAIM_ID,
    });

    expect(result).toEqual({
      acknowledged: true,
      reportId: REPORT_ID,
      occurrenceCount: 1,
      deduplicated: false,
    });
    const [sql] = mocks.rawQuery.mock.calls[0]!;
    expect(String(sql)).toContain("ON CONFLICT (dedupe_key) DO UPDATE");
    const params = insertCall()!;
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
  });

  it("reports a collapsed repeat as deduplicated with the running count", async () => {
    mocks.rawQuery.mockResolvedValue([
      { id: REPORT_ID, occurrence_count: 7, inserted: false },
    ]);
    const result = await raiseIssue({
      kind: "system_failure",
      severity: "blocking",
      title: "search_similar_claims timed out",
      agent: "matcher",
    });
    expect(result.deduplicated).toBe(true);
    expect(result.occurrenceCount).toBe(7);
  });

  it("caps the body and title at write time", async () => {
    await raiseIssue({
      kind: "improvement",
      severity: "idea",
      title: "t".repeat(1000),
      body: "b".repeat(REPORT_BODY_MAX_CHARS + 500),
      agent: "curator",
    });
    const params = insertCall()!;
    expect(String(params[2]).length).toBe(200);
    expect(String(params[3]).length).toBe(REPORT_BODY_MAX_CHARS);
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
  });
});
