import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The reconcile sweep's mathematics rules (docs/mathematics.md §5.4, §7.2):
 * formalize rows open from plan items (group formalize:<claim_id>, one
 * variant) only while the claim lacks a published statement; attempt rows
 * open from attempt_proof items as sibling variants in group
 * attempt:<formalization_id>:<n> with n one more than the closed attempts;
 * open attempt rows whose statement is no longer published are cancelled;
 * and the reopen rule treats attempt rows on their own three-hour clock.
 */

const CLAIM_A = "a1111111-1111-4111-8111-111111111111";
const CLAIM_B = "b1111111-1111-4111-8111-111111111111";
const FORMALIZATION_B = "fb111111-1111-4111-8111-111111111111";

const { state, queries } = vi.hoisted(() => ({
  state: {
    grant: {
      id: "g-1",
      name: "Mathematics",
      status: "active",
      policy: "agent",
      plan: { items: [] as Array<Record<string, unknown>> },
      plan_cursor: 0,
    },
    attemptGroups: { groups: 0, live: 0 },
    publishedFor: new Set<string>(),
  },
  queries: [] as Array<{ q: string; params: unknown[] }>,
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    queries.push({ q, params });
    if (q.includes("FROM claims c") && q.includes("steward_state = 'pending'")) return [];
    if (q.includes("FROM grants") && q.includes("plan_cursor")) return [state.grant];
    if (q.includes("FROM claim_formalizations") && q.includes("status = 'published'") && q.startsWith("SELECT id")) {
      return state.publishedFor.has(params[0] as string) ? [{ id: FORMALIZATION_B }] : [];
    }
    if (q.includes("COUNT(DISTINCT exclusion_group)")) return [state.attemptGroups];
    return [];
  }),
  withTransaction: vi.fn(),
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ stewardStrongModel: "strong", owlCostMicroUsd: 1_000_000 }),
}));

vi.mock("../../../src/services/cost-estimate-service.js", () => ({
  stewardTierCostEstimates: vi.fn(async () => ({
    standardMicroUsd: 300_000,
    strongMicroUsd: 1_500_000,
  })),
}));

vi.mock("../../../src/services/allocation-policy-service.js", () => ({
  getMandateAllocationPolicy: vi.fn(async () => ({
    est_attempt_standard_cost_owls: 60,
    est_attempt_max_cost_owls: 150,
  })),
}));

import {
  ATTEMPT_GROUP,
  FORMALIZE_GROUP,
  reconcileActions,
} from "../../../src/services/action-service.js";

const inserts = (kind: string) =>
  queries.filter((x) => x.q.includes("INSERT INTO actions") && x.q.includes(`'${kind}'`));

beforeEach(() => {
  queries.length = 0;
  state.grant.status = "active";
  state.grant.plan = { items: [] };
  state.attemptGroups = { groups: 0, live: 0 };
  state.publishedFor = new Set();
});

describe("formalize rows from plan items", () => {
  it("opens one standard row per claim in group formalize:<claim_id>, costed at two strong passes", async () => {
    state.grant.plan.items = [
      { action: "formalize", claim_id: CLAIM_A, rationale: "first target" },
      { action: "formalize", claim_id: CLAIM_A, rationale: "duplicate item" },
      { action: "formalize", rationale: "no claim: ignored" },
    ];
    await reconcileActions();
    const rows = inserts("formalize");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.params).toEqual([FORMALIZE_GROUP(CLAIM_A), CLAIM_A, 3_000_000]);
    // Opened only while no published statement exists, and never a second
    // variant.
    expect(rows[0]!.q).toContain("NOT EXISTS (SELECT 1 FROM claim_formalizations f");
    expect(rows[0]!.q).toContain("'standard'");
    expect(rows[0]!.q).toMatch(/ON CONFLICT \(exclusion_group, variant\) DO UPDATE/);
  });

  it("opens nothing for a mandate that is not active", async () => {
    state.grant.status = "planning";
    state.grant.plan.items = [{ action: "formalize", claim_id: CLAIM_A, rationale: "r" }];
    await reconcileActions();
    expect(inserts("formalize")).toHaveLength(0);
    expect(inserts("attempt_proof")).toHaveLength(0);
  });
});

