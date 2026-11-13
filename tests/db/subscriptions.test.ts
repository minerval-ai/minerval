/**
 * The event log, subscriptions and the subscription router against real
 * Postgres: an event reaches the subscriptions it matches (by run, by node,
 * beneath a node, by mandate), into a session (waking it or not) or a
 * mandate's inbox; a check-in comes due; a session holding a subscription
 * pauses instead of closing, and waits past its latest check-in.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { recordEvent } from "../../src/services/event-service.js";
import { createSubscription } from "../../src/services/subscription-service.js";
import { routeEvents } from "../../src/services/subscription-router.js";
import { suspendSession, takeLiveReplies } from "../../src/services/session-service.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

async function session(status: "running" | "waiting" = "running"): Promise<string> {
  const id = randomUUID();
  await rawQuery(
    `INSERT INTO agent_sessions (id, role, status, awaiting, transcript, model)
     VALUES ($1, 'grantmaker', $2, '[]'::jsonb, '[]'::jsonb, 'm')`,
    [id, status]
  );
  return id;
}

async function replies(id: string): Promise<Array<{ kind: string; text: string; delivered: boolean; wake?: boolean }>> {
  const [s] = await rawQuery<{ replies: Array<{ kind: string; text: string; delivered: boolean; wake?: boolean }> }>(
    `SELECT replies FROM agent_sessions WHERE id = $1`,
    [id]
  );
  return s!.replies;
}

beforeEach(async () => {
  // Each test reads the log from where the last one left it.
  await routeEvents();
});

describe("subscriptions", () => {
  it("delivers a settled run to the running session that subscribed to it, and only that one", async () => {
    const mine = await session();
    const other = await session();
    const action = randomUUID();
    await createSubscription({ subscriberKind: "session", subscriberRef: mine, filter: { action_ids: [action] }, once: true, reason: "the pass I commissioned", createdBy: "test" });
    await createSubscription({ subscriberKind: "session", subscriberRef: other, filter: { action_ids: [randomUUID()] }, reason: "another run", createdBy: "test" });
    await recordEvent({ kind: "run_settled", actionId: action, summary: "Assess X finished, spending 1.2 owls." });
    await routeEvents();
    const shown = await takeLiveReplies(mine);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.text).toContain("the pass I commissioned");
    expect(shown[0]!.text).toContain("Assess X finished");
    expect(await takeLiveReplies(other)).toHaveLength(0);
    // once: it ended at its first delivery.
    const [s] = await rawQuery<{ active: boolean; deliveries: number }>(
      `SELECT active, deliveries FROM subscriptions WHERE subscriber_ref = $1`,
      [mine]
    );
    expect(s).toEqual({ active: false, deliveries: 1 });
  });

  it("matches beneath a node, and a queued delivery does not wake a paused session", async () => {
    const root = await seedClaim("root");
    const child = await seedClaim("child");
    await rawQuery(`INSERT INTO claim_relationships (parent_claim_id, child_claim_id, reasoning) VALUES ($1, $2, 'a premise')`, [root, child]);
    const paused = await session("waiting");
    await createSubscription({ subscriberKind: "session", subscriberRef: paused, filter: { under: [root] }, delivery: "queue", reason: "my subtree", createdBy: "test" });
    await recordEvent({ kind: "assessed", nodeId: child, summary: "Its verdict moved from supported to doubtful." });
    await routeEvents();
    const [s] = await rawQuery<{ status: string }>(`SELECT status FROM agent_sessions WHERE id = $1`, [paused]);
    expect(s!.status).toBe("waiting");
    const r = await replies(paused);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "subscription", delivered: false, wake: false });
  });

  it("raises a mandate-wide event to the mandate's inbox", async () => {
    const { grantId } = await seedGrantWithJob({ funderId: await seedUser("sub funder"), budgetMicroUsd: 10 * OWL });
    const node = await seedClaim("watched");
    await createSubscription({ subscriberKind: "mandate_inbox", subscriberRef: grantId, filter: { node_ids: [node], kinds: ["assessed"] }, reason: "a node the plan rests on", createdBy: "test" });
    await recordEvent({ kind: "assessed", nodeId: node, summary: "First assessed: supported." });
    await recordEvent({ kind: "run_settled", nodeId: node, summary: "not an assessment" });
    await routeEvents();
    const items = await rawQuery<{ kind: string; summary: string }>(
      `SELECT kind, summary FROM mandate_inbox WHERE grant_id = $1 AND kind = 'subscription'`,
      [grantId]
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.summary).toContain("First assessed: supported.");
  });

  it("delivers a check-in when it comes due, and keeps a paused session waiting until then", async () => {
    const id = await session();
    const due = new Date(Date.now() + 3 * 86_400_000);
    await createSubscription({ subscriberKind: "session", subscriberRef: id, dueAt: due, once: true, reason: "look again on Friday", createdBy: "test" });
    const status = await suspendSession({ id, transcript: [], model: "m", budgetLeftMicroUsd: 0, payer: null });
    expect(status).toBe("waiting");
    const [s] = await rawQuery<{ deadline: string }>(`SELECT deadline::text AS deadline FROM agent_sessions WHERE id = $1`, [id]);
    expect(new Date(s!.deadline).getTime()).toBeGreaterThan(due.getTime());
    // Make it due, and route.
    await rawQuery(`UPDATE subscriptions SET due_at = now() - interval '1 minute' WHERE subscriber_ref = $1`, [id]);
    await routeEvents();
    const r = await replies(id);
    expect(r.at(-1)!.text).toContain("look again on Friday");
    const [after] = await rawQuery<{ status: string }>(`SELECT status FROM agent_sessions WHERE id = $1`, [id]);
    expect(after!.status).toBe("ready");
  });

  it("closes a session that holds nothing, and ends its subscriptions when it closes", async () => {
    const id = await session();
    await createSubscription({ subscriberKind: "session", subscriberRef: id, filter: { node_ids: [randomUUID()] }, delivery: "queue", reason: "queued only", createdBy: "test" });
    expect(await suspendSession({ id, transcript: [], model: "m", budgetLeftMicroUsd: 0, payer: null })).toBe("closed");
    const [s] = await rawQuery<{ active: boolean }>(`SELECT active FROM subscriptions WHERE subscriber_ref = $1`, [id]);
    expect(s!.active).toBe(false);
  });
});
