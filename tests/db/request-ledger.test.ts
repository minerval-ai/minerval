/**
 * Requests on the action ledger (Part VIII), against real Postgres: a
 * filed request opens its row (a scoping pass without a budget, the full
 * work at its budget), readers and mandates put money on it within what
 * the row lacks, a closed request returns its funders' money, the request
 * formula values it in a formula mandate's scope, and a funded row runs:
 * a scoping pass's quote becomes the budget and opens the full work, and
 * the full work's outcome is recorded for the keeper.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const researcher = vi.hoisted(() => {
  process.env.RESEARCHER_ENABLED = "true";
  return { report: null as Record<string, unknown> | null, billed: 0 };
});

vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this file");
  }),
}));

// The Researcher stands in: it reports what the test sets and meters what
// the test says it cost.
vi.mock("../../src/llm/agents/researcher.js", async (orig) => {
  const real = await orig<typeof import("../../src/llm/agents/researcher.js")>();
  const { getUsageContext } = await import("../../src/llm/usage-context.js");
  return {
    ...real,
    runResearcher: vi.fn(async () => {
      const meter = getUsageContext().meter;
      if (meter) meter.billedMicroUsd += researcher.billed;
      return {
        status: "completed",
        report: researcher.report,
        turns: 3,
        stopReason: "report",
        servedModels: [],
        toolNames: [],
        error: null,
      };
    }),
  };
});

import { rawQuery } from "../../src/db/client.js";
import { OWL, creditOwls, owlBalance, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";
import {
  fileRequest,
  getRequest,
  setRequestBudget,
  setRequestState,
} from "../../src/services/request-service.js";
import { REQUEST_GROUP } from "../../src/services/action-service.js";
import {
  allocateMandateToRequest,
  allocateToRequest,
} from "../../src/services/allocation-service.js";
import { refreshRequestValuations } from "../../src/services/mandate-valuer-service.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { processNextEngineAction } from "../../src/workers/engine-executor.js";

async function rows(requestId: string) {
  return rawQuery<{ id: string; variant: string; status: string; cost_est_micro_usd: string }>(
    `SELECT id, variant, status, cost_est_micro_usd FROM actions
      WHERE exclusion_group = $1 ORDER BY created_at`,
    [REQUEST_GROUP(requestId)]
  );
}

async function claim(importance = 0.6): Promise<string> {
  const id = await seedClaim("request ledger");
  await rawQuery(`UPDATE claims SET steward_state = 'done', importance = $2 WHERE id = $1`, [id, importance]);
  return id;
}

async function file(opts: { budgetUsd?: number; claimId?: string } = {}): Promise<string> {
  const claimId = opts.claimId ?? (await claim());
  const { id } = await fileRequest({
    ask: "Find the trial's registered primary outcome",
    why: "If it differs from the reported one, the claim's support is weaker",
    satisfiedBy: "The registry entry, quoted",
    claimIds: [claimId],
    budgetUsd: opts.budgetUsd ?? null,
    filer: { kind: "admin", agent: "claim_steward" },
  });
  return id;
}

beforeAll(async () => {
  // No platform mandate funds anything here unless a test seeds one.
  await rawQuery(
    `UPDATE grants SET status = 'completed'
      WHERE is_platform = true OR policy IN ('general', 'governance')`
  );
  resetAllocationPolicyCache();
});

beforeEach(() => {
  researcher.report = null;
  researcher.billed = 0;
});

describe("a request's row", () => {
  it("is a scoping pass at the prior when the request has no budget", async () => {
    const id = await file();
    const [row] = await rows(id);
    expect(row).toMatchObject({ variant: "scope", status: "open" });
    // est_request_scope_cost_owls: 0.5 owl until the ledger has its own figures.
    expect(Number(row!.cost_est_micro_usd)).toBe(0.5 * OWL);
    const view = await getRequest(id);
    expect(view!.budget_usd).toBeNull();
    expect(view!.ledger).toMatchObject({ variant: "scope", status: "open", cost_usd: 0.5, backing_usd: 0 });
  });

  it("is the full work at the budget when one is stated, and a budget set later supersedes the scoping pass", async () => {
    const stated = await file({ budgetUsd: 12 });
    expect((await rows(stated)).map((r) => [r.variant, r.status, Number(r.cost_est_micro_usd)])).toEqual([
      ["full", "open", 12 * OWL],
    ]);

    const later = await file();
    await setRequestBudget({ requestId: later, budgetUsd: 30 });
    const after = await rows(later);
    expect(after.find((r) => r.variant === "scope")!.status).toBe("superseded");
    expect(after.find((r) => r.variant === "full")).toMatchObject({ status: "open" });
    expect((await getRequest(later))!.budget_usd).toBe(30);
  });
});

describe("funding a request", () => {
  it("takes a reader's owls up to what the row lacks, and gives them back when the request closes", async () => {
    const id = await file({ budgetUsd: 4 });
    const reader = await seedUser("request reader");
    await creditOwls(reader, 10 * OWL);

    const first = await allocateToRequest({ userId: reader, requestId: id, owls: 3 });
    expect(first).toMatchObject({ ok: true, allocatedOwls: 3, variant: "full", covered: false });
    // Clipped to the 1 owl the row still lacks.
    const second = await allocateToRequest({ userId: reader, requestId: id, owls: 5 });
    expect(second).toMatchObject({ ok: true, allocatedOwls: 1, backingOwls: 4, covered: true });
    expect(await owlBalance(reader)).toBe(6 * OWL);
    const third = await allocateToRequest({ userId: reader, requestId: id, owls: 1 });
    expect(third).toMatchObject({ ok: false, code: "COVERED" });

    await setRequestState({ requestId: id, state: "moot", note: "answered elsewhere" });
    expect((await rows(id))[0]!.status).toBe("cancelled");
    expect(await owlBalance(reader)).toBe(10 * OWL);
    const live = await rawQuery(
      `SELECT 1 FROM action_allocations WHERE exclusion_group = $1 AND released_at IS NULL`,
      [REQUEST_GROUP(id)]
    );
    expect(live).toHaveLength(0);
    expect(await allocateToRequest({ userId: reader, requestId: id, owls: 1 })).toMatchObject({
      ok: false,
      code: "CLOSED",
    });
  });

  it("takes a mandate's money within its uncommitted escrow, folding in its earlier placement", async () => {
    const id = await file({ budgetUsd: 20 });
    const funder = await seedUser("request mandate");
    const mandate = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 8 * OWL });

    const first = await allocateMandateToRequest({ grantId: mandate.grantId, requestId: id, microUsd: 5 * OWL });
    expect(first).toMatchObject({ ok: true, placedMicroUsd: 5 * OWL, covered: false });
    // Only 3 owls of the escrow are left uncommitted.
    const second = await allocateMandateToRequest({ grantId: mandate.grantId, requestId: id, microUsd: 10 * OWL });
    expect(second).toMatchObject({ ok: true, placedMicroUsd: 3 * OWL, backingMicroUsd: 8 * OWL });
    const live = await rawQuery<{ amount_micro_usd: string }>(
      `SELECT amount_micro_usd FROM action_allocations
        WHERE exclusion_group = $1 AND grant_id = $2 AND released_at IS NULL`,
      [REQUEST_GROUP(id), mandate.grantId]
    );
    // One live placement for the whole 8.
    expect(live.map((l) => Number(l.amount_micro_usd))).toEqual([8 * OWL]);
    expect(
      await allocateMandateToRequest({ grantId: mandate.grantId, requestId: id, microUsd: OWL })
    ).toMatchObject({ ok: false, code: "NO_ROOM" });
  });
});

describe("the request formula", () => {
  it("values open request rows, a scoped mandate only those bearing on its scope", async () => {
    const inScope = await claim(0.8);
    const outside = await claim(0.8);
    const near = await file({ claimId: inScope, budgetUsd: 5 });
    const far = await file({ claimId: outside, budgetUsd: 5 });
    const funder = await seedUser("formula mandate");
    const mandate = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 10 * OWL, policy: "general" });

    await refreshRequestValuations(mandate.grantId, { scopeClaimId: inScope, scopeQuery: null });
    const valued = await rawQuery<{ target_ref: string; value_est: number }>(
      `SELECT a.target_ref, mv.value_est FROM mandate_valuations mv
         JOIN actions a ON a.id = mv.action_id WHERE mv.grant_id = $1`,
      [mandate.grantId]
    );
    expect(valued.map((v) => v.target_ref)).toEqual([near]);
    expect(valued.map((v) => v.target_ref)).not.toContain(far);
    // weight 3 × importance 0.8 × contested-factor 0.25 (uncontested) × admin
    // filer 1.0 × a fresh request's wait factor ≈ 1.
    expect(Number(valued[0]!.value_est)).toBeCloseTo(0.6, 2);
  });
});

describe("running a funded request", () => {
  async function fund(id: string, owls: number) {
    const reader = await seedUser("request funder");
    await creditOwls(reader, owls * OWL);
    const placed = await allocateToRequest({ userId: reader, requestId: id, owls });
    expect(placed).toMatchObject({ ok: true, covered: true });
    return reader;
  }

  /** Run only this request's row: nothing else the suite left open is runnable. */
  async function runOnly(id: string) {
    await rawQuery(
      `UPDATE actions SET status = 'cancelled'
        WHERE status = 'open' AND exclusion_group <> $1`,
      [REQUEST_GROUP(id)]
    );
    return processNextEngineAction();
  }

  it("turns a scoping pass's quote into the budget and opens the full work", async () => {
    const id = await file();
    const reader = await fund(id, 0.5);
    researcher.billed = 0.2 * OWL;
    researcher.report = { answer: "Two registries to read, one paid lookup.", request_outcome: "scoped", budget_quote_usd: 15 };

    const result = await runOnly(id);
    expect(result).toMatchObject({ status: "processed", kind: "request", ok: true });
    const after = await rows(id);
    expect(after.find((r) => r.variant === "scope")!.status).toBe("done");
    expect(after.find((r) => r.variant === "full")).toMatchObject({ status: "open" });
    expect(Number(after.find((r) => r.variant === "full")!.cost_est_micro_usd)).toBe(15 * OWL);
    const view = await getRequest(id);
    expect(view!.budget_usd).toBe(15);
    expect(view!.work.at(-1)!.summary).toContain("Scoped at about $15.00");
    // The reader paid the metered 0.2 and got the rest of the 0.5 back.
    expect(await owlBalance(reader)).toBe(0.3 * OWL);
    // The scoping run was told it scopes, and worked under the row's funding.
    const [run] = await rawQuery<{ requested_by: string; ceiling_micro_usd: string; model_tier: string }>(
      `SELECT requested_by, ceiling_micro_usd, model_tier FROM research_runs
        WHERE request_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [id]
    );
    expect(run).toMatchObject({ requested_by: "request_scope", model_tier: "standard" });
    expect(Number(run!.ceiling_micro_usd)).toBe(0.5 * OWL);
  });

  it("records the full work's outcome for the keeper, never naming a funder", async () => {
    const id = await file({ budgetUsd: 2 });
    await fund(id, 2);
    researcher.billed = 1.5 * OWL;
    researcher.report = {
      answer: "The registered outcome was the same; the claim's support stands.",
      request_outcome: "negative",
    };
    const result = await runOnly(id);
    expect(result).toMatchObject({ status: "processed", kind: "request", ok: true });
    expect((await rows(id))[0]!.status).toBe("done");
    const work = (await getRequest(id))!.work;
    expect(work.map((w) => [w.by, w.outcome])).toEqual([
      ["Researcher", null],
      ["Researcher", "negative"],
    ]);
    expect(work.map((w) => w.summary).join(" ")).not.toMatch(/mandate|fund/i);
  });
});
