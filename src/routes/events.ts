/**
 * Events for outside clients (docs/events.md): the event types, reading one
 * from a position, and webhook subscriptions.
 *
 *   GET    /events                     — the event types and how each is delivered
 *   POST   /events/poll                — events of one type after a cursor
 *   POST   /events/subscriptions       — subscribe a callback address, or refresh
 *   GET    /events/subscriptions       — the caller's subscriptions
 *   DELETE /events/subscriptions/:id   — end one
 *
 * The same service answers the MCP Events extension's methods
 * (src/mcp/events.ts), so the two cannot drift. An event is the same object
 * wherever it appears: here, in a poll over MCP, and in a webhook's body.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadConfig } from "../config.js";
import {
  DEFAULT_EVENTS_PAGE,
  eventTypes,
  MAX_EVENTS_PAGE,
  NEXT_POLL_MS,
  pollEvents,
  type DeliveryMode,
} from "../services/event-types.js";
import {
  DEFAULT_TTL_MS,
  listWebhooks,
  MAX_TTL_MS,
  MIN_TTL_MS,
  subscribeWebhook,
  unsubscribeWebhook,
  webhooksAvailable,
  type DeliveryStatus,
  type WebhookErrorCode,
} from "../services/event-webhook-service.js";

const STATUS: Record<WebhookErrorCode, number> = {
  INVALID_PARAMS: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  RESOURCE_EXHAUSTED: 429,
  UNSUPPORTED: 501,
  CALLBACK_ENDPOINT_ERROR: 422,
};

/** The delivery modes this deployment offers. */
export function deliveryModes(): DeliveryMode[] {
  return webhooksAvailable() ? ["poll", "webhook"] : ["poll"];
}

function refuse(
  request: FastifyRequest,
  reply: FastifyReply,
  e: { code: WebhookErrorCode; message: string; data?: Record<string, unknown> }
) {
  return reply
    .code(STATUS[e.code])
    .send({ error: { code: e.code, message: e.message, ...(e.data ? { details: e.data } : {}), request_id: request.id } });
}

function statusView(s: DeliveryStatus) {
  return {
    active: s.active,
    last_delivery_at: s.lastDeliveryAt,
    last_error: s.lastError,
    ...(s.failedSince ? { failed_since: s.failedSince } : {}),
  };
}

