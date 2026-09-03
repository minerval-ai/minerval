/**
 * Agent reports (#366): the read and triage surface for what the agents
 * have raised about the system. Service-scoped only — this is an operator
 * view, not a public one: reports quote whatever the agent was working on,
 * and triage is a maintainer's call.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  reportKindEnum,
  reportOriginEnum,
  reportSeverityEnum,
  reportStatusEnum,
  uuidSchema,
} from "../schemas/common.js";
import {
  formatAgentReport,
  getAgentReportById,
  listAgentReports,
  triageAgentReport,
} from "../services/report-service.js";

const listReportsParams = z.object({
  status: reportStatusEnum.optional(),
  kind: reportKindEnum.optional(),
  severity: reportSeverityEnum.optional(),
  origin: reportOriginEnum.optional(),
  agent: z.string().max(64).optional(),
  surface: z.string().max(200).optional(),
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const triageReportBody = z.object({
  status: reportStatusEnum,
  triage_note: z.string().max(2000).optional(),
  duplicate_of_id: uuidSchema.optional(),
});

// additionalProperties is load-bearing: fast-json-stringify serializes a
// bare `type: "object"` with no declared properties as `{}`.
const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string", format: "uuid" },
    kind: { type: "string" },
    severity: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    surface: { type: "string", nullable: true },
    origin: { type: "string" },
    agent: { type: "string" },
    status: { type: "string" },
    occurrence_count: { type: "integer" },
    first_seen_at: { type: "string", format: "date-time" },
    last_seen_at: { type: "string", format: "date-time" },
  },
} as const;

const ERROR_SCHEMA = {
  type: "object",
  properties: { error: { type: "string" }, code: { type: "string" } },
} as const;

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  // GET /reports
  app.get<{ Querystring: Record<string, string> }>("/", {
    preHandler: [app.authenticate, app.requireService],
    schema: {
      tags: ["reports"],
      summary: "List the issues agents have raised about the system",
      querystring: {
        type: "object",
        properties: {
          status: { type: "string" },
          kind: { type: "string" },
          severity: { type: "string" },
          origin: { type: "string" },
          agent: { type: "string" },
          surface: { type: "string" },
          since: { type: "string", format: "date-time" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            reports: { type: "array", items: REPORT_SCHEMA },
          },
        },
        400: ERROR_SCHEMA,
        403: ERROR_SCHEMA,
      },
    },
    handler: async (request, reply) => {
      const parsed = listReportsParams.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: parsed.error.issues.map((i) => i.message).join("; "),
          code: "INVALID_QUERY",
        });
      }
      const rows = await listAgentReports(parsed.data);
      return reply.send({ reports: rows.map(formatAgentReport) });
    },
  });

  // GET /reports/:id
  app.get<{ Params: { id: string } }>("/:id", {
    preHandler: [app.authenticate, app.requireService],
    schema: {
      tags: ["reports"],
      summary: "Get one agent report",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
      response: {
        200: { type: "object", properties: { report: REPORT_SCHEMA } },
        403: ERROR_SCHEMA,
        404: ERROR_SCHEMA,
      },
    },
    handler: async (request, reply) => {
      const row = await getAgentReportById(request.params.id);
      if (!row) {
        return reply
          .code(404)
          .send({ error: "Report not found", code: "NOT_FOUND" });
      }
      return reply.send({ report: formatAgentReport(row) });
    },
  });

  // PATCH /reports/:id — triage
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/:id",
    {
      preHandler: [app.authenticate, app.requireService],
      schema: {
        tags: ["reports"],
        summary: "Set a report's triage status",
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string" },
            triage_note: { type: "string" },
            duplicate_of_id: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: { type: "object", properties: { report: REPORT_SCHEMA } },
          400: ERROR_SCHEMA,
          403: ERROR_SCHEMA,
          404: ERROR_SCHEMA,
        },
      },
      handler: async (request, reply) => {
        const parsed = triageReportBody.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: parsed.error.issues.map((i) => i.message).join("; "),
            code: "INVALID_BODY",
          });
        }
        const auth = request.auth;
        const triagedBy = `service:${auth?.apiKeyId ?? auth?.method ?? "unknown"}`;
        let row;
        try {
          row = await triageAgentReport(request.params.id, {
            status: parsed.data.status,
            triageNote: parsed.data.triage_note ?? null,
            duplicateOfId: parsed.data.duplicate_of_id ?? null,
            triagedBy,
          });
        } catch (err) {
          return reply.code(400).send({
            error: err instanceof Error ? err.message : String(err),
            code: "INVALID_TRIAGE",
          });
        }
        if (!row) {
          return reply
            .code(404)
            .send({ error: "Report not found", code: "NOT_FOUND" });
        }
        return reply.send({ report: formatAgentReport(row) });
      },
    }
  );
}
