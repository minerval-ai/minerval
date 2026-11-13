/**
 * A mandate's pace against real Postgres (pace-service.ts): as needed is
 * bounded by the escrow alone; steady holds commitments to a rolling window;
 * the Grantmaker's reserve stops officers and plan orders but not the
 * Grantmaker; and the pace is the funder's, changed only in their chat.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { commissionNodePass } from "../../src/services/commission-service.js";
import { paceRoom, parsePace, validatePace } from "../../src/services/pace-service.js";
import { executeMandateOperationsTool } from "../../src/llm/agents/program-officer.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

async function mandate(opts: { escrow: number; perDay?: number }) {
  const funder = await seedUser("pace funder");
  return seedGrantWithJob({ funderId: funder, budgetMicroUsd: opts.escrow, dailyBudgetMicroUsd: opts.perDay ?? 0 });
}

const pass = (grantId: string, claimId: string, budget: number, by: string) =>
  commissionNodePass({
    payer: { kind: "grant", grantId },
    claimId,
    budgetMicroUsd: budget,
    brief: "Read the new replication against the original.",
    reason: "A replication landed.",
    commissionedBy: by,
  });

describe("pace", () => {
  it("bounds an as-needed mandate by its escrow alone, and says so", async () => {
    const { grantId } = await mandate({ escrow: 10 * OWL });
    expect(await pass(grantId, await seedClaim("a"), 6 * OWL, "program_officer")).toMatchObject({ ok: true });
    const over = await pass(grantId, await seedClaim("b"), 5 * OWL, "program_officer");
    expect(over).toMatchObject({ ok: false, code: "OVER_ESCROW" });
    const room = (await paceRoom(grantId, "delegated"))!;
    expect(room.pace).toEqual({ kind: "as_needed", reason: null });
    expect(room.availableMicroUsd).toBe(4 * OWL);
    expect(room.sentence).toContain("as needed: the escrow is the only bound");
  });

  it("holds a steady mandate to its rolling window, which frees as commitments age out", async () => {
    const { grantId } = await mandate({ escrow: 100 * OWL, perDay: 5 * OWL });
    expect(await pass(grantId, await seedClaim("c"), 3 * OWL, "program_officer")).toMatchObject({ ok: true });
    const over = await pass(grantId, await seedClaim("d"), 3 * OWL, "program_officer");
    expect(over).toMatchObject({ ok: false, code: "OVER_PACE" });
    expect(!over.ok && over.message).toContain("2 of 5 owls per 24 hours");
    // A commitment older than the window no longer counts against it.
    await rawQuery(`UPDATE action_allocations SET created_at = now() - interval '25 hours' WHERE grant_id = $1`, [grantId]);
    expect(await pass(grantId, await seedClaim("e"), 3 * OWL, "program_officer")).toMatchObject({ ok: true });
  });

  it("keeps the reserve from officers and plan orders, lets the Grantmaker draw on it, and states it", async () => {
    const { grantId } = await mandate({ escrow: 10 * OWL });
    const set = JSON.parse(
      (await executeMandateOperationsTool(grantId, "set_reserve", { owls: 7, reason: "for the directions the first wave opens" }, { chat: false }))!
    );
    expect(set.success).toBe(true);
    expect(set.message).toContain("The Grantmaker holds 7 owls in reserve (for the directions the first wave opens)");
    const officer = await pass(grantId, await seedClaim("f"), 4 * OWL, "program_officer");
    expect(officer).toMatchObject({ ok: false, code: "OVER_PACE" });
    expect(!officer.ok && officer.message).toContain("7 are reserved");
    expect(await pass(grantId, await seedClaim("g"), 4 * OWL, "plan")).toMatchObject({ ok: false, code: "OVER_PACE" });
    expect(await pass(grantId, await seedClaim("h"), 2 * OWL, "program_officer")).toMatchObject({ ok: true });
    expect(await pass(grantId, await seedClaim("i"), 6 * OWL, "grantmaker")).toMatchObject({ ok: true });
    const [d] = await rawQuery<{ decision: string; reason: string }>(
      `SELECT decision, reason FROM mandate_decisions WHERE grant_id = $1 AND item_kind = 'reserve'`,
      [grantId]
    );
    expect(d).toEqual({ decision: "held in reserve", reason: "for the directions the first wave opens" });
    // A reserve can be at most what is uncommitted.
    const tooBig = JSON.parse((await executeMandateOperationsTool(grantId, "set_reserve", { owls: 50, reason: "x" }, { chat: false }))!);
    expect(tooBig.success).toBe(false);
  });

  it("changes only in the funder's chat, and records why", async () => {
    const { grantId } = await mandate({ escrow: 10 * OWL });
    const review = JSON.parse(
      (await executeMandateOperationsTool(grantId, "amend_pace", { kind: "steady", owls: 2, period_hours: 168, note: "spread it" }, { chat: false }))!
    );
    expect(review.success).toBe(false);
    expect(review.message).toContain("the pace is the funder's");
    const chat = JSON.parse(
      (await executeMandateOperationsTool(grantId, "amend_pace", { kind: "steady", owls: 2, period_hours: 168, note: "The funder wants it spread over the month." }, { chat: true }))!
    );
    expect(chat.success).toBe(true);
    const [g] = await rawQuery<{ pace: unknown }>(`SELECT pace FROM grants WHERE id = $1`, [grantId]);
    expect(parsePace(g!.pace)).toMatchObject({ kind: "steady", owls: 2, period_hours: 168 });
    expect(validatePace({ kind: "steady", owls: 0, period_hours: 24 })).toMatchObject({ ok: false });
  });
});
