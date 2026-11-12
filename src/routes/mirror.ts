/**
 * /mirror: the mirror feed, both sides (docs/mirror.md).
 *
 * Mounted only on a deployment configured for the mirror
 * (services/mirror-roles.ts), and then only the side it is on.
 *
 * A deployment that publishes:
 *   GET /mirror/feed/key        the public key the feed is signed with
 *   GET /mirror/feed            the batches after a sequence, without rows,
 *                               and where the latest snapshot begins
 *   GET /mirror/feed/:sequence  one batch as signed. Needs an account's key.
 *
 * A deployment that mirrors:
 *   GET /mirror/status          how current its mirror is: "the public graph
 *                               as of ..."
 *
 * Fetching a batch is the one read here that asks who is calling. The feed
 * is meant to have a price (design plan, "Every private graph pays towards
 * the public graph it reads") and nothing charges for it yet; when
 * something does, the check goes in that route's preHandler, after
 * authenticate, where the account is known.
 */
import type { FastifyInstance } from "fastify";
import { mirrorStatus } from "../services/mirror-apply-service.js";
import {
  FEED_LIST_DEFAULT,
  FEED_LIST_MAX,
  feedKey,
  getBatchText,
  listBatches,
} from "../services/mirror-feed-service.js";
import { mirrorRoles } from "../services/mirror-roles.js";

const HASH = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;

const BATCH_LISTING = {
  type: "object",
  properties: {
    sequence: { type: "integer" },
    kind: { type: "string", enum: ["snapshot", "changes"] },
    part: {
      type: "object",
      properties: { first: { type: "integer" }, last: { type: "boolean" } },
    },
    cut_at: { type: "string", format: "date-time" },
    migration: {
      type: "object",
      properties: { number: { type: "integer" }, tag: { type: "string" } },
    },
    shape: HASH,
    previous_hash: HASH,
    hash: HASH,
    key_id: { type: "string" },
    rows: { type: "integer" },
    removals: { type: "integer" },
    bytes: { type: "integer" },
  },
} as const;

export async function mirrorRoutes(app: FastifyInstance): Promise<void> {
  const roles = mirrorRoles();

  if (roles.publisher) {
    app.get("/feed/key", {
      schema: {
        tags: ["mirror"],
        summary:
          "The public key this deployment signs its mirror feed with: an Ed25519 key as the base64 of " +
          "its 32 bytes, the key's id as batches name it, and the feed's id. A deployment that mirrors " +
          "this graph is configured with this key and applies a batch only when its signature verifies " +
          "under it",
        response: {
          200: {
            type: "object",
            properties: {
              algorithm: { type: "string" },
              public_key: { type: "string" },
              key_id: { type: "string" },
              feed_id: { type: "string", nullable: true },
            },
          },
        },
      },
      handler: async (_request, reply) => reply.send(await feedKey()),
    });

    app.get<{ Querystring: { after?: number; limit?: number } }>("/feed", {
      schema: {
        tags: ["mirror"],
        summary:
          "The batches of this deployment's mirror feed after a sequence number, oldest first, without " +
          "their rows: each batch's sequence, its kind (a snapshot of every public row, or changes), " +
          "when it was cut, the schema migration it was cut from, its hash and the hash of the batch " +
          "before it, and its size. Also the newest batch's sequence and where the latest snapshot " +
          "begins, which is where a new mirror starts",
        querystring: {
          type: "object",
          properties: {
            after: { type: "integer", minimum: 0, description: "Batches with a sequence above this; all from the first when omitted" },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: FEED_LIST_MAX,
              default: FEED_LIST_DEFAULT,
              description: `Most batches to list, ${FEED_LIST_DEFAULT} by default`,
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              feed_id: { type: "string", nullable: true },
              head: { type: "integer", nullable: true },
              latest_snapshot: { type: "integer", nullable: true },
              batches: { type: "array", items: BATCH_LISTING },
              has_more: { type: "boolean" },
            },
          },
        },
      },
      handler: async (request, reply) =>
        reply.send(await listBatches({ after: request.query.after, limit: request.query.limit })),
    });

    app.get<{ Params: { sequence: number } }>("/feed/:sequence", {
      // An account's key, so that there is someone to answer for the fetch;
      // a price for the feed would be checked here.
      preHandler: [app.authenticate],
      schema: {
        tags: ["mirror"],
        summary:
          "One batch of the mirror feed, exactly as it was signed: the full public rows that changed, " +
          "the rows deleted or retracted, the hash of the batch before it, and the signature. Several " +
          "megabytes of rows, for a deployment's mirror to check and apply",
        params: {
          type: "object",
          required: ["sequence"],
          properties: { sequence: { type: "integer", minimum: 1 } },
        },
      },
      handler: async (request, reply) => {
        const text = await getBatchText(Number(request.params.sequence));
        if (text === null) {
          return reply.code(404).send({
            error: {
              code: "NO_SUCH_BATCH",
              message: `The feed has no batch ${request.params.sequence}. GET /mirror/feed lists the batches it has.`,
              request_id: request.id,
            },
          });
        }
        // Sent as the stored text, not re-serialized: these are the bytes
        // that were signed.
        return reply.type("application/json; charset=utf-8").send(text);
      },
    });
  }

  if (roles.applier) {
    app.get("/status", {
      schema: {
        tags: ["mirror"],
        summary:
          "How current this deployment's mirror of the public graph is. public_graph_as_of is the time " +
          "the mirrored claims, sources and assessments here are shown as of: when the public graph cut " +
          "the newest batch this deployment has applied. Also that batch's sequence and hash, when it " +
          "was applied, whether a snapshot is only partly applied (complete is then false), how many " +
          "mirrored claims a search can find, and the last batch refused since, with the reason",
        response: {
          200: {
            type: "object",
            properties: {
              applied: { type: "boolean" },
              public_graph_as_of: { type: "string", format: "date-time", nullable: true },
              complete: { type: "boolean" },
              sequence: { type: "integer", nullable: true },
              batch_hash: { type: "string", nullable: true },
              applied_at: { type: "string", format: "date-time", nullable: true },
              feed_id: { type: "string", nullable: true },
              key_id: { type: "string", nullable: true },
              public_web_base_url: { type: "string", nullable: true },
              searchable_claims: { type: "integer" },
              last_refusal: {
                type: "object",
                nullable: true,
                properties: {
                  sequence: { type: "integer", nullable: true },
                  code: { type: "string" },
                  message: { type: "string" },
                  refused_at: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
      },
      handler: async (_request, reply) => reply.send(await mirrorStatus()),
    });
  }
}
