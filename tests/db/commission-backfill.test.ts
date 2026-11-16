/**
 * Migration 0143 against real Postgres: money a mandate placed on its own
 * upkeep before every run had to be commissioned (#991) becomes the
 * commission it was, and nothing else is touched.
 *
 * On 2026-11-13 twelve funded consistency sweeps sat open and could never
 * run: their allocations were placed hours before #991 deployed, so they
 * carried no commissioner, the executors passed them over, and the
 * self-funding pass saw them as paid for and placed nothing new. The same
 * file covers the reconcile sweep's reopening of ingest rows, which those
 * allocations made matter: a row whose extraction is still queued is not a
 * dead worker's.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rawQuery } from "../../src/db/client.js";
import { nextRunnableAction, reconcileActions, type ActionKind } from "../../src/services/action-service.js";
import { fundGrantSelfActions } from "../../src/services/allocation-service.js";
import { createJob, updateJob } from "../../src/services/job-service.js";
import { OWL, seedAction, seedAllocation, seedClaim, seedGrantWithJob, seedUser, seedValuation } from "./helpers.js";

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../src/db/migrations/0143_commission_backfill.sql", import.meta.url)),
  "utf8"
);
const runMigration = () => rawQuery(MIGRATION);

// More backing than any row another file leaves on the ledger, so the row
// under test is the executor's next pick whenever it can be picked at all.
const MOST = 9_000_000_000_000;

const tag = `backfill-${randomUUID().slice(0, 8)}`;
const group = (name: string) => `${tag}:${name}:${randomUUID()}`;

interface Placed {
  commissioned_by: string | null;
  reason: string | null;
  amount: string;
  spent: string;
  released_at: Date | null;
}
async function placed(id: string): Promise<Placed> {
  const [r] = await rawQuery<Placed>(
    `SELECT commissioned_by, reason, amount_micro_usd AS amount, spent_micro_usd AS spent, released_at
       FROM action_allocations WHERE id = $1`,
    [id]
  );
  return r!;
}

/** A ledger row with a mandate's allocation pinned to it, placed as the code before #991 placed one. */
async function oldPlacement(input: {
  kind: string;
  status?: string;
  grantId: string;
  amount?: number;
  spent?: number;
  released?: boolean;
}) {
  const g = group(input.kind);
  const actionId = await seedAction({
    group: g,
    kind: input.kind,
    costMicroUsd: 10_000,
    status: input.status ?? "open",
    targetRef: `https://example.org/${tag}/${randomUUID()}`,
  });
  const allocationId = await seedAllocation({
    group: g,
    actionId,
    grantId: input.grantId,
    amountMicroUsd: input.amount ?? 50_000,
    spentMicroUsd: input.spent ?? 0,
    released: input.released ?? false,
    commissionedBy: null,
  });
  return { group: g, actionId, allocationId };
}

const close = async (actionId: string) => {
  await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE id = $1`, [actionId]);
};

afterAll(async () => {
  // Nothing of this file's stays open or funded for the files after it.
  await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE exclusion_group LIKE $1 AND status IN ('open', 'running')`, [`${tag}:%`]);
  await rawQuery(`UPDATE action_allocations SET released_at = now() WHERE exclusion_group LIKE $1 AND released_at IS NULL`, [`${tag}:%`]);
});

