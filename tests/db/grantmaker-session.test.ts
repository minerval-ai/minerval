/**
 * The Grantmaker's long-lived session against real Postgres: while it is
 * live (paused, holding its subscriptions) no fresh review pass opens; what
 * its officers escalate wakes it, and the sitting that resumes it is
 * commissioned from its mandate at the review-pass figure, not at what the
 * paused run happened to have left.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { REVIEW_GROUP, reconcileActions } from "../../src/services/action-service.js";
import { createSubscription } from "../../src/services/subscription-service.js";
import { recordEvent } from "../../src/services/event-service.js";
import { routeEvents } from "../../src/services/subscription-router.js";
import { OWL, seedGrantWithJob, seedUser } from "./helpers.js";

async function liveSession(grantId: string): Promise<string> {
  const id = randomUUID();
  await rawQuery(
    `INSERT INTO agent_sessions (id, role, status, awaiting, transcript, model, payer, context, budget_left_micro_usd, suspended_at, deadline)
     VALUES ($1, 'grantmaker', 'waiting', '[]'::jsonb, '[]'::jsonb, 'm', $2::jsonb, $3::jsonb, 50000, now(), now() + interval '2 days')`,
    [id, JSON.stringify({ grantId }), JSON.stringify({ input: { grantId } })]
  );
  await rawQuery(`UPDATE grants SET grantmaker_session_id = $2 WHERE id = $1`, [grantId, id]);
  return id;
}

describe("the Grantmaker's session", () => {
  it("opens no fresh pass while it is live, and wakes on an escalation into a sitting at the review-pass figure", async () => {
    const { grantId } = await seedGrantWithJob({ funderId: await seedUser("gm session"), budgetMicroUsd: 50 * OWL });
    await rawQuery(
      `INSERT INTO actions (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, status, updated_at)
       VALUES ('mandate_review', $1, 'standard', $2, 'review', 500000, 'done', now() - interval '3 days')`,
      [REVIEW_GROUP(grantId), grantId]
    );
    const session = await liveSession(grantId);
    await createSubscription({
      subscriberKind: "session",
      subscriberRef: session,
      filter: { kinds: ["escalated"], grant_ids: [grantId] },
      reason: "what your officers send you",
      createdBy: "system",
    });

    // Live: the reconcile sweep leaves the review closed (no hidden cadence).
    await reconcileActions();
    const [review] = await rawQuery<{ status: string }>(`SELECT status FROM actions WHERE exclusion_group = $1`, [REVIEW_GROUP(grantId)]);
    expect(review!.status).toBe("done");

    // An escalation from another mandate does not wake it; its own does.
    await recordEvent({ kind: "escalated", grantId: randomUUID(), summary: "someone else's" });
    await routeEvents();
    expect((await rawQuery<{ status: string }>(`SELECT status FROM agent_sessions WHERE id = $1`, [session]))[0]!.status).toBe("waiting");
    await recordEvent({ kind: "escalated", grantId, summary: "Your officer sent you a more_budget petition with a run waiting: beyond my limit." });
    await routeEvents();
    const [s] = await rawQuery<{ status: string; replies: Array<{ text: string }> }>(`SELECT status, replies FROM agent_sessions WHERE id = $1`, [session]);
    expect(s!.status).toBe("ready");
    expect(s!.replies.at(-1)!.text).toContain("beyond my limit");

    // The sitting that resumes it works to the review-pass figure (the
    // platform's default, 5 owls), not to the 0.05 owls the paused run had left.
    const [row] = await rawQuery<{ amount: string }>(
      `SELECT al.amount_micro_usd AS amount FROM actions a
         JOIN action_allocations al ON al.action_id = a.id AND al.released_at IS NULL
        WHERE a.kind = 'resume' AND a.target_ref = $1`,
      [session]
    );
    expect(Number(row!.amount)).toBe(5 * OWL);
    // Leave no live work behind for later files' executor ticks.
    await rawQuery(`UPDATE grants SET status = 'completed' WHERE id = $1`, [grantId]);
    await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE target_ref = $1 AND status = 'open'`, [session]);
  });

  it("opens a fresh pass once its session has ended", async () => {
    const { grantId } = await seedGrantWithJob({ funderId: await seedUser("gm ended"), budgetMicroUsd: 50 * OWL });
    await rawQuery(
      `INSERT INTO actions (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, status, updated_at)
       VALUES ('mandate_review', $1, 'standard', $2, 'review', 500000, 'done', now() - interval '3 days')`,
      [REVIEW_GROUP(grantId), grantId]
    );
    const session = await liveSession(grantId);
    await rawQuery(`UPDATE agent_sessions SET status = 'expired' WHERE id = $1`, [session]);
    await reconcileActions();
    const [review] = await rawQuery<{ status: string }>(`SELECT status FROM actions WHERE exclusion_group = $1`, [REVIEW_GROUP(grantId)]);
    expect(review!.status).toBe("open");
    await rawQuery(`UPDATE grants SET status = 'completed' WHERE id = $1`, [grantId]);
    await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE exclusion_group = $1`, [REVIEW_GROUP(grantId)]);
  });
});