describe("attempt_proof rows from plan items", () => {
  it("opens standard and max siblings in attempt:<formalization_id>:<n> with n = closed attempts + 1", async () => {
    state.publishedFor.add(CLAIM_B);
    state.attemptGroups = { groups: 2, live: 0 };
    state.grant.plan.items = [
      { action: "attempt_proof", claim_id: CLAIM_B, variant: "max", is_calibration: true, rationale: "control" },
      { action: "attempt_proof", claim_id: CLAIM_B, variant: "standard", rationale: "again" },
      { action: "attempt_proof", claim_id: CLAIM_B, variant: "max", rationale: "and again" },
    ];
    await reconcileActions();
    const rows = inserts("attempt_proof");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.params).toEqual([
      ATTEMPT_GROUP(FORMALIZATION_B, 3),
      "standard",
      FORMALIZATION_B,
      "3",
      60_000_000,
      CLAIM_B,
    ]);
    expect(rows[1]!.params).toEqual([
      ATTEMPT_GROUP(FORMALIZATION_B, 3),
      "max",
      FORMALIZATION_B,
      "3",
      150_000_000,
      CLAIM_B,
    ]);
    expect(rows[0]!.q).toContain("ON CONFLICT (exclusion_group, variant) DO NOTHING");
  });

  it("opens nothing while an attempt is open or running, or when the plan's items are all used", async () => {
    state.publishedFor.add(CLAIM_B);
    state.grant.plan.items = [{ action: "attempt_proof", claim_id: CLAIM_B, rationale: "r" }];
    state.attemptGroups = { groups: 0, live: 1 };
    await reconcileActions();
    expect(inserts("attempt_proof")).toHaveLength(0);

    queries.length = 0;
    state.attemptGroups = { groups: 1, live: 0 };
    await reconcileActions();
    expect(inserts("attempt_proof")).toHaveLength(0);
  });

  it("opens nothing for a claim without a published statement", async () => {
    state.grant.plan.items = [{ action: "attempt_proof", claim_id: CLAIM_B, rationale: "r" }];
    await reconcileActions();
    expect(inserts("attempt_proof")).toHaveLength(0);
  });
});

describe("cancellation and the reopen rule", () => {
  it("cancels open attempt rows whose statement is no longer published, and formalize rows whose claim has one", async () => {
    await reconcileActions();
    const cancels = queries.filter((x) => x.q.includes("SET status = 'cancelled'"));
    const attempt = cancels.find((x) => x.q.includes("a.kind = 'attempt_proof'"));
    expect(attempt).toBeDefined();
    expect(attempt!.q).toContain("split_part(a.exclusion_group, ':', 2)");
    expect(attempt!.q).toContain("f.status = 'published'");
    expect(attempt!.q).toMatch(/NOT EXISTS/);
    const formalize = cancels.find((x) => x.q.includes("a.kind = 'formalize'"));
    expect(formalize).toBeDefined();
    expect(formalize!.q).toMatch(/EXISTS \(SELECT 1 FROM claim_formalizations f/);
  });

  it("reopens dead running rows on three clocks: 60 minutes, 24 hours for ingest, 3 hours for attempts", async () => {
    await reconcileActions();
    const reopen = queries.find(
      (x) => x.q.includes("SET status = 'open'") && x.q.includes("status = 'running'")
    );
    expect(reopen).toBeDefined();
    expect(reopen!.q).toContain("kind NOT IN ('ingest', 'attempt_proof') AND updated_at < now() - interval '60 minutes'");
    expect(reopen!.q).toContain("kind = 'ingest' AND updated_at < now() - interval '24 hours'");
    expect(reopen!.q).toContain("kind = 'attempt_proof' AND updated_at < now() - make_interval(hours => 3)");
  });
});
