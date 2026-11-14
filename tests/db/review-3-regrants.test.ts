/**
 * Third review: the own-label guard let any regrant be deleted at any
 * label. It was written for one case, a mandate taking back a regrant it
 * made, whole (withdrawFromMandate), and the money view a regrant is
 * deleted through reads every label. The guard now lets that case through
 * and no other (migration 0153).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { A, B, at, caught, seedUser, sqlState, system, tag, unwall, wall } from "./review-3-common.js";

const grants: Record<string, string> = {};
let account = "";

beforeAll(async () => {
  await wall();
  account = await seedUser();
  await system(async () => {
    for (const [name, label] of [["a", A], ["b1", B], ["b2", B], ["pub", "public"]] as const) {
      const [job] = await rawQuery<{ id: string }>(
        `INSERT INTO budget_jobs (user_id, kind, budget_micro_usd, status, sensitivity_label) VALUES ($1, 'grant', 1000000, 'running', $2) RETURNING id`,
        [account, label]
      );
      const [grant] = await rawQuery<{ id: string }>(
        `INSERT INTO grants (funder_user_id, budget_job_id, name, policy, status, pace, sensitivity_label)
         VALUES ($1, $2, $3, 'custom', 'active', '{"kind":"steady","owls":0.1,"period_hours":24}'::jsonb, $4) RETURNING id`,
        [account, job!.id, `Review three mandate ${name} ${tag}`, label]
      );
      grants[name] = grant!.id;
    }
  });
}, 120_000);

afterAll(async () => {
  await system(async () => {
    await rawQuery(`DELETE FROM regrants WHERE from_grant_id = ANY($1::uuid[])`, [Object.values(grants)]);
    await rawQuery(`DELETE FROM grants WHERE id = ANY($1::uuid[])`, [Object.values(grants)]);
    await rawQuery(`DELETE FROM budget_jobs WHERE user_id = $1`, [account]);
  }).catch(() => undefined);
  await unwall();
}, 120_000);

const regrant = (from: string, to: string, label: string, refunded = 0) =>
  system(async () => (await rawQuery<{ id: string }>(
    `INSERT INTO regrants (from_grant_id, to_grant_id, amount_micro_usd, refunded_micro_usd, sensitivity_label)
     VALUES ($1, $2, 5000, $3, $4) RETURNING id`,
    [grants[from], grants[to], refunded, label]
  ))[0]!.id);
const remove = (label: string, id: string) =>
  caught(() => at(label, () => rawQuery(`DELETE FROM minerval_whole.regrant_money WHERE id = $1`, [id])));
const exists = async (id: string) => (await system(() => rawQuery(`SELECT 1 FROM regrants WHERE id = $1`, [id]))).length === 1;

describe("deleting a regrant through the money view", () => {
  it("is refused for a regrant between two mandates at a label the work does not read, in words that name no label", async () => {
    const id = await regrant("b1", "b2", B);
    const err = await remove(A, id);
    expect(sqlState(err)).toBe("MVL06");
    const message = (err as { cause?: { message?: string }; message: string }).cause?.message ?? (err as Error).message;
    expect(message).toBe(
      "this regrant was not deleted: a regrant is taken back whole only by the mandate that made it, by work at that mandate's label, and only while nothing has been returned from it"
    );
    expect(message).not.toContain(B);
    expect(await exists(id)).toBe(true);
  });

  it("is refused for another label's regrant the work reads, and for the maker once something has been returned from it", async () => {
    // Made by a public mandate, deleted by work at a, which reads public.
    const publics = await regrant("pub", "b1", "public");
    expect(sqlState(await remove(A, publics))).toBe("MVL06");
    expect(await exists(publics)).toBe(true);
    // The maker's own, at another label than its work, with part of it already returned.
    const partly = await regrant("a", "pub", "public", 1000);
    expect(sqlState(await remove(A, partly))).toBe("MVL06");
    expect(await exists(partly)).toBe(true);
  });

  it("is let through for the case it was written for: the mandate that made it takes it back whole", async () => {
    const mine = await regrant("a", "pub", "public");
    expect(await remove(A, mine)).toBeNull();
    expect(await exists(mine)).toBe(false);
    // And a regrant at the work's own label is its own row, as before.
    const own = await regrant("a", "pub", A, 1000);
    expect(await remove(A, own)).toBeNull();
    expect(await exists(own)).toBe(false);
  });
});
