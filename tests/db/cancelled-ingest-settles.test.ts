/**
 * A cancelled ingest settles its money and says why (#1045). An extraction
 * that failed, or that the recovery sweep gave up on, used to be cancelled
 * with a bare status write: its allocations stayed live, so a mandate's
 * escrow held money for a row that would never run, a person's owls did not
 * come back, and the plan item read "cancelled" with no reason. Over real
 * SQL: the cancel releases every live allocation on the group (a person's
 * unspent owls refunded), writes the reason on the row and the public ledger,
 * the plan item reads it, the reconcile sweep releases holds left by the old
 * cancel, and a row that leaves cancelled drops its reason.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import {
  seedAction,
  seedAllocation,
  getAllocation,
  seedGrantWithJob,
  seedUser,
  ledgerRows,
} from "./helpers.js";
import {
  cancelActionGroup,
  materializeGrantPlan,
  INGEST_GROUP,
} from "../../src/services/action-service.js";
import { settleDeadGroups } from "../../src/services/action-settlement.js";
import { grantEscrowBreakdown } from "../../src/services/regrant-service.js";
import { createJob } from "../../src/services/job-service.js";
import { sweepStalledIngests, ingestStallMinutes } from "../../src/workers/recovery-sweep.js";
import { ingestFailureReason } from "../../src/workers/url-extraction.js";
import { HttpStatusError } from "../../src/services/url-guard.js";

async function ingestRow(status = "running"): Promise<{ id: string; group: string; url: string }> {
  const url = `https://example.org/${randomUUID()}`;
  const group = INGEST_GROUP(url);
  const id = await seedAction({ group, kind: "ingest", targetRef: url, costMicroUsd: 1_000_000, status });
  return { id, group, url };
}

async function row(id: string) {
  const [r] = await rawQuery<{ status: string; closed_reason: string | null }>(
    `SELECT status, closed_reason FROM actions WHERE id = $1`,
    [id]
  );
  return r!;
}

describe("cancelling an ingest", () => {
  it("releases the mandate's hold, refunds a person's owls, and records the reason", async () => {
    const funder = await seedUser("mandate funder");
    const buyer = await seedUser("buyer");
    const { grantId, jobId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 10_000_000 });
    const ingest = await ingestRow();
    const fromMandate = await seedAllocation({
      group: ingest.group,
      actionId: ingest.id,
      grantId,
      amountMicroUsd: 1_000_000,
      commissionedBy: "mandate",
    });
    const fromPerson = await seedAllocation({
      group: ingest.group,
      actionId: ingest.id,
      userId: buyer,
      amountMicroUsd: 400_000,
    });
    const before = await grantEscrowBreakdown({ id: grantId, budgetJobId: jobId });
    expect(before.held).toBe(1_000_000);

    const reason = ingestFailureReason(new HttpStatusError(ingest.url, 403, null), ingest.url);
    const cancelled = await cancelActionGroup(ingest.group, reason);

    expect(cancelled).toEqual([ingest.id]);
    expect(await row(ingest.id)).toEqual({ status: "cancelled", closed_reason: reason });
    expect((await getAllocation(fromMandate)).released_at).not.toBeNull();
    expect((await getAllocation(fromPerson)).released_at).not.toBeNull();
    const after = await grantEscrowBreakdown({ id: grantId, budgetJobId: jobId });
    expect(after.held).toBe(0);
    expect(after.spent).toBe(before.spent);
    const refunds = (await ledgerRows(buyer)).filter((r) => r.reason === "refund");
    expect(refunds.map((r) => Number(r.amount_micro_usd))).toEqual([400_000]);

    const [view] = await rawQuery<{ status: string; closed_reason: string | null }>(
      `SELECT status, closed_reason FROM public_read.ledger WHERE action_id = $1`,
      [ingest.id]
    );
    expect(view).toEqual({ status: "cancelled", closed_reason: reason });
    expect(reason).toMatch(/HTTP 403/);
    const [event] = await rawQuery<{ kind: string; grant_id: string | null; payload: { reason: string } }>(
      `SELECT kind, grant_id, payload FROM events WHERE action_id = $1`,
      [ingest.id]
    );
    expect(event).toMatchObject({ kind: "run_closed", grant_id: grantId, payload: { reason } });
  });

  it("does nothing to a group with no live row, and settles nothing twice", async () => {
    const buyer = await seedUser("twice");
    const ingest = await ingestRow();
    await seedAllocation({ group: ingest.group, actionId: ingest.id, userId: buyer, amountMicroUsd: 300_000 });
    await cancelActionGroup(ingest.group, "first");
    expect(await cancelActionGroup(ingest.group, "second")).toEqual([]);
    expect((await row(ingest.id)).closed_reason).toBe("first");
    expect((await ledgerRows(buyer)).filter((r) => r.reason === "refund")).toHaveLength(1);
  });

  it("leaves the money while another row of the group is still live", async () => {
    const url = `https://example.org/${randomUUID()}`;
    const group = INGEST_GROUP(url);
    const one = await seedAction({ group, kind: "ingest", targetRef: url, costMicroUsd: 1, status: "running" });
    await seedAction({ group, kind: "ingest", variant: "other", targetRef: url, costMicroUsd: 1, status: "open" });
    const holder = await seedUser("live group");
    const al = await seedAllocation({ group, userId: holder, amountMicroUsd: 500_000 });
    await cancelActionGroup(group, "only the one", { only: one });
    expect((await row(one)).status).toBe("cancelled");
    expect((await getAllocation(al)).released_at).toBeNull();
  });

  it("the plan item that asked for it reads the reason", async () => {
    const funder = await seedUser("plan");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 10_000_000 });
    const ingest = await ingestRow();
    await cancelActionGroup(ingest.group, "the site refused to serve it (HTTP 403)");
    const outcomes = await materializeGrantPlan({
      id: grantId,
      name: "plan",
      status: "active",
      policy: "agent",
      plan: { items: [{ action: "ingest", url: ingest.url }] },
      plan_cursor: 0,
    });
    expect(outcomes[0]!.ledger).toMatchObject({
      status: "cancelled",
      action_id: ingest.id,
      reason: "the site refused to serve it (HTTP 403)",
    });
  });

  it("a row that leaves cancelled drops its reason", async () => {
    const ingest = await ingestRow();
    await cancelActionGroup(ingest.group, "gone");
    await rawQuery(`UPDATE actions SET status = 'open' WHERE id = $1`, [ingest.id]);
    expect(await row(ingest.id)).toEqual({ status: "open", closed_reason: null });
  });
});

describe("the recovery sweep giving up on an ingest", () => {
  it("cancels it with its reason and releases its money", async () => {
    const funder = await seedUser("sweep");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 10_000_000 });
    const ingest = await ingestRow();
    const al = await seedAllocation({
      group: ingest.group,
      actionId: ingest.id,
      grantId,
      amountMicroUsd: 1_000_000,
      commissionedBy: "mandate",
    });
    const job = await createJob("url_extraction", { url: ingest.url }, undefined, ingest.id);
    await rawQuery(
      `UPDATE jobs SET status = 'processing', attempts = 1,
              started_at = now() - make_interval(mins => $2::int),
              heartbeat_at = now() - make_interval(mins => $2::int)
        WHERE id = $1`,
      [job.id, ingestStallMinutes() + 5]
    );
    for (let i = 0; i < 2; i++) {
      const old = await createJob("url_extraction", { url: ingest.url }, undefined, ingest.id);
      await rawQuery(`UPDATE jobs SET status = 'failed', result = '{"abandoned": true}' WHERE id = $1`, [old.id]);
    }
    await sweepStalledIngests();
    const r = await row(ingest.id);
    expect(r.status).toBe("cancelled");
    expect(r.closed_reason).toMatch(/stopped making progress 3 times/);
    expect((await getAllocation(al)).released_at).not.toBeNull();
  });
});

describe("holds left on ingests cancelled before the fix", () => {
  it("are released by the reconcile pass, and only where every row is cancelled", async () => {
    const buyer = await seedUser("backfill");
    // The old cancel: a bare status write, the money left live.
    const old = await ingestRow("cancelled");
    const stuck = await seedAllocation({ group: old.group, actionId: old.id, userId: buyer, amountMicroUsd: 250_000 });
    // A group still running is owed its money.
    const live = await ingestRow("running");
    const owed = await seedAllocation({ group: live.group, actionId: live.id, userId: buyer, amountMicroUsd: 250_000 });

    // The general backstop (settleDeadGroups, #1045), with no grace here.
    expect((await settleDeadGroups({ graceMinutes: 0 })).groups).toBeGreaterThanOrEqual(1);
    expect((await getAllocation(stuck)).released_at).not.toBeNull();
    expect((await getAllocation(owed)).released_at).toBeNull();
    expect((await ledgerRows(buyer)).filter((r) => r.reason === "refund").map((r) => Number(r.amount_micro_usd))).toEqual([
      250_000,
    ]);
    // A second pass finds nothing more on it.
    await settleDeadGroups({ graceMinutes: 0 });
    expect((await ledgerRows(buyer)).filter((r) => r.reason === "refund")).toHaveLength(1);
  });
});

describe("the reason an ingest failed", () => {
  const url = "https://example.org/a";
  it("names a refusal, a missing page, an unavailable site, and a document too long", () => {
    expect(ingestFailureReason(new HttpStatusError(url, 403, null), url)).toMatch(/refused.*archived copy/);
    expect(ingestFailureReason(new HttpStatusError(url, 404, null), url)).toMatch(/not there/);
    expect(ingestFailureReason(new HttpStatusError(url, 503, null), url)).toMatch(/again later/);
    expect(ingestFailureReason(new Error("prompt is too long: 250000 tokens > 200000 maximum"), url)).toMatch(
      /too long for the Extractor/
    );
  });

  it("never repeats an unrecognized error's own text", () => {
    const reason = ingestFailureReason(new Error('Failed query: select "id", "claim_id" from assessments'), url);
    expect(reason).not.toMatch(/Failed query|assessments/);
    expect(reason).toMatch(/platform's side/);
  });
});
