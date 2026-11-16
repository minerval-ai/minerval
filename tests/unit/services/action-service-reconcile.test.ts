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
    dueLookouts: [] as Array<{ id: string; title: string; sensitivity_label: string }>,
    // The Steward standing of the claims a test names (#834): its queue
    // state and, when it parked, the failure recorded against it.
    stewardState: "done" as string,
    stewardErrorReason: null as string | null,
    stewardAttempts: 0,
    // The action row `groupLedger` finds by id, for an item that already
    // carries an action_id.
    rowById: null as null | { id: string; status: string; exclusion_group: string },
    // The pending claims the sweep finds without an open row, each with the
    // label its row carries, and the label of any claim a test names (a
    // claim with no entry reads as no row).
    pending: [] as Array<{ id: string; sensitivity_label: string | null }>,
    claimLabels: {} as Record<string, string>,
    // The mandate's own label, and the labels of the unread messages
    // waiting on a claim (a claim with no entry has none waiting).
    grantLabel: "public" as string,
    unread: {} as Record<string, string[]>,
  },
  queries: [] as Array<{ q: string; params: unknown[] }>,
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    queries.push({ q, params });
    if (q.includes("FROM claims c") && q.includes("steward_state = 'pending'")) return state.pending;
    // runAtMandateLabel's read of the mandate's label, and pendingPassLabel's
    // read of the labels waiting on a claim (label-service.ts).
    if (q.includes("SELECT sensitivity_label FROM grants WHERE id = $1")) return [{ sensitivity_label: state.grantLabel }];
    if (q.includes("FROM node_messages") && q.includes("read_at IS NULL")) {
      return (state.unread[params[0] as string] ?? []).map((sensitivity_label) => ({ sensitivity_label }));
    }
    // runAtClaimLabel's read of the claim's label (label-service.ts).
    if (q.includes("SELECT sensitivity_label FROM claims WHERE id = $1")) {
      const label = state.claimLabels[params[0] as string];
      return label ? [{ sensitivity_label: label }] : [];
    }
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
// A stewarding item's pass is a standing order the mandate commissions
// (#849); the commission's own SQL runs in tests/db/standing-orders.test.ts.
vi.mock("../../../src/services/standing-order-service.js", () => ({
  orderTier: (variant: unknown) => (variant === "standard" || variant === "strong" ? variant : null),
  placeStandingOrder: vi.fn(async () => ({
    state: "placed",
    actionId: "act-1",
    budgetMicroUsd: 1_500_000,
    tier: "strong",
  })),
  releaseStandingOrder: vi.fn(async () => 0),
  orderChildPasses: vi.fn(async () => ({ children: [], notOrdered: [], waiting: null, blocked: null, note: null })),
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
  ASSESS_GROUP,
  ATTEMPT_GROUP,
  FORMALIZE_GROUP,
  LOOKOUT_GROUP,
  reconcileActions,
} from "../../../src/services/action-service.js";
import { runWithUsageContext } from "../../../src/llm/usage-context.js";

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
  state.pending = [];
  state.claimLabels = {};
  state.grantLabel = "public";
  state.unread = {};
});

