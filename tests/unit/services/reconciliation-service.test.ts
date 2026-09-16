import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the raw SQL the merge issues so we can assert the operation sequence
// without a live DB. mergeClaims uses rawQuery for every step.
const rawQuery = vi.fn(async (..._args: unknown[]) => [] as unknown[]);

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: (...args: unknown[]) => rawQuery(...args),
  getDb: () => ({}),
}));

import { mergeClaims, reverseReconciliation } from "../../../src/services/reconciliation-service.js";

function sqls(): string[] {
  return rawQuery.mock.calls.map((c) => String(c[0]));
}

describe("mergeClaims", () => {
  beforeEach(() => rawQuery.mockClear());

  it("moves instances, arguments, and edges onto the survivor, then marks the loser merged", async () => {
    await mergeClaims({
      survivorId: "s",
      loserId: "l",
      stanceRelation: "same",
      reasoning: "duplicate",
    });

    const all = sqls();
    expect(all.some((s) => /UPDATE claim_instances/.test(s))).toBe(true);
    expect(all.some((s) => /UPDATE arguments/.test(s))).toBe(true);
    // child-side and parent-side repoint (with a dedupe DELETE before each)
    expect(all.some((s) => /SET child_claim_id = \$1 WHERE child_claim_id = \$2/.test(s))).toBe(true);
    expect(all.some((s) => /SET parent_claim_id = \$1 WHERE parent_claim_id = \$2/.test(s))).toBe(true);
    // the loser becomes a merged alias pointing at the survivor
    expect(all.some((s) => /UPDATE claims SET merged_into = \$1, state = 'merged'/.test(s))).toBe(true);
    // and the operation is logged as a reversible reconciliation event (§18)
    const logCall = rawQuery.mock.calls.find((c) =>
      /INSERT INTO reconciliation_events/.test(String(c[0]))
    );
    expect(logCall).toBeDefined();
    expect(logCall?.[1]?.[0]).toBe("merge");
  });

  it("flips moved stances (opposed=true) when merging a negation/counterpart", async () => {
    await mergeClaims({
      survivorId: "s",
      loserId: "l",
      stanceRelation: "opposed",
      reasoning: "negation",
    });

    const instancesCall = rawQuery.mock.calls.find((c) =>
      /UPDATE claim_instances/.test(String(c[0]))
    );
    expect(instancesCall?.[1]).toEqual(["s", "l", true]);

    const argumentsCall = rawQuery.mock.calls.find((c) =>
      /UPDATE arguments/.test(String(c[0]))
    );
    expect(argumentsCall?.[1]).toEqual(["s", "l", true]);
  });

  it("does NOT flip stances for a same-direction merge", async () => {
    await mergeClaims({
      survivorId: "s",
      loserId: "l",
      stanceRelation: "same",
      reasoning: "duplicate",
    });
    const instancesCall = rawQuery.mock.calls.find((c) =>
      /UPDATE claim_instances/.test(String(c[0]))
    );
    expect(instancesCall?.[1]).toEqual(["s", "l", false]);
  });

  it("carries a deleted duplicate's argument memberships onto the survivor's edge (#437)", async () => {
    // The dedupe SELECT finds one duplicate edge of the loser's; its
    // memberships must be re-pointed BEFORE it is captured and deleted, and
    // the capture must precede the delete (membership rows cascade away).
    rawQuery.mockImplementation(async (sql: unknown) =>
      /SELECT cr\.id FROM claim_relationships/.test(String(sql)) ? [{ id: "dup" }] : []
    );
    try {
      await mergeClaims({
        survivorId: "s",
        loserId: "l",
        stanceRelation: "same",
        reasoning: "duplicate",
      });
    } finally {
      rawQuery.mockImplementation(async () => []);
    }
    const all = sqls();
    const repoint = all.findIndex((s) => /INSERT INTO argument_subclaims/.test(s));
    const capture = all.findIndex((s) => /array_agg\(am\.argument_id\)/.test(s));
    const del = all.findIndex((s) => /DELETE FROM claim_relationships WHERE id = ANY/.test(s));
    expect(repoint).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(repoint);
    expect(del).toBeGreaterThan(capture);
    // and the re-pointed rows are part of the reversible payload
    const logCall = rawQuery.mock.calls.find((c) =>
      /INSERT INTO reconciliation_events/.test(String(c[0]))
    );
    expect(String(logCall?.[1]?.[2])).toContain("repointed_memberships");
  });

  it("moves the loser's lateral links onto the survivor and records what it created (#436)", async () => {
    rawQuery.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (/DELETE FROM claim_links/.test(text)) {
        return [
          { id: "k1", claim_a_id: "a", claim_b_id: "l", kind: "related", reasoning: "r", created_by: "c" },
          { id: "k2", claim_a_id: "l", claim_b_id: "s", kind: "related", reasoning: "r", created_by: "c" },
        ];
      }
      if (/INSERT INTO claim_links/.test(text)) return [{ id: "k3" }];
      return [];
    });
    try {
      await mergeClaims({ survivorId: "s", loserId: "l", stanceRelation: "same", reasoning: "dup" });
    } finally {
      rawQuery.mockImplementation(async () => []);
    }
    const inserts = rawQuery.mock.calls.filter((c) => /INSERT INTO claim_links/.test(String(c[0])));
    // a <-> l becomes a <-> s (canonical order); l <-> s is a self-link and drops
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![1]!.slice(0, 3)).toEqual(["a", "s", "related"]);
    const logCall = rawQuery.mock.calls.find((c) =>
      /INSERT INTO reconciliation_events/.test(String(c[0]))
    );
    const payload = JSON.parse(String(logCall?.[1]?.[2]));
    expect(payload.merged_link_ids).toEqual(["k3"]);
    expect(payload.moved_links).toHaveLength(2);
  });

  it("refuses to merge a claim into itself", async () => {
    await expect(
      mergeClaims({ survivorId: "x", loserId: "x", stanceRelation: "same", reasoning: "" })
    ).rejects.toThrow();
  });
});

