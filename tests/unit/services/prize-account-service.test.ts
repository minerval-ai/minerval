import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The account projection of a prize claim (docs/mathematics.md §8.7): the
 * public summary, the claim it is on, the amount at stake, and the state of
 * each of the winner's steps, with the payee deadline counted from the
 * moment the claim became payable. Nothing from the payee record beyond
 * the state of each step is served.
 */
const state = vi.hoisted(() => ({ queries: [] as Array<{ sql: string; params: unknown[] }>, rows: [] as unknown[] }));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    state.queries.push({ sql, params });
    return state.rows;
  }),
  withTransaction: vi.fn(),
  getDb: vi.fn(),
}));

import {
  openPrizeClaimFromRow,
  listOpenPrizeClaimsFor,
  type OpenPrizeClaimRow,
} from "../../../src/services/prize-account-service.js";
import { loadConfig } from "../../../src/config.js";

function row(overrides: Partial<OpenPrizeClaimRow> = {}): OpenPrizeClaimRow {
  return {
    id: "pc-1",
    contribution_id: "co-1",
    claim_id: "claim-1",
    direction: "proof",
    status: "payable",
    rejected_stage: null,
    credit_name: "Ada",
    submitted_at: new Date("2026-08-01T00:00:00Z"),
    updated_at: new Date("2026-08-20T12:00:00Z"),
    window_ends_at: new Date("2026-08-20T00:00:00Z"),
    payee: null,
    defect_award_micro_usd: null,
    claim_text: "Every even integer greater than two is the sum of two primes.",
    bounty_amount_micro_usd: "500000000",
    tax_form_received: false,
    paid_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  state.queries = [];
  state.rows = [];
});

describe("openPrizeClaimFromRow", () => {
  it("projects exactly the account shape for a payable claim with no step taken", () => {
    const out = openPrizeClaimFromRow(row({ payee: { payable_at: "2026-08-20T00:00:00.000Z" } }), { payeeStepsDays: 90 });
    expect(out).toEqual({
      id: "pc-1",
      credit_name: "Ada",
      direction: "proof",
      submitted_at: "2026-08-01T00:00:00.000Z",
      status: "payable",
      rejected_stage: null,
      contribution_id: "co-1",
      claim_id: "claim-1",
      claim_text: "Every even integer greater than two is the sum of two primes.",
      amount_micro_usd: 500_000_000,
      window_ends_at: "2026-08-20T00:00:00.000Z",
      payee_deadline_at: "2026-11-18T00:00:00.000Z",
      payee_status: "pending",
      tax_form_status: "pending",
      screening_status: "pending",
      paid_at: null,
    });
  });

  it("counts the payee deadline from payee.payable_at, and from updated_at when that stamp is absent", () => {
    const stamped = openPrizeClaimFromRow(
      row({ payee: { payable_at: "2026-08-20T00:00:00.000Z" }, updated_at: new Date("2026-08-25T00:00:00Z") }),
      { payeeStepsDays: 90 }
    );
    expect(stamped.payee_deadline_at).toBe("2026-11-18T00:00:00.000Z");
    const fallback = openPrizeClaimFromRow(row({ payee: null, updated_at: new Date("2026-08-25T00:00:00Z") }), { payeeStepsDays: 90 });
    expect(fallback.payee_deadline_at).toBe("2026-11-23T00:00:00.000Z");
    const shorter = openPrizeClaimFromRow(row({ payee: { payable_at: "2026-08-20T00:00:00.000Z" } }), { payeeStepsDays: 10 });
    expect(shorter.payee_deadline_at).toBe("2026-08-30T00:00:00.000Z");
  });

  it("reports each step from the payee record and the attachments table, and never the details", () => {
    const out = openPrizeClaimFromRow(
      row({
        payee: {
          legal_name: "Ada Lovelace",
          country: "GB",
          us_person: false,
          has_tin: false,
          treaty_position: true,
          identity_recorded_at: "2026-08-21T00:00:00.000Z",
          screening_result: "clear",
          payable_at: "2026-08-20T00:00:00.000Z",
        },
        tax_form_received: true,
      }),
      { payeeStepsDays: 90 }
    );
    expect(out.payee_status).toBe("submitted");
    expect(out.tax_form_status).toBe("received");
    expect(out.screening_status).toBe("cleared");
    expect(JSON.stringify(out)).not.toMatch(/Lovelace|"GB"|has_tin|treaty/);
  });

  it("calls any screening result other than clear blocked", () => {
    for (const result of ["match", "potential_match", "unclear"]) {
      const out = openPrizeClaimFromRow(row({ payee: { screening_result: result } }), { payeeStepsDays: 90 });
      expect(out.screening_status).toBe("blocked");
    }
  });

  it("leaves the steps null before the claim is payable", () => {
    const out = openPrizeClaimFromRow(row({ status: "in_challenge_window", payee: null }), { payeeStepsDays: 90 });
    expect(out.payee_deadline_at).toBeNull();
    expect(out.payee_status).toBeNull();
    expect(out.tax_form_status).toBeNull();
    expect(out.screening_status).toBeNull();
    expect(out.window_ends_at).toBe("2026-08-20T00:00:00.000Z");
  });

  it("owes a defect award at the award, not the bounty, and reports the payment", () => {
    const out = openPrizeClaimFromRow(
      row({ status: "paid", defect_award_micro_usd: "50000000", paid_at: new Date("2026-09-01T00:00:00Z") }),
      { payeeStepsDays: 90 }
    );
    expect(out.amount_micro_usd).toBe(50_000_000);
    expect(out.paid_at).toBe("2026-09-01T00:00:00.000Z");
  });

  it("names an anonymous claimant the way the public summary does", () => {
    expect(openPrizeClaimFromRow(row({ credit_name: null }), { payeeStepsDays: 90 }).credit_name).toBe("a contributor");
  });
});

describe("listOpenPrizeClaimsFor", () => {
  it("queries prize_claims by claimant joined to bounties and claims, reading the tax form from attachments", async () => {
    state.rows = [row({ payee: { payable_at: "2026-08-20T00:00:00.000Z" } })];
    const out = await listOpenPrizeClaimsFor("user-1");
    const q = state.queries[0]!;
    expect(q.params[0]).toBe("user-1");
    expect(q.sql).toMatch(/FROM prize_claims pc/);
    expect(q.sql).toMatch(/JOIN bounties b ON b\.id = pc\.bounty_id/);
    expect(q.sql).toMatch(/JOIN claims c ON c\.id = pc\.claim_id/);
    expect(q.sql).toMatch(/WHERE pc\.claimant_id = \$1/);
    expect(q.sql).toMatch(/FROM attachments a/);
    expect(q.sql).toMatch(/a\.kind = 'tax_form'/);
    expect(q.sql).toMatch(/tax_form_attachment_id/);
    expect(q.sql).toMatch(/FROM prize_payouts pp/);
    expect(out).toHaveLength(1);
    const days = loadConfig().prizePayeeStepsDays;
    expect(out[0]!.payee_deadline_at).toBe(new Date(Date.parse("2026-08-20T00:00:00.000Z") + days * 86_400_000).toISOString());
  });
});
