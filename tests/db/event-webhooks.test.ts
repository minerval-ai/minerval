/**
 * Webhook subscriptions to events (src/services/event-webhook-service.ts;
 * docs/events.md) over real SQL. The address is a function in this file, so
 * nothing leaves the process; everything else is the real path, from the
 * event on the log through the router to the signed body.
 *
 *  - Subscribing proves the address once, keeps the secret sealed, and gives
 *    the same id for the same account, address, event type and arguments.
 *  - An event on the log that matches wakes the subscription, and the tick
 *    sends what a poll from its cursor would return, signed, once.
 *  - A failed delivery is retried under the same message id and given up
 *    after its tries; an address that keeps failing is suspended until its
 *    owner refreshes; a subscription that is not refreshed is collected.
 *  - A revoked key ends its subscriptions, and the address is told.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

vi.hoisted(() => {
  // The key a caller's signing secret is sealed with.
  process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.EVENT_WEBHOOK_MAX_PER_ACCOUNT = "4";
});

import { rawQuery } from "../../src/db/client.js";
import { recordEvent } from "../../src/services/event-service.js";
import { pollEvents } from "../../src/services/event-types.js";
import {
  deliveryTick,
  listWebhooks,
  MAX_ATTEMPTS,
  subscribeWebhook,
  unsubscribeWebhook,
  type SubscribeResult,
} from "../../src/services/event-webhook-service.js";
import { encodeChangeCursor, toMicroIso } from "../../src/services/graph-change-service.js";
import { createCorrespondent, publishCorrespondentUpdate } from "../../src/services/correspondent-service.js";
import { routeEvents } from "../../src/services/subscription-router.js";
import type { SendResult, WebhookSend } from "../../src/services/webhook-sender.js";
import { makeSecret, secretBytes, verifyDelivery } from "../../src/services/webhook-signing.js";
import { seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

interface Received {
  url: string;
  headers: Record<string, string>;
  body: string;
  json: Record<string, unknown>;
}

/** An address: it answers a challenge, and answers events as `answer` says. */
function address(answer: () => SendResult = () => ({ ok: true, status: 200, body: "" })) {
  const received: Received[] = [];
  const send: WebhookSend = async (url, headers, body) => {
    const json = JSON.parse(body) as Record<string, unknown>;
    received.push({ url, headers, body, json });
    if (json.type === "verification") return { ok: true, status: 200, body: JSON.stringify({ challenge: json.challenge }) };
    return answer();
  };
  return { received, send, events: () => received.filter((r) => r.json.type === undefined) };
}

const url = () => `https://hooks.example.test/${randomUUID()}`;
/** A position a moment ago, so that what a test does next is after it. */
const justNow = () => encodeChangeCursor(toMicroIso(new Date(Date.now() - 2000).toISOString()), "00000000-0000-0000-0000-000000000000");

async function assess(claimId: string, status: string, credence: number | null): Promise<string> {
  await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1 AND is_current`, [claimId]);
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO assessments (claim_id, status, confidence, claim_credence, reasoning_trace)
     VALUES ($1, $2, 0.7, $3, 'db test') RETURNING id`,
    [claimId, status, credence]
  );
  await recordEvent({ kind: "assessed", nodeId: claimId, refs: { assessment: row!.id }, summary: `assessed ${status}` });
  return row!.id;
}

async function row(id: string) {
  const [r] = await rawQuery<Record<string, unknown>>(`SELECT * FROM event_webhooks WHERE subscription_key = $1`, [id]);
  return r;
}

function ok(result: Awaited<ReturnType<typeof subscribeWebhook>>): SubscribeResult {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result;
}

beforeEach(async () => {
  // Each test starts with no subscription but its own: a tick sends for
  // every subscription that is due, whoever's address it is.
  await rawQuery(`DELETE FROM event_webhooks`);
  await rawQuery(`UPDATE subscriptions SET active = false WHERE subscriber_kind = 'webhook'`);
  // Whatever earlier tests left on the log is behind the router's cursor.
  await routeEvents();
});

