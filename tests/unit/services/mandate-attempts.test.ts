import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The mandate's attempt list (docs/mathematics.md §7, §8.3): proof_attempts
 * by grant_id, through the attempt log's serializer, so an unpublished
 * attempt on a claim with a live bounty stays opaque on the mandate page as
 * it does on the claim page.
 */
const state = vi.hoisted(() => ({ queries: [] as Array<{ sql: string; params: unknown[] }>, rows: [] as unknown[] }));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    state.queries.push({ sql, params });
    if (sql.includes("FROM proof_attempts pa")) return state.rows;
    return [];
  }),
  withTransaction: vi.fn(),
  getDb: vi.fn(),
}));

import { listMandateAttempts } from "../../../src/services/mandate-service.js";
import { LIVE_BOUNTY_STATUSES } from "../../../src/services/bounty-service.js";

function attemptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "a-1",
    claim_id: "claim-1",
    formalization_id: "f-1",
    action_id: null,
    run_id: null,
    grant_id: "g-1",
    job_id: null,
    model: "m",
    variant: "max",
    effort: "high",
    status: "completed",
    outcome: "negative",
    report: { informal_argument: "tried", approaches_tried: ["a"], obstruction: "b", what_would_help: "c", confidence: 0.2 },
    lean_proof: null,
    lean_check_id: null,
    notebook: { plan: "x" },
    is_calibration: false,
    ceiling_micro_usd: "20000000",
    spent_micro_usd: "12000000",
    turns: "40",
    compactions: "1",
    served_models: ["m"],
    published_at: new Date("2026-08-02T00:00:00Z"),
    started_at: new Date("2026-08-01T00:00:00Z"),
    heartbeat_at: null,
    finished_at: new Date("2026-08-01T02:00:00Z"),
    error: null,
    bounty_bearing: false,
    ...overrides,
  };
}

beforeEach(() => {
  state.queries = [];
  state.rows = [];
});

describe("listMandateAttempts", () => {
  it("selects proof_attempts by grant_id, newest first, with the live-bounty flag from the bounties table", async () => {
    state.rows = [attemptRow()];
    const out = await listMandateAttempts("g-1");
    const q = state.queries[0]!;
    expect(q.sql).toMatch(/FROM proof_attempts pa/);
    expect(q.sql).toMatch(/WHERE pa\.grant_id = \$1/);
    expect(q.sql).toMatch(/ORDER BY pa\.started_at DESC/);
    expect(q.sql).toMatch(/FROM bounties b/);
    expect(q.params[0]).toBe("g-1");
    expect(q.params[1]).toEqual([...LIVE_BOUNTY_STATUSES]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: "a-1",
      claim_id: "claim-1",
      variant: "max",
      effort: "high",
      status: "completed",
      outcome: "negative",
      is_calibration: false,
      spent_micro_usd: 12_000_000,
      turns: 40,
      started_at: "2026-08-01T00:00:00.000Z",
      finished_at: "2026-08-01T02:00:00.000Z",
      published_at: "2026-08-02T00:00:00.000Z",
      report: { informal_argument: "tried", approaches_tried: ["a"], obstruction: "b", what_would_help: "c", confidence: 0.2 },
      notebook: { plan: "x" },
    });
  });

  it("keeps an unpublished attempt on a bounty-bearing claim opaque", async () => {
    state.rows = [attemptRow({ published_at: null, bounty_bearing: true })];
    const [a] = await listMandateAttempts("g-1");
    expect(a!.outcome).toBeNull();
    expect(a!.report).toBeNull();
    expect(a!.notebook).toBeNull();
    expect(a!.published_at).toBeNull();
  });

  it("returns an empty list for a mandate without attempts", async () => {
    expect(await listMandateAttempts("g-2")).toEqual([]);
  });
});
