/**
 * A mandate's first hours, against real Postgres: what the postmortem of
 * the FAA ground-stop mandate (2026-11-13) found the machinery did not do.
 *
 *  - Its Grantmaker's first sitting opens at funding, and a lookout's run
 *    opens when its heartbeat falls due, without the six-hourly sweep
 *    (openMandateFirstSitting, openFirstSittings, openDueAgentRuns).
 *  - A pass that names the plan's ingests (`after`) waits for them to be
 *    read, at most AFTER_INGESTS_MAX_WAIT_HOURS, holding no money.
 *  - A `work_settled` subscription wakes its holder once, when nothing the
 *    mandate set going is waiting to run or running.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import {
  INGEST_GROUP,
  LOOKOUT_GROUP,
  PLANNING_GROUP,
  REVIEW_GROUP,
  mandateWorkInFlight,
  materializePlanItems,
  openDueAgentRuns,
  openFirstSittings,
  openMandateFirstSitting,
  type PlanItemLedger,
} from "../../src/services/action-service.js";
import { AFTER_INGESTS_MAX_WAIT_HOURS } from "../../src/services/grant-service.js";
import { createSubscription } from "../../src/services/subscription-service.js";
import { routeEvents } from "../../src/services/subscription-router.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

interface Item {
  action: string;
  ledger?: PlanItemLedger;
  [k: string]: unknown;
}

async function mandate(status: "active" | "planning" = "active") {
  const funder = await seedUser("first-hours funder");
  return seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL, grantStatus: status });
}

async function row(group: string) {
  const [r] = await rawQuery<{ id: string; status: string; kind: string }>(
    `SELECT id, status, kind FROM actions WHERE exclusion_group = $1 AND variant = 'standard'`,
    [group]
  );
  return r ?? null;
}

async function setPlan(grantId: string, items: Item[]): Promise<void> {
  await rawQuery(`UPDATE grants SET plan = $2::jsonb, plan_cursor = 0 WHERE id = $1`, [
    grantId,
    JSON.stringify({ strategy: "s", items }),
  ]);
}

async function ledgers(grantId: string): Promise<Array<PlanItemLedger | undefined>> {
  const [r] = await rawQuery<{ plan: { items: Item[] } }>(`SELECT plan FROM grants WHERE id = $1`, [grantId]);
  return r!.plan.items.map((i) => i.ledger);
}

async function placements(grantId: string): Promise<number> {
  const [r] = await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM action_allocations
      WHERE grant_id = $1 AND commissioned_by = 'plan' AND released_at IS NULL`,
    [grantId]
  );
  return Number(r!.n);
}

beforeAll(async () => {
  await rawQuery(
    `UPDATE grants SET status = 'completed' WHERE is_platform = true OR policy IN ('general', 'governance')`
  );
  resetAllocationPolicyCache();
});

describe("a new mandate's first sitting does not wait for the sweep", () => {
  it("opens an active mandate's first review row, and a planned one's planning row, idempotently", async () => {
    const active = await mandate("active");
    const planned = await mandate("planning");
    await openMandateFirstSitting(active.grantId);
    await openMandateFirstSitting(planned.grantId);
    expect(await row(REVIEW_GROUP(active.grantId))).toMatchObject({ kind: "mandate_review", status: "open" });
    expect(await row(PLANNING_GROUP(planned.grantId))).toMatchObject({ kind: "grant_planning", status: "open" });
    // Again: still one row each.
    await openMandateFirstSitting(active.grantId);
    const [n] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM actions WHERE exclusion_group = $1`,
      [REVIEW_GROUP(active.grantId)]
    );
    expect(Number(n!.n)).toBe(1);
  });

  it("between sweeps, opens the first sitting of a mandate that never had one, and only the first", async () => {
    const { grantId } = await mandate("active");
    await openFirstSittings();
    const first = await row(REVIEW_GROUP(grantId));
    expect(first?.status).toBe("open");
    // Its sitting ran and its session ended: a later sitting is not this
    // pass's to open (it opens on what the Grantmaker subscribed to).
    await rawQuery(`UPDATE actions SET status = 'done' WHERE id = $1`, [first!.id]);
    await openFirstSittings();
    expect((await row(REVIEW_GROUP(grantId)))?.status).toBe("done");
  });
});

describe("a lookout runs at its heartbeat, not the sweep's", () => {
  it("opens the row of a lookout that has fallen due, and not of one that has not", async () => {
    const { grantId } = await mandate();
    const [due] = await rawQuery<{ id: string }>(
      `INSERT INTO lookouts (grant_id, title, brief, heartbeat_hours, triggers, next_due_at)
       VALUES ($1, 'Breaking watch', 'Watch the story as it breaks.', 3, '[]'::jsonb, now() - interval '1 minute')
       RETURNING id`,
      [grantId]
    );
    const [later] = await rawQuery<{ id: string }>(
      `INSERT INTO lookouts (grant_id, title, brief, heartbeat_hours, triggers, next_due_at)
       VALUES ($1, 'Later watch', 'Watch the story later.', 3, '[]'::jsonb, now() + interval '2 hours')
       RETURNING id`,
      [grantId]
    );
    await openDueAgentRuns();
    expect(await row(LOOKOUT_GROUP(due!.id))).toMatchObject({ kind: "lookout_run", status: "open" });
    expect(await row(LOOKOUT_GROUP(later!.id))).toBeNull();
  });
});

describe("a pass can wait for the plan's ingests (after)", () => {
  const URL = () => `https://example.org/faa-${randomUUID().slice(0, 8)}`;

  it("waits, holding no money, until the ingest it names is read, then is placed", async () => {
    const { grantId } = await mandate();
    const claimId = await seedClaim("The FAA ordered a nationwide ground stop");
    const url = URL();
    await setPlan(grantId, [
      { action: "ingest", url, rationale: "the order itself" },
      { action: "assess", claim_id: claimId, variant: "standard", rationale: "the headline claim", after: [url] },
    ]);
    await materializePlanItems(grantId);
    let [, assess] = await ledgers(grantId);
    expect(assess!.status).toBe("waiting");
    expect(assess!.reason).toContain(url);
    expect(assess!.reason).toContain(`${AFTER_INGESTS_MAX_WAIT_HOURS} hours`);
    expect(assess!.after_wait_from).toBeTruthy();
    expect(await placements(grantId)).toBe(0);
    // The wait is work in flight: the ingest and the item waiting on it.
    expect(await mandateWorkInFlight(grantId)).toBe(2);

    // A later look while the ingest still runs keeps the time it began.
    const began = assess!.after_wait_from;
    await rawQuery(`UPDATE actions SET status = 'running' WHERE exclusion_group = $1`, [INGEST_GROUP(url)]);
    await materializePlanItems(grantId);
    [, assess] = await ledgers(grantId);
    expect(assess!.status).toBe("waiting");
    expect(assess!.after_wait_from).toBe(began);

    // The ingest is read: the pass is placed at the next look.
    await rawQuery(`UPDATE actions SET status = 'done' WHERE exclusion_group = $1`, [INGEST_GROUP(url)]);
    await materializePlanItems(grantId);
    [, assess] = await ledgers(grantId);
    expect(assess!.status).toBe("open");
    expect(assess!.order).toBeTruthy();
    expect(await placements(grantId)).toBe(1);
  });

  it("stops waiting once the most an item waits has passed, and says so", async () => {
    const { grantId } = await mandate();
    const claimId = await seedClaim("Flights resumed by morning");
    const url = URL();
    const longAgo = new Date(Date.now() - (AFTER_INGESTS_MAX_WAIT_HOURS + 1) * 3_600_000).toISOString();
    await setPlan(grantId, [
      { action: "ingest", url, rationale: "a stuck source" },
      {
        action: "assess",
        claim_id: claimId,
        variant: "standard",
        rationale: "must not wait forever",
        after: [url],
        ledger: { status: "waiting", reason: "waiting", after_wait_from: longAgo, checked_at: longAgo },
      },
    ]);
    await materializePlanItems(grantId);
    const [, assess] = await ledgers(grantId);
    expect(assess!.status).toBe("open");
    expect(assess!.reason).toContain("placed without waiting longer");
    expect(await placements(grantId)).toBe(1);
  });
});

describe("a work_settled subscription", () => {
  beforeEach(async () => {
    await routeEvents();
  });

  it("wakes its holder once, when nothing the mandate set going is waiting to run or running", async () => {
    const { grantId } = await mandate();
    const url = `https://example.org/wave-${randomUUID().slice(0, 8)}`;
    await setPlan(grantId, [{ action: "ingest", url, rationale: "the first source" }]);
    await materializePlanItems(grantId);
    const sessionId = randomUUID();
    await rawQuery(
      `INSERT INTO agent_sessions (id, role, status, awaiting, transcript, model)
       VALUES ($1, 'grantmaker', 'waiting', '[]'::jsonb, '[]'::jsonb, 'm')`,
      [sessionId]
    );
    await createSubscription({
      subscriberKind: "session",
      subscriberRef: sessionId,
      condition: { kind: "work_settled", grant_id: grantId, since: new Date().toISOString() },
      once: true,
      reason: "my first wave settling",
      createdBy: "test",
    });
    // The ingest is still to run: nothing is delivered.
    await routeEvents();
    const [held] = await rawQuery<{ active: boolean }>(`SELECT active FROM subscriptions WHERE subscriber_ref = $1`, [sessionId]);
    expect(held!.active).toBe(true);

    await rawQuery(`UPDATE actions SET status = 'done' WHERE exclusion_group = $1`, [INGEST_GROUP(url)]);
    expect(await mandateWorkInFlight(grantId)).toBe(0);
    await routeEvents();
    const [s] = await rawQuery<{ status: string; replies: Array<{ text: string }> }>(
      `SELECT status, replies FROM agent_sessions WHERE id = $1`,
      [sessionId]
    );
    expect(s!.status).toBe("ready");
    expect(s!.replies.at(-1)!.text).toContain("my first wave settling");
    const [ended] = await rawQuery<{ active: boolean }>(`SELECT active FROM subscriptions WHERE subscriber_ref = $1`, [sessionId]);
    expect(ended!.active).toBe(false);
  });
});
