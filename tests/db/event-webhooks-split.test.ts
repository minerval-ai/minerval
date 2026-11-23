/**
 * Webhook subscriptions on a members-only deployment that has been split
 * into its three bottom layers (src/labels.ts, "The layers at the bottom";
 * docs/events.md, "What a webhook carries"). On its own database
 * (tests/db/urls.ts).
 *
 * A callback address is outside the deployment, so a delivery carries what
 * anyone may read: the public graph's rows and what the deployment released
 * outside. The members' own work, at the base label every member reads, is
 * not sent, though a member's poll returns it. And a delivery, like a
 * request, is for a member: an account whose grants are gone is sent the
 * ending and nothing more.
 */
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.hoisted(() => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `${url.pathname}_own_split_hooks`;
  process.env.DATABASE_URL = url.toString();
  process.env.READS = "members";
  process.env.LOG_LEVEL = "fatal";
  process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
  delete process.env.PROVIDER_LABELS;
});

import { rawQuery } from "../../src/db/client.js";
import { setNoContextSessionForTests, withSystemClearance } from "../../src/db/clearance.js";
import { loadConfig } from "../../src/config.js";
import { baseLabel, layersAreSplit, publishedLabel } from "../../src/labels.js";
import { runAtLabel } from "../../src/llm/usage-context.js";
import { recordEvent } from "../../src/services/event-service.js";
import { pollEvents } from "../../src/services/event-types.js";
import { deliveryTick, subscribeWebhook } from "../../src/services/event-webhook-service.js";
import { encodeChangeCursor, toMicroIso } from "../../src/services/graph-change-service.js";
import { ensureLabelSplit } from "../../src/services/label-split.js";
import { routeEvents } from "../../src/services/subscription-router.js";
import type { WebhookSend } from "../../src/services/webhook-sender.js";
import { makeSecret } from "../../src/services/webhook-signing.js";

const system = <T>(fn: () => Promise<T>) => withSystemClearance("A test of webhook delivery on a split deployment checks rows at every label.", fn);
const at = <T>(label: string, fn: () => Promise<T>) => runAtLabel(label, "a test", fn);

const url = `https://hooks.example.test/${randomUUID()}`;
const sent: Array<Record<string, unknown>> = [];
const send: WebhookSend = async (_to, _headers, body) => {
  const json = JSON.parse(body) as Record<string, unknown>;
  if (json.type !== "verification") sent.push(json);
  return { ok: true, status: 200, body: json.type === "verification" ? JSON.stringify({ challenge: json.challenge }) : "" };
};

/** A node at a label, judged there, with the event that tells of it. */
async function judgedNodeAt(label: string, text: string): Promise<{ node: string; assessment: string }> {
  return at(label, async () => {
    const [node] = await rawQuery<{ id: string }>(`INSERT INTO claims (text) VALUES ($1) RETURNING id`, [text]);
    const [a] = await rawQuery<{ id: string }>(
      `INSERT INTO assessments (claim_id, status, confidence, claim_credence, reasoning_trace)
       VALUES ($1, 'supported', 0.7, 0.8, 'db test') RETURNING id`,
      [node!.id]
    );
    await recordEvent({ kind: "assessed", nodeId: node!.id, refs: { assessment: a!.id }, summary: `assessed at ${label}` });
    return { node: node!.id, assessment: a!.id };
  });
}

describe("a webhook on a split, members-only deployment", () => {
  it("is sent what was published and not the members' own work, and nothing once the account is no member", async () => {
    expect(new URL(loadConfig().databaseUrl).pathname.endsWith("_own_split_hooks")).toBe(true);
    await ensureLabelSplit({ ...loadConfig(), providerLabels: { anthropic: ["public"] } });
    setNoContextSessionForTests({ role: "owner", label: baseLabel() });
    expect(layersAreSplit()).toBe(true);
    expect([baseLabel(), publishedLabel()]).toEqual(["members", "published"]);

    const [member] = await system(() =>
      rawQuery<{ id: string }>(`INSERT INTO contributors (display_name, external_id) VALUES ('hook member', $1) RETURNING id`, [
        `dbtest:hook-member:${randomUUID()}`,
      ])
    );
    const user = member!.id;
    const subscribe = () =>
      at(baseLabel(), () => subscribeWebhook({ userId: user }, { name: "graph.change", url, secret: makeSecret(), cursor: start }, send));
    const start = encodeChangeCursor(toMicroIso(new Date(Date.now() - 2000).toISOString()), "00000000-0000-0000-0000-000000000000");

    // Signed in and holding no grant: not a member, so nothing to follow.
    expect(await subscribe()).toMatchObject({ ok: false, code: "FORBIDDEN" });
    await system(() =>
      rawQuery(`INSERT INTO permission_grants (permission, account_id, label, granted_via) VALUES ('read', $1, $2, 'operator')`, [user, baseLabel()])
    );
    const made = await subscribe();
    if (!made.ok) throw new Error(`${made.code}: ${made.message}`);
    await system(() => routeEvents());

    const tag = randomUUID().slice(0, 8);
    const own = await judgedNodeAt(baseLabel(), `The members' own claim ${tag}`);
    await system(() => routeEvents());
    await system(() => rawQuery(`UPDATE event_webhooks SET checked_at = now() - interval '1 hour'`));
    await system(() => deliveryTick(send));
    expect(sent).toEqual([]);
    // The member reads it by polling, at the base label a member's request works at.
    const polled = await at(baseLabel(), () => pollEvents({ name: "graph.change", cursor: start }));
    expect(polled.ok && polled.page.events.map((e) => e.eventId)).toContain(own.assessment);

    const released = await judgedNodeAt(publishedLabel(), `A claim the organization released ${tag}`);
    await system(() => routeEvents());
    await system(() => deliveryTick(send));
    expect(sent.map((s) => s.eventId)).toEqual([released.assessment]);
    expect(JSON.stringify(sent)).not.toContain("members' own claim");

    // The grant is removed: the next delivery is the ending, and the subscription is gone.
    await system(() => rawQuery(`UPDATE permission_grants SET removed_at = now() WHERE account_id = $1`, [user]));
    await judgedNodeAt(publishedLabel(), `Another released claim ${tag}`);
    await system(() => routeEvents());
    await system(() => deliveryTick(send));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ type: "terminated", error: { code: -32024 } });
    expect(await system(() => rawQuery(`SELECT 1 FROM event_webhooks`))).toEqual([]);
  });
});
