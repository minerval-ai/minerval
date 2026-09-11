/**
 * GitHub issue filing for agent reports (#366): off unless configured,
 * never throws, files with the agent-generated labels and records the
 * issue on the row only once GitHub confirmed it, keeps external reports
 * out unless opted in, comments on sightings that carry something new
 * and on milestones only otherwise, and closes with the triage decision.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []),
  fetch: vi.fn(),
  config: {
    githubToken: "ghp_test",
    githubIssuesRepo: "minerval-ai/minerval",
    githubIssuesLabel: "agent-generated",
    githubApiBaseUrl: "https://api.github.test/",
    githubIssuesIncludeExternal: false,
  },
}));

vi.mock("../../../src/db/client.js", () => ({ rawQuery: mocks.rawQuery }));
vi.mock("../../../src/config.js", () => ({ loadConfig: () => mocks.config }));

import {
  fileIssueForReport,
  githubIssuesConfigured,
  isSightingMilestone,
  labelsForReport,
  renderIssueBody,
  resetGithubLabelCache,
  syncSightingToIssue,
  syncTriageToIssue,
} from "../../../src/services/github-issue-service.js";
import type { AgentReportRow } from "../../../src/services/report-service.js";

const REPORT_ID = "a1a1a1a1-1111-4111-8111-111111111111";
const RUN_ID = "c3c3c3c3-3333-4333-8333-333333333333";

const ROW: AgentReportRow = {
  id: REPORT_ID,
  kind: "tool_gap",
  severity: "degraded",
  title: "add_relationship_edge has no relation type for counterparts",
  body: "Tried to link two claims.\n```\nnot a fence escape\n```",
  surface: "add_relationship_edge",
  origin: "internal",
  agent: "steward",
  model: "claude-x",
  reporter_contributor_id: null,
  context_refs: { claim_id: "b2b2", n: 3 },
  run_id: RUN_ID,
  job_id: null,
  claim_id: null,
  status: "new",
  triage_note: null,
  triaged_by: null,
  triaged_at: null,
  duplicate_of_id: null,
  github_issue_number: null,
  github_issue_url: null,
  github_synced_at: null,
  occurrence_count: 1,
  first_seen_at: new Date("2026-08-01T00:00:00Z"),
  last_seen_at: new Date("2026-08-02T00:00:00Z"),
};

const WITH_ISSUE: AgentReportRow = {
  ...ROW,
  github_issue_number: 41,
  github_issue_url: "https://github.com/minerval-ai/minerval/issues/41",
};

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Every request, as [method, path, body]. */
function requests(): Array<[string, string, unknown]> {
  return mocks.fetch.mock.calls.map(([url, init]) => [
    (init as RequestInit).method as string,
    String(url).replace("https://api.github.test", ""),
    (init as RequestInit).body ? JSON.parse(String((init as RequestInit).body)) : undefined,
  ]);
}

