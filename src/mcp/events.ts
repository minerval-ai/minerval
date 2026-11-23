/**
 * The MCP Events extension's own methods on the remote endpoint
 * (`io.modelcontextprotocol/events`; docs/events.md, "Over MCP").
 *
 * A client that speaks the extension follows events at the protocol level,
 * without a model in the loop: `events/list`, `events/poll`,
 * `events/subscribe` and `events/unsubscribe`. Each is answered by
 * dispatching into the REST route that does the same thing
 * (routes/events.ts), as a route tool is (dispatch.ts), so the route's
 * guards and validation are the only ones and the three doors cannot
 * disagree. What this file adds is the extension's wire shape: its field
 * names, its result type, and its error codes.
 *
 * The extension is written for protocol revision 2026-07-28, and this
 * endpoint serves 2025-11-25. The methods and the capability are here now;
 * `server/discover` and the `Mcp-Name` routing header belong to the newer
 * revision and come with the move to it. `events/stream` (a held
 * connection) is not offered: no event type lists `push`.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";
import type { RequestAuth } from "../server/plugins/auth.js";
import { validateArguments } from "../services/event-types.js";
import { subscriptionId } from "../services/webhook-signing.js";
import { dispatchToRoute } from "./dispatch.js";

export const EVENTS_EXTENSION = "io.modelcontextprotocol/events";

/** The extension's error codes, by the name the REST routes answer with. */
export const EVENT_ERROR_CODES: Record<string, number> = {
  INVALID_PARAMS: -32602,
  NOT_FOUND: -32023,
  FORBIDDEN: -32024,
  RESOURCE_EXHAUSTED: -32025,
  UNSUPPORTED: -32026,
  CALLBACK_ENDPOINT_ERROR: -32027,
};

const params = z.looseObject({}).optional();

const ListRequest = z.object({ method: z.literal("events/list"), params });
const PollRequest = z.object({ method: z.literal("events/poll"), params });
const SubscribeRequest = z.object({ method: z.literal("events/subscribe"), params });
const UnsubscribeRequest = z.object({ method: z.literal("events/unsubscribe"), params });

interface RestError {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
  message?: string;
}

/** A route's answer as the extension's result, or its refusal as the extension's error. */
function answered(response: { statusCode: number; body: string }): Record<string, unknown> {
  let body: unknown = null;
  try {
    body = JSON.parse(response.body);
  } catch {
    // An answer that is not JSON is a fault below.
  }
  if (response.statusCode >= 200 && response.statusCode < 300 && body && typeof body === "object") {
    return body as Record<string, unknown>;
  }
  const e = (body ?? {}) as RestError;
  const named = e.error?.code ? EVENT_ERROR_CODES[e.error.code] : undefined;
  const code =
    named ??
    (response.statusCode === 400
      ? EVENT_ERROR_CODES.INVALID_PARAMS!
      : response.statusCode === 401 || response.statusCode === 403
        ? EVENT_ERROR_CODES.FORBIDDEN!
        : response.statusCode === 404
          ? EVENT_ERROR_CODES.NOT_FOUND!
          : -32603);
  throw new McpError(code, e.error?.message ?? e.message ?? "The request could not be answered.", e.error?.details);
}

function statusOut(s: unknown): Record<string, unknown> | undefined {
  if (!s || typeof s !== "object") return undefined;
  const d = s as Record<string, unknown>;
  return {
    active: d.active,
    lastDeliveryAt: d.last_delivery_at ?? null,
    lastError: d.last_error ?? null,
    ...(d.failed_since ? { failedSince: d.failed_since } : {}),
  };
}

/** Add the extension's methods and capability to a server built for one request. */
export function registerEventMethods(server: McpServer, ctx: { auth: RequestAuth; app?: FastifyInstance }): void {
  const app = ctx.app;
  if (!app) return;
  const low = server.server;
  low.registerCapabilities({ extensions: { [EVENTS_EXTENSION]: {} } });
  const call = (method: string, url: string, body?: Record<string, unknown>) =>
    dispatchToRoute(app, ctx.auth, { method, url, ...(body ? { body } : {}) });
  const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

  low.setRequestHandler(ListRequest, async () => {
    const out = answered(await call("GET", "/events"));
    return { resultType: "complete", events: out.events };
  });

  low.setRequestHandler(PollRequest, async (request) => {
    const p = (request.params ?? {}) as Record<string, unknown>;
    const out = answered(
      await call(
        "POST",
        "/events/poll",
        defined({ name: p.name, arguments: p.arguments, cursor: p.cursor, max_events: p.maxEvents, max_age_ms: p.maxAgeMs })
      )
    );
    return {
      resultType: "complete",
      events: out.events,
      cursor: out.cursor,
      truncated: out.truncated,
      hasMore: out.has_more,
      nextPollMs: out.next_poll_ms,
    };
  });

  low.setRequestHandler(SubscribeRequest, async (request) => {
    const p = (request.params ?? {}) as Record<string, unknown>;
    const delivery = (p.delivery ?? {}) as Record<string, unknown>;
    if (delivery.mode !== undefined && delivery.mode !== "webhook") {
      throw new McpError(EVENT_ERROR_CODES.UNSUPPORTED!, "events/subscribe is for webhook delivery.", {
        feature: "deliveryMode",
        value: delivery.mode,
      });
    }
    const out = answered(
      await call(
        "POST",
        "/events/subscriptions",
        defined({
          name: p.name,
          arguments: p.arguments,
          url: delivery.url,
          secret: delivery.secret,
          cursor: p.cursor,
          max_age_ms: p.maxAgeMs,
          ttl_ms: p.ttlMs,
        })
      )
    );
    const status = statusOut(out.delivery_status);
    return {
      resultType: "complete",
      id: out.id,
      refreshBefore: out.refresh_before,
      cursor: out.cursor,
      truncated: out.truncated,
      ...(status ? { deliveryStatus: status } : {}),
    };
  });

  low.setRequestHandler(UnsubscribeRequest, async (request) => {
    const p = (request.params ?? {}) as Record<string, unknown>;
    const delivery = (p.delivery ?? {}) as Record<string, unknown>;
    if (!ctx.auth.userId) {
      throw new McpError(EVENT_ERROR_CODES.FORBIDDEN!, "A webhook subscription belongs to an account; this request has none.");
    }
    const checked = validateArguments(p.name, p.arguments);
    if (!checked.ok) throw new McpError(EVENT_ERROR_CODES[checked.code]!, checked.message, checked.kind ? { kind: checked.kind } : undefined);
    if (typeof delivery.url !== "string") throw new McpError(EVENT_ERROR_CODES.INVALID_PARAMS!, "delivery.url is required.");
    // A subscription is named by what it is; its id is derived from that and is never taken as input.
    const id = subscriptionId(`user:${ctx.auth.userId}`, delivery.url, checked.name, checked.arguments);
    answered(await call("DELETE", `/events/subscriptions/${id}`));
    return { resultType: "complete" };
  });
}
