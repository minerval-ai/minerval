/**
 * A lookout's commission window (#1043) over real SQL: the per-item limit
 * bounds one commission, the window bounds what the lookout commits alone
 * across items in any N hours. Each allocation it places records it; an item
 * past the window is not clipped but goes to the program officers with the
 * figures; running work holds its budget against the window and settled work
 * its spend; and the check is made behind the mandate's lock, so commissions
 * at the same moment cannot both fit the room one leaves.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedGrantWithJob, seedUser } from "./helpers.js";

vi.mock("../../src/services/url-guard.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/services/url-guard.js")>();
  return { ...real, assertPublicHttpUrl: async (raw: string) => new URL(raw) };
});

import { createLookout, flagIngest } from "../../src/services/lookout-service.js";
import { lookoutWindow } from "../../src/services/lookout-window.js";

const OWL = 1_000_000;

async function seedLookout(window: { owls?: number; hours?: number } | undefined) {
  const funder = await seedUser("lookout-window");
  const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 60 * OWL });
  const res = await createLookout({
    grantId,
    title: "Known problems",
    brief: "Watch the reporting on this event for corrections and new primary sources worth ingesting.",
    triggers: ["manual"],
    commissionLimitOwls: 4,
    commissionWindow: window,
    createdBy: "grantmaker:review",
  });
  if (!res.ok) throw new Error(res.message);
  return { grantId, lookoutId: res.lookoutId };
}

const ingest = (s: { grantId: string; lookoutId: string }, budgetOwls: number) =>
  flagIngest({
    lookoutId: s.lookoutId,
    grantId: s.grantId,
    url: `https://news-${randomUUID().slice(0, 8)}.example/report`,
    rationale: "A first-hand account of the stop that no source in the graph carries yet.",
    commissionLimitMicroUsd: 4 * OWL,
    budgetMicroUsd: budgetOwls * OWL,
  });

const lookoutAllocations = (lookoutId: string) =>
  rawQuery<{ id: string; amount: string; commissioned_by: string }>(
    `SELECT id, amount_micro_usd::text AS amount, commissioned_by FROM action_allocations WHERE lookout_id = $1 ORDER BY created_at`,
    [lookoutId]
  );

describe("a lookout's commission window (#1043)", () => {
  it("commits items inside the window, raises the one past it to the officers with the figures, and records the lookout on each allocation", async () => {
    const s = await seedLookout({ owls: 7, hours: 24 });
    const first = await ingest(s, 3);
    const second = await ingest(s, 3);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(JSON.stringify(first)).toContain("within your limit");
    // The result states the running state of the window.
    expect(JSON.stringify(second)).toContain("hold 6 of your 7 owls for any 24 hours (1 left)");

    // Inside the per-item limit, past the window: not clipped, raised.
    const third = await ingest(s, 3);
    expect(JSON.stringify(third)).toContain("Not commissioned");
    expect(JSON.stringify(third)).toContain("commission window");
    const allocations = await lookoutAllocations(s.lookoutId);
    expect(allocations.map((a) => [Number(a.amount), a.commissioned_by])).toEqual([
      [3 * OWL, "lookout"],
      [3 * OWL, "lookout"],
    ]);
    const [inbox] = await rawQuery<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM mandate_inbox WHERE grant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [s.grantId]
    );
    expect(inbox!.detail.suggested_budget_owls).toBe(3);
    expect(String(inbox!.detail.not_commissioned_because)).toContain("1 of 7 owls for any 24 hours");

    // A smaller item that fits what is left is still the lookout's to commit.
    expect(JSON.stringify(await ingest(s, 1))).toContain("within your limit");
  });

  it("counts settled work at its spend, so room returns as runs finish, and frees what ages out of the window", async () => {
    const s = await seedLookout({ owls: 6, hours: 24 });
    await ingest(s, 3);
    await ingest(s, 3);
    expect((await lookoutWindow(s.lookoutId))!.leftMicroUsd).toBe(0);

    const [a, b] = await lookoutAllocations(s.lookoutId);
    // One run settled having spent 1 owl of its 3.
    await rawQuery(`UPDATE action_allocations SET spent_micro_usd = $2, released_at = now() WHERE id = $1`, [a!.id, OWL]);
    expect((await lookoutWindow(s.lookoutId))!.usedMicroUsd).toBe(4 * OWL);
    // The other was placed more than a day ago.
    await rawQuery(`UPDATE action_allocations SET created_at = now() - interval '25 hours' WHERE id = $1`, [b!.id]);
    expect((await lookoutWindow(s.lookoutId))!).toMatchObject({ usedMicroUsd: OWL, leftMicroUsd: 5 * OWL });
  });

  it("sets no bound with no window: the per-item limit alone, within the pace", async () => {
    const s = await seedLookout(undefined);
    for (let i = 0; i < 5; i++) expect(JSON.stringify(await ingest(s, 4))).toContain("within your limit");
    expect(await lookoutAllocations(s.lookoutId)).toHaveLength(5);
  });

  it("holds under commissions at the same moment: the window is read behind the mandate's lock", async () => {
    const s = await seedLookout({ owls: 6, hours: 24 });
    const results = await Promise.all([ingest(s, 3), ingest(s, 3), ingest(s, 3), ingest(s, 3)]);
    expect(results.filter((r) => JSON.stringify(r).includes("within your limit"))).toHaveLength(2);
    const placed = await lookoutAllocations(s.lookoutId);
    expect(placed.reduce((sum, a) => sum + Number(a.amount), 0)).toBe(6 * OWL);
  });
});
