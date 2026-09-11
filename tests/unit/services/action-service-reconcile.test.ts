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
    lastAttemptFinishedAt: null as Date | null,
  },
  queries: [] as Array<{ q: string; params: unknown[] }>,
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    queries.push({ q, params });
    if (q.includes("FROM claims c") && q.includes("steward_state = 'pending'")) return [];
    // The materializer's per-item standing lookup: every claim the tests
    // name is active and assessed; published iff the test says so.
    if (q.includes("FROM claims c WHERE c.id = $1")) {
      const id = params[0] as string;
      return [{ id, state: "active", steward_state: "done", published: state.publishedFor.has(id) }];
    }
    if (q.includes("FROM grants") && q.includes("plan_cursor")) return [state.grant];
    if (q.includes("FROM claim_formalizations") && q.includes("status = 'published'") && q.startsWith("SELECT id")) {
      return state.publishedFor.has(params[0] as string) ? [{ id: FORMALIZATION_B }] : [];
    }
    if (q.includes("COUNT(DISTINCT exclusion_group)")) return [state.attemptGroups];
    if (q.includes("FROM proof_attempts") && q.includes("finished_at IS NOT NULL")) {
      return state.lastAttemptFinishedAt ? [{ finished_at: state.lastAttemptFinishedAt }] : [];
    }
    return [];
  }),
  withTransaction: vi.fn(),
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ stewardStrongModel: "strong", owlCostMicroUsd: 1_000_000 }),
}));