describe("migration 0143: a mandate's own placements from before every run was commissioned", () => {
  it("makes the stuck rows runnable, in each state such a placement can be in, and touches nothing else", async () => {
    const funder = await seedUser("backfill-funder");
    // Completed, so the self-funding pass and the reconcile sweep leave this
    // mandate's rows to the test.
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 100 * OWL, grantStatus: "completed" });

    // The rows the migration is for.
    const sweep = await oldPlacement({ kind: "consistency_sweep", grantId, amount: MOST });
    const running = await oldPlacement({ kind: "ingest", status: "running", grantId, amount: MOST });
    const closedWithHold = await oldPlacement({ kind: "lookout_run", status: "cancelled", grantId, amount: MOST });
    const settled = await oldPlacement({ kind: "mandate_review", status: "done", grantId, amount: 40_000, spent: 40_000 });
    const planning = await oldPlacement({ kind: "grant_planning", grantId });
    const correspondent = await oldPlacement({ kind: "correspondent_run", grantId });
    const withReason = await oldPlacement({ kind: "ingest", grantId });
    await rawQuery(`UPDATE action_allocations SET reason = 'kept as written' WHERE id = $1`, [withReason.allocationId]);

    // The rows it must leave alone.
    // A run's overspend: no commissioner, already spent, already released.
    const overage = await oldPlacement({ kind: "ingest", status: "done", grantId, amount: 7_000, spent: 7_000, released: true });
    // The retired allocator's placement on a group as a whole.
    const claimId = await seedClaim("backfill");
    const assessGroup = group("assess");
    const assess = await seedAction({ group: assessGroup, kind: "assess", claimId, costMicroUsd: 10_000 });
    const groupLevel = await seedAllocation({ group: assessGroup, claimId, grantId, amountMicroUsd: MOST, commissionedBy: null });
    // ... and one it pinned to a row of a kind the self-funding pass never funds.
    const pinnedAssessGroup = group("assess");
    const pinnedAssess = await seedAction({ group: pinnedAssessGroup, kind: "assess", claimId: await seedClaim("backfill"), costMicroUsd: 10_000 });
    const pinnedOther = await seedAllocation({ group: pinnedAssessGroup, actionId: pinnedAssess, grantId, amountMicroUsd: MOST, commissionedBy: null });
    // ... and one it pinned to an ingest row its mandate had valued.
    const valued = await oldPlacement({ kind: "ingest", grantId, amount: MOST });
    await seedValuation({ grantId, actionId: valued.actionId, valueEst: 3 });
    // A person's money with no commissioner.
    const personGroup = group("ingest");
    const personRow = await seedAction({ group: personGroup, kind: "ingest", costMicroUsd: 10_000, targetRef: `https://example.org/${tag}/person` });
    const persons = await seedAllocation({ group: personGroup, actionId: personRow, userId: funder, amountMicroUsd: MOST, commissionedBy: null });
    // A commission someone else placed.
    const commissionedGroup = group("ingest");
    const commissionedRow = await seedAction({ group: commissionedGroup, kind: "ingest", costMicroUsd: 10_000, status: "done", targetRef: `https://example.org/${tag}/commissioned` });
    const commissioned = await seedAllocation({ group: commissionedGroup, actionId: commissionedRow, grantId, amountMicroUsd: 50_000, commissionedBy: "grantmaker" });

    // Before: the money is there and no executor will pick the work.
    const pick = async (kind: string) => (await nextRunnableAction([kind as ActionKind]))?.id;
    expect(await pick("consistency_sweep")).not.toBe(sweep.actionId);
    expect(await pick("assess")).not.toBe(assess);
    const before = await Promise.all(
      [sweep, running, closedWithHold, settled, planning, correspondent, withReason, overage, valued].map((r) => placed(r.allocationId))
    );

    await runMigration();

    // The mandate's own placements are its commissions, with the reason the
    // self-funding pass writes for the kind.
    expect(await placed(sweep.allocationId)).toMatchObject({ commissioned_by: "mandate", reason: "A consistency sweep the mandate funds." });
    expect(await placed(running.allocationId)).toMatchObject({ commissioned_by: "mandate", reason: "An ingest item of the mandate's plan." });
    expect(await placed(closedWithHold.allocationId)).toMatchObject({ commissioned_by: "mandate", reason: "A run of one of the mandate's lookouts." });
    expect(await placed(settled.allocationId)).toMatchObject({ commissioned_by: "mandate", reason: "A sitting of the mandate's Grantmaker." });
    expect(await placed(planning.allocationId)).toMatchObject({ commissioned_by: "mandate", reason: "The mandate's planning pass." });
    expect(await placed(correspondent.allocationId)).toMatchObject({ commissioned_by: "mandate", reason: "A run of one of the mandate's Correspondents." });
    expect(await placed(withReason.allocationId)).toMatchObject({ commissioned_by: "mandate", reason: "kept as written" });

    // No money moved on any row.
    const after = await Promise.all(
      [sweep, running, closedWithHold, settled, planning, correspondent, withReason, overage, valued].map((r) => placed(r.allocationId))
    );
    for (const [i, b] of before.entries()) {
      expect(after[i]).toMatchObject({ amount: b.amount, spent: b.spent });
      expect(after[i]!.released_at?.getTime() ?? null).toBe(b.released_at?.getTime() ?? null);
    }

    // The open row runs now.
    expect(await pick("consistency_sweep")).toBe(sweep.actionId);
    await close(sweep.actionId);
    // The running row is settled by its run as before; were it handed back,
    // it would be picked again.
    await rawQuery(`UPDATE actions SET status = 'open' WHERE id = $1`, [running.actionId]);
    expect(await pick("ingest")).toBe(running.actionId);
    await close(running.actionId);
    // A row that closed with its hold unreleased runs when its group's next
    // piece of work reopens it, instead of reading as paid for and never
    // being picked.
    await rawQuery(`UPDATE actions SET status = 'open' WHERE id = $1`, [closedWithHold.actionId]);
    expect(await pick("lookout_run")).toBe(closedWithHold.actionId);
    await close(closedWithHold.actionId);

    // Left exactly as they were.
    expect(await placed(overage.allocationId)).toMatchObject({ commissioned_by: null, reason: null });
    expect(await placed(groupLevel)).toMatchObject({ commissioned_by: null, reason: null });
    expect(await placed(pinnedOther)).toMatchObject({ commissioned_by: null, reason: null });
    expect(await placed(valued.allocationId)).toMatchObject({ commissioned_by: null, reason: null });
    expect(await placed(persons)).toMatchObject({ commissioned_by: null, reason: null });
    expect(await placed(commissioned)).toMatchObject({ commissioned_by: "grantmaker" });
    expect(await pick("assess")).not.toBe(assess);
    expect(await pick("assess")).not.toBe(pinnedAssess);
    expect(await pick("ingest")).not.toBe(valued.actionId);
    expect(await pick("ingest")).not.toBe(personRow);

    // Run again: nothing changes.
    await rawQuery(`UPDATE action_allocations SET reason = 'changed since' WHERE id = $1`, [planning.allocationId]);
    await runMigration();
    expect(await placed(planning.allocationId)).toMatchObject({ commissioned_by: "mandate", reason: "changed since" });
    expect(await placed(groupLevel)).toMatchObject({ commissioned_by: null });
    expect(await placed(commissioned)).toMatchObject({ commissioned_by: "grantmaker" });
  });

  it("the self-funding pass places nothing on a row an old placement covers, which is why the row could never run", async () => {
    const funder = await seedUser("backfill-live");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 100 * OWL });
    // A planning row of a mandate being planned is one the pass funds.
    await rawQuery(`UPDATE grants SET status = 'planning' WHERE id = $1`, [grantId]);
    const g = `plan:${grantId}`;
    const actionId = await seedAction({ group: g, kind: "grant_planning", costMicroUsd: 20_000, targetRef: grantId });
    const allocationId = await seedAllocation({ group: g, actionId, grantId, amountMicroUsd: MOST, commissionedBy: null });

    await fundGrantSelfActions();
    const [n] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM action_allocations WHERE exclusion_group = $1 AND released_at IS NULL`,
      [g]
    );
    expect(n!.n).toBe(1);
    expect((await nextRunnableAction(["grant_planning"]))?.id).not.toBe(actionId);

    await runMigration();
    expect((await nextRunnableAction(["grant_planning"]))?.id).toBe(actionId);

    await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE id = $1`, [actionId]);
    await rawQuery(`UPDATE action_allocations SET released_at = now() WHERE id = $1`, [allocationId]);
    await rawQuery(`UPDATE grants SET status = 'completed' WHERE id = $1`, [grantId]);
  });
});

