import { describe, it, expect } from "vitest";

// The account page's owl history (web/lib/owl-history.ts): one line per piece
// of work with what it cost in the end. The folding is arithmetic over the
// ledger, so the first thing held here is that it never changes a sum.
import { foldDay, groupOwlHistory, isFold } from "../../../web/lib/owl-history";
import type { OwlLedgerEntry } from "../../../web/lib/account-api";

let n = 0;
function entry(
  at: string,
  amount: number,
  reason: string,
  rest: Partial<OwlLedgerEntry> = {}
): OwlLedgerEntry {
  n += 1;
  return {
    id: rest.id ?? `e-${n}`,
    amount_micro_usd: amount,
    reason,
    op: null,
    claim_id: null,
    contribution_id: null,
    job_id: null,
    settles_entry_id: null,
    created_at: at,
    ...rest,
  };
}

const sum = (xs: Array<{ netMicroUsd: number }>) => xs.reduce((t, x) => t + x.netMicroUsd, 0);

describe("groupOwlHistory", () => {
  it("folds a return into the charge the API says it settles", () => {
    const days = groupOwlHistory([
      entry("2026-11-06T10:05:00Z", 1_443_000, "meter_settlement", {
        op: "assessment", claim_id: "c-1", settles_entry_id: "hold-1",
      }),
      entry("2026-11-06T10:00:00Z", -2_000_000, "charge", {
        id: "hold-1", op: "assessment", claim_id: "c-1",
      }),
    ]);
    expect(days).toHaveLength(1);
    expect(days[0]!.lines).toHaveLength(1);
    const line = days[0]!.lines[0]!;
    expect(line.heldMicroUsd).toBe(2_000_000);
    expect(line.returnedMicroUsd).toBe(1_443_000);
    expect(line.netMicroUsd).toBe(-557_000);
  });

  it("keeps two assessments of one claim apart", () => {
    const days = groupOwlHistory([
      entry("2026-11-06T09:00:00Z", -2_000_000, "charge", { id: "a", op: "assessment", claim_id: "c-1" }),
      entry("2026-11-06T09:10:00Z", 1_500_000, "meter_settlement", { op: "assessment", claim_id: "c-1" }),
      entry("2026-11-06T11:00:00Z", -2_000_000, "charge", { id: "b", op: "assessment", claim_id: "c-1" }),
      entry("2026-11-06T11:10:00Z", 1_200_000, "meter_settlement", { op: "assessment", claim_id: "c-1" }),
    ]);
    expect(days[0]!.lines.map((l) => l.netMicroUsd)).toEqual([-800_000, -500_000]);
  });

  it("leaves a return alone when its charge is older than the list", () => {
    const days = groupOwlHistory([
      entry("2026-11-05T09:10:00Z", 1_500_000, "meter_settlement", {
        op: "assessment", claim_id: "c-9", settles_entry_id: "not-in-the-list",
      }),
      entry("2026-11-05T09:00:00Z", -2_000_000, "charge", { op: "assessment", claim_id: "c-1" }),
    ]);
    expect(days[0]!.lines).toHaveLength(2);
    expect(days[0]!.lines.find((l) => l.reason === "meter_settlement")!.netMicroUsd).toBe(1_500_000);
  });

  it("does not guess a home for a return that names no claim or contribution", () => {
    const days = groupOwlHistory([
      entry("2026-11-05T09:00:00Z", -100_000, "charge", { op: "extension_chat" }),
      entry("2026-11-05T09:01:00Z", 80_000, "meter_settlement", { op: "extension_chat" }),
    ]);
    expect(days[0]!.lines).toHaveLength(2);
  });

  it("gathers a day's Assistant charges into one line", () => {
    const days = groupOwlHistory([
      entry("2026-11-11T09:00:00Z", -119_000, "charge", { op: "assistant" }),
      entry("2026-11-11T09:02:00Z", -294_000, "charge", { op: "assistant" }),
      entry("2026-11-11T09:04:00Z", -66_000, "charge", { op: "assistant" }),
      entry("2026-11-10T09:04:00Z", -50_000, "charge", { op: "assistant" }),
    ]);
    expect(days.map((d) => d.date)).toEqual(["2026-11-11", "2026-11-10"]);
    expect(days[0]!.lines).toHaveLength(1);
    expect(days[0]!.lines[0]!.count).toBe(3);
    expect(days[0]!.lines[0]!.netMicroUsd).toBe(-479_000);
  });

  it("joins the holds that funded one job in parts, and no others", () => {
    const days = groupOwlHistory([
      entry("2026-11-10T09:00:00Z", -250_000_000, "escrow_hold", { job_id: "j-1" }),
      entry("2026-11-10T09:30:00Z", -150_000_000, "escrow_hold", { job_id: "j-1" }),
      entry("2026-11-10T10:00:00Z", -160_000_000, "escrow_hold", { job_id: "j-2" }),
      entry("2026-11-10T11:00:00Z", 20_000_000, "escrow_refund", { job_id: "j-1" }),
    ]);
    const lines = days[0]!.lines;
    expect(lines).toHaveLength(3);
    const j1 = lines.find((l) => l.reason === "escrow_hold" && l.jobId === "j-1")!;
    expect(j1.count).toBe(2);
    expect(j1.netMicroUsd).toBe(-400_000_000);
  });

  it("never changes what the ledger sums to", () => {
    const ledger = [
      entry("2026-11-01T00:00:00Z", 20_000_000, "purchase"),
      entry("2026-11-02T09:00:00Z", -2_000_000, "charge", { id: "p", op: "claim_proposal", contribution_id: "k-1" }),
      entry("2026-11-02T09:05:00Z", 1_300_000, "meter_settlement", { op: "claim_proposal", contribution_id: "k-1" }),
      entry("2026-11-02T09:06:00Z", 700_000, "refund", { op: "claim_proposal", contribution_id: "k-1" }),
      entry("2026-11-03T09:00:00Z", -100_000, "charge", { op: "assistant" }),
      entry("2026-11-03T09:00:01Z", -100_000, "charge", { op: "assistant" }),
      entry("2026-11-03T12:00:00Z", 5_000_000, "contribution_award", { contribution_id: "k-1" }),
    ];
    const days = groupOwlHistory(ledger);
    const total = days.reduce((t, d) => t + sum(d.lines), 0);
    expect(total).toBe(ledger.reduce((t, e) => t + e.amount_micro_usd, 0));
    // The refunded proposal is one line that cost nothing.
    const proposal = days.flatMap((d) => d.lines).find((l) => l.op === "claim_proposal")!;
    expect(proposal.netMicroUsd).toBe(0);
    expect(proposal.entries).toHaveLength(3);
  });
});

