/**
 * Platform faults against real Postgres (#967, #969, #971): what a ledger
 * row, its payer and the operator see when a model provider refuses calls
 * because the deployment's account is out of credits.
 *
 * On 2026-11-12 that happened for thirteen hours. The failures were
 * classified as transient, and everything around the classification went
 * wrong: the refused row was picked again at once, rows read `open` with
 * nothing saying why, an ingest was cancelled, its mandate paid for a
 * review whose only news was the fault, and no maintainer was told. Each
 * of those is a test here. No model is called.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({ extractError: null as unknown, briefing: "" }));

vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this file");
  }),
}));
vi.mock("../../src/services/github-issue-service.js", () => ({
  fileIssueForReport: vi.fn(async () => null),
  syncSightingToIssue: vi.fn(async () => undefined),
  syncTriageToIssue: vi.fn(async () => undefined),
}));
vi.mock("../../src/llm/agents/extractor.js", () => ({
  extractClaims: vi.fn(async () => {
    if (h.extractError) throw h.extractError;
    return [];
  }),
}));
vi.mock("../../src/services/source-facts-service.js", () => ({ refreshSourceFactsOnce: vi.fn(async () => undefined) }));
vi.mock("../../src/services/source-segment-service.js", () => ({ segmentSourceOnce: vi.fn(async () => undefined) }));
vi.mock("../../src/llm/client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/client.js")>()),
  toolUseLoop: vi.fn(async (opts: { initialMessages: Array<{ content: string }> }) => {
    h.briefing = String(opts.initialMessages[0]?.content ?? "");
    return { content: "Read the briefing.", toolCalls: [], iterations: 1 };
  }),
}));

import { rawQuery } from "../../src/db/client.js";
import { LlmBudgetExceededError } from "../../src/llm/errors.js";
import {
  actionWaitingOn,
  completeAction,
  joinFaultWait,
  materializePlanItems,
  nextRunnableAction,
  releaseAction,
  type ActionKind,
  type PlanItemLedger,
} from "../../src/services/action-service.js";
import { commissionNodePass, commissionNoteText } from "../../src/services/commission-service.js";
import { FAULT_RETRY_BASE_SECONDS } from "../../src/services/deployment-fault.js";
import {
  CLEAR_QUIET_MINUTES,
  clearSettledDeploymentFaults,
  noteDeploymentFault,
  openDeploymentFaults,
  platformFaultBriefing,
  resetDeploymentFaultState,
} from "../../src/services/deployment-fault-service.js";
import { collectMandateEvents, pendingMandateEvents } from "../../src/services/mandate-event-service.js";
import { queueHealth } from "../../src/services/monitor-service.js";
import { taggingQueueHealth } from "../../src/services/tag-service.js";
import {
  clearTaggingLaneWait,
  currentTaggingLaneWait,
  holdTaggingLaneOnBreaker,
  holdTaggingLaneOnFault,
  readTaggingLaneWait,
} from "../../src/services/tagging-lane.js";
import { createJob } from "../../src/services/job-service.js";
import { getOrCreateSource } from "../../src/services/source-service.js";
import { handleUrlExtraction } from "../../src/workers/url-extraction.js";
import { runMandateReview } from "../../src/llm/agents/mandate-review.js";
import { OWL, seedAction, seedAllocation, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

/** What the agents reported, as the SDK throws it for the Matcher's provider. */
const RAW = "402 This request's maximum cost exceeds your available credits. Add credits, or lower max_tokens or prompt size.";
const refused = (provider?: string) => {
  const err = Object.assign(new Error(RAW), { status: 402 });
  if (provider) Object.defineProperty(err, "llmProvider", { value: provider });
  return err;
};

interface FaultRow {
  status: string;
  fault_reason: string | null;
  fault_since: Date | null;
  fault_attempts: number;
  retry_after: Date | null;
  wait_seconds: number | null;
}
async function row(id: string): Promise<FaultRow> {
  const [r] = await rawQuery<FaultRow>(
    `SELECT status, fault_reason, fault_since, fault_attempts, retry_after,
            EXTRACT(EPOCH FROM retry_after - now())::float8 AS wait_seconds
       FROM actions WHERE id = $1`,
    [id]
  );
  return r!;
}

/**
 * A funded, running row of a kind and tier of its own, so the rows other
 * files leave on the ledger do not wait with it. `variant` is the tier.
 */
async function fundedRow(input: { kind?: string; variant: string; grantId?: string; amount?: number; status?: string }) {
  const group = `faulttest:${randomUUID()}`;
  const id = await seedAction({
    group,
    kind: input.kind ?? "lookout_run",
    variant: input.variant,
    costMicroUsd: 10_000,
    status: input.status ?? "running",
    targetRef: randomUUID(),
  });
  const allocationId = await seedAllocation({
    group,
    actionId: id,
    grantId: input.grantId ?? null,
    userId: input.grantId ? null : (payer ??= await seedUser("fault-payer")),
    amountMicroUsd: input.amount ?? 50_000,
  });
  return { id, group, allocationId };
}