const hours = (ms: number) => ms / 3_600_000;

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  const max = loadConfig().eventWebhookMaxPerAccount;

  app.get("/", {
    schema: {
      tags: ["events"],
      summary:
        "The events you can follow: each type's name, the arguments that narrow it, what each event carries, " +
        "and how it is delivered (poll: poll_events; webhook: subscribe_events). Free",
    },
    handler: async (_request, reply) => reply.send({ events: eventTypes(deliveryModes()) }),
  });

  app.post<{
    Body: { name: string; arguments?: Record<string, unknown>; cursor?: string | null; max_events?: number; max_age_ms?: number };
  }>("/poll", {
    schema: {
      tags: ["events"],
      summary:
        "Events of one type after a position, oldest first. Call it first with no cursor: that returns no " +
        "events and the cursor for now. Keep the cursor from each answer and pass it back; when has_more is " +
        `true call again at once, otherwise wait next_poll_ms. A read: it changes nothing, holds nothing for ` +
        "you and is free",
      body: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 100, description: "An event type's name (list_event_types)" },
          arguments: { type: "object", description: "The type's arguments, as its inputSchema describes", additionalProperties: true },
          cursor: {
            type: ["string", "null"],
            maxLength: 300,
            description: "The cursor from your last answer or delivery. Leave it out to start from now",
          },
          max_events: {
            type: "integer",
            minimum: 1,
            maximum: MAX_EVENTS_PAGE,
            default: DEFAULT_EVENTS_PAGE,
            description: `Most events to return, ${DEFAULT_EVENTS_PAGE} by default`,
          },
          max_age_ms: {
            type: "integer",
            minimum: 0,
            description: "Read back no further than this many milliseconds, however old the cursor. truncated says when that skipped something",
          },
        },
        required: ["name"],
      },
    },
    handler: async (request, reply) => {
      const b = request.body;
      const result = await pollEvents({
        name: b.name,
        arguments: b.arguments,
        cursor: b.cursor ?? null,
        maxEvents: b.max_events ?? null,
        maxAgeMs: b.max_age_ms ?? null,
      });
      if (!result.ok) return refuse(request, reply, result);
      const { events, cursor, truncated, hasMore } = result.page;
      return reply.send({ events, cursor, truncated, has_more: hasMore, next_poll_ms: NEXT_POLL_MS });
    },
  });

  app.post<{
    Body: {
      name: string;
      arguments?: Record<string, unknown>;
      url: string;
      secret: string;
      cursor?: string | null;
      max_age_ms?: number;
      ttl_ms?: number | null;
    };
  }>("/subscriptions", {
    schema: {
      tags: ["events"],
      summary:
        "Have an event type POSTed to an https address of yours as it happens, or refresh a subscription you " +
        "hold: the same address, type and arguments again renew it, take a new secret, and resume delivery " +
        "that was suspended. Each delivery is one event, signed (Standard Webhooks: webhook-id, " +
        "webhook-timestamp, webhook-signature under your secret) and carrying the cursor after it. Before the " +
        'first, the address is sent {"type":"verification","challenge":"..."} and must answer 2xx with ' +
        '{"challenge":"<the same>"}. A subscription ends at refresh_before unless refreshed: ' +
        `${hours(DEFAULT_TTL_MS)} hours by default, ${hours(MIN_TTL_MS) * 60} minutes at least, ` +
        `${hours(MAX_TTL_MS) / 24} days at most. An account holds at most ${max} at once: each is matched ` +
        "against every event and nothing prices that, so the number is fixed. A webhook carries what is " +
        "public here; to follow more, poll. Holding one is free",
      body: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 100, description: "An event type that offers webhook delivery (list_event_types)" },
          arguments: { type: "object", description: "The type's arguments, as its inputSchema describes", additionalProperties: true },
          url: { type: "string", maxLength: 2000, description: "Where to POST: an https address you control" },
          secret: {
            type: "string",
            maxLength: 200,
            description:
              "The signing secret, which you generate and keep: whsec_ followed by the base64 of 24 to 64 random bytes. Give a new one on a refresh to rotate it",
          },
          cursor: {
            type: ["string", "null"],
            maxLength: 300,
            description:
              "Where to begin: a cursor you kept from a poll or a delivery. Leave it out to start from now. Ignored on a refresh of a live subscription, which carries on where it is",
          },
          max_age_ms: { type: "integer", minimum: 0, description: "With a cursor: begin no further back than this" },
          ttl_ms: {
            type: ["integer", "null"],
            minimum: 1,
            description: "How long you want it to live, in milliseconds; null for the longest granted. refresh_before says what was granted",
          },
        },
        required: ["name", "url", "secret"],
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const b = request.body;
      const result = await subscribeWebhook(
        { userId: request.auth!.userId!, apiKeyId: request.auth!.apiKeyId },
        {
          name: b.name,
          arguments: b.arguments,
          url: b.url,
          secret: b.secret,
          cursor: b.cursor ?? null,
          maxAgeMs: b.max_age_ms ?? null,
          ttlMs: b.ttl_ms,
        }
      );
      if (!result.ok) return refuse(request, reply, result);
      return reply.send({
        id: result.id,
        refresh_before: result.refreshBefore,
        cursor: result.cursor,
        truncated: result.truncated,
        ...(result.deliveryStatus ? { delivery_status: statusView(result.deliveryStatus) } : {}),
      });
    },
  });

  app.get("/subscriptions", {
    schema: {
      tags: ["events"],
      summary:
        "Your webhook subscriptions: what each follows, where it delivers, when it ends unless refreshed, its " +
        "cursor, and whether deliveries are landing. Never a secret",
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const rows = await listWebhooks(request.auth!.userId!);
      return reply.send({
        subscriptions: rows.map((r) => ({
          id: r.id,
          name: r.name,
          arguments: r.arguments,
          url: r.url,
          cursor: r.cursor,
          refresh_before: r.refreshBefore,
          created_at: r.createdAt,
          deliveries: r.deliveries,
          delivery_status: statusView(r.deliveryStatus),
        })),
        max,
      });
    },
  });

  app.delete<{ Params: { id: string } }>("/subscriptions/:id", {
    schema: {
      tags: ["events"],
      summary: "End one of your webhook subscriptions now, by its id. Deliveries stop at once; one left alone ends by itself at refresh_before",
      params: {
        type: "object",
        properties: { id: { type: "string", pattern: "^sub_[0-9a-f]{32}$", description: "The subscription's id (list_event_subscriptions)" } },
        required: ["id"],
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const result = await unsubscribeWebhook({ userId: request.auth!.userId! }, { id: request.params.id });
      if (!result.ok) return refuse(request, reply, result);
      return reply.send({ ended: true });
    },
  });
}
