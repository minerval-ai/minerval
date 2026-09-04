import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The public bounty read models (docs/mathematics.md §8.3, §11.1): GET
 * /prizes serves each open bounty with the claim it is pinned to, in the
 * shape the browse card reads (text, kind, assessment, importance,
 * checked); the Atom feed and the mandate's bounty table say the same
 * thing; and every bounty transition emits a `prize` claim event beside
 * its audit row.
 */
const state = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  events: [] as Array<Record<string, unknown>>,
  listing: [] as unknown[],
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    state.queries.push({ sql, params });
    if (sql.includes("FROM bounties b") && sql.includes("JOIN claims c")) return state.listing;
    if (sql.includes("COUNT(*)::int AS n FROM bounties")) return [{ n: state.listing.length }];
    if (sql.includes("FROM claim_formalizations WHERE id")) return [{ source_hash: "sh", expr_hash: "eh", pin_id: "pin-1" }];
    if (sql.includes("COUNT(*)::int AS n FROM prize_claims")) return [{ n: 2 }];
    // The mandate's prize numbers (§8.1): its escrow job, and the prize
    // term's breakdown from the shared FROM clause.
    if (sql.includes("FROM grants g JOIN budget_jobs j")) return [{ budget_job_id: "job-1", budget_micro_usd: 2_500_000_000 }];
    if (sql.includes("AS held")) return [{ held: 500_000_000, paid: 0, reserve: 50_000_000, total: 550_000_000 }];
    return [];
  }),
  withTransaction: vi.fn(),
  getDb: vi.fn(),
}));
vi.mock("../../../src/services/claim-events-service.js", () => ({
  emitClaimEvent: vi.fn(async (event: Record<string, unknown>) => {
    state.events.push(event);
  }),
}));
vi.mock("../../../src/services/contributor-service.js", () => ({
  getOrCreateContributor: vi.fn(async () => ({ id: "platform" })),
}));
vi.mock("../../../src/services/queue-service.js", () => ({ requestAudit: vi.fn(async () => "run") }));
// Committed money, every term included (the prize term among them).
vi.mock("../../../src/services/regrant-service.js", () => ({
  grantCommittedMicroUsd: vi.fn(async () => 600_000_000),
}));

import {
  listOpenBounties,
  openBountiesAtom,
  mandatePrizesBlock,
  logBountyEvent,
  bountyStatusAfter,
  bountyEventSubtype,
  PRIZE_RULES_VERSION,
} from "../../../src/services/bounty-service.js";

function listingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "b-1",
    claim_id: "claim-1",
    formalization_id: "f-1",
    condition_type: "lean_statement",
    resolution: "either",
    amount_micro_usd: "500000000",
    status: "open",
    rules_version: PRIZE_RULES_VERSION,
    posted_by_grant_id: "g-1",
    rationale: "x",
    requested_at: new Date("2026-08-01T00:00:00Z"),
    opened_at: new Date("2026-08-02T00:00:00Z"),
    expires_at: null,
    human_confirmed_at: null,
    human_confirmed_by: null,
    withdraw_effective_at: null,
    resolved_at: null,
    resolution_note: null,
    text: "Every even integer greater than two is the sum of two primes.",
    claim_type: "mathematical",
    importance: 0.8,
    assessment_status: "contested",
    checked: null,
    ...overrides,
  };
}

beforeEach(() => {
  state.queries = [];
  state.events = [];
  state.listing = [];
});

describe("listOpenBounties", () => {
  it("serves the browse-card shape: text, claim_type, assessment_status, importance, checked, bounty", async () => {
    state.listing = [listingRow()];
    const { items, total } = await listOpenBounties({ limit: 10 });
    expect(total).toBe(1);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(Object.keys(item).sort()).toEqual(
      ["assessment_status", "bounty", "checked", "claim_id", "claim_type", "importance", "text"].sort()
    );
    expect(item).toMatchObject({
      claim_id: "claim-1",
      text: "Every even integer greater than two is the sum of two primes.",
      claim_type: "mathematical",
      assessment_status: "contested",
      importance: 0.8,
      checked: null,
    });
    expect(item.bounty).toMatchObject({ id: "b-1", amount_micro_usd: 500_000_000, status: "open", pin_id: "pin-1", submissions: 2 });
    expect("claim_text" in item).toBe(false);
    // The bounty summary carries none of the claim columns.
    expect("text" in item.bounty).toBe(false);
  });

  it("joins the current assessment and derives checked from the published statement's accepted check", async () => {
    state.listing = [listingRow({ checked: "proof", assessment_status: null, importance: "0.25" })];
    const { items } = await listOpenBounties();
    const q = state.queries.find((x) => x.sql.includes("FROM bounties b"))!;
    expect(q.sql).toMatch(/LEFT JOIN assessments a ON a\.claim_id = c\.id AND a\.is_current = true/);
    expect(q.sql).toMatch(/c\.claim_type/);
    expect(q.sql).toMatch(/c\.importance/);
    expect(q.sql).toMatch(/FROM lean_checks lc/);
    expect(q.sql).toMatch(/AS checked/);
    expect(q.sql).toMatch(/b\.status IN \('open', 'claim_pending'\)/);
    expect(items[0]).toMatchObject({ checked: "proof", assessment_status: null, importance: 0.25 });
  });
});