// The formalize gate (#416): the claim's domains carry the publishing tool
// unless a test says otherwise.
const gate = vi.hoisted(() => ({ missing: [] as string[] }));
vi.mock("../../../src/workers/steward-direct.js", () => ({
  missingTriggerTools: vi.fn(async () => ({
    skills: gate.missing.length > 0 ? [] : ["mathematics"],
    active: [],
    missing: gate.missing,
  })),
}));
vi.mock("../../../src/services/queue-service.js", () => ({
  enqueueSteward: vi.fn(async () => {}),
}));
vi.mock("../../../src/services/report-service.js", () => ({
  raiseIssue: vi.fn(async () => ({ acknowledged: true })),
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
    attempt_cooldown_days: 30,
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
  state.lastAttemptFinishedAt = null;
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

  it("waits out the mandate's cooldown after the last closed attempt unless the entitling item states a reason (§7.2)", async () => {
    const DAY = 86_400_000;
    state.publishedFor.add(CLAIM_B);
    state.attemptGroups = { groups: 1, live: 0 };
    state.lastAttemptFinishedAt = new Date(Date.now() - 3 * DAY);
    // The second item entitles the second group; a bare rationale waives nothing.
    state.grant.plan.items = [
      { action: "attempt_proof", claim_id: CLAIM_B, rationale: "a new lemma in the subtree was formalized since" },
      { action: "attempt_proof", claim_id: CLAIM_B, rationale: "again" },
    ];
    await reconcileActions();
    expect(inserts("attempt_proof")).toHaveLength(0);

    // A reason of at least twenty characters on the entitling item opens it.
    queries.length = 0;
    state.grant.plan.items = [
      { action: "attempt_proof", claim_id: CLAIM_B, rationale: "first" },
      { action: "attempt_proof", claim_id: CLAIM_B, rationale: "the prior report names a route it could not pursue for budget" },
    ];
    await reconcileActions();
    expect(inserts("attempt_proof")).toHaveLength(2);
    expect(inserts("attempt_proof")[0]!.params[0]).toBe(ATTEMPT_GROUP(FORMALIZATION_B, 2));

    // Once the cooldown has passed, no reason is needed.
    queries.length = 0;
    state.lastAttemptFinishedAt = new Date(Date.now() - 31 * DAY);
    state.grant.plan.items = [
      { action: "attempt_proof", claim_id: CLAIM_B, rationale: "first" },
      { action: "attempt_proof", claim_id: CLAIM_B, rationale: "again" },
    ];
    await reconcileActions();
    expect(inserts("attempt_proof")).toHaveLength(2);
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

describe("plan-to-ledger materialization writes each item's standing back (#416)", () => {
  const ledgerWrites = () =>
    queries.filter((x) => x.q.includes("UPDATE grants") && x.q.includes("jsonb_set(plan, $2::text[]"));
  const ledgerOf = (index: number) => {
    const w = ledgerWrites().find((x) => (x.params[1] as string[])[1] === String(index));
    return w ? (JSON.parse(w.params[2] as string) as { status: string; reason?: string }) : null;
  };

  it("blocks a formalize item whose claim's domains carry no publish_formalization tool, and opens no row", async () => {
    gate.missing = ["publish_formalization"];
    try {
      state.grant.plan.items = [{ action: "formalize", claim_id: CLAIM_A, rationale: "r" }];
      await reconcileActions();
      expect(inserts("formalize")).toHaveLength(0);
      const ledger = ledgerOf(0);
      expect(ledger?.status).toBe("blocked");
      expect(ledger?.reason).toContain("publish_formalization");
      expect(ledger?.reason).toContain("set_claim_domains");
    } finally {
      gate.missing = [];
    }
  });

  it("marks an attempt_proof item on a claim without a published statement as waiting, with the reason", async () => {
    state.grant.plan.items = [{ action: "attempt_proof", claim_id: CLAIM_B, rationale: "r" }];
    await reconcileActions();
    const ledger = ledgerOf(0);
    expect(ledger?.status).toBe("waiting");
    expect(ledger?.reason).toContain("no published formal statement");
  });

  it("reads a formalize item on a claim that already has a published statement as done", async () => {
    state.publishedFor.add(CLAIM_B);
    state.grant.plan.items = [{ action: "formalize", claim_id: CLAIM_B, rationale: "r" }];
    await reconcileActions();
    expect(inserts("formalize")).toHaveLength(0);
    expect(ledgerOf(0)?.status).toBe("done");
  });

  it("holds strong-tier items as waiting, not blocked, while the mandate is not active", async () => {
    state.grant.status = "planning";
    state.grant.plan.items = [
      { action: "formalize", claim_id: CLAIM_A, rationale: "r" },
      { action: "assess", claim_id: CLAIM_A, rationale: "r" },
    ];
    await reconcileActions();
    expect(ledgerOf(0)?.status).toBe("waiting");
    expect(ledgerOf(0)?.reason).toContain("not active");
    expect(ledgerOf(1)?.status).toBe("waiting");
  });

  it("does not rewrite a standing that has not changed", async () => {
    state.grant.plan.items = [
      {
        action: "attempt_proof",
        claim_id: CLAIM_B,
        rationale: "r",
        ledger: {
          status: "waiting",
          reason:
            "the claim has no published formal statement; an attempt opens only " +
            "once a formalize item has published one (docs/mathematics.md §7.2)",
          checked_at: "2026-01-01T00:00:00.000Z",
        },
      },
    ];
    await reconcileActions();
    expect(ledgerWrites()).toHaveLength(0);
  });

  it("isolates one mandate's failure: the sweep reports it and finishes", async () => {
    const { raiseIssue } = await import("../../../src/services/report-service.js");
    state.grant.plan.items = [{ action: "formalize", claim_id: CLAIM_A, rationale: "r" }];
    const { stewardTierCostEstimates } = await import("../../../src/services/cost-estimate-service.js");
    (stewardTierCostEstimates as unknown as { mockRejectedValueOnce: (e: Error) => void })
      .mockRejectedValueOnce(new Error("estimator down"));
    const result = await reconcileActions();
    // The item's failure is its own blocked reason, not a sweep abort.
    expect(result.plansFailed).toBe(0);
    expect(ledgerOf(0)?.status).toBe("blocked");
    expect(ledgerOf(0)?.reason).toContain("estimator down");
    expect(raiseIssue).not.toHaveBeenCalled();
  });
});