beforeEach(() => {
  mocks.rawQuery.mockReset().mockResolvedValue([]);
  mocks.fetch.mockReset().mockImplementation(async (url: string, init: RequestInit) => {
    const path = String(url);
    if (init.method === "POST" && path.endsWith("/labels")) {
      return response(422, { message: "Validation Failed", errors: [{ code: "already_exists" }] });
    }
    if (init.method === "POST" && path.endsWith("/issues")) {
      return response(201, { number: 41, html_url: "https://github.com/minerval-ai/minerval/issues/41" });
    }
    return response(200, {});
  });
  vi.stubGlobal("fetch", mocks.fetch);
  resetGithubLabelCache();
  mocks.config.githubToken = "ghp_test";
  mocks.config.githubIssuesRepo = "minerval-ai/minerval";
  mocks.config.githubIssuesIncludeExternal = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("githubIssuesConfigured", () => {
  it("needs both a token and an owner/repo", () => {
    expect(githubIssuesConfigured()).toBe(true);
    mocks.config.githubToken = "";
    expect(githubIssuesConfigured()).toBe(false);
    mocks.config.githubToken = "ghp_test";
    mocks.config.githubIssuesRepo = "not-a-repo";
    expect(githubIssuesConfigured()).toBe(false);
  });
});

describe("labels and body", () => {
  it("labels every issue as agent-generated with its kind and severity, external when it is", () => {
    expect(labelsForReport(ROW)).toEqual([
      "agent-generated",
      "kind/tool_gap",
      "severity/degraded",
    ]);
    expect(labelsForReport({ ...ROW, origin: "external" })).toContain("origin/external");
  });

  it("renders the metadata, the body, the refs, and the attribution, ids only", () => {
    const body = renderIssueBody(ROW);
    expect(body).toContain("| Kind | tool_gap |");
    expect(body).toContain("| Agent | steward (claude-x) |");
    expect(body).toContain("| Surface | `add_relationship_edge` |");
    expect(body).toContain(`| Report id | \`${REPORT_ID}\` |`);
    expect(body).toContain("Tried to link two claims.");
    // A fence inside the report cannot close the block it is rendered in.
    expect(body).not.toContain("\n```\n");
    expect(body).toContain("- `claim_id`: `b2b2`");
    expect(body).toContain(`run \`${RUN_ID}\``);
    expect(body).toContain("Filed automatically by `raise_issue`");
  });

  it("marks the milestone counts", () => {
    expect([1, 2, 3, 5, 10, 11, 100, 999, 1000, 2000, 2500].map(isSightingMilestone)).toEqual([
      false, true, false, true, true, false, true, false, true, true, false,
    ]);
  });
});

describe("fileIssueForReport", () => {
  it("creates missing labels once, files the issue, and records the number where none is yet", async () => {
    const ref = await fileIssueForReport(ROW);
    expect(ref).toEqual({ number: 41, url: "https://github.com/minerval-ai/minerval/issues/41" });

    const reqs = requests();
    const labelCreates = reqs.filter(([m, p]) => m === "POST" && p.endsWith("/labels"));
    expect(labelCreates.map(([, , b]) => (b as { name: string }).name)).toEqual([
      "agent-generated",
      "kind/tool_gap",
      "severity/degraded",
    ]);
    const [, path, body] = reqs.find(([m, p]) => m === "POST" && p.endsWith("/issues"))!;
    expect(path).toBe("/repos/minerval-ai/minerval/issues");
    expect(body).toMatchObject({
      title: ROW.title,
      labels: ["agent-generated", "kind/tool_gap", "severity/degraded"],
    });
    const init = mocks.fetch.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ghp_test");

    const [sql, params] = mocks.rawQuery.mock.calls[0]!;
    expect(String(sql)).toContain("WHERE id = $1 AND github_issue_number IS NULL");
    expect(params).toEqual([REPORT_ID, 41, "https://github.com/minerval-ai/minerval/issues/41"]);

    // Second filing in the same process: labels are known, no label calls.
    mocks.fetch.mockClear();
    await fileIssueForReport({ ...ROW, id: "d4d4d4d4-4444-4444-8444-444444444444" });
    expect(requests().filter(([, p]) => p.endsWith("/labels"))).toHaveLength(0);
  });

  it("carries an already-triaged report's decision over when filing it from the backlog", async () => {
    const ref = await fileIssueForReport({
      ...ROW,
      status: "wontfix",
      triage_note: "by design",
      triaged_by: "audit:run-1",
    });
    expect(ref?.number).toBe(41);
    const reqs = requests();
    const comment = reqs.find(([m, p]) => m === "POST" && p.endsWith("/issues/41/comments"))!;
    expect((comment[2] as { body: string }).body).toContain("Triaged as `wontfix`");
    const patch = reqs.find(([m, p]) => m === "PATCH" && p.endsWith("/issues/41"))!;
    expect(patch[2]).toMatchObject({ state: "closed", state_reason: "not_planned" });

    // A fresh report is filed and left open.
    mocks.fetch.mockClear();
    await fileIssueForReport(ROW);
    expect(requests().filter(([m]) => m === "PATCH")).toHaveLength(0);
  });

  it("is a no-op when unconfigured, and keeps external reports out unless opted in", async () => {
    mocks.config.githubToken = "";
    expect(await fileIssueForReport(ROW)).toBeNull();
    mocks.config.githubToken = "ghp_test";
    expect(await fileIssueForReport({ ...ROW, origin: "external" })).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();

    mocks.config.githubIssuesIncludeExternal = true;
    const ref = await fileIssueForReport({ ...ROW, origin: "external" });
    expect(ref?.number).toBe(41);
    const [, , body] = requests().find(([m, p]) => m === "POST" && p.endsWith("/issues"))!;
    expect((body as { labels: string[] }).labels).toContain("origin/external");
  });

  it("never throws: a GitHub failure is logged and leaves the row unrecorded", async () => {
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) =>
      init.method === "POST" && String(_url).endsWith("/issues")
        ? response(401, { message: "Bad credentials" })
        : response(422, {})
    );
    expect(await fileIssueForReport(ROW)).toBeNull();
    expect(mocks.rawQuery).not.toHaveBeenCalled();

    mocks.fetch.mockRejectedValue(new Error("ECONNRESET"));
    expect(await fileIssueForReport(ROW)).toBeNull();
  });

  it("surfaces a label creation failure other than already-exists", async () => {
    mocks.fetch.mockImplementation(async () => response(403, { message: "Forbidden" }));
    expect(await fileIssueForReport(ROW)).toBeNull();
    expect(requests().filter(([, p]) => p.endsWith("/issues"))).toHaveLength(0);
  });
});