describe("reverseReconciliation", () => {
  beforeEach(() => rawQuery.mockReset());

  it("un-merges: restores the loser and marks the event reversed", async () => {
    const event = {
      operation: "merge",
      reversed: false,
      payload: {
        survivor_id: "s",
        loser_id: "l",
        stance_relation: "opposed",
        loser_prev_state: "active",
        moved_instance_ids: ["i1"],
        moved_argument_ids: [],
        repointed_child_edge_ids: ["e1"],
        repointed_parent_edge_ids: [],
        deleted_edges: [],
      },
    };
    rawQuery.mockImplementation(async (sql: unknown) =>
      /SELECT operation, payload, reversed FROM reconciliation_events/.test(String(sql))
        ? [event]
        : []
    );

    const result = await reverseReconciliation("evt-1");
    expect(result.reversed).toBe(true);

    const sqlsRun = rawQuery.mock.calls.map((c) => String(c[0]));
    // instance moved back to the loser, edge repointed back, loser un-merged, event flagged
    expect(sqlsRun.some((s) => /UPDATE claim_instances SET claim_id = \$1/.test(s))).toBe(true);
    expect(sqlsRun.some((s) => /SET child_claim_id = \$1 WHERE id = ANY/.test(s))).toBe(true);
    expect(sqlsRun.some((s) => /UPDATE claims SET merged_into = NULL/.test(s))).toBe(true);
    expect(sqlsRun.some((s) => /SET reversed = true/.test(s))).toBe(true);
  });

  it("is idempotent: an already-reversed event is a no-op", async () => {
    rawQuery.mockImplementation(async (sql: unknown) =>
      /SELECT operation, payload, reversed/.test(String(sql))
        ? [{ operation: "merge", reversed: true, payload: {} }]
        : []
    );
    const result = await reverseReconciliation("evt-2");
    expect(result.reversed).toBe(false);
    expect(result.reason).toBe("already reversed");
  });
});