describe("foldDay", () => {
  it("offers four or more like lines folded under their sum, in place", () => {
    const ledger = [1, 2, 3, 4].flatMap((i) => [
      entry(`2026-11-05T0${i}:00:00Z`, -2_000_000, "charge", {
        id: `h-${i}`, op: "claim_proposal", contribution_id: `k-${i}`,
      }),
      entry(`2026-11-05T0${i}:30:00Z`, 1_000_000, "meter_settlement", {
        op: "claim_proposal", contribution_id: `k-${i}`, settles_entry_id: `h-${i}`,
      }),
    ]);
    ledger.push(entry("2026-11-05T08:00:00Z", -2_000_000, "charge", { op: "assessment", claim_id: "c-1" }));
    const [day] = groupOwlHistory(ledger);
    const shown = foldDay(day!.lines);
    expect(shown).toHaveLength(2);
    const fold = shown.find(isFold)!;
    expect(fold.lines).toHaveLength(4);
    expect(fold.netMicroUsd).toBe(-4_000_000);
    expect(sum(shown)).toBe(sum(day!.lines));
  });

  it("leaves three alone", () => {
    const ledger = [1, 2, 3].map((i) =>
      entry(`2026-11-05T0${i}:00:00Z`, -2_000_000, "charge", { op: "assessment", claim_id: `c-${i}` })
    );
    const [day] = groupOwlHistory(ledger);
    expect(foldDay(day!.lines).some(isFold)).toBe(false);
  });
});