describe("subscribing", () => {
  it("proves the address once, keeps the secret sealed, and is the same subscription when asked again", async () => {
    const user = await seedUser("hook subscriber");
    const node = await seedClaim("hook scope");
    const hook = address();
    const where = url();
    const secret = makeSecret();
    const args = { under: [node] };

    const first = ok(await subscribeWebhook({ userId: user }, { name: "graph.change", arguments: args, url: where, secret }, hook.send));
    expect(first.id).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(first.truncated).toBe(false);
    const life = new Date(first.refreshBefore).getTime() - Date.now();
    expect(life).toBeGreaterThan(23 * 3_600_000);
    expect(life).toBeLessThanOrEqual(24 * 3_600_000);

    // The challenge was signed with the caller's secret and named the subscription.
    expect(hook.received).toHaveLength(1);
    const challenge = hook.received[0]!;
    expect(challenge.json.type).toBe("verification");
    expect(challenge.headers["x-mcp-subscription-id"]).toBe(first.id);
    expect(challenge.headers["webhook-id"]).toMatch(/^msg_verification_/);
    expect(
      verifyDelivery(
        secretBytes(secret)!,
        challenge.headers["webhook-id"]!,
        Number(challenge.headers["webhook-timestamp"]),
        challenge.body,
        challenge.headers["webhook-signature"]!
      )
    ).toBe(true);

    const kept = (await row(first.id))!;
    expect(String(kept.secret_sealed)).not.toContain(secret.slice(6));
    expect(String(kept.secret_sealed).startsWith("v1.")).toBe(true);

    // The router holds a row for it, at public, for the kinds on the log that tell of a verdict.
    const [sub] = await rawQuery<{ filter: Record<string, unknown>; sensitivity_label: string; subscriber_kind: string }>(
      `SELECT filter, sensitivity_label, subscriber_kind FROM subscriptions WHERE id = $1`,
      [kept.router_subscription_id]
    );
    expect(sub).toMatchObject({ subscriber_kind: "webhook", sensitivity_label: "public", filter: { kinds: ["assessed"], under: [node] } });

    // The same four again: the same subscription, refreshed, and no second challenge.
    const again = ok(
      await subscribeWebhook({ userId: user }, { name: "graph.change", arguments: args, url: where, secret, ttlMs: 60_000 }, hook.send)
    );
    expect(again.id).toBe(first.id);
    expect(again.deliveryStatus).toEqual({ active: true, lastDeliveryAt: null, lastError: null });
    // A life shorter than the least is raised to it.
    expect(new Date(again.refreshBefore).getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(hook.received).toHaveLength(1);

    // Another event type to the same address, by the same account: already proven.
    const other = ok(
      await subscribeWebhook({ userId: user }, { name: "graph.change", arguments: { tags: ["nothing-here"] }, url: where, secret }, hook.send)
    );
    expect(other.id).not.toBe(first.id);
    expect(hook.received).toHaveLength(1);

    expect((await listWebhooks(user)).map((w) => w.id).sort()).toEqual([first.id, other.id].sort());
    expect(JSON.stringify(await listWebhooks(user))).not.toContain("whsec_");
  });

  it("refuses what is not a subscription, an address that does not answer the challenge, and one more than an account may hold", async () => {
    const user = await seedUser("hook refusals");
    const hook = address();
    const good = { name: "graph.change", url: url(), secret: makeSecret() };

    expect(await subscribeWebhook({ userId: user }, { ...good, name: "nothing.such" }, hook.send)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await subscribeWebhook({ userId: user }, { ...good, secret: "hunter2" }, hook.send)).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(await subscribeWebhook({ userId: user }, { ...good, secret: "whsec_" + randomBytes(8).toString("base64") }, hook.send)).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(await subscribeWebhook({ userId: user }, { ...good, url: "http://hooks.example.test/x" }, hook.send)).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(await subscribeWebhook({ userId: user }, { ...good, arguments: { flavour: "sweet" } }, hook.send)).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(hook.received).toHaveLength(0);

    // An address that answers, but not with the challenge.
    const deaf: WebhookSend = async () => ({ ok: true, status: 200, body: "{}" });
    expect(await subscribeWebhook({ userId: user }, good, deaf)).toMatchObject({
      ok: false,
      code: "CALLBACK_ENDPOINT_ERROR",
      data: { reason: "challenge_failed" },
    });
    const down: WebhookSend = async () => ({ ok: false, failure: "timeout" });
    expect(await subscribeWebhook({ userId: user }, good, down)).toMatchObject({
      ok: false,
      code: "CALLBACK_ENDPOINT_ERROR",
      data: { reason: "timeout" },
    });
    expect(await listWebhooks(user)).toEqual([]);

    for (let i = 0; i < 4; i++) ok(await subscribeWebhook({ userId: user }, { ...good, url: url() }, hook.send));
    const fifth = await subscribeWebhook({ userId: user }, { ...good, url: url() }, hook.send);
    expect(fifth).toMatchObject({ ok: false, code: "RESOURCE_EXHAUSTED", data: { limit: "subscriptions", max: 4 } });
    // Refreshing one already held is not one more.
    const [held] = await listWebhooks(user);
    expect((await subscribeWebhook({ userId: user }, { ...good, url: held!.url }, hook.send)).ok).toBe(true);
  });

  it("ends by its id for its own account only", async () => {
    const user = await seedUser("hook owner");
    const stranger = await seedUser("hook stranger");
    const hook = address();
    const sub = ok(await subscribeWebhook({ userId: user }, { name: "graph.change", url: url(), secret: makeSecret() }, hook.send));
    const routerRow = (await row(sub.id))!.router_subscription_id;

    expect(await unsubscribeWebhook({ userId: stranger }, { id: sub.id })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await unsubscribeWebhook({ userId: user }, { id: sub.id })).toEqual({ ok: true });
    expect(await row(sub.id)).toBeUndefined();
    const [r] = await rawQuery<{ active: boolean }>(`SELECT active FROM subscriptions WHERE id = $1`, [routerRow]);
    expect(r!.active).toBe(false);
    expect(await unsubscribeWebhook({ userId: user }, { id: sub.id })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("delivering", () => {
  it("sends a matching change once, signed, and carries what a poll from the same cursor returns", async () => {
    const user = await seedUser("hook reader");
    const node = await seedClaim("hook node");
    const elsewhere = await seedClaim("hook elsewhere");
    const hook = address();
    const secret = makeSecret();
    const start = justNow();
    const sub = ok(
      await subscribeWebhook({ userId: user }, { name: "graph.change", arguments: { under: [node] }, url: url(), secret, cursor: start }, hook.send)
    );
    // Nothing has happened yet: the first read finds nothing and sends nothing.
    await deliveryTick(hook.send);
    expect(hook.events()).toEqual([]);

    const outside = await assess(elsewhere, "supported", 0.8);
    const assessment = await assess(node, "supported", 0.8);
    await routeEvents();
    expect((await row(sub.id))!.wake_at).not.toBeNull();
    await deliveryTick(hook.send);

    const sent = hook.events();
    expect(sent).toHaveLength(1);
    const delivery = sent[0]!;
    expect(delivery.json).toMatchObject({
      eventId: assessment,
      name: "graph.change",
      data: { change_id: assessment, claim_id: node, kind: "first_assessment", status: "supported" },
    });
    expect(delivery.json.eventId).not.toBe(outside);
    expect(delivery.headers["x-mcp-subscription-id"]).toBe(sub.id);
    expect(delivery.headers["webhook-id"]).toMatch(/^msg_[A-Za-z0-9_-]+$/);
    expect(delivery.headers["webhook-id"]).not.toContain(assessment);
    expect(
      verifyDelivery(
        secretBytes(secret)!,
        delivery.headers["webhook-id"]!,
        Number(delivery.headers["webhook-timestamp"]),
        delivery.body,
        delivery.headers["webhook-signature"]!
      )
    ).toBe(true);

    // The same read by poll returns the same event, and the delivery's cursor is the position after it.
    const polled = await pollEvents({ name: "graph.change", arguments: { under: [node] }, cursor: start });
    expect(polled.ok && polled.page.events.map((e) => ({ ...e }))).toEqual([
      { eventId: delivery.json.eventId, name: "graph.change", timestamp: delivery.json.timestamp, data: delivery.json.data, cursor: delivery.json.cursor },
    ]);
    const after = await pollEvents({ name: "graph.change", arguments: { under: [node] }, cursor: String(delivery.json.cursor) });
    expect(after.ok && after.page.events).toEqual([]);

    // Sent once: the cursor moved, the mark is cleared, and another tick sends nothing.
    const kept = (await row(sub.id))!;
    expect(kept.wake_at).toBeNull();
    expect(kept.deliveries).toBe(1);
    await deliveryTick(hook.send);
    expect(hook.events()).toHaveLength(1);

    // A refresh of a live subscription carries on where it is, whatever cursor comes with it.
    const refreshed = ok(
      await subscribeWebhook({ userId: user }, { name: "graph.change", arguments: { under: [node] }, url: delivery.url, secret, cursor: start }, hook.send)
    );
    expect(refreshed.cursor).toBe(kept.cursor);
    await deliveryTick(hook.send);
    expect(hook.events()).toHaveLength(1);
    expect(refreshed.deliveryStatus?.lastDeliveryAt).not.toBeNull();
  });

  it("retries under the same message id, gives up after its tries, and moves on", async () => {
    const user = await seedUser("hook retries");
    const node = await seedClaim("hook retried node");
    let working = false;
    const hook = address(() => (working ? { ok: true, status: 200, body: "" } : { ok: false, failure: "http_5xx", status: 503 }));
    const sub = ok(
      await subscribeWebhook(
        { userId: user },
        { name: "graph.change", arguments: { under: [node], material_only: false }, url: url(), secret: makeSecret(), cursor: justNow() },
        hook.send
      )
    );
    const first = await assess(node, "supported", 0.8);
    const second = await assess(node, "supported", 0.8);
    await routeEvents();

    await deliveryTick(hook.send);
    expect(hook.events()).toHaveLength(1);
    let kept = (await row(sub.id))!;
    expect(kept).toMatchObject({ attempts: 1, attempt_event_id: first, last_error: "http_5xx", active: true });
    expect(kept.next_attempt_at).not.toBeNull();
    expect(kept.failed_since).not.toBeNull();

    // Not due yet: nothing is sent.
    await deliveryTick(hook.send);
    expect(hook.events()).toHaveLength(1);

    const due = () => rawQuery(`UPDATE event_webhooks SET next_attempt_at = now() - interval '1 second' WHERE subscription_key = $1`, [sub.id]);
    for (let attempt = 2; attempt < MAX_ATTEMPTS; attempt++) {
      await due();
      await deliveryTick(hook.send);
    }
    expect(hook.events()).toHaveLength(MAX_ATTEMPTS - 1);
    // Every try of one event is the same message, signed afresh.
    expect(new Set(hook.events().map((e) => e.headers["webhook-id"])).size).toBe(1);
    expect(new Set(hook.events().map((e) => e.json.eventId))).toEqual(new Set([first]));

    // The last try fails too: the event is given up and the cursor moves past it.
    await due();
    await deliveryTick(hook.send);
    kept = (await row(sub.id))!;
    expect(kept).toMatchObject({ attempts: 0, attempt_event_id: null, last_error: "http_5xx" });
    expect(hook.events()).toHaveLength(MAX_ATTEMPTS);

    // The stream goes on: the next event is sent when the address is back.
    working = true;
    await deliveryTick(hook.send);
    const last = hook.events().at(-1)!;
    expect(last.json.eventId).toBe(second);
    expect(last.headers["webhook-id"]).not.toBe(hook.events()[0]!.headers["webhook-id"]);
    expect(await row(sub.id)).toMatchObject({ failed_since: null, last_error: null, deliveries: 1 });
  });

  it("does not retry what the address refuses with 410", async () => {
    const user = await seedUser("hook gone");
    const node = await seedClaim("hook refused node");
    const hook = address(() => ({ ok: false, failure: "http_4xx", status: 410 }));
    const sub = ok(
      await subscribeWebhook(
        { userId: user },
        { name: "graph.change", arguments: { under: [node] }, url: url(), secret: makeSecret(), cursor: justNow() },
        hook.send
      )
    );
    await assess(node, "supported", 0.8);
    await routeEvents();
    await deliveryTick(hook.send);
    await deliveryTick(hook.send);
    expect(hook.events()).toHaveLength(1);
    expect(await row(sub.id)).toMatchObject({ attempts: 0, next_attempt_at: null, failed_since: null, active: true });
  });

  it("suspends an address that has failed for an hour, and resumes when its owner refreshes", async () => {
    const user = await seedUser("hook suspended");
    const node = await seedClaim("hook suspended node");
    let working = false;
    const hook = address(() => (working ? { ok: true, status: 200, body: "" } : { ok: false, failure: "connection_refused" }));
    const input = { name: "graph.change", arguments: { under: [node] }, url: url(), secret: makeSecret(), cursor: justNow() };
    const sub = ok(await subscribeWebhook({ userId: user }, input, hook.send));
    const assessment = await assess(node, "supported", 0.8);
    await routeEvents();
    await deliveryTick(hook.send);
    await rawQuery(
      `UPDATE event_webhooks SET failed_since = now() - interval '61 minutes', next_attempt_at = now() - interval '1 second' WHERE subscription_key = $1`,
      [sub.id]
    );
    await deliveryTick(hook.send);
    expect(await row(sub.id)).toMatchObject({ active: false, next_attempt_at: null });

    // Suspended: nothing is tried, however long.
    const tries = hook.events().length;
    await deliveryTick(hook.send);
    expect(hook.events()).toHaveLength(tries);

    // The refresh says what happened, and delivery resumes with the event that was waiting.
    working = true;
    const refreshed = ok(await subscribeWebhook({ userId: user }, input, hook.send));
    expect(refreshed.deliveryStatus).toMatchObject({ active: false, lastError: "connection_refused" });
    expect(refreshed.deliveryStatus?.failedSince).toBeDefined();
    await deliveryTick(hook.send);
    expect(hook.events().at(-1)!.json.eventId).toBe(assessment);
    expect(await row(sub.id)).toMatchObject({ active: true, deliveries: 1, failed_since: null });
  });

  it("signs with the old secret too for a while after a rotation", async () => {
    const user = await seedUser("hook rotation");
    const node = await seedClaim("hook rotated node");
    const hook = address();
    const old = makeSecret();
    const fresh = makeSecret();
    const input = { name: "graph.change", arguments: { under: [node] }, url: url(), cursor: justNow() };
    ok(await subscribeWebhook({ userId: user }, { ...input, secret: old }, hook.send));
    ok(await subscribeWebhook({ userId: user }, { ...input, secret: fresh }, hook.send));
    await assess(node, "supported", 0.8);
    await routeEvents();
    await deliveryTick(hook.send);
    const d = hook.events()[0]!;
    const check = (secret: string) =>
      verifyDelivery(secretBytes(secret)!, d.headers["webhook-id"]!, Number(d.headers["webhook-timestamp"]), d.body, d.headers["webhook-signature"]!);
    expect(d.headers["webhook-signature"]!.split(" ")).toHaveLength(2);
    expect(check(fresh)).toBe(true);
    expect(check(old)).toBe(true);
    expect(check(makeSecret())).toBe(false);
  });

  it("collects a subscription that was not refreshed", async () => {
    const user = await seedUser("hook lapsed");
    const hook = address();
    const sub = ok(await subscribeWebhook({ userId: user }, { name: "graph.change", url: url(), secret: makeSecret() }, hook.send));
    const routerRow = (await row(sub.id))!.router_subscription_id;
    await rawQuery(`UPDATE event_webhooks SET expires_at = now() - interval '1 second' WHERE subscription_key = $1`, [sub.id]);
    expect(await listWebhooks(user)).toEqual([]);
    const tick = await deliveryTick(hook.send);
    expect(tick.expired).toBeGreaterThanOrEqual(1);
    expect(await row(sub.id)).toBeUndefined();
    const [r] = await rawQuery<{ active: boolean }>(`SELECT active FROM subscriptions WHERE id = $1`, [routerRow]);
    expect(r!.active).toBe(false);
  });

  it("ends the subscriptions of a revoked key, and tells the address", async () => {
    const user = await seedUser("hook key");
    const node = await seedClaim("hook key node");
    const [key] = await rawQuery<{ id: string }>(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, 'hook key', 'epk_test', $2) RETURNING id`,
      [user, randomUUID()]
    );
    const hook = address();
    const secret = makeSecret();
    const sub = ok(
      await subscribeWebhook(
        { userId: user, apiKeyId: key!.id },
        { name: "graph.change", arguments: { under: [node] }, url: url(), secret, cursor: justNow() },
        hook.send
      )
    );
    await rawQuery(`UPDATE api_keys SET revoked_at = now() WHERE id = $1`, [key!.id]);
    await assess(node, "supported", 0.8);
    await routeEvents();
    await deliveryTick(hook.send);

    expect(hook.events()).toEqual([]);
    const told = hook.received.at(-1)!;
    expect(told.json).toMatchObject({ type: "terminated", error: { code: -32024, message: "Forbidden" } });
    expect(told.headers["webhook-id"]).toMatch(/^msg_terminated_/);
    expect(
      verifyDelivery(secretBytes(secret)!, told.headers["webhook-id"]!, Number(told.headers["webhook-timestamp"]), told.body, told.headers["webhook-signature"]!)
    ).toBe(true);
    expect(await row(sub.id)).toBeUndefined();
    // And the revoked key cannot subscribe again.
    expect(
      await subscribeWebhook({ userId: user, apiKeyId: key!.id }, { name: "graph.change", url: url(), secret }, hook.send)
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("sends a Correspondent's update to those who follow it: its id and title, not its body", async () => {
    const user = await seedUser("hook follower");
    const funder = await seedUser("hook funder");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 20_000_000 });
    const scope = await seedClaim("hook correspondent scope");
    const made = await createCorrespondent({
      grantId,
      title: `Hook correspondent ${randomUUID().slice(0, 8)}`,
      brief: "Follow the scope for its readers and say what moved, with the reasons a reader would want.",
      audience: "followers",
      scopeClaimIds: [scope],
      createdBy: "test",
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const correspondentId = made.correspondentId;
    const hook = address();
    const sub = ok(
      await subscribeWebhook(
        { userId: user },
        { name: "correspondent.update", arguments: { correspondent_id: correspondentId }, url: url(), secret: makeSecret(), cursor: justNow() },
        hook.send
      )
    );
    expect((await row(sub.id))!.router_subscription_id).toBeNull();
    expect(
      await subscribeWebhook({ userId: user }, { name: "correspondent.update", arguments: { correspondent_id: randomUUID() }, url: url(), secret: makeSecret() }, hook.send)
    ).toMatchObject({ ok: false, code: "INVALID_PARAMS" });

    const body = `The body of the update, which a delivery does not carry ${randomUUID()}`;
    const { updateId } = await publishCorrespondentUpdate({
      correspondentId,
      grantId,
      title: "What moved this week",
      body,
      items: [],
      notCovered: { changes: [], more: 0, unexamined: "" } as never,
      changesFrom: justNow(),
      changesTo: justNow(),
    });
    await deliveryTick(hook.send);
    const sent = hook.events();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.json).toMatchObject({
      eventId: updateId,
      name: "correspondent.update",
      data: { update_id: updateId, correspondent_id: correspondentId, mandate_id: grantId, title: "What moved this week", items: 0 },
    });
    expect(sent[0]!.body).not.toContain(body);
    await deliveryTick(hook.send);
    expect(hook.events()).toHaveLength(1);
  });
});
