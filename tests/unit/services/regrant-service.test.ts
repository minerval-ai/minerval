import { describe, it, expect, beforeEach, vi } from "vitest";

// Regrants: grants funding grants as peers. Headroom counts everything
// the source escrow is committed to; a regrant grows the target's budget
// job (resuming it if paused at the floor); spawning mints a peer mandate
// in planning seeded entirely by a regrant.

const { state } = vi.hoisted(() => ({
  state: {
    source: null as null | Record<string, unknown>,
    target: null as null | Record<string, unknown>,
    jobSpent: 0,
    exposure: { spentMicroUsd: 0, outstandingMicroUsd: 0 },
    regrantsOut: 0,
    inserted: [] as Array<{ table: string; params: unknown[] }>,
    jobUpdates: [] as unknown[][],
    deleted: [] as string[],
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    if (q.includes("FROM regrants WHERE from_grant_id")) {
      return [{ total: state.regrantsOut }];
    }
    if (q.includes("g.status = 'active'") && q.includes("j.budget_micro_usd")) {
      return state.source ? [state.source] : [];
    }
    if (q.includes("status IN ('planning', 'pending_approval', 'active')")) {
      return state.target ? [state.target] : [];
    }
    if (q.includes("WHERE id = $1 AND status = 'active'") && q.includes("funder_user_id")) {
      return state.source ? [state.source] : [];
    }
    if (q.includes("INSERT INTO regrants")) {
      state.inserted.push({ table: "regrants", params });
      return [{ id: "rg-1" }];
    }
    if (q.includes("INSERT INTO budget_jobs")) {
      state.inserted.push({ table: "budget_jobs", params });
      return [{ id: "job-new" }];
    }
    if (q.includes("INSERT INTO grants")) {
      state.inserted.push({ table: "grants", params });
      return [{ id: "grant-new" }];
    }
    if (q.includes("UPDATE budget_jobs")) {
      state.jobUpdates.push(params);
      return [];
    }
    if (q.startsWith("DELETE FROM")) {
      state.deleted.push(q);
      return [];
    }
    return [];
  }),
}));

vi.mock("../../../src/services/budget-job-service.js", () => ({
  getJobSpentMicroUsd: vi.fn(async () => state.jobSpent),
}));

vi.mock("../../../src/services/allocation-service.js", () => ({
  grantAllocationExposureMicroUsd: vi.fn(async () => state.exposure),
}));

import {
  createRegrant,
  spawnFundedMandate,
} from "../../../src/services/regrant-service.js";

beforeEach(() => {
  state.source = {
    id: "g-src",
    budget_job_id: "job-src",
    budget_micro_usd: 10_000_000,
    funder_user_id: "u-1",
  };
  state.target = { id: "g-dst", budget_job_id: "job-dst" };
  state.jobSpent = 0;
  state.exposure = { spentMicroUsd: 0, outstandingMicroUsd: 0 };
  state.regrantsOut = 0;
  state.inserted = [];
  state.jobUpdates = [];
  state.deleted = [];
});

describe("createRegrant", () => {
  it("moves budget to the target and grows its job", async () => {
    const r = await createRegrant({
      fromGrantId: "g-src",
      toGrantId: "g-dst",
      owls: 3,
      note: "the ingestion slice",
    });
    expect(r).toMatchObject({ ok: true, toGrantId: "g-dst", amountOwls: 3 });
    const row = state.inserted.find((i) => i.table === "regrants");
    expect(row!.params).toEqual(["g-src", "g-dst", 3_000_000, "the ingestion slice"]);
    // Target job credited (and would resume from paused_budget).
    expect(state.jobUpdates[0]).toEqual(["job-dst", 3_000_000]);
  });

  it("refuses past the source's committed headroom", async () => {
    // 10 owls budget: 4 metered + 3 allocated + 2 regranted = 1 owl free.
    state.jobSpent = 4_000_000;
    state.exposure = { spentMicroUsd: 1_000_000, outstandingMicroUsd: 2_000_000 };
    state.regrantsOut = 2_000_000;
    const r = await createRegrant({
      fromGrantId: "g-src",
      toGrantId: "g-dst",
      owls: 2,
    });
    expect(r).toMatchObject({ ok: false, code: "INSUFFICIENT_BUDGET" });
    expect(state.inserted).toHaveLength(0);
  });

  it("refuses self-regrants and dead targets", async () => {
    expect(
      (await createRegrant({ fromGrantId: "g", toGrantId: "g", owls: 1 }))
    ).toMatchObject({ ok: false, code: "SELF_REGRANT" });
    state.target = null;
    expect(
      (await createRegrant({ fromGrantId: "g-src", toGrantId: "g-x", owls: 1 }))
    ).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
  });
});

describe("spawnFundedMandate", () => {
  it("mints a peer mandate in planning, seeded entirely by the regrant", async () => {
    // createRegrant's target lookup must find the NEW grant.
    state.target = { id: "grant-new", budget_job_id: "job-new" };
    const r = await spawnFundedMandate({
      fromGrantId: "g-src",
      title: "Physics ingestion",
      objective: "Bring the physics literature into the graph.",
      owls: 5,
    });
    expect(r).toMatchObject({ ok: true, grantId: "grant-new" });
    const grantInsert = state.inserted.find((i) => i.table === "grants");
    expect(grantInsert).toBeDefined();
    const regrant = state.inserted.find((i) => i.table === "regrants");
    expect(regrant!.params[2]).toBe(5_000_000);
  });

  it("rolls the new grant back when the regrant fails", async () => {
    state.jobSpent = 10_000_000; // no headroom
    state.target = { id: "grant-new", budget_job_id: "job-new" };
    const r = await spawnFundedMandate({
      fromGrantId: "g-src",
      title: "x",
      objective: "y",
      owls: 5,
    });
    expect(r.ok).toBe(false);
    expect(state.deleted.some((q) => q.includes("FROM grants"))).toBe(true);
    expect(state.deleted.some((q) => q.includes("FROM budget_jobs"))).toBe(true);
  });
});
