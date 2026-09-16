import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Lookouts (docs/allocation.md, "Lookouts"): the mechanism around a
 * mandate's standing watch. Creation enforces the bounds the brief cannot;
 * a reassess flag makes the claim a candidate and writes the mandate's
 * valuation CLAMPED to the delegated ceiling, folding repeats while the
 * earlier flag is still open; an ingest flag appends to the mandate's plan
 * and refuses a source already in the graph; the run stamp advances the
 * heartbeat and backs a failed run off. DB mocked.
 */

const GRANT = "11111111-1111-4111-8111-111111111111";
const LOOKOUT = "22222222-2222-4222-8222-222222222222";
const CLAIM = "33333333-3333-4333-8333-333333333333";
const ACTION = "44444444-4444-4444-8444-444444444444";

const { state, queries } = vi.hoisted(() => ({
  state: {
    // (hoisted: the module-level constants are not yet initialized here)
    grantActive: true,
    claimActive: true,
    openFlag: null as null | { id: string; created_at: Date; repeats: number },
    current: null as null | { id: string; status: string; claim_credence: number | null },
    standardAction: "44444444-4444-4444-8444-444444444444" as string | null,
    existingSource: null as null | { id: string; title: string },
    planned: false,
    lookout: null as null | Record<string, unknown>,
    valuations: [] as Array<{ grantId: string; entries: unknown[] }>,
    enqueued: [] as Array<Record<string, unknown>>,
    ensured: [] as string[],
  },
  queries: [] as Array<{ q: string; params: unknown[] }>,
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    queries.push({ q, params });
    if (q.includes("FROM grants WHERE id = $1 AND status = 'active'")) {
      return state.grantActive ? [{ id: GRANT }] : [];
    }
    if (q.includes("INSERT INTO lookouts")) return [{ id: LOOKOUT }];
    if (q.includes("FROM lookouts") && q.includes("WHERE id = $1")) {
      return state.lookout ? [state.lookout] : [];
    }
    if (q.includes("SELECT id, state FROM claims WHERE id = $1")) {
      return state.claimActive ? [{ id: CLAIM, state: "active" }] : [];
    }
    if (q.includes("FROM lookout_flags f") && q.includes("f.kind = 'reassess'")) {
      return state.openFlag ? [state.openFlag] : [];
    }
    if (q.includes("FROM assessments") && q.includes("is_current = true LIMIT 1")) {
      return state.current ? [state.current] : [];
    }
    if (q.includes("variant = 'standard' AND status = 'open'")) {
      return state.standardAction ? [{ id: state.standardAction }] : [];
    }
    if (q.includes("INSERT INTO lookout_flags")) return [{ id: "flag-1" }];
    if (q.includes("SELECT id, title FROM sources WHERE url = $1")) {
      return state.existingSource ? [state.existingSource] : [];
    }
    if (q.includes("jsonb_array_elements(COALESCE(plan->'items'")) {
      return state.planned ? [{ id: GRANT }] : [];
    }
    if (q.includes("INSERT INTO lookout_events")) return [{ id: "ev-1" }];
    return [];
  }),
  withTransaction: vi.fn(),
}));

vi.mock("../../../src/services/action-service.js", () => ({
  ASSESS_GROUP: (id: string) => `assess:${id}`,
  ensureAssessActions: vi.fn(async (id: string) => {
    state.ensured.push(id);
  }),
}));
vi.mock("../../../src/services/queue-service.js", () => ({
  enqueueSteward: vi.fn(async (m: Record<string, unknown>) => {
    state.enqueued.push(m);
  }),
}));
vi.mock("../../../src/services/mandate-valuer-service.js", () => ({
  setMandateValuations: vi.fn(async (grantId: string, entries: unknown[]) => {
    state.valuations.push({ grantId, entries });
    return { written: entries.length, unknownActionIds: [] };
  }),
}));
vi.mock("../../../src/services/url-guard.js", () => ({
  UnsafeUrlError: class UnsafeUrlError extends Error {},
  assertPublicHttpUrl: vi.fn(async (raw: string) => {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Refusing non-HTTP(S) URL");
    return u;
  }),
}));

import {
  createLookout,
  flagReassessment,
  flagIngest,
  recordLookoutRun,
  queueLookoutEventsByTrigger,
  updateLookout,
  LOOKOUT_BOUNDS,
} from "../../../src/services/lookout-service.js";

const BRIEF =
  "Watch the retraction record behind the sources under the nutrition claims; " +
  "flag any claim resting on a retracted or corrected paper; ignore commentary.";