// The sweep starts from a pending slot. A node's own row is its slot for
// work at its own label, so the rows the sweep opens for it are at the
// node's label, in that label's own group (src/labels.ts). A row that is a
// mandate's work, or a lookout's, takes the mandate's or the lookout's.
describe("rows opened by the sweep", () => {
  const assessRows = () =>
    queries.filter((x) => x.q.includes("INSERT INTO actions") && ["assess", "reassess"].includes(x.params[0] as string));

  it("opens a pending claim's assess rows at the claim's label", async () => {
    state.pending = [
      { id: CLAIM_A, sensitivity_label: "internal" },
      { id: CLAIM_B, sensitivity_label: "public" },
    ];
    await reconcileActions();
    const rows = assessRows();
    // A standard and a strong row for each claim; the label is the last parameter.
    expect(rows.map((r) => [r.params[1], r.params[2], r.params[6]])).toEqual([
      [ASSESS_GROUP(CLAIM_A, "internal"), "standard", "internal"],
      [ASSESS_GROUP(CLAIM_A, "internal"), "strong", "internal"],
      [ASSESS_GROUP(CLAIM_B), "standard", "public"],
      [ASSESS_GROUP(CLAIM_B), "strong", "public"],
    ]);
    expect(ASSESS_GROUP(CLAIM_A, "internal")).toBe(`assess:${CLAIM_A} @internal`);
    expect(ASSESS_GROUP(CLAIM_B)).toBe(`assess:${CLAIM_B}`);
  });

  it("opens a pending claim's rows at the claim's own label whatever labels its unread messages carry", async () => {
    state.pending = [
      { id: CLAIM_A, sensitivity_label: "public" },
      { id: CLAIM_B, sensitivity_label: "public" },
    ];
    // A message at another label waits in that label's own slot and has its
    // own rows (tests/db/label-governance.test.ts); it does not decide the
    // label of the node's own pass.
    state.unread = { [CLAIM_A]: ["internal"], [CLAIM_B]: ["internal", "embargoed"] };
    await reconcileActions();
    expect(assessRows().map((r) => [r.params[1], r.params[6]])).toEqual([
      [ASSESS_GROUP(CLAIM_A), "public"],
      [ASSESS_GROUP(CLAIM_A), "public"],
      [ASSESS_GROUP(CLAIM_B), "public"],
      [ASSESS_GROUP(CLAIM_B), "public"],
    ]);
  });

  it("opens no row for a pending claim read without its label, and carries on with the rest", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      state.pending = [
        { id: CLAIM_A, sensitivity_label: null },
        { id: CLAIM_B, sensitivity_label: "internal" },
      ];
      await reconcileActions();
      expect(assessRows().map((r) => [r.params[1], r.params[6]])).toEqual([
        [ASSESS_GROUP(CLAIM_B, "internal"), "internal"],
        [ASSESS_GROUP(CLAIM_B, "internal"), "internal"],
      ]);
      expect(logged.mock.calls.flat().join(" ")).toContain("carries no label");
    } finally {
      logged.mockRestore();
    }
  });

  it("opens a plan's formalize and attempt rows at the mandate's label, whatever the claims' are", async () => {
    // A mandate decides for its work. The claims' own labels are not read.
    state.grantLabel = "internal";
    state.claimLabels = { [CLAIM_A]: "embargoed", [CLAIM_B]: "public" };
    state.publishedFor.add(CLAIM_B);
    state.grant.plan.items = [
      { action: "formalize", claim_id: CLAIM_A, rationale: "a statement" },
      { action: "attempt_proof", claim_id: CLAIM_B, variant: "max", rationale: "a proof" },
    ];
    await reconcileActions();
    expect(inserts("formalize").map((r) => r.params)).toEqual([[FORMALIZE_GROUP(CLAIM_A, "internal"), CLAIM_A, 3_000_000, "internal"]]);
    const attempts = inserts("attempt_proof");
    expect(attempts).toHaveLength(2);
    expect(attempts.map((r) => r.params[6])).toEqual(["internal", "internal"]);
    expect(queries.some((x) => x.q.includes("SELECT sensitivity_label FROM claims"))).toBe(false);
  });

  it("opens a mandate's review row, and its planning row, at the mandate's label", async () => {
    state.grantLabel = "internal";
    await reconcileActions();
    expect(inserts("mandate_review").map((r) => [r.params[1], r.params[4]])).toEqual([["g-1", "internal"]]);
    queries.length = 0;
    state.grant.status = "planning";
    await reconcileActions();
    expect(inserts("grant_planning").map((r) => [r.params[1], r.params[4]])).toEqual([["g-1", "internal"]]);
  });

  it("leaves them at the run's label when a run, not the sweep, materializes the plan", async () => {
    // A Grantmaker's run that writes a plan materializes it there and then:
    // the rows are that run's work, as everything a run opens is.
    state.grantLabel = "internal";
    state.claimLabels = { [CLAIM_A]: "internal" };
    state.grant.plan.items = [{ action: "formalize", claim_id: CLAIM_A, rationale: "a statement" }];
    await runWithUsageContext({ label: "public" }, () => reconcileActions());
    expect(inserts("formalize").map((r) => r.params[3])).toEqual(["public"]);
  });
});

