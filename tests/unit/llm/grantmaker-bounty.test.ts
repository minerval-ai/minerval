/**
 * post_bounty's two-pass rule and bounds (docs/mathematics.md §8.1): the
 * first call records the request on the mandate and creates a `requested`
 * bounty; only a call from a LATER pass opens it; the same pass cannot;
 * the service's bounds come back as the problem; withdraw_bounty gives
 * notice through the service. One implementation for both paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  pending: null as null | { at: string; bounty_id: string },
  live: null as null | Record<string, unknown>,
  grantUpdates: [] as Array<{ sql: string; params: unknown[] }>,
  requests: [] as Array<Record<string, unknown>>,
  opens: [] as Array<Record<string, unknown>>,
  requestResult: { ok: true, bounty_id: "b-1", status: "requested", opened: false } as Record<string, unknown>,
  openResult: { ok: true, bounty_id: "b-1", status: "open", opened: true } as Record<string, unknown>,
  withdraws: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("bounty_requests") && sql.startsWith("SELECT")) {
      return [state.pending ? { at: state.pending.at, bounty_id: state.pending.bounty_id } : { at: null, bounty_id: null }];
    }
    if (sql.startsWith("UPDATE grants")) {
      state.grantUpdates.push({ sql, params });
      return [];
    }
    return [];
  }),
  withTransaction: vi.fn(),
}));
vi.mock("../../../src/services/bounty-service.js", () => ({
  requestBounty: vi.fn(async (input: Record<string, unknown>) => {
    state.requests.push(input);
    return state.requestResult;
  }),
  openBounty: vi.fn(async (input: Record<string, unknown>) => {
    state.opens.push(input);
    return state.openResult;
  }),
  withdrawBounty: vi.fn(async (input: Record<string, unknown>) => {
    state.withdraws.push(input);
    return { ok: true, status: "open", effective_at: "2026-04-01T00:00:00.000Z" };
  }),
  getBountyById: vi.fn(async (id: string) => (state.live && state.live.id === id ? state.live : null)),
  getLiveBountyForClaim: vi.fn(async () => state.live),
  formatUsd: (micro: number) => `$${micro / 1_000_000}`,
}));

import { executeManagementTool, getBountyToolDefinitions } from "../../../src/llm/agents/grantmaker.js";

const GRANT = "11111111-1111-4111-8111-111111111111";
const CLAIM = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  state.pending = null;
  state.live = null;
  state.grantUpdates = [];
  state.requests = [];
  state.opens = [];
  state.withdraws = [];
  state.requestResult = { ok: true, bounty_id: "b-1", status: "requested", opened: false };
  state.openResult = { ok: true, bounty_id: "b-1", status: "open", opened: true };
});

describe("post_bounty", () => {
  it("is declared with withdraw_bounty for both the review pass and the chat", () => {
    expect(getBountyToolDefinitions().map((t) => t.name)).toEqual(["post_bounty", "withdraw_bounty"]);
  });

  it("first call: records the request on the mandate and returns opened:false", async () => {
    const passStartedAt = new Date("2026-03-10T10:00:00Z");
    const out = JSON.parse((await executeManagementTool(GRANT, "post_bounty", { claim_id: CLAIM, cash_usd: 500, expires_in_days: 180, rationale: "a live crux" }, { passStartedAt }))!);
    expect(out).toMatchObject({ success: true, opened: false, bounty_id: "b-1", status: "requested" });
    expect(state.requests[0]).toMatchObject({ claimId: CLAIM, cashUsd: 500, expiresInDays: 180, rationale: "a live crux", grantId: GRANT, passStartedAt });
    expect(state.opens).toHaveLength(0);
    expect(state.grantUpdates[0]!.sql).toMatch(/bounty_requests/);
    expect(state.grantUpdates[0]!.params).toEqual([GRANT, CLAIM, "b-1", 500, "a live crux"]);
  });

  it("a second call in the SAME pass does not open: the request is re-recorded", async () => {
    const passStartedAt = new Date(Date.now() - 3_600_000);
    state.pending = { at: new Date(Date.now() - 1_800_000).toISOString(), bounty_id: "b-1" };
    state.live = { id: "b-1", status: "requested", amount_micro_usd: 500_000_000 };
    const out = JSON.parse((await executeManagementTool(GRANT, "post_bounty", { claim_id: CLAIM, cash_usd: 500, rationale: "still" }, { passStartedAt }))!);
    expect(out.opened).toBe(false);
    expect(state.opens).toHaveLength(0);
    expect(state.requests).toHaveLength(1);
  });

  it("a call from a LATER pass opens it and clears the request", async () => {
    state.pending = { at: new Date(Date.now() - 86_400_000).toISOString(), bounty_id: "b-1" };
    state.live = { id: "b-1", status: "requested", amount_micro_usd: 500_000_000 };
    const passStartedAt = new Date(Date.now() - 60_000);
    const out = JSON.parse((await executeManagementTool(GRANT, "post_bounty", { claim_id: CLAIM, cash_usd: 500, rationale: "still right" }, { passStartedAt }))!);
    expect(out).toMatchObject({ success: true, opened: true, status: "open", amount: "$500" });
    expect(state.opens[0]).toMatchObject({ bountyId: "b-1", passStartedAt, confirmedBy: null });
    expect(state.requests).toHaveLength(0);
    expect(state.grantUpdates[0]!.sql).toMatch(/#- ARRAY\['bounty_requests'/);
  });

  it("a stale request (older than the confirmation window) starts over", async () => {
    state.pending = { at: new Date(Date.now() - 30 * 86_400_000).toISOString(), bounty_id: "b-1" };
    state.live = { id: "b-1", status: "requested", amount_micro_usd: 500_000_000 };
    const out = JSON.parse((await executeManagementTool(GRANT, "post_bounty", { claim_id: CLAIM, cash_usd: 500, rationale: "again" }, { passStartedAt: new Date() }))!);
    expect(out.opened).toBe(false);
    expect(state.requests).toHaveLength(1);
  });

  it("at or above the autonomy threshold the later pass parks at confirm_pending", async () => {
    state.pending = { at: new Date(Date.now() - 86_400_000).toISOString(), bounty_id: "b-1" };
    state.live = { id: "b-1", status: "requested", amount_micro_usd: 1_500_000_000 };
    state.openResult = { ok: true, bounty_id: "b-1", status: "confirm_pending", opened: false };
    const out = JSON.parse((await executeManagementTool(GRANT, "post_bounty", { claim_id: CLAIM, cash_usd: 1500, rationale: "big" }, { passStartedAt: new Date(Date.now() - 60_000) }))!);
    expect(out).toMatchObject({ success: true, opened: false, status: "confirm_pending" });
    expect(out.note).toMatch(/confirm/);
  });

  it("returns the service's bounds as the problem", async () => {
    state.requestResult = { ok: false, code: "AMOUNT_OUT_OF_BOUNDS", message: "a bounty is between $250 and $5,000 per claim" };
    const out = JSON.parse((await executeManagementTool(GRANT, "post_bounty", { claim_id: CLAIM, cash_usd: 50, rationale: "tiny" }, { passStartedAt: new Date() }))!);
    expect(out).toMatchObject({ success: false, code: "AMOUNT_OUT_OF_BOUNDS" });
    expect(state.grantUpdates).toHaveLength(0);
  });

  it("refuses a malformed claim id or a missing rationale before touching anything", async () => {
    expect(JSON.parse((await executeManagementTool(GRANT, "post_bounty", { claim_id: "nope", cash_usd: 500, rationale: "x" }))!)).toMatchObject({ success: false });
    expect(JSON.parse((await executeManagementTool(GRANT, "post_bounty", { claim_id: CLAIM, cash_usd: 500, rationale: "" }))!)).toMatchObject({ success: false, problem: /rationale/ });
    expect(state.requests).toHaveLength(0);
  });
});

describe("withdraw_bounty", () => {
  it("gives notice through the service for a bounty on this mandate only", async () => {
    state.live = { id: "b-1", status: "open", posted_by_grant_id: GRANT, amount_micro_usd: 500_000_000 };
    const out = JSON.parse((await executeManagementTool(GRANT, "withdraw_bounty", { bounty_id: "b-1", rationale: "the statement is being reworked" }))!);
    expect(out).toMatchObject({ success: true, effective_at: "2026-04-01T00:00:00.000Z" });
    expect(state.withdraws[0]).toMatchObject({ bountyId: "b-1", actor: `grantmaker:${GRANT}` });
    state.live = { id: "b-1", status: "open", posted_by_grant_id: "other", amount_micro_usd: 1 };
    expect(JSON.parse((await executeManagementTool(GRANT, "withdraw_bounty", { bounty_id: "b-1", rationale: "x" }))!)).toMatchObject({ success: false });
  });

  it("returns null for a tool it does not own", async () => {
    expect(await executeManagementTool(GRANT, "not_a_tool", {})).toBeNull();
  });
});
