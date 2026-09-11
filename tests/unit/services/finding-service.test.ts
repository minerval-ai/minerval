/**
 * Agent findings (#394): the write never throws, refs are checked against
 * the tables they name, a near match on record stops the write until the
 * agent answers, and `joins` records a sighting instead of a row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []),
  generateEmbedding: vi.fn(async (_text: string): Promise<number[]> => [0.1, 0.2, 0.3]),
  config: { findingMatchSimilarity: 0.8, findingMatchSimilaritySameClaim: 0.65 },
}));

vi.mock("../../../src/db/client.js", () => ({ rawQuery: mocks.rawQuery }));
vi.mock("../../../src/services/embedding-service.js", () => ({
  generateEmbedding: mocks.generateEmbedding,
}));
vi.mock("../../../src/config.js", () => ({ loadConfig: () => mocks.config }));

import {
  noteFinding,
  parseFindingRefs,
  formatFinding,
  FINDING_ACCOUNT_MAX_CHARS,
  type AgentFindingRow,
} from "../../../src/services/finding-service.js";

const CLAIM_ID = "b2b2b2b2-2222-4222-8222-222222222222";
const ASSESSMENT_ID = "a1a1a1a1-1111-4111-8111-111111111111";
const CHECK_ID = "c3c3c3c3-3333-4333-8333-333333333333";
const FINDING_ID = "d4d4d4d4-4444-4444-8444-444444444444";
const OTHER_FINDING_ID = "e5e5e5e5-5555-4555-8555-555555555555";

const GOOD = {
  headline: "The claim that moderate drinking lowers cardiovascular risk is contradicted once abstainer bias is corrected for.",
  account: "The received view rests on cohort studies whose abstainer groups include former drinkers. The assessment weighs the corrected cohorts and finds no protective effect.",
  claimId: CLAIM_ID,
  refs: [
    { kind: "assessment", id: ASSESSMENT_ID },
    { kind: "claim", id: CLAIM_ID },
  ],
  importance: 5,
  agent: "steward",
  model: "claude-fable-5-1",
  runId: null,
  jobId: null,
  skills: [],
};

/**
 * Route each SQL the service issues to a canned answer. Refs resolve by
 * table; the match search and the insert are keyed on their SQL.
 */
function routeQueries(opts: {
  existing?: Partial<Record<string, string[]>>;
  matches?: unknown[];
  insertedId?: string;
  joinRow?: { id: string; sighting_count: number } | null;
}) {
  mocks.rawQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const m = /SELECT id FROM (\w+) WHERE id = ANY/.exec(sql);
    if (m) {
      const table = m[1]!;
      const ids = (params?.[0] as string[]) ?? [];
      const allowed = opts.existing?.[table];
      // Default: every id exists, unless the table has an explicit allowlist.
      return ids
        .filter((id) => (allowed ? allowed.includes(id) : true))
        .map((id) => ({ id }));
    }
    if (sql.includes("FROM agent_findings") && sql.includes("<=>")) {
      return opts.matches ?? [];
    }
    if (sql.includes("INSERT INTO agent_findings")) {
      return [{ id: opts.insertedId ?? FINDING_ID }];
    }
    if (sql.includes("UPDATE agent_findings") && sql.includes("sighting_count + 1")) {
      return opts.joinRow === null ? [] : [opts.joinRow ?? { id: FINDING_ID, sighting_count: 2 }];
    }
    if (sql.includes("INSERT INTO agent_finding_sightings")) return [];
    return [];
  });
}

function callsMatching(fragment: string): unknown[][] {
  return mocks.rawQuery.mock.calls
    .filter(([sql]) => String(sql).includes(fragment))
    .map(([, params]) => params as unknown[]);
}