let payer: string | undefined;
const grantsMade: string[] = [];
/** A mandate of this file's, closed again when its test ends. */
async function seedMandate(input: Parameters<typeof seedGrantWithJob>[0]) {
  const made = await seedGrantWithJob(input);
  grantsMade.push(made.grantId);
  return made;
}
const tier = () => `t-${randomUUID().slice(0, 8)}`;

beforeEach(async () => {
  resetDeploymentFaultState();
  h.extractError = null;
  h.briefing = "";
  // Each test reads the faults it opened.
  await rawQuery(`UPDATE deployment_faults SET cleared_at = now() - interval '2 days' WHERE cleared_at IS NULL`);
});

// The ledger and the mandates' inboxes are shared with the files that run
// after this one, whose drains and wakes read all of it: nothing here is
// left open, funded, pending or waking.
afterEach(async () => {
  const mine = `exclusion_group LIKE 'faulttest:%' OR exclusion_group LIKE 'ingest:https://example.org/fault-%'`;
  await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE (${mine}) AND status IN ('open', 'running')`);
  await rawQuery(`UPDATE action_allocations SET released_at = now() WHERE (${mine}) AND released_at IS NULL`);
  await rawQuery(
    `UPDATE mandate_events SET consumed_at = now() WHERE consumed_at IS NULL AND grant_id = ANY($1::uuid[])`,
    [grantsMade]
  );
  await rawQuery(
    `UPDATE actions a SET status = 'cancelled'
       FROM action_allocations al
      WHERE al.exclusion_group = a.exclusion_group AND al.grant_id = ANY($1::uuid[])
        AND a.status IN ('open', 'running')`,
    [grantsMade]
  );
  await rawQuery(
    `UPDATE action_allocations SET released_at = now() WHERE grant_id = ANY($1::uuid[]) AND released_at IS NULL`,
    [grantsMade]
  );
  await rawQuery(`UPDATE grants SET status = 'completed' WHERE id = ANY($1::uuid[])`, [grantsMade]);
  grantsMade.length = 0;
  await rawQuery(`UPDATE deployment_faults SET cleared_at = now() - interval '2 days' WHERE cleared_at IS NULL`);
});

describe("a ledger row whose run a provider refuses for credits", () => {
  it("goes back to open, uncounted and funded, and says what it waits on, since when, and until when", async () => {
    const variant = tier();
    const a = await fundedRow({ variant });
    expect(await releaseAction(a.id, refused("openrouter"))).toBe("credits_fault");

    const r = await row(a.id);
    expect(r.status).toBe("open");
    expect(r.fault_reason).toBe("credits_fault");
    expect(r.fault_since).not.toBeNull();
    expect(r.fault_attempts).toBe(1);
    expect(r.wait_seconds).toBeGreaterThan(FAULT_RETRY_BASE_SECONDS - 5);
    expect(r.wait_seconds).toBeLessThanOrEqual(FAULT_RETRY_BASE_SECONDS);
    expect(await actionWaitingOn(a.id)).toBe("credits_fault");

    // Its money is untouched: the commission is live and unspent.
    const [al] = await rawQuery<{ released_at: Date | null; spent: string }>(
      `SELECT released_at, spent_micro_usd AS spent FROM action_allocations WHERE id = $1`,
      [a.allocationId]
    );
    expect(al).toMatchObject({ released_at: null });
    expect(Number(al!.spent)).toBe(0);

    // The public ledger says so, by class and nothing more.
    const [pub] = await rawQuery<Record<string, unknown>>(
      `SELECT status, waiting_on, waiting_since, next_attempt_at FROM public_read.ledger WHERE action_id = $1`,
      [a.id]
    );
    expect(pub).toMatchObject({ status: "open", waiting_on: "credits_fault" });
    expect(pub!.waiting_since).not.toBeNull();
    expect(pub!.next_attempt_at).not.toBeNull();
    expect(JSON.stringify(pub)).not.toContain("402");
  });

  it("is passed over by the executor until its wait ends, instead of being picked first every time", async () => {
    // The 2026-11-12 stall: the refused row had the most backing of any
    // runnable row of its lane, so it was the next pick, every pick.
    const kind = "lookout_run" as ActionKind;
    const variant = tier();
    const a = await fundedRow({ variant, amount: 9_000_000_000_000 });
    await rawQuery(`UPDATE actions SET status = 'open' WHERE id = $1`, [a.id]);
    expect((await nextRunnableAction([kind]))?.id).toBe(a.id);

    await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [a.id]);
    await releaseAction(a.id, refused());
    expect((await nextRunnableAction([kind]))?.id).not.toBe(a.id);

    // The wait over, it is tried again, for as long as the fault lasts.
    await rawQuery(`UPDATE actions SET retry_after = now() - interval '1 second' WHERE id = $1`, [a.id]);
    expect((await nextRunnableAction([kind]))?.id).toBe(a.id);
    expect(await actionWaitingOn(a.id)).toBeNull();
  });

  it("waits longer after each consecutive refusal, and holds the funded rows of its kind and tier with it", async () => {
    const variant = tier();
    const a = await fundedRow({ variant });
    const sibling = await fundedRow({ variant, status: "open" });
    const otherTier = await fundedRow({ variant: tier(), status: "open" });
    // Not funded: it waits on money, as it did before, not on the fault.
    const unfunded = await seedAction({ group: `faulttest:${randomUUID()}`, kind: "lookout_run", variant, costMicroUsd: 10_000 });
    // Money on it and no commission: no executor picks it, so it waits on a
    // payer, not on the fault, and nothing would ever try it and clear a mark.
    const looseGroup = `faulttest:${randomUUID()}`;
    const loose = await seedAction({ group: looseGroup, kind: "lookout_run", variant, costMicroUsd: 10_000 });
    await seedAllocation({ group: looseGroup, actionId: loose, userId: (payer ??= await seedUser("fault-payer")), amountMicroUsd: 50_000, commissionedBy: null });

    await releaseAction(a.id, refused());
    const first = await row(a.id);
    const held = await row(sibling.id);
    expect(held.fault_reason).toBe("credits_fault");
    expect(held.retry_after?.getTime()).toBe(first.retry_after?.getTime());
    expect((await row(otherTier.id)).fault_reason).toBeNull();
    expect((await row(unfunded)).fault_reason).toBeNull();
    expect((await row(loose)).fault_reason).toBeNull();

    // The sibling is tried when the wait ends and is refused too: the count
    // is the kind's, so the wait doubles whichever row was tried.
    await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [sibling.id]);
    await releaseAction(sibling.id, refused());
    const second = await row(sibling.id);
    expect(second.fault_attempts).toBe(2);
    expect(second.wait_seconds).toBeGreaterThan(FAULT_RETRY_BASE_SECONDS * 2 - 5);
    expect(second.wait_seconds).toBeLessThanOrEqual(FAULT_RETRY_BASE_SECONDS * 2);
    expect((await row(a.id)).retry_after?.getTime()).toBe(second.retry_after?.getTime());
    // Since when is since the first refusal.
    expect((await row(a.id)).fault_since?.getTime()).toBe(first.fault_since?.getTime());
  });

  it("does the same for a rejected key and for a provider that stayed down, by their own classes", async () => {
    const a = await fundedRow({ variant: tier() });
    expect(await releaseAction(a.id, Object.assign(new Error("401 invalid x-api-key"), { status: 401 }))).toBe("credentials_fault");
    expect((await row(a.id)).fault_reason).toBe("credentials_fault");
    const b = await fundedRow({ variant: tier() });
    expect(await releaseAction(b.id, Object.assign(new Error("503"), { status: 503 }))).toBe("provider_unavailable");
    expect((await row(b.id)).fault_reason).toBe("provider_unavailable");
  });

  it("is simply open again after a budget stop or a release with no cause", async () => {
    const a = await fundedRow({ variant: tier() });
    expect(await releaseAction(a.id, new LlmBudgetExceededError("hourly_token_count", 2, 1))).toBeNull();
    expect(await row(a.id)).toMatchObject({ status: "open", fault_reason: null, fault_attempts: 0, retry_after: null });
    const b = await fundedRow({ variant: tier() });
    expect(await releaseAction(b.id)).toBeNull();
    expect(await row(b.id)).toMatchObject({ status: "open", fault_reason: null, retry_after: null });
  });

  it("stops waiting when it runs, and the rows that waited with it are tried at once", async () => {
    const variant = tier();
    const a = await fundedRow({ variant });
    const sibling = await fundedRow({ variant, status: "open" });
    // Another kind of work waiting on the same class.
    const elsewhere = await fundedRow({ kind: "consistency_sweep", variant: tier() });
    await releaseAction(a.id, refused());
    await releaseAction(elsewhere.id, refused());
    expect((await row(sibling.id)).fault_reason).toBe("credits_fault");

    // The wait ends, the row is claimed and this time the provider serves it.
    await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [a.id]);
    await completeAction(a.id, 12_000);
    expect(await row(a.id)).toMatchObject({ status: "done", fault_reason: null, fault_since: null, fault_attempts: 0, retry_after: null });
    // Same kind and tier: the fault is over for them.
    expect(await row(sibling.id)).toMatchObject({ status: "open", fault_reason: null, retry_after: null });
    // Another kind on the same class: tried now, still marked until it runs.
    const other = await row(elsewhere.id);
    expect(other.fault_reason).toBe("credits_fault");
    expect(other.wait_seconds).toBeLessThanOrEqual(0);
  });

  it("stops waiting when any row of its kind and tier runs, not only one that had waited", async () => {
    // 2026-11-13: the row picked when a wait ended was one commissioned after
    // the fault, never marked; nine such sweeps finished and thirteen rows
    // went on reading as waiting.
    const variant = tier();
    const a = await fundedRow({ variant });
    const sibling = await fundedRow({ variant, status: "open" });
    const elsewhere = await fundedRow({ kind: "consistency_sweep", variant: tier() });
    const otherClass = await fundedRow({ kind: "correspondent_run", variant: tier() });
    await releaseAction(a.id, refused());
    await releaseAction(elsewhere.id, refused());
    await releaseAction(otherClass.id, Object.assign(new Error("503"), { status: 503 }));
    // Placed after the fault, and not marked.
    const fresh = await fundedRow({ variant });
    expect((await row(fresh.id)).fault_reason).toBeNull();

    // A row that closes having spent nothing says nothing about the provider.
    const idle = await fundedRow({ variant });
    await completeAction(idle.id, 0);
    expect((await row(a.id)).fault_reason).toBe("credits_fault");
    expect((await row(sibling.id)).fault_reason).toBe("credits_fault");

    await completeAction(fresh.id, 12_000);
    expect(await row(a.id)).toMatchObject({ status: "open", fault_reason: null, fault_since: null, fault_attempts: 0, retry_after: null });
    expect(await row(sibling.id)).toMatchObject({ status: "open", fault_reason: null, retry_after: null });
    // Another kind on the same class is tried now; one on another class waits on.
    const other = await row(elsewhere.id);
    expect(other.fault_reason).toBe("credits_fault");
    expect(other.wait_seconds).toBeLessThanOrEqual(0);
    expect((await row(otherClass.id)).wait_seconds).toBeGreaterThan(0);
  });

  it("reads as due, not waiting, once its next attempt has come", async () => {
    const variant = tier();
    const a = await fundedRow({ variant });
    await releaseAction(a.id, refused());
    const read = async () => {
      const [pub] = await rawQuery<{ waiting_on: string | null; waiting_since: Date | null; next_attempt_at: Date | null }>(
        `SELECT waiting_on, waiting_since, next_attempt_at FROM public_read.ledger WHERE action_id = $1`,
        [a.id]
      );
      const mine = (await queueHealth()).waitingOnFault.filter((w) => w.kind === "lookout_run" && w.reason === "credits_fault");
      return { pub: pub!, rows: mine.reduce((n, w) => n + w.rows, 0), due: mine.reduce((n, w) => n + w.due, 0) };
    };
    const waiting = await read();
    expect(waiting.pub.waiting_on).toBe("credits_fault");
    expect(waiting.rows).toBeGreaterThanOrEqual(1);

    // The wait ends and nothing has picked the row yet. The fault stays on
    // it (a second refusal continues the doubling), and no surface says it
    // is waiting on one.
    await rawQuery(`UPDATE actions SET retry_after = now() - interval '1 second' WHERE id = $1`, [a.id]);
    const due = await read();
    expect((await row(a.id)).fault_reason).toBe("credits_fault");
    expect(due.pub).toMatchObject({ waiting_on: null, waiting_since: null, next_attempt_at: null });
    expect(due.rows).toBe(waiting.rows - 1);
    expect(due.due).toBe(waiting.due + 1);
    expect(await actionWaitingOn(a.id)).toBeNull();

    // Refused again: waiting again, the count carried on.
    await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [a.id]);
    await releaseAction(a.id, refused());
    expect((await row(a.id)).fault_attempts).toBe(2);
    expect((await read()).pub.waiting_on).toBe("credits_fault");
  });

  it("never reads as waiting once it is closed, whichever statement closed it", async () => {
    const a = await fundedRow({ variant: tier() });
    await releaseAction(a.id, refused());
    // A park, a retired group and a reconcile sweep each close rows with a
    // statement of their own; the trigger covers them all.
    await rawQuery(`UPDATE actions SET status = 'cancelled', updated_at = now() WHERE id = $1`, [a.id]);
    expect(await row(a.id)).toMatchObject({ status: "cancelled", fault_reason: null, fault_attempts: 0, retry_after: null });
    await rawQuery(`UPDATE actions SET status = 'open' WHERE id = $1`, [a.id]);
    expect((await row(a.id)).fault_reason).toBeNull();
    const [pub] = await rawQuery<{ waiting_on: string | null }>(
      `SELECT waiting_on FROM public_read.ledger WHERE action_id = $1`,
      [a.id]
    );
    expect(pub!.waiting_on).toBeNull();
  });
});

describe("what the payer reads", () => {
  it("a plan item whose ingest a fault is holding reads open, with the reason and what happens to its budget", async () => {
    const funder = await seedUser("fault-plan-funder");
    const { grantId } = await seedMandate({ funderId: funder, budgetMicroUsd: 100 * OWL });
    const url = `https://example.org/fault-plan-${randomUUID()}`;
    await rawQuery(`UPDATE grants SET plan = $2::jsonb WHERE id = $1`, [
      grantId,
      JSON.stringify({ items: [{ action: "ingest", url, rationale: "read it" }] }),
    ]);
    await materializePlanItems(grantId);
    const [ingest] = await rawQuery<{ id: string }>(`SELECT id FROM actions WHERE target_ref = $1 AND kind = 'ingest'`, [url]);
    await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [ingest!.id]);
    await releaseAction(ingest!.id, refused());

    await materializePlanItems(grantId);
    const [g] = await rawQuery<{ plan: { items: Array<{ ledger?: PlanItemLedger }> } }>(`SELECT plan FROM grants WHERE id = $1`, [grantId]);
    const ledger = g!.plan.items[0]!.ledger!;
    // Not cancelled, not failed: open, and saying why it is not running.
    expect(ledger.status).toBe("open");
    expect(ledger.reason).toContain("waiting on a deployment fault");
    expect(ledger.reason).toContain("out of credits");
    expect(ledger.reason).toContain("The platform retries it on its own");
    expect(ledger.reason).toContain("budget stays held");
    expect(ledger.reason).not.toContain("402");
    const [item] = await rawQuery<{ ledger_status: string; ledger_reason: string }>(
      `SELECT ledger_status, ledger_reason FROM public_read.plan_items WHERE mandate_id = $1`,
      [grantId]
    );
    expect(item).toMatchObject({ ledger_status: "open" });
    expect(item!.ledger_reason).toContain("waiting on a deployment fault");
  });

  it("a commission placed while its kind of work is waiting says so, and joins the wait", async () => {
    const funder = await seedUser("fault-commission-funder");
    const { grantId } = await seedMandate({ funderId: funder, budgetMicroUsd: 100 * OWL, dailyBudgetMicroUsd: 50 * OWL });
    // A standard pass elsewhere was just refused: the Steward's provider is out.
    const blockedClaim = await seedClaim("fault blocked pass");
    const blocked = await seedAction({ group: `assess:${blockedClaim}`, claimId: blockedClaim, costMicroUsd: 500_000, status: "running" });
    await seedAllocation({ group: `assess:${blockedClaim}`, actionId: blocked, grantId, amountMicroUsd: 600_000 });
    await releaseAction(blocked, refused());

    const node = await seedClaim("fault commissioned node");
    const res = await commissionNodePass({
      payer: { kind: "grant", grantId },
      claimId: node,
      budgetMicroUsd: 610_000,
      brief: "Assess it.",
      commissionedBy: "grantmaker",
    });
    expect(res.ok && res.status).toBe("commissioned");
    if (!res.ok || res.status !== "commissioned") return;
    expect(res.waiting?.reason).toBe("credits_fault");
    const note = commissionNoteText(res);
    expect(note).toContain("placed but not starting yet");
    expect(note).toContain("waiting on a deployment fault");
    expect(note).toContain("budget stays held");
    expect(note).toContain("counts against the mandate's pace from when it was placed");
    // It reads as waiting on the ledger from the start.
    expect((await row(res.actionId)).fault_reason).toBe("credits_fault");
    // The hold is as it was for any work not yet run: no limit added or lifted.
    const [al] = await rawQuery<{ released_at: Date | null; amount: string }>(
      `SELECT released_at, amount_micro_usd AS amount FROM action_allocations WHERE id = $1`,
      [res.allocationId]
    );
    expect(al!.released_at).toBeNull();
    expect(Number(al!.amount)).toBe(610_000);

    // Nothing waiting on the kind: nothing joined, nothing said.
    const quiet = await fundedRow({ variant: tier(), status: "open" });
    expect(await joinFaultWait(quiet.id)).toBeNull();
    // Leave the Steward lane's rows as other files expect to find them.
    await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE kind IN ('assess', 'reassess') AND fault_reason IS NOT NULL`);
  });

  it("the review briefing states the fault, the mandate's waiting rows and what is held, and that nothing is asked of it", async () => {
    const funder = await seedUser("fault-briefing-funder");
    const { grantId } = await seedMandate({ funderId: funder, budgetMicroUsd: 100 * OWL, dailyBudgetMicroUsd: 50 * OWL });
    expect(await platformFaultBriefing(grantId, null)).toBe("");

    const variant = tier();
    const a = await fundedRow({ variant, grantId, amount: 610_000 });
    const b = await fundedRow({ variant, grantId, amount: 610_000, status: "open" });
    // As the client's seam records it when the call is refused.
    await noteDeploymentFault(refused("openrouter"), { surface: "the lookout agent" });
    await releaseAction(a.id, refused("openrouter"));
    expect((await row(b.id)).fault_reason).toBe("credits_fault");

    const text = await platformFaultBriefing(grantId, null);
    expect(text).toContain("Platform faults");
    expect(text).toContain("Open since");
    expect(text).toContain("out of credits");
    expect(text).toContain("The operator has been told");
    expect(text).toContain("2 of your funded lookout_run rows (1.22 owls held) are waiting on a deployment fault");
    expect(text).toContain("Do not commission such work again");
    expect(text).toContain("counts against your pace from when it was placed");
    expect(text).toContain("A fault does not wake your review");
    // The class, never the provider's words or its name.
    expect(text).not.toMatch(/402|max_tokens|openrouter/i);

    await runMandateReview({ grantId });
    expect(h.briefing).toContain("Platform faults (none of this is your work's doing");
    expect(h.briefing).toContain("1.22 owls held");

    // Over: the next pass is told it came and went, once.
    await rawQuery(`UPDATE deployment_faults SET last_seen_at = now() - interval '2 hours' WHERE cleared_at IS NULL`);
    expect(await clearSettledDeploymentFaults()).toBeGreaterThanOrEqual(1);
    const after = await platformFaultBriefing(grantId, new Date(Date.now() - 3_600_000).toISOString());
    expect(after).toContain("Over: a deployment fault");
    expect(after).not.toContain("are waiting on");
    expect(await platformFaultBriefing(grantId, new Date(Date.now() + 60_000).toISOString())).toBe("");
  });
});

describe("an ingest a deployment fault stops", () => {
  async function plannedIngest() {
    const funder = await seedUser("fault-ingest-funder");
    const { grantId, jobId: budgetJobId } = await seedMandate({ funderId: funder, budgetMicroUsd: 100 * OWL, dailyBudgetMicroUsd: 50 * OWL });
    expect(await collectMandateEvents(grantId)).toBe(0);
    await rawQuery(`UPDATE grants SET events_scanned_at = now() - interval '1 minute' WHERE id = $1`, [grantId]);
    const url = `https://example.org/fault-ingest-${randomUUID()}`;
    const group = `ingest:${url}`;
    // As the engine executor leaves it: the row running, the source
    // submitted, the mandate's pipeline naming the job.
    const actionId = await seedAction({ group, kind: "ingest", costMicroUsd: 100_000, status: "running", targetRef: url });
    const allocationId = await seedAllocation({ group, actionId, grantId, amountMicroUsd: 9_000_000_000_000 });
    const source = await getOrCreateSource({ url, content: "A page of text the Extractor would read." });
    const job = await createJob("url_extraction", { sourceId: source.id, url }, { userId: funder });
    await rawQuery(`INSERT INTO grant_sources (grant_id, source_id, url, job_id) VALUES ($1, $2, $3, $4)`, [grantId, source.id, url, job.id]);
    const [review] = await rawQuery<{ id: string }>(
      `INSERT INTO actions (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, status, updated_at)
       VALUES ('mandate_review', $1, 'standard', $2, 'review', 500000, 'done', now() - make_interval(mins => $3))
       RETURNING id`,
      [`review:${grantId}`, grantId, 60]
    );
    const message = { sourceId: source.id, jobId: job.id, url, ingestGroup: group, meterJobId: budgetJobId, grantId };
    return { grantId, url, group, actionId, allocationId, jobId: job.id, reviewId: review!.id, message };
  }

  it("is not cancelled: its row waits, funded, and the platform picks it up again without a new plan item", async () => {
    const p = await plannedIngest();
    h.extractError = refused("anthropic");
    // The ledger owns the retry, so the message is done: nothing is thrown
    // for the queue to redeliver beside it.
    await expect(handleUrlExtraction(p.message)).resolves.toBeUndefined();

    const r = await row(p.actionId);
    expect(r.status).toBe("open");
    expect(r.fault_reason).toBe("credits_fault");
    const [al] = await rawQuery<{ released_at: Date | null }>(`SELECT released_at FROM action_allocations WHERE id = $1`, [p.allocationId]);
    expect(al!.released_at).toBeNull();

    // The job says what happened by class, and that the platform retries it.
    const [job] = await rawQuery<{ status: string; error: string; result: Record<string, unknown> }>(
      `SELECT status, error, result FROM jobs WHERE id = $1`,
      [p.jobId]
    );
    expect(job!.status).toBe("failed");
    expect(job!.error).toContain("did not finish because of a deployment fault");
    expect(job!.error).toContain("the platform submits it again on its own");
    expect(job!.error).not.toMatch(/402|max_tokens|Add credits/);
    expect(job!.result).toMatchObject({ platform_fault: "credits_fault", retried_by_platform: true });

    // Passed over while it waits; the next pick of its lane when the wait ends.
    expect((await nextRunnableAction(["ingest"]))?.id).not.toBe(p.actionId);
    await rawQuery(`UPDATE actions SET retry_after = now() - interval '1 second' WHERE id = $1`, [p.actionId]);
    expect((await nextRunnableAction(["ingest"]))?.id).toBe(p.actionId);
    await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE id = $1`, [p.actionId]);
  });

  it("is not news for the mandate: the failed extraction is not an event, and the retry's end is", async () => {
    const p = await plannedIngest();
    h.extractError = refused();
    await handleUrlExtraction(p.message);

    expect(await collectMandateEvents(p.grantId)).toBe(0);
    expect((await pendingMandateEvents(p.grantId)).total).toBe(0);

    // The platform's retry: a new job for the same source, which finishes.
    h.extractError = null;
    const [gs] = await rawQuery<{ source_id: string }>(`SELECT source_id FROM grant_sources WHERE grant_id = $1`, [p.grantId]);
    const retry = await createJob("url_extraction", { sourceId: gs!.source_id, url: p.url }, {});
    await rawQuery(`INSERT INTO grant_sources (grant_id, source_id, url, job_id) VALUES ($1, $2, $3, $4)`, [p.grantId, gs!.source_id, p.url, retry.id]);
    await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [p.actionId]);
    await handleUrlExtraction({ ...p.message, jobId: retry.id });
    expect((await row(p.actionId)).status).toBe("done");

    await rawQuery(`UPDATE grants SET events_scanned_at = now() - interval '1 minute' WHERE id = $1`, [p.grantId]);
    expect(await collectMandateEvents(p.grantId)).toBe(1);
    const { events } = await pendingMandateEvents(p.grantId);
    expect(events[0]).toMatchObject({ kind: "source_ingested" });
    expect(events[0]!.payload).toMatchObject({ outcome: "completed" });
  });

  it("is still cancelled, and still news, when the failure is the source's own", async () => {
    const p = await plannedIngest();
    h.extractError = new Error("The document could not be parsed");
    await expect(handleUrlExtraction(p.message)).rejects.toThrow("could not be parsed");
    expect((await row(p.actionId)).status).toBe("cancelled");
    const [job] = await rawQuery<{ status: string; error: string }>(`SELECT status, error FROM jobs WHERE id = $1`, [p.jobId]);
    expect(job).toMatchObject({ status: "failed", error: "The document could not be parsed" });
    expect(await collectMandateEvents(p.grantId)).toBe(1);
  });
});

describe("the tagging lane, which has no ledger row", () => {
  // The lane's wait is one row of platform_flags (services/tagging-lane.ts),
  // written by whichever task met the fault and read by the process that
  // serves /queue and /monitors.
  afterEach(() => clearTaggingLaneWait());

  it("says on /queue and /monitors what it is waiting on, since when and until when, and stops saying so when the attempt is due", async () => {
    expect((await taggingQueueHealth()).waiting).toBeNull();

    const placed = await holdTaggingLaneOnFault("credits_fault", null);
    expect(placed).toMatchObject({ reason: "credits_fault", attempts: 1 });
    const health = await taggingQueueHealth();
    expect(health.waiting).toMatchObject({ reason: "credits_fault", attempts: 1, since: placed.since, next_attempt_at: placed.next_attempt_at });
    expect(health.waiting!.reason_label).toContain("out of credits");
    expect(typeof health.pending).toBe("number");
    const lane = (await queueHealth()).taggingLane;
    expect(lane.waiting).toMatchObject({ reason: "credits_fault", next_attempt_at: placed.next_attempt_at });
    expect(lane.pending).toBe(health.pending);

    // A second refusal continues the count from the first and keeps its since.
    const second = await holdTaggingLaneOnFault("credits_fault", await readTaggingLaneWait());
    expect(second).toMatchObject({ attempts: 2, since: placed.since });
    expect(Date.parse(second.next_attempt_at) - Date.now()).toBeGreaterThan(FAULT_RETRY_BASE_SECONDS * 2 * 1000 - 5000);

    // Its time has come and no tick has run yet: due, not waiting.
    const later = Date.parse(second.next_attempt_at) + 1;
    expect(await currentTaggingLaneWait(later)).toBeNull();
    expect(await readTaggingLaneWait()).toMatchObject({ reason: "credits_fault", attempts: 2 });

    await clearTaggingLaneWait();
    expect((await taggingQueueHealth()).waiting).toBeNull();
    expect((await queueHealth()).taggingLane.waiting).toBeNull();
  });

  it("says so when it is the spend breaker it waits on, until the breaker's window rolls over", async () => {
    const placed = await holdTaggingLaneOnBreaker("hourly_call_count", null);
    expect(Date.parse(placed.next_attempt_at) % 3_600_000).toBe(0);
    const health = await taggingQueueHealth();
    expect(health.waiting).toMatchObject({ reason: "spend_breaker", attempts: 0 });
    expect(health.waiting!.reason_label).toContain("spend breaker");
  });
});

describe("what the operator is told", () => {
  it("one open fault and one report, however many calls it fails; the class on /monitors, the provider's words only in the report", async () => {
    const provider = `prov-${randomUUID().slice(0, 8)}`;
    expect(await noteDeploymentFault(refused(provider), { surface: "the matcher agent" })).toBe("credits_fault");
    // More failures in the same process fold into the next write.
    for (let i = 0; i < 5; i++) await noteDeploymentFault(refused(provider));
    resetDeploymentFaultState();
    await noteDeploymentFault(refused(provider));
    // A ledger row refused by a provider the client did not name records it too.
    const a = await fundedRow({ variant: tier() });
    await releaseAction(a.id, refused());

    const faults = await rawQuery<{ reason: string; occurrences: number; reported_at: Date | null; last_error: string }>(
      `SELECT reason, occurrences, reported_at, last_error FROM deployment_faults WHERE provider = $1`,
      [provider]
    );
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ reason: "credits_fault", occurrences: 2 });
    expect(faults[0]!.reported_at).not.toBeNull();
    // Kept for maintainers.
    expect(faults[0]!.last_error).toContain("available credits");

    const reports = await rawQuery<{ severity: string; kind: string; occurrence_count: number; body: string }>(
      `SELECT severity, kind, occurrence_count, body FROM agent_reports WHERE title = $1`,
      [`deployment fault: the ${provider} account is out of credits`]
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ severity: "blocking", kind: "system_failure" });
    expect(Number(reports[0]!.occurrence_count)).toBe(1);
    expect(reports[0]!.body).toContain("Add credits");
    expect(reports[0]!.body).toContain("One report per fault");

    // A rejected key is its own fault, not folded into this one.
    await noteDeploymentFault(Object.assign(new Error("401 invalid x-api-key"), { status: 401, llmProvider: provider }));
    // Anything else records nothing.
    expect(await noteDeploymentFault(Object.assign(new Error("529 overloaded"), { status: 529 }))).toBeNull();

    const open = (await openDeploymentFaults()).filter((f) => f.provider === provider);
    expect(open.map((f) => f.reason).sort()).toEqual(["credentials_fault", "credits_fault"]);
    const credits = open.find((f) => f.reason === "credits_fault")!;
    expect(credits.failedCalls).toBe(2);
    expect(credits.waitingRows).toBeGreaterThanOrEqual(1);
    expect(credits.reasonLabel).toContain("out of credits");

    const health = await queueHealth();
    const shown = health.deploymentFaults.filter((f) => f.provider === provider);
    expect(shown).toHaveLength(2);
    expect(JSON.stringify(health.deploymentFaults)).not.toMatch(/402|available credits|x-api-key/);
    expect(health.waitingOnFault.find((w) => w.reason === "credits_fault" && w.kind === "lookout_run")?.rows).toBeGreaterThanOrEqual(1);
  });

  it("the fault closes once the provider has served a call after a quiet spell, and what waited is tried at once", async () => {
    const provider = `prov-${randomUUID().slice(0, 8)}`;
    await noteDeploymentFault(refused(provider));
    const a = await fundedRow({ variant: tier() });
    await releaseAction(a.id, refused(provider));
    expect(await actionWaitingOn(a.id)).toBe("credits_fault");

    // Refused a moment ago: open, whatever else the provider served. A
    // nearly empty account passes small requests while it refuses large ones.
    await rawQuery(`INSERT INTO llm_usage (provider, model, agent, input_tokens, output_tokens, cost_micro_usd) VALUES ($1, 'm', 'matcher', 1, 1, 1)`, [provider]);
    expect(await clearSettledDeploymentFaults()).toBe(0);

    // Quiet for the spell, and a served call since the last refusal.
    await rawQuery(
      `UPDATE deployment_faults SET last_seen_at = now() - make_interval(mins => $2) WHERE provider = $1`,
      [provider, CLEAR_QUIET_MINUTES + 1]
    );
    expect(await clearSettledDeploymentFaults()).toBe(1);
    expect((await openDeploymentFaults()).filter((f) => f.provider === provider)).toEqual([]);
    // The row no longer reads as waiting and may be picked now.
    expect(await row(a.id)).toMatchObject({ status: "open", fault_reason: null, retry_after: null });

    // The same fault later is a sighting of the same report, not a new one.
    resetDeploymentFaultState();
    await noteDeploymentFault(refused(provider));
    const reports = await rawQuery<{ occurrence_count: number }>(
      `SELECT occurrence_count FROM agent_reports WHERE title = $1`,
      [`deployment fault: the ${provider} account is out of credits`]
    );
    expect(reports).toHaveLength(1);
    expect(Number(reports[0]!.occurrence_count)).toBe(2);
  });

  it("a quiet fault with no served call since stays open until the silent spell passes", async () => {
    const provider = `prov-${randomUUID().slice(0, 8)}`;
    await noteDeploymentFault(refused(provider));
    await rawQuery(
      `UPDATE deployment_faults SET last_seen_at = now() - make_interval(mins => $2) WHERE provider = $1`,
      [provider, CLEAR_QUIET_MINUTES + 1]
    );
    expect(await clearSettledDeploymentFaults()).toBe(0);
    await rawQuery(`UPDATE deployment_faults SET last_seen_at = now() - interval '61 minutes' WHERE provider = $1`, [provider]);
    expect(await clearSettledDeploymentFaults()).toBe(1);
  });
});