describe("syncSightingToIssue", () => {
  const base = { reopened: false, account: "", agent: "curator", explicit: false };

  it("stays silent on an ordinary repeat and comments at a milestone", async () => {
    await syncSightingToIssue({ ...WITH_ISSUE, occurrence_count: 3 }, base);
    expect(mocks.fetch).not.toHaveBeenCalled();

    await syncSightingToIssue({ ...WITH_ISSUE, occurrence_count: 5 }, base);
    const [method, path, body] = requests()[0]!;
    expect(method).toBe("POST");
    expect(path).toBe("/repos/minerval-ai/minerval/issues/41/comments");
    expect((body as { body: string }).body).toContain("Seen again");
    expect((body as { body: string }).body).toContain("5 time(s)");
    expect(String(mocks.rawQuery.mock.calls[0]![0])).toContain("github_synced_at = now()");
  });

  it("always carries an account the agent gave, with where it happened", async () => {
    await syncSightingToIssue(
      { ...WITH_ISSUE, occurrence_count: 3 },
      { ...base, account: "Happened on a merged pair too.", explicit: true }
    );
    const [, , body] = requests()[0]!;
    expect((body as { body: string }).body).toContain("Happened on a merged pair too.");
    expect((body as { body: string }).body).toContain(`run \`${RUN_ID}\``);
  });

  it("reopens the issue on a regression and relabels it", async () => {
    await syncSightingToIssue(
      { ...WITH_ISSUE, occurrence_count: 3, status: "new" },
      { ...base, reopened: true }
    );
    const reqs = requests();
    expect((reqs.find(([m, p]) => m === "POST" && p.endsWith("/comments"))![2] as { body: string }).body).toContain(
      "regression"
    );
    const patch = reqs.find(([m]) => m === "PATCH")!;
    expect(patch[1]).toBe("/repos/minerval-ai/minerval/issues/41");
    expect(patch[2]).toMatchObject({ state: "open", labels: expect.arrayContaining(["status/new"]) });
  });

  it("posts a note and follows a re-rated severity into the labels", async () => {
    await syncSightingToIssue(
      { ...WITH_ISSUE, severity: "blocking" },
      { ...base, account: "Found the cause.", explicit: true, note: true, severityChanged: true }
    );
    const reqs = requests();
    expect((reqs.find(([m]) => m === "POST" && true)![2] as { body: string }).body).toContain("Note from `curator`");
    const patch = reqs.find(([m]) => m === "PATCH")!;
    expect((patch[2] as { labels: string[] }).labels).toContain("severity/blocking");
    expect(patch[2]).not.toHaveProperty("state");
  });

  it("is a no-op for a report with no issue, and never throws", async () => {
    await syncSightingToIssue(ROW, { ...base, reopened: true });
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.fetch.mockRejectedValue(new Error("down"));
    await expect(syncSightingToIssue(WITH_ISSUE, { ...base, reopened: true })).resolves.toBeUndefined();
  });
});

describe("syncTriageToIssue", () => {
  it("comments the decision and closes with the matching state_reason", async () => {
    await syncTriageToIssue({
      ...WITH_ISSUE,
      status: "wontfix",
      triage_note: "by design: use add_instance",
      triaged_by: "audit:run-1",
      occurrence_count: 9,
    });
    const reqs = requests();
    const comment = reqs.find(([m, p]) => m === "POST" && p.endsWith("/comments"))!;
    expect((comment[2] as { body: string }).body).toContain("Triaged as `wontfix`");
    expect((comment[2] as { body: string }).body).toContain("by design: use add_instance");
    expect((comment[2] as { body: string }).body).toContain("Seen 9 time(s)");
    const patch = reqs.find(([m]) => m === "PATCH")!;
    expect(patch[2]).toMatchObject({
      state: "closed",
      state_reason: "not_planned",
      labels: expect.arrayContaining(["status/wontfix"]),
    });
  });

  it("closes actioned as completed, a withdrawal as not planned, and reopens on triaged", async () => {
    await syncTriageToIssue({ ...WITH_ISSUE, status: "actioned" });
    expect(requests().find(([m]) => m === "PATCH")![2]).toMatchObject({ state_reason: "completed" });

    mocks.fetch.mockClear();
    await syncTriageToIssue({ ...WITH_ISSUE, status: "withdrawn", triaged_by: "agent:steward" });
    const reqs = requests();
    expect((reqs.find(([m, p]) => m === "POST" && p.endsWith("/comments"))![2] as { body: string }).body).toContain(
      "Withdrawn"
    );
    expect(reqs.find(([m]) => m === "PATCH")![2]).toMatchObject({ state_reason: "not_planned" });

    mocks.fetch.mockClear();
    await syncTriageToIssue({ ...WITH_ISSUE, status: "triaged" });
    expect(requests().find(([m]) => m === "PATCH")![2]).toMatchObject({ state: "open" });
  });

  it("names a duplicate's target, and is a no-op without an issue", async () => {
    await syncTriageToIssue({
      ...WITH_ISSUE,
      status: "duplicate",
      duplicate_of_id: "e5e5e5e5-5555-4555-8555-555555555555",
    });
    const comment = requests().find(([m, p]) => m === "POST" && p.endsWith("/comments"))!;
    expect((comment[2] as { body: string }).body).toContain("Duplicate of report `e5e5e5e5");

    mocks.fetch.mockClear();
    await syncTriageToIssue({ ...ROW, status: "wontfix" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