describe("openBountiesAtom", () => {
  it("titles each entry with the claim's text", async () => {
    state.listing = [listingRow({ text: "A <claim> & its text" })];
    const { items } = await listOpenBounties();
    const xml = openBountiesAtom(items, "https://minerval.example");
    expect(xml).toContain("500 owls for a proof or disproof: A &lt;claim&gt; &amp; its text</title>");
    expect(xml).not.toContain("$");
    expect(xml).toContain('<link href="https://minerval.example/claims/claim-1"/>');
    expect(xml).toContain("urn:minerval:bounty:b-1");
  });
});

describe("mandatePrizesBlock", () => {
  it("lists each bounty with the claim's text under `text`", async () => {
    const { rawQuery } = await import("../../../src/db/client.js");
    (rawQuery as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => [
      { id: "b-1", claim_id: "claim-1", text: "The claim", amount_micro_usd: "500000000", status: "open", opened_at: new Date("2026-08-02T00:00:00Z"), resolution_note: null, submissions: 1, reserve: 0, reserve_spent: 0 },
    ]);
    const block = await mandatePrizesBlock("g-1");
    expect(block.bounties[0]).toMatchObject({ id: "b-1", claim_id: "claim-1", text: "The claim", amount_micro_usd: 500_000_000, status: "open" });
    expect("claim_text" in block.bounties[0]!).toBe(false);
    expect(block.bounties_posted).toBe(1);
    // The mandate's prize numbers (§8.1): escrow, held, paid, the review
    // reserve, and headroom = budget less committed money; no fund anywhere.
    expect(block).toMatchObject({
      escrow_micro_usd: 2_500_000_000,
      held_micro_usd: 500_000_000,
      paid_micro_usd: 0,
      review_reserve_micro_usd: 50_000_000,
      headroom_micro_usd: 1_900_000_000,
    });
    expect("pool_balance_micro_usd" in block).toBe(false);
  });
});

describe("logBountyEvent", () => {
  const runner = { query: vi.fn(async () => []) };

  it("writes the audit row and emits a prize event with the bounty id and its new status", async () => {
    await logBountyEvent(
      runner,
      { id: "b-1", claim_id: "claim-1", status: "requested", formalization_id: "f-1", amount_micro_usd: "500000000", rules_version: PRIZE_RULES_VERSION },
      "opened",
      "offered"
    );
    expect(runner.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO audit_log"), ["claim-1", "bounty:opened", "bounty b-1: offered", "prize_service"]);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      kind: "prize",
      subtype: "bounty_opened",
      claim_id: "claim-1",
      bounty_id: "b-1",
      prize_claim_id: null,
      formalization_id: "f-1",
      amount_micro_usd: 500_000_000,
      status: "open",
      rules_version: PRIZE_RULES_VERSION,
      actor: "prize_service",
    });
  });

  it("emits on every transition, with the terminal statuses as resolutions and nulls for what a bare row lacks", async () => {
    await logBountyEvent(runner, { id: "b-2", claim_id: "claim-2" }, "requested", "asked");
    await logBountyEvent(runner, { id: "b-2", claim_id: "claim-2", status: "claim_pending" }, "claim_pending", "under review");
    await logBountyEvent(runner, { id: "b-2", claim_id: "claim-2", status: "open" }, "withdrawal_noticed", "notice");
    await logBountyEvent(runner, { id: "b-2", claim_id: "claim-2", status: "expired" }, "expired", "dated");
    expect(state.events.map((e) => [e.subtype, e.status])).toEqual([
      ["bounty_requested", "requested"],
      ["bounty_opened", "claim_pending"],
      ["bounty_opened", "open"],
      ["bounty_resolved", "expired"],
    ]);
    expect(state.events[0]).toMatchObject({ formalization_id: null, amount_micro_usd: null, rules_version: null, bounty_id: "b-2" });
  });

  it("does not fail the transition when a listener throws", async () => {
    const { emitClaimEvent } = await import("../../../src/services/claim-events-service.js");
    (emitClaimEvent as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("listener down"));
    await expect(logBountyEvent(runner, { id: "b-3", claim_id: "claim-3" }, "expired", "dated")).resolves.toBeUndefined();
  });
});

describe("the transition vocabulary", () => {
  it("maps the logged action to the status the bounty now holds", () => {
    expect(bountyStatusAfter("opened")).toBe("open");
    expect(bountyStatusAfter("rebound", "rebinding")).toBe("open");
    expect(bountyStatusAfter("confirm_pending", "requested")).toBe("confirm_pending");
    expect(bountyStatusAfter("paid", "claim_pending")).toBe("paid");
    expect(bountyStatusAfter("withdrawal_noticed", "open")).toBe("open");
  });

  it("files a status under the read model's three bounty subtypes", () => {
    expect(bountyEventSubtype("requested")).toBe("bounty_requested");
    expect(bountyEventSubtype("confirm_pending")).toBe("bounty_requested");
    for (const s of ["open", "claim_pending", "house_result_pending", "rebinding"]) expect(bountyEventSubtype(s)).toBe("bounty_opened");
    for (const s of ["paid", "resolved_internally", "resolved_unpaid", "expired", "withdrawn"]) expect(bountyEventSubtype(s)).toBe("bounty_resolved");
  });
});