beforeEach(() => {
  mocks.rawQuery.mockReset();
  mocks.generateEmbedding.mockReset().mockResolvedValue([0.1, 0.2, 0.3]);
  routeQueries({});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("parseFindingRefs", () => {
  it("keeps well-formed {kind, id} pairs, drops the rest, and dedupes", () => {
    const { refs, malformed } = parseFindingRefs([
      { kind: "assessment", id: ASSESSMENT_ID },
      { kind: "assessment", id: ASSESSMENT_ID.toUpperCase() },
      { kind: "source", id: CLAIM_ID },
      { kind: "claim", id: "not-a-uuid" },
      "claim",
      null,
    ]);
    expect(refs).toEqual([{ kind: "assessment", id: ASSESSMENT_ID }]);
    expect(malformed).toBe(4);
  });

  it("treats a missing array as no refs, not as malformed", () => {
    expect(parseFindingRefs(undefined)).toEqual({ refs: [], malformed: 0 });
    expect(parseFindingRefs("assessment")).toEqual({ refs: [], malformed: 1 });
  });
});

describe("noteFinding", () => {
  it("records a finding whose refs resolve, embedding it first", async () => {
    const result = await noteFinding(GOOD);
    expect(result).toEqual({ outcome: "recorded", findingId: FINDING_ID, droppedRefs: [] });
    expect(mocks.generateEmbedding).toHaveBeenCalledTimes(1);
    expect(mocks.generateEmbedding.mock.calls[0]![0]).toContain(GOOD.headline);
    const [params] = callsMatching("INSERT INTO agent_findings");
    expect(params![0]).toBe(GOOD.headline);
    expect(params![2]).toBe(CLAIM_ID);
    expect(JSON.parse(params![3] as string)).toEqual(GOOD.refs);
    expect(params![4]).toBe(5);
    expect(params![5]).toBe("[0.1,0.2,0.3]");
    expect(params![6]).toBe("steward");
    expect(params![7]).toBe("claude-fable-5-1");
  });

  it("drops refs that do not resolve and names them, still recording", async () => {
    routeQueries({ existing: { assessments: [] } });
    const result = await noteFinding(GOOD);
    expect(result).toEqual({
      outcome: "recorded",
      findingId: FINDING_ID,
      droppedRefs: [{ kind: "assessment", id: ASSESSMENT_ID }],
    });
    const [params] = callsMatching("INSERT INTO agent_findings");
    expect(JSON.parse(params![3] as string)).toEqual([{ kind: "claim", id: CLAIM_ID }]);
  });

  it("does not record a finding none of whose refs resolve", async () => {
    routeQueries({ existing: { assessments: [], claims: [] } });
    const result = await noteFinding(GOOD);
    expect(result.outcome).toBe("not_recorded");
    expect((result as { problem: string }).problem).toMatch(/none of the refs resolve/);
    expect(callsMatching("INSERT INTO agent_findings")).toHaveLength(0);
    expect(mocks.generateEmbedding).not.toHaveBeenCalled();
  });

  it("requires refs at all", async () => {
    const result = await noteFinding({ ...GOOD, refs: [] });
    expect(result.outcome).toBe("not_recorded");
    expect((result as { problem: string }).problem).toMatch(/refs is required/);
  });

  it("returns the near matches instead of writing when one is on record", async () => {
    routeQueries({
      matches: [
        {
          id: OTHER_FINDING_ID,
          headline: "Moderate drinking does not protect the heart once abstainer bias is removed.",
          claim_id: CLAIM_ID,
          agent: "steward",
          importance: 5,
          sighting_count: 3,
          first_noted_at: new Date("2026-09-03T00:00:00Z"),
          similarity: 0.91,
        },
      ],
    });
    const result = await noteFinding(GOOD);
    expect(result.outcome).toBe("possible_duplicate");
    const matches = (result as { matches: unknown[] }).matches;
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      id: OTHER_FINDING_ID,
      same_claim: true,
      sighting_count: 3,
      similarity: 0.91,
      first_noted_at: "2026-09-03T00:00:00.000Z",
    });
    expect(callsMatching("INSERT INTO agent_findings")).toHaveLength(0);
    // The search carries both thresholds and the claim, and excludes nothing.
    const [params] = callsMatching("<=>");
    expect(params![1]).toBe(0.8);
    expect(params![2]).toBe(CLAIM_ID);
    expect(params![3]).toBe(0.65);
    expect(params![4]).toEqual([]);
  });

  it("writes when the agent answers distinct_from, excluding those ids from the search", async () => {
    routeQueries({ matches: [] });
    const result = await noteFinding({ ...GOOD, distinctFrom: [OTHER_FINDING_ID, "junk"] });
    expect(result.outcome).toBe("recorded");
    const [params] = callsMatching("<=>");
    expect(params![4]).toEqual([OTHER_FINDING_ID]);
  });

  it("records a sighting, not a row, when the agent answers joins", async () => {
    const result = await noteFinding({ ...GOOD, joins: OTHER_FINDING_ID });
    expect(result).toEqual({
      outcome: "joined",
      findingId: FINDING_ID,
      sightingCount: 2,
      droppedRefs: [],
    });
    expect(mocks.generateEmbedding).not.toHaveBeenCalled();
    expect(callsMatching("INSERT INTO agent_findings ")).toHaveLength(0);
    const [update] = callsMatching("sighting_count + 1");
    expect(update![0]).toBe(OTHER_FINDING_ID);
    const [sighting] = callsMatching("INSERT INTO agent_finding_sightings");
    expect(sighting![1]).toBe(GOOD.account);
    expect(JSON.parse(sighting![2] as string)).toEqual(GOOD.refs);
    expect(sighting![4]).toBe("steward");
  });

  it("refuses a joins that names no published finding", async () => {
    routeQueries({ joinRow: null });
    const result = await noteFinding({ ...GOOD, joins: OTHER_FINDING_ID });
    expect(result.outcome).toBe("not_recorded");
    expect((result as { problem: string }).problem).toMatch(/joins names no published finding/);
  });

  it("records without a match search when embedding fails, rather than failing the run", async () => {
    mocks.generateEmbedding.mockRejectedValue(new Error("openai down"));
    const result = await noteFinding(GOOD);
    expect(result.outcome).toBe("recorded");
    expect(callsMatching("<=>")).toHaveLength(0);
    const [params] = callsMatching("INSERT INTO agent_findings");
    expect(params![5]).toBeNull();
  });

  it("validates importance, claim id, and the text fields, in agent-facing words", async () => {
    for (const [patch, re] of [
      [{ importance: 11 }, /importance must be an integer from 1 to 10/],
      [{ importance: 2.5 }, /importance must be an integer from 1 to 10/],
      [{ claimId: "nope" }, /claim_id must be a claim id/],
      [{ headline: "  " }, /headline is required/],
      [{ account: "" }, /account is required/],
    ] as const) {
      const result = await noteFinding({ ...GOOD, ...patch });
      expect(result.outcome).toBe("not_recorded");
      expect((result as { problem: string }).problem).toMatch(re);
    }
    expect(callsMatching("INSERT INTO agent_findings")).toHaveLength(0);
  });

  it("caps the account and never throws on a database failure", async () => {
    mocks.rawQuery.mockRejectedValue(new Error("connection refused"));
    const result = await noteFinding({ ...GOOD, account: "x".repeat(FINDING_ACCOUNT_MAX_CHARS + 500) });
    expect(result).toEqual({
      outcome: "not_recorded",
      problem: "the finding could not be persisted right now",
    });
  });
});

describe("formatFinding", () => {
  it("serializes the wire shape with ISO dates and the stale flag", () => {
    const row: AgentFindingRow = {
      id: FINDING_ID,
      headline: GOOD.headline,
      account: GOOD.account,
      claim_id: CLAIM_ID,
      claim_text: "Moderate drinking lowers cardiovascular risk.",
      refs: [{ kind: "lean_check", id: CHECK_ID }],
      importance: 5,
      agent: "steward",
      model: null,
      run_id: null,
      skills: null,
      status: "published",
      withdrawn_note: null,
      sighting_count: 1,
      first_noted_at: new Date("2026-09-03T00:00:00Z"),
      last_noted_at: new Date("2026-09-04T00:00:00Z"),
      stale: true,
    };
    expect(formatFinding(row)).toMatchObject({
      id: FINDING_ID,
      claim_text: "Moderate drinking lowers cardiovascular risk.",
      refs: [{ kind: "lean_check", id: CHECK_ID }],
      skills: [],
      sighting_count: 1,
      first_noted_at: "2026-09-03T00:00:00.000Z",
      last_noted_at: "2026-09-04T00:00:00.000Z",
      stale: true,
    });
  });
});