beforeEach(() => {
  queries.length = 0;
  state.grantActive = true;
  state.claimActive = true;
  state.openFlag = null;
  state.current = { id: "as-1", status: "supported", claim_credence: 0.8 };
  state.standardAction = ACTION;
  state.existingSource = null;
  state.planned = false;
  state.lookout = null;
  state.valuations = [];
  state.enqueued = [];
  state.ensured = [];
});

describe("createLookout", () => {
  it("posts a lookout with clamped bounds and normalized triggers", async () => {
    const res = await createLookout({
      grantId: GRANT,
      title: "Retraction watch",
      brief: BRIEF,
      heartbeatHours: 100_000,
      triggers: ["retraction", "retraction", "manual"],
      maxValue: 42,
      maxIngestsPerRun: -3,
      createdBy: "grantmaker:review",
    });
    expect(res).toEqual({ ok: true, lookoutId: LOOKOUT });
    const insert = queries.find((x) => x.q.includes("INSERT INTO lookouts"))!;
    expect(insert.params).toEqual([
      GRANT,
      "Retraction watch",
      BRIEF,
      LOOKOUT_BOUNDS.heartbeatHours.max,
      JSON.stringify(["retraction", "manual"]),
      null,
      10,
      0,
      "grantmaker:review",
    ]);
  });

  it("refuses a short brief, an unknown trigger, an unresolvable model, and a watch that never wakes", async () => {
    const base = { grantId: GRANT, title: "x y z", brief: BRIEF, createdBy: "t" };
    expect((await createLookout({ ...base, brief: "too short" })).ok).toBe(false);
    expect(await createLookout({ ...base, triggers: ["rss"] })).toMatchObject({ ok: false, code: "TRIGGERS" });
    expect(await createLookout({ ...base, model: "us.anthropic.claude-x" })).toMatchObject({ ok: false, code: "MODEL" });
    expect(await createLookout({ ...base, heartbeatHours: 0 })).toMatchObject({ ok: false, code: "NEVER_WAKES" });
    expect(await createLookout({ ...base, heartbeatHours: 0, triggers: ["manual"] })).toMatchObject({ ok: true });
  });

  it("refuses a mandate that is not active", async () => {
    state.grantActive = false;
    expect(await createLookout({ grantId: GRANT, title: "x y z", brief: BRIEF, createdBy: "t" })).toMatchObject({
      ok: false,
      code: "MANDATE_NOT_ACTIVE",
    });
  });
});

describe("updateLookout", () => {
  it("changes only the given fields, on the mandate's own lookout, and makes a resumed watch due now", async () => {
    state.lookout = { id: LOOKOUT, grant_id: GRANT, status: "paused", heartbeat_hours: 24, max_value: 6, max_ingests_per_run: 3 };
    const res = await updateLookout({ grantId: GRANT, lookoutId: LOOKOUT, status: "active", maxValue: 3 });
    expect(res.ok).toBe(true);
    const upd = queries.find((x) => x.q.startsWith("UPDATE lookouts SET"))!;
    expect(upd.q).toContain("status = $2");
    expect(upd.q).toContain("next_due_at = $3");
    expect(upd.q).toContain("max_value = $4");
    expect(upd.params[1]).toBe("active");
    expect(upd.params[3]).toBe(3);
  });

  it("refuses another mandate's lookout and a retired one", async () => {
    state.lookout = { id: LOOKOUT, grant_id: "other", status: "active" };
    expect(await updateLookout({ grantId: GRANT, lookoutId: LOOKOUT, title: "new title" })).toMatchObject({ code: "NOT_FOUND" });
    state.lookout = { id: LOOKOUT, grant_id: GRANT, status: "retired" };
    expect(await updateLookout({ grantId: GRANT, lookoutId: LOOKOUT, title: "new title" })).toMatchObject({ code: "RETIRED" });
  });
});

