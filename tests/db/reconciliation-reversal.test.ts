/**
 * The Curator's undo (#761) against real Postgres: a reversal is refused
 * while a later, unreversed operation touched the same nodes, and goes
 * through once that one is reversed first. The guard reads "later" from
 * the stored timestamps in SQL; a timestamp round-tripped through
 * JavaScript loses its microseconds and would read an event as later than
 * itself, refusing every reversal.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { mergeClaims, reverseReconciliation } from "../../src/services/reconciliation-service.js";

async function state(id: string): Promise<{ state: string; merged_into: string | null }> {
  const [row] = await rawQuery<{ state: string; merged_into: string | null }>(
    `SELECT state, merged_into FROM claims WHERE id = $1`,
    [id]
  );
  return row!;
}

describe("reverseReconciliation's ordering guard (#761)", () => {
  it("reverses an operation nothing later has touched", async () => {
    const s = await seedClaim("survivor");
    const l = await seedClaim("loser");
    const { eventId } = await mergeClaims({ survivorId: s, loserId: l, stanceRelation: "same", reasoning: "dup" });
    expect(await reverseReconciliation(eventId!, { reasoning: "not one claim" })).toEqual({ reversed: true });
    expect(await state(l)).toEqual({ state: "active", merged_into: null });
    // The reversal is logged with its reasoning.
    const [logged] = await rawQuery<{ reasoning: string }>(
      `SELECT reasoning FROM reconciliation_events
        WHERE operation = 'reverse' AND payload->>'reversed_event_id' = $1`,
      [eventId]
    );
    expect(logged?.reasoning).toBe("not one claim");
  });

  it("refuses while a genuinely later merge touched a node, then reverses newest first", async () => {
    const a = await seedClaim("a");
    const b = await seedClaim("b");
    const c = await seedClaim("c");
    const first = await mergeClaims({ survivorId: b, loserId: a, stanceRelation: "same", reasoning: "a is b" });
    const second = await mergeClaims({ survivorId: c, loserId: b, stanceRelation: "same", reasoning: "b is c" });

    const refused = await reverseReconciliation(first.eventId!, { reasoning: "a is not b" });
    expect(refused.reversed).toBe(false);
    expect(refused.blockedBy).toEqual([second.eventId]);
    expect(await state(a)).toEqual({ state: "merged", merged_into: b });

    expect((await reverseReconciliation(second.eventId!, { reasoning: "b is not c" })).reversed).toBe(true);
    expect((await reverseReconciliation(first.eventId!, { reasoning: "a is not b" })).reversed).toBe(true);
    expect(await state(a)).toEqual({ state: "active", merged_into: null });
    expect(await state(b)).toEqual({ state: "active", merged_into: null });
  });
});
