/**
 * Webhook subscriptions where a deployment holds material at more than one
 * label (src/services/event-webhook-service.ts; docs/events.md, "What a
 * webhook carries"). A callback address is outside the deployment, so a
 * delivery is read at `public` whatever the account may read: a judgment at
 * a private label does not wake the subscription, is not sent, and nothing
 * is said of it. A poll is a read at the caller's own clearance, and is how
 * a subscriber at a private label follows it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.hoisted(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
});

import { closeDb, rawQuery } from "../../src/db/client.js";
import { setNoContextSessionForTests, withSystemClearance } from "../../src/db/clearance.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { runAtLabel } from "../../src/llm/usage-context.js";
import { recordEvent } from "../../src/services/event-service.js";
import { pollEvents } from "../../src/services/event-types.js";
import { deliveryTick, subscribeWebhook } from "../../src/services/event-webhook-service.js";
import { encodeChangeCursor, toMicroIso } from "../../src/services/graph-change-service.js";
import { routeEvents } from "../../src/services/subscription-router.js";
import type { WebhookSend } from "../../src/services/webhook-sender.js";
import { makeSecret } from "../../src/services/webhook-signing.js";
import { seedClaim, seedUser } from "./helpers.js";

const tag = randomUUID().slice(0, 8);
const A = `hook-a-${tag}`;
const system = <T>(fn: () => Promise<T>) => withSystemClearance("A test of webhook delivery's fixtures.", fn);
const at = <T>(label: string, fn: () => Promise<T>) => runAtLabel(label, "a test", fn);

const sent: Array<Record<string, unknown>> = [];
const url = `https://hooks.example.test/${randomUUID()}`;
const send: WebhookSend = async (to, _headers, body) => {
  const json = JSON.parse(body) as Record<string, unknown>;
  if (to === url && json.type === undefined) sent.push(json);
  return { ok: true, status: 200, body: json.type === "verification" ? JSON.stringify({ challenge: json.challenge }) : "" };
};

let node: string;
let user: string;

/** A judgment of the node at a label, and the event that tells of it, as a run at that label writes them. */
async function assessAt(label: string, status: string): Promise<string> {
  return at(label, async () => {
    const [row] = await rawQuery<{ id: string }>(
      `INSERT INTO assessments (claim_id, status, confidence, claim_credence, reasoning_trace)
       VALUES ($1, $2, 0.7, 0.8, 'db test') RETURNING id`,
      [node, status]
    );
    await recordEvent({ kind: "assessed", nodeId: node, refs: { assessment: row!.id }, summary: `assessed ${status} at ${label}` });
    return row!.id;
  });
}

beforeAll(async () => {
  node = await seedClaim(`A node judged at two labels ${tag}`);
  user = await seedUser("hook at two labels");
  await system(() => rawQuery(`INSERT INTO labels (name, description) VALUES ($1, 'Private, for the webhook test.')`, [A]));
  await ensureEnforcement();
  setNoContextSessionForTests(null);
  await system(async () => {
    await rawQuery(`DELETE FROM event_webhooks`);
    await routeEvents();
  });
});

afterAll(async () => {
  await system(async () => {
    await rawQuery(`DELETE FROM event_webhooks`);
    await rawQuery(`DELETE FROM subscriptions WHERE subscriber_kind = 'webhook'`);
    await rawQuery(`DELETE FROM events WHERE node_id = $1`, [node]);
    await rawQuery(`DELETE FROM assessments WHERE claim_id = $1`, [node]);
  });
  await closeDb();
});

describe("a webhook, with a second label", () => {
  it("is sent what public reads and nothing of a judgment at a private label, which a poll at that label returns", async () => {
    const start = encodeChangeCursor(toMicroIso(new Date(Date.now() - 2000).toISOString()), "00000000-0000-0000-0000-000000000000");
    // The account subscribes from a request at the private label; the subscription is the same wherever it is made.
    const made = await at(A, () =>
      subscribeWebhook({ userId: user }, { name: "graph.change", arguments: { under: [node] }, url, secret: makeSecret(), cursor: start }, send)
    );
    if (!made.ok) throw new Error(`${made.code}: ${made.message}`);
    const marked = async () =>
      (await system(() => rawQuery<{ wake_at: string | null }>(`SELECT wake_at::text AS wake_at FROM event_webhooks WHERE subscription_key = $1`, [made.id])))[0]!
        .wake_at;
    await system(() => deliveryTick(send));
    expect(sent).toEqual([]);

    const secret = await assessAt(A, "doubtful");
    await system(() => routeEvents());
    // The private event does not so much as wake it.
    expect(await marked()).toBeNull();
    await system(() => rawQuery(`UPDATE event_webhooks SET checked_at = now() - interval '1 hour'`));
    // And the sweep, which reads whether or not anything woke it, finds nothing to send.
    await system(() => deliveryTick(send));
    expect(sent).toEqual([]);

    // A poll at the private label reads it; a poll at public does not.
    const privately = await at(A, () => pollEvents({ name: "graph.change", arguments: { under: [node] }, cursor: start }));
    expect(privately.ok && privately.page.events.map((e) => e.eventId)).toEqual([secret]);
    const publicly = await at("public", () => pollEvents({ name: "graph.change", arguments: { under: [node] }, cursor: start }));
    expect(publicly.ok && publicly.page.events).toEqual([]);

    const open = await assessAt("public", "supported");
    await system(() => routeEvents());
    expect(await marked()).not.toBeNull();
    await system(() => deliveryTick(send));
    expect(sent.map((s) => s.eventId)).toEqual([open]);
    expect(JSON.stringify(sent)).not.toContain(secret);
    expect(JSON.stringify(sent)).not.toContain("doubtful");
  });
});
