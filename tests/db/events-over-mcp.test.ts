/**
 * Events over MCP (src/mcp/events.ts, src/routes/events.ts; docs/events.md),
 * against the real app and real SQL: the Events extension's own methods and
 * the tools generated from the routes answer from the same service, in the
 * extension's wire shape and with its error codes. Only the network is not
 * real: the callback address is a function in this file.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

vi.hoisted(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
});

const posted: Array<{ url: string; json: Record<string, unknown> }> = [];
vi.mock("../../src/services/webhook-sender.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/webhook-sender.js")>()),
  sendWebhook: vi.fn(async (url: string, _headers: Record<string, string>, body: string) => {
    const json = JSON.parse(body) as Record<string, unknown>;
    posted.push({ url, json });
    return { ok: true, status: 200, body: json.type === "verification" ? JSON.stringify({ challenge: json.challenge }) : "" };
  }),
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rawQuery } from "../../src/db/client.js";
import { assistantAuth } from "../../src/llm/tools/assistant-tools.js";
import { EVENTS_EXTENSION } from "../../src/mcp/events.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { recordEvent } from "../../src/services/event-service.js";
import { deliveryTick, listWebhooks } from "../../src/services/event-webhook-service.js";
import { routeEvents } from "../../src/services/subscription-router.js";
import { makeSecret } from "../../src/services/webhook-signing.js";
import { seedClaim, seedUser } from "./helpers.js";

let app: FastifyInstance;
const Any = z.looseObject({});

beforeAll(async () => {
  process.env.LOG_LEVEL = "fatal";
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
  await rawQuery(`DELETE FROM event_webhooks`);
});

afterAll(async () => {
  await app?.close();
});

async function connect(userId: string) {
  const server = buildMcpServer({ auth: assistantAuth({ id: userId, externalId: null }), requestId: `events-${randomUUID()}`, app });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "events-test", version: "1.0.0" });
  await client.connect(clientSide);
  const call = (method: string, params?: Record<string, unknown>) =>
    client.request({ method, ...(params ? { params } : {}) }, Any) as Promise<Record<string, unknown>>;
  const refused = async (method: string, params: Record<string, unknown>) =>
    call(method, params).then(
      () => null,
      (err: { code?: number; data?: unknown }) => ({ code: err.code, data: err.data })
    );
  return { client, call, refused };
}

async function assess(claimId: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO assessments (claim_id, status, confidence, claim_credence, reasoning_trace)
     VALUES ($1, 'supported', 0.7, 0.8, 'db test') RETURNING id`,
    [claimId]
  );
  await recordEvent({ kind: "assessed", nodeId: claimId, refs: { assessment: row!.id }, summary: "assessed" });
  return row!.id;
}

describe("the Events extension on the MCP endpoint", () => {
  it("advertises the extension and lists the event types with the modes offered", async () => {
    const { client, call } = await connect(await seedUser("events lister"));
    expect(client.getServerCapabilities()?.extensions).toMatchObject({ [EVENTS_EXTENSION]: {} });
    const listed = await call("events/list");
    expect(listed.resultType).toBe("complete");
    const events = listed.events as Array<{ name: string; delivery: string[]; inputSchema: unknown; payloadSchema: unknown }>;
    expect(events.map((e) => e.name)).toEqual(["graph.change", "correspondent.update"]);
    for (const e of events) {
      expect(e.delivery).toEqual(["poll", "webhook"]);
      expect(e.inputSchema).toMatchObject({ type: "object" });
      expect(e.payloadSchema).toMatchObject({ type: "object" });
    }
  });

  it("polls from now, then returns what happened after, in the extension's shape", async () => {
    const { call, refused } = await connect(await seedUser("events poller"));
    const node = await seedClaim("events polled node");
    const args = { under: [node] };
    const start = await call("events/poll", { name: "graph.change", arguments: args, cursor: null });
    expect(start).toMatchObject({ resultType: "complete", events: [], truncated: false, hasMore: false });
    expect(typeof start.cursor).toBe("string");
    expect(start.nextPollMs).toBeGreaterThanOrEqual(1000);

    const assessment = await assess(node);
    const next = await call("events/poll", { name: "graph.change", arguments: args, cursor: start.cursor, maxEvents: 5 });
    const events = next.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventId: assessment, name: "graph.change", data: { claim_id: node, kind: "first_assessment" } });
    expect(events[0]!.cursor).toBe(next.cursor);
    expect((await call("events/poll", { name: "graph.change", arguments: args, cursor: next.cursor })).events).toEqual([]);

    expect(await refused("events/poll", { name: "no.such", cursor: null })).toMatchObject({ code: -32023 });
    expect(await refused("events/poll", { name: "graph.change", cursor: "not-a-cursor" })).toMatchObject({ code: -32602 });
    expect(await refused("events/poll", { name: "graph.change", arguments: { colour: "red" }, cursor: null })).toMatchObject({ code: -32602 });
  });

  it("subscribes a webhook, refreshes it by the same key, delivers to it, and unsubscribes by what it is", async () => {
    const user = await seedUser("events subscriber");
    const { call, refused } = await connect(user);
    const node = await seedClaim("events hooked node");
    const url = `https://hooks.example.test/${randomUUID()}`;
    const secret = makeSecret();
    const params = { name: "graph.change", arguments: { under: [node] }, delivery: { mode: "webhook", url, secret }, cursor: null };

    expect(await refused("events/subscribe", { ...params, delivery: { mode: "webhook", url, secret: "nope" } })).toMatchObject({ code: -32602 });
    expect(await refused("events/subscribe", { ...params, delivery: { mode: "push", url, secret } })).toMatchObject({ code: -32026 });

    const made = await call("events/subscribe", params);
    expect(made).toMatchObject({ resultType: "complete", truncated: false });
    expect(String(made.id)).toMatch(/^sub_/);
    expect(new Date(String(made.refreshBefore)).getTime()).toBeGreaterThan(Date.now());
    expect(made.deliveryStatus).toBeUndefined();

    const again = await call("events/subscribe", { ...params, ttlMs: 3_600_000 });
    expect(again.id).toBe(made.id);
    expect(again.deliveryStatus).toEqual({ active: true, lastDeliveryAt: null, lastError: null });

    const assessment = await assess(node);
    await routeEvents();
    await deliveryTick();
    expect(posted.filter((p) => p.url === url && p.json.eventId === assessment)).toHaveLength(1);

    // Another account cannot end it: to that account there is no such subscription.
    const stranger = await connect(await seedUser("events stranger"));
    const noMode = { name: params.name, arguments: params.arguments, delivery: { url } };
    expect(await stranger.refused("events/unsubscribe", noMode)).toMatchObject({ code: -32023 });
    expect(await listWebhooks(user)).toHaveLength(1);

    expect(await call("events/unsubscribe", noMode)).toMatchObject({ resultType: "complete" });
    expect(await listWebhooks(user)).toEqual([]);
    expect(await refused("events/unsubscribe", noMode)).toMatchObject({ code: -32023 });
  });

  it("offers the same through tools, for a client that does not speak the extension", async () => {
    const user = await seedUser("events tools");
    const { client } = await connect(user);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["list_event_types", "poll_events", "subscribe_events", "list_event_subscriptions", "unsubscribe_events"])
    );
    const tool = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const text = ((result.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
      return JSON.parse(text) as Record<string, unknown>;
    };
    const polled = await tool("poll_events", { name: "graph.change" });
    expect(polled).toMatchObject({ events: [], truncated: false, has_more: false });
    const url = `https://hooks.example.test/${randomUUID()}`;
    const made = await tool("subscribe_events", { name: "graph.change", url, secret: makeSecret(), cursor: polled.cursor });
    expect(String(made.id)).toMatch(/^sub_/);
    const held = await tool("list_event_subscriptions", {});
    expect(held).toMatchObject({ subscriptions: [{ id: made.id, name: "graph.change", url }] });
    expect(JSON.stringify(held)).not.toContain("whsec_");
    expect(await tool("unsubscribe_events", { id: made.id })).toEqual({ ended: true });
    expect(await listWebhooks(user)).toEqual([]);
  });
});