describe("flagReassessment", () => {
  const flag = (over: Partial<Parameters<typeof flagReassessment>[0]> = {}) =>
    flagReassessment({
      lookoutId: LOOKOUT,
      grantId: GRANT,
      maxValue: 6,
      claimId: CLAIM,
      rationale: "Crossref records a retraction notice against the primary source.",
      urgency: 9,
      ...over,
    });

  it("makes the claim a candidate with the lookout's context and values it CLAMPED to the ceiling", async () => {
    const res = await flag();
    expect(res).toMatchObject({ ok: true, duplicate: false, action_id: ACTION, value_written: 6 });
    expect(state.enqueued).toHaveLength(1);
    expect(state.enqueued[0]).toMatchObject({ claimId: CLAIM, trigger: "lookout_flag" });
    expect(String(state.enqueued[0]!.context)).toContain("retraction notice");
    expect(state.ensured).toEqual([CLAIM]);
    expect(state.valuations).toEqual([
      { grantId: GRANT, entries: [{ action_id: ACTION, value: 6, rationale: expect.stringContaining("[lookout]") }] },
    ]);
    // The flag snapshots the assessment for the precision read.
    const ins = queries.find((x) => x.q.includes("INSERT INTO lookout_flags"))!;
    expect(ins.params).toEqual([LOOKOUT, CLAIM, ACTION, expect.any(String), 9, 6, "supported", 0.8, "as-1"]);
  });

  it("writes urgency itself when it is under the ceiling, and nothing at a ceiling of 0", async () => {
    expect(await flag({ urgency: 4 })).toMatchObject({ value_written: 4 });
    state.valuations = [];
    const res = await flag({ maxValue: 0 });
    expect(res).toMatchObject({ ok: true, value_written: null });
    expect(state.valuations).toHaveLength(0);
    // Still a candidate: the Steward lane and the ledger row exist either way.
    expect(state.enqueued).toHaveLength(2);
  });

  it("folds a repeat on a claim whose earlier flag is still waiting, rewriting nothing", async () => {
    state.openFlag = { id: "flag-0", created_at: new Date("2026-09-01T00:00:00Z"), repeats: 0 };
    const res = await flag();
    expect(res).toMatchObject({ ok: true, duplicate: true, flag_id: "flag-0" });
    expect(state.enqueued).toHaveLength(0);
    expect(state.valuations).toHaveLength(0);
    expect(queries.some((x) => x.q.includes("repeats = repeats + 1"))).toBe(true);
  });

  it("refuses an inactive claim and an empty rationale", async () => {
    state.claimActive = false;
    expect(await flag()).toMatchObject({ ok: false, code: "CLAIM" });
    state.claimActive = true;
    expect(await flag({ rationale: "" })).toMatchObject({ ok: false, code: "RATIONALE" });
  });
});

describe("flagIngest", () => {
  const ingest = (over: Partial<Parameters<typeof flagIngest>[0]> = {}) =>
    flagIngest({
      lookoutId: LOOKOUT,
      grantId: GRANT,
      url: "https://example.org/paper",
      rationale: "The primary source for the live crux; not yet in the graph.",
      ...over,
    });

  it("appends an ingest item to the mandate's plan and records the flag", async () => {
    const res = await ingest();
    expect(res).toMatchObject({ ok: true, duplicate: false });
    const upd = queries.find((x) => x.q.includes("UPDATE grants") && x.q.includes("jsonb_set"))!;
    expect(upd.params[0]).toBe(GRANT);
    expect(JSON.parse(upd.params[1] as string)).toEqual([
      { action: "ingest", url: "https://example.org/paper", rationale: expect.stringContaining("[lookout]") },
    ]);
  });

  it("refuses a source already in the graph, a planned URL, and an unsafe URL", async () => {
    state.existingSource = { id: "s-1", title: "Paper" };
    expect(await ingest()).toMatchObject({ ok: false, code: "ALREADY_IN_GRAPH" });
    state.existingSource = null;
    state.planned = true;
    expect(await ingest()).toMatchObject({ ok: false, code: "ALREADY_PLANNED" });
    state.planned = false;
    expect(await ingest({ url: "ftp://example.org/x" })).toMatchObject({ ok: false, code: "URL" });
  });
});

describe("recordLookoutRun and triggers", () => {
  it("advances the heartbeat from now, counts the run, and backs a failed run off", async () => {
    await recordLookoutRun({ lookoutId: LOOKOUT, note: "nothing to report", flagsRaised: 0 });
    const upd = queries.find((x) => x.q.includes("UPDATE lookouts") && x.q.includes("runs = runs + 1"))!;
    expect(upd.q).toContain("make_interval(hours => heartbeat_hours)");
    expect(upd.q).toContain("'infinity'::timestamptz");
    expect(upd.params).toEqual([LOOKOUT, "nothing to report", 0, false]);
    queries.length = 0;
    await recordLookoutRun({ lookoutId: LOOKOUT, note: null, flagsRaised: 0, failed: true });
    expect(queries[0]!.params).toEqual([LOOKOUT, null, 0, true]);
    expect(queries[0]!.q).toContain("interval '6 hours'");
  });

  it("fans an event out only to active lookouts on active mandates that hold the trigger, under a pending cap", async () => {
    const res = await queueLookoutEventsByTrigger({ kind: "retraction", payload: { doi: "10.1/x" }, maxPendingPerLookout: 7 });
    expect(res).toEqual({ queued: 1 });
    const ins = queries.find((x) => x.q.includes("INSERT INTO lookout_events"))!;
    expect(ins.q).toContain("l.triggers ? $1");
    expect(ins.q).toContain("g.status = 'active'");
    expect(ins.params).toEqual(["retraction", JSON.stringify({ doi: "10.1/x" }), 7]);
  });
});