describe("an ingest row that has read running for more than a day", () => {
  async function staleIngest(hoursAgo = 25) {
    const url = `https://example.org/${tag}/${randomUUID()}`;
    const id = await seedAction({ group: `${tag}:ingest:${url}`, kind: "ingest", costMicroUsd: 10_000, status: "running", targetRef: url });
    await rawQuery(`UPDATE actions SET updated_at = now() - make_interval(hours => $2) WHERE id = $1`, [id, hoursAgo]);
    return { id, url };
  }
  const submitted = async (url: string, at: string) => {
    const job = await createJob("url_extraction", { sourceId: randomUUID(), url });
    await rawQuery(`UPDATE jobs SET created_at = ${at} WHERE id = $1`, [job.id]);
    return job.id;
  };
  const status = async (id: string) =>
    (await rawQuery<{ status: string }>(`SELECT status FROM actions WHERE id = $1`, [id]))[0]!.status;

  it("is left running while its extraction is queued or being read, and reopened once nothing is", async () => {
    const queued = await staleIngest();
    const queuedJob = await submitted(queued.url, `now() - interval '25 hours' + interval '2 seconds'`);
    const reading = await staleIngest();
    const readingJob = await submitted(reading.url, `now() - interval '25 hours' + interval '2 seconds'`);
    await updateJob(readingJob, { status: "processing" });
    // Its worker died before the job was made.
    const dead = await staleIngest();
    // Its job finished and the row was never closed.
    const finished = await staleIngest();
    await updateJob(await submitted(finished.url, `now() - interval '25 hours' + interval '2 seconds'`), { status: "failed" });
    // An unfinished job from an earlier run of the row is not this run's.
    const earlier = await staleIngest();
    await submitted(earlier.url, `now() - interval '3 days'`);
    // A job the queue has long since dropped.
    const lost = await staleIngest(5 * 24);
    await submitted(lost.url, `now() - interval '5 days' + interval '2 seconds'`);

    await reconcileActions();

    expect(await status(queued.id)).toBe("running");
    expect(await status(reading.id)).toBe("running");
    expect(await status(dead.id)).toBe("open");
    expect(await status(finished.id)).toBe("open");
    expect(await status(earlier.id)).toBe("open");
    expect(await status(lost.id)).toBe("open");

    // The extraction ends; the row is no longer held.
    await updateJob(queuedJob, { status: "failed" });
    await reconcileActions();
    expect(await status(queued.id)).toBe("open");
  });
});