describe("lookout_run rows (docs/allocation.md, Lookouts)", () => {
  it("opens one standard row per due lookout in group lookout:<id>, reopening a closed row only when the lookout is due again", async () => {
    state.dueLookouts = [{ id: "l-1", title: "Retraction watch", sensitivity_label: "internal" }];
    await reconcileActions();
    const due = queries.find((x) => x.q.includes("FROM lookouts l"))!;
    // Due = heartbeat passed, or an unconsumed event waits; active on both sides.
    expect(due.q).toContain("l.next_due_at <= now()");
    expect(due.q).toContain("consumed_at IS NULL");
    expect(due.q).toContain("g.status = 'active'");
    const rows = inserts("lookout_run");
    expect(rows).toHaveLength(1);
    // The last parameter is the row's label: the lookout's own, read with the row.
    expect(due.q).toContain("l.sensitivity_label");
    expect(rows[0]!.params).toEqual([LOOKOUT_GROUP("l-1"), "l-1", 'Lookout run: "Retraction watch"', 50_000, "internal"]);
    expect(rows[0]!.q).toMatch(/WHERE actions.status IN \('done', 'superseded', 'cancelled'\)/);
    // A closed row opened again takes the new work's text and target. Its
    // label is the lookout's and never changes.
    expect(rows[0]!.q).not.toContain("EXCLUDED.sensitivity_label");
    expect(rows[0]!.q).toContain("THEN EXCLUDED.label ELSE actions.label");
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
    expect(rows[0]!.params).toEqual([FORMALIZE_GROUP(CLAIM_A), CLAIM_A, 3_000_000, "public"]);
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
      "public",
    ]);
    expect(rows[1]!.params).toEqual([
      ATTEMPT_GROUP(FORMALIZATION_B, 3),
      "max",
      FORMALIZATION_B,
      "3",
      150_000_000,
      CLAIM_B,
      "public",
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
    expect(reopen!.q).toContain("a.kind NOT IN ('ingest', 'attempt_proof') AND a.updated_at < now() - interval '60 minutes'");
    expect(reopen!.q).toContain("a.kind = 'ingest' AND a.updated_at < now() - interval '24 hours'");
    expect(reopen!.q).toContain("a.kind = 'attempt_proof' AND a.updated_at < now() - make_interval(hours => 3)");
    // An ingest whose extraction is still queued or being read is not a dead
    // worker's (tests/db/commission-backfill.test.ts runs it).
    expect(reopen!.q).toMatch(/a\.kind = 'ingest'[\s\S]*NOT EXISTS \(\s*SELECT 1 FROM jobs j[\s\S]*j\.status IN \('pending', 'processing'\)/);
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
    // Nothing is queued or commissioned while the claim is parked: the
    // pass would fail the same way, and the lanes would retire the row
    // again. The order's budget is taken back off the retired row (#849).
    expect(enqueueSteward).not.toHaveBeenCalled();
    const orders = await import("../../../src/services/standing-order-service.js");
    expect(orders.placeStandingOrder).not.toHaveBeenCalled();
    expect(orders.releaseStandingOrder).toHaveBeenCalledWith("g-1", CLAIM_A);
  });

  it("orders the pass afresh once the park has cleared, rather than reading cancelled forever", async () => {
    state.stewardState = "done";
    // The retired row, reopened by the commission the order places.
    state.rowById = { ...ROW, status: "open" };
    state.grant.plan.items = [
      { ...parkedItem()[0]!, ledger: { ...parkedItem()[0]!.ledger, status: "cancelled" }, budget_owls: 2, variant: "strong" },
    ];
    const orders = await import("../../../src/services/standing-order-service.js");
    (orders.placeStandingOrder as unknown as { mockClear: () => void }).mockClear();
    state.rowById = ROW;
    const reopened = { ...ROW, status: "open" };
    (orders.placeStandingOrder as unknown as { mockImplementationOnce: (f: () => Promise<unknown>) => void })
      .mockImplementationOnce(async () => {
        state.rowById = reopened;
        return { state: "placed", actionId: ROW.id, budgetMicroUsd: 2_000_000, tier: "strong" };
      });
    await reconcileActions();
    // The mandate commissions the pass, at the item's budget and on the
    // tier the item names; the brief says the kind of pass and nothing
    // about who paid.
    expect(orders.placeStandingOrder).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: "g-1", claimId: CLAIM_A, tier: "strong", budgetMicroUsd: 2_000_000 })
    );
    const brief = (orders.placeStandingOrder as unknown as { mock: { calls: Array<[{ brief: string }]> } }).mock
      .calls[0]![0].brief;
    expect(brief).toBe("A funded mandate scheduled a reassess pass on this claim.");
    const ledger = ledgerOf(0) as { status: string; order?: { budget_owls: number; tier: string } };
    expect(ledger.status).toBe("open");
    expect(ledger.order).toMatchObject({ budget_owls: 2, tier: "strong" });
  });

  it("asks for an item that names no variant with no tier, so nothing is placed on one nobody chose (#956)", async () => {
    state.stewardState = "done";
    state.grant.plan.items = [{ action: "reassess", claim_id: CLAIM_A, rationale: "written before items named a tier" }];
    const orders = await import("../../../src/services/standing-order-service.js");
    const place = orders.placeStandingOrder as unknown as {
      mockClear: () => void;
      mockImplementationOnce: (f: () => Promise<unknown>) => void;
    };
    place.mockClear();
    place.mockImplementationOnce(async () => ({ state: "blocked", reason: "this item names no variant" }));
    await reconcileActions();
    expect(orders.placeStandingOrder).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: CLAIM_A, tier: null })
    );
    expect(ledgerOf(0)).toMatchObject({ status: "blocked", reason: "this item names no variant" });
  });

  it("reads a withdrawn item cancelled, releases what it placed, and never asks for its order again (#956)", async () => {
    state.stewardState = "pending";
    state.rowById = { ...ROW, status: "open" };
    state.grant.plan.items = [
      {
        action: "reassess",
        claim_id: CLAIM_A,
        rationale: "r",
        variant: "strong",
        withdrawn: { at: "2026-11-12T10:00:00.000Z", note: "a standard pass is enough here" },
        ledger: {
          status: "open",
          action_id: ROW.id,
          exclusion_group: ROW.exclusion_group,
          checked_at: "2026-11-12T00:00:00.000Z",
          order: { budget_owls: 5.8, tier: "strong", placed_at: "2026-11-12T00:00:00.000Z" },
        },
      },
    ];
    const orders = await import("../../../src/services/standing-order-service.js");
    (orders.placeStandingOrder as unknown as { mockClear: () => void }).mockClear();
    const release = orders.releaseStandingOrder as unknown as {
      mockClear: () => void;
      mockImplementationOnce: (f: () => Promise<number>) => void;
    };
    release.mockClear();
    release.mockImplementationOnce(async () => 5_800_000);
    await reconcileActions();
    expect(orders.releaseStandingOrder).toHaveBeenCalledWith("g-1", CLAIM_A);
    expect(orders.placeStandingOrder).not.toHaveBeenCalled();
    const ledger = ledgerOf(0)!;
    expect(ledger.status).toBe("cancelled");
    expect(ledger.reason).toContain("withdrawn by the mandate's Grantmaker on 2026-11-12");
    expect(ledger.reason).toContain("a standard pass is enough here");
    expect(ledger.reason).toContain("5.8 owls it held are back");
    // Settled: the next look leaves it exactly as it is.
    state.grant.plan.items[0]!.ledger = ledger as never;
    release.mockClear();
    await reconcileActions();
    expect(orders.releaseStandingOrder).not.toHaveBeenCalled();
    expect(orders.placeStandingOrder).not.toHaveBeenCalled();
  });
});
