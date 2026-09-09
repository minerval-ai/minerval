/**
 * /findings (#394): what the administrators have found that people who hold
 * a question would be better for knowing, published as written.
 *
 * Reads are public, like claims: a finding is the graph's voice on the
 * record, and the findings page is the raw feed the platform's later
 * writing draws from. The one write is the operator's withdrawal, behind
 * the service key: a note that should not have been made comes off the
 * page with a reason, and the row stays so the id resolves.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { findingStatusEnum, uuidSchema } from "../schemas/common.js";
import {
  formatFinding,
  formatFindingSighting,
  getFindingById,
  listFindings,
  listFindingSightings,
  setFindingStatus,
} from "../services/finding-service.js";

const listFindingsParams = z.object({
  claim_id: uuidSchema.optional(),
  tag: z.string().max(80).optional(),
  min_importance: z.coerce.number().int().min(1).max(10).optional(),
  order: z.enum(["recent", "importance"]).default("recent"),
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const statusBody = z.object({
  status: findingStatusEnum,
  note: z.string().max(2000).optional(),
});

// additionalProperties is load-bearing: fast-json-stringify serializes a
// bare `type: "object"` with no declared properties as `{}`.
const FINDING_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string", format: "uuid" },
    headline: { type: "string" },
    account: { type: "string" },
    claim_id: { type: "string", format: "uuid" },
    claim_text: { type: "string", nullable: true },
    importance: { type: "integer" },
    agent: { type: "string" },
    status: { type: "string" },
    sighting_count: { type: "integer" },
    stale: { type: "boolean" },
    first_noted_at: { type: "string", format: "date-time" },
    last_noted_at: { type: "string", format: "date-time" },
  },
} as const;

const ERROR_SCHEMA = {
  type: "object",
  properties: { error: { type: "string" }, code: { type: "string" } },
} as const;

export async function findingRoutes(app: FastifyInstance): Promise<void> {
  // GET /findings — public
  app.get<{ Querystring: Record<string, string> }>("/", {
    schema: {
      tags: ["findings"],
      summary: "Notable findings the administrators have recorded, newest first",
      querystring: {
        type: "object",
        properties: {
          // Ranges and formats are checked by the Zod parse in the handler
          // so a bad query gets the house INVALID_QUERY, not FST_ERR_VALIDATION.
          claim_id: { type: "string" },
          tag: { type: "string" },
          min_importance: { type: "integer" },
          order: { type: "string", enum: ["recent", "importance"], default: "recent" },
          since: { type: "string", format: "date-time" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
      },
      response: {
        200: {
          type: "object",
          properties: { findings: { type: "array", items: FINDING_SCHEMA } },
        },
        400: ERROR_SCHEMA,
      },
    },
    handler: async (request, reply) => {
      const parsed = listFindingsParams.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: parsed.error.errors.map((e) => e.message).join("; "),
          code: "INVALID_QUERY",
        });
      }
      const q = parsed.data;
      const rows = await listFindings({
        claimId: q.claim_id,
        tag: q.tag,
        minImportance: q.min_importance,
        order: q.order,
        since: q.since,
        limit: q.limit,
        offset: q.offset,
      });
      return { findings: rows.map(formatFinding) };
    },
  });

  // GET /findings/:id — public, with the sightings that joined it
  app.get<{ Params: { id: string } }>("/:id", {
    schema: {
      tags: ["findings"],
      summary: "One finding, with the later sightings that joined it",
      params: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      response: {
        200: {
          type: "object",
          properties: {
            finding: FINDING_SCHEMA,
            sightings: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
          },
        },
        404: ERROR_SCHEMA,
      },
    },
    handler: async (request, reply) => {
      const id = uuidSchema.safeParse(request.params.id);
      if (!id.success) {
        return reply.code(404).send({ error: "Finding not found", code: "NOT_FOUND" });
      }
      const finding = await getFindingById(id.data);
      if (!finding) {
        return reply.code(404).send({ error: "Finding not found", code: "NOT_FOUND" });
      }
      const sightings = await listFindingSightings(finding.id);
      return {
        finding: formatFinding(finding),
        sightings: sightings.map(formatFindingSighting),
      };
    },
  });

  // PATCH /findings/:id — service only: withdraw or restore
  app.patch<{ Params: { id: string }; Body: unknown }>("/:id", {
    preHandler: [app.authenticate, app.requireService],
    schema: {
      tags: ["findings"],
      summary: "Withdraw a finding from the page (or restore it), with a reason",
      params: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      body: {
        type: "object",
        properties: {
          status: { type: "string", enum: [...findingStatusEnum.options] },
          note: { type: "string" },
        },
        required: ["status"],
      },
      response: {
        200: {
          type: "object",
          properties: { finding: FINDING_SCHEMA },
        },
        400: ERROR_SCHEMA,
        403: ERROR_SCHEMA,
        404: ERROR_SCHEMA,
      },
    },
    handler: async (request, reply) => {
      const id = uuidSchema.safeParse(request.params.id);
      if (!id.success) {
        return reply.code(404).send({ error: "Finding not found", code: "NOT_FOUND" });
      }
      const body = statusBody.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: body.error.errors.map((e) => e.message).join("; "),
          code: "INVALID_BODY",
        });
      }
      const updated = await setFindingStatus(id.data, body.data.status, body.data.note ?? null);
      if (!updated) {
        return reply.code(404).send({ error: "Finding not found", code: "NOT_FOUND" });
      }
      return { finding: formatFinding(updated) };
    },
  });
}
