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
    dueLookouts: [] as Array<{ id: string; title: string }>,
    // The Steward standing of the claims a test names (#834): its queue
    // state and, when it parked, the failure recorded against it.
    stewardState: "done" as string,
    stewardErrorReason: null as string | null,
    stewardAttempts: 0,
    // The action row `groupLedger` finds by id, for an item that already
    // carries an action_id.
    rowById: null as null | { id: string; status: string; exclusion_group: string },
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
      return [
        {
          id,
          state: "active",
          steward_state: state.stewardState,
          steward_error_reason: state.stewardErrorReason,
          steward_attempts: state.stewardAttempts,
          published: state.publishedFor.has(id),
        },
      ];
    }
    // ensureAssessActions' own claim read (its label and whether the claim
    // is already assessed).
    if (q.includes("FROM claims c") && q.includes("c.state = 'active'") && q.includes("AS assessed")) {
      return [{ text: "a claim", assessed: true }];
    }
    if (q.includes("FROM actions WHERE id = $1")) {
      return state.rowById && state.rowById.id === params[0] ? [state.rowById] : [];
    }
    if (q.includes("FROM grants") && q.includes("plan_cursor")) return [state.grant];
    if (q.includes("FROM lookouts l")) return state.dueLookouts;
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
  loadConfig: () => ({ stewardStrongModel: "strong", owlCostMicroUsd: 1_000_000, capLookoutRunOwls: 0.05 }),
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
  LOOKOUT_GROUP,
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
  state.dueLookouts = [];
  state.stewardState = "done";
  state.stewardErrorReason = null;
  state.stewardAttempts = 0;
  state.rowById = null;
});

describe("lookout_run rows (docs/allocation.md, Lookouts)", () => {
  it("opens one standard row per due lookout in group lookout:<id>, reopening a closed row only when the lookout is due again", async () => {
    state.dueLookouts = [{ id: "l-1", title: "Retraction watch" }];
    await reconcileActions();
    const due = queries.find((x) => x.q.includes("FROM lookouts l"))!;
    // Due = heartbeat passed, or an unconsumed event waits; active on both sides.
    expect(due.q).toContain("l.next_due_at <= now()");
    expect(due.q).toContain("consumed_at IS NULL");
    expect(due.q).toContain("g.status = 'active'");
    const rows = inserts("lookout_run");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.params).toEqual([LOOKOUT_GROUP("l-1"), "l-1", 'Lookout run: "Retraction watch"', 50_000]);
    expect(rows[0]!.q).toMatch(/WHERE actions.status IN \('done', 'superseded', 'cancelled'\)/);
  });

  it("opens nothing when no lookout is due", async () => {
    await reconcileActions();
    expect(inserts("lookout_run")).toHaveLength(0);
  });
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
    // The second item entitles the second group; with no reason on it, the
    // cooldown holds it back.
    state.grant.plan.items = [
      { action: "attempt_proof", claim_id: CLAIM_B, rationale: "a new lemma in the subtree was formalized since" },
      { action: "attempt_proof", claim_id: CLAIM_B, rationale: "  " },
    ];
    await reconcileActions();
    expect(inserts("attempt_proof")).toHaveLength(0);

    // A stated reason opens it, however short: whether it is reason enough is
    // the Grantmaker's judgment, public and open to audit, not a test of its
    // length (#763).
    queries.length = 0;
    state.grant.plan.items = [
      { action: "attempt_proof", claim_id: CLAIM_B, rationale: "first" },
      { action: "attempt_proof", claim_id: CLAIM_B, rationale: "new lemma" },
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

/**
 * A funded stewarding item whose row was retired because the claim parked
 * as 'error' (#834). The park, not the ledger, is the thing to fix: the
 * item says so with the recorded failure rather than inviting another item
 * that would be retired the same way. Once the park clears, the funder's
 * item gets the pass it paid for.
 */
describe("a stewarding item whose row was retired while the claim was parked (#834)", () => {
  const ROW = { id: "act-1", status: "cancelled", exclusion_group: `assess:${CLAIM_A}` };
  const ledgerOf = (index: number) => {
    const w = queries
      .filter((x) => x.q.includes("UPDATE grants") && x.q.includes("jsonb_set(plan, $2::text[]"))
      .find((x) => (x.params[1] as string[])[1] === String(index));
    return w ? (JSON.parse(w.params[2] as string) as { status: string; reason?: string }) : null;
  };
  const parkedItem = () => [
    {
      action: "reassess",
      claim_id: CLAIM_A,
      rationale: "r",
      ledger: { status: "open", action_id: ROW.id, checked_at: "2026-01-01T00:00:00.000Z" },
    },
  ];

  it("states the park and the class of its error, and does not ask for another item", async () => {
    state.stewardState = "error";
    state.stewardErrorReason = "model_refusal";
    state.stewardAttempts = 3;
    state.rowById = ROW;
    state.grant.plan.items = parkedItem();
    const { enqueueSteward } = await import("../../../src/services/queue-service.js");
    await reconcileActions();
    const ledger = ledgerOf(0);
    expect(ledger?.status).toBe("cancelled");
    expect(ledger?.reason).toContain("parked this claim as 'error'");
    expect(ledger?.reason).toContain("3 failed passes");
    // The explanation is public: it carries the fixed class, which is all
    // the reconciler reads (#846).
    expect(ledger?.reason).toContain("Reason: the model refused the request.");
    expect(ledger?.reason).not.toContain("add another item");
    // Nothing is queued while the claim is parked: the pass would fail the
    // same way, and the lanes would retire the row again.
    expect(enqueueSteward).not.toHaveBeenCalled();
  });

  it("opens a fresh row once the park has cleared, rather than reading cancelled forever", async () => {
    state.stewardState = "done";
    state.rowById = ROW;
    state.grant.plan.items = parkedItem();
    const { enqueueSteward } = await import("../../../src/services/queue-service.js");
    await reconcileActions();
    expect(enqueueSteward).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: CLAIM_A, trigger: "mandate_plan" })
    );
    // ensureAssessActions reopens the retired row for the funded pass
    // (its kind is a bound parameter, so match the group).
    const opened = queries.filter(
      (x) => x.q.includes("INSERT INTO actions") && x.params[1] === `assess:${CLAIM_A}`
    );
    expect(opened.length).toBeGreaterThan(0);
    expect(opened[0]!.params[0]).toBe("reassess");
  });
});
