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
  formatReportSighting,
  getAgentReportById,
  listAgentReports,
  listReportSightings,
  triageAgentReport,
  TRIAGE_NOTE_MAX_LENGTH,
  REPORT_BODY_MAX_CHARS,
  REPORT_TITLE_MAX_CHARS,
  checkReportRateLimit,
  raiseIssue,
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
  triage_note: z
    .string()
    .max(
      TRIAGE_NOTE_MAX_LENGTH,
      `triage_note must be at most ${TRIAGE_NOTE_MAX_LENGTH} characters`
    )
    .optional(),
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
    github_issue_number: { type: "integer", nullable: true },
    github_issue_url: { type: "string", nullable: true },
    occurrence_count: { type: "integer" },
    first_seen_at: { type: "string", format: "date-time" },
    last_seen_at: { type: "string", format: "date-time" },
  },
} as const;

const SIGHTING_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string", format: "uuid" },
    kind: { type: "string" },
    body: { type: "string" },
    agent: { type: "string" },
    seen_at: { type: "string", format: "date-time" },
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
      summary: "Get one agent report, with its sightings and notes",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
      response: {
        200: {
          type: "object",
          properties: {
            report: REPORT_SCHEMA,
            sightings: { type: "array", items: SIGHTING_SCHEMA },
          },
        },
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
      const sightings = await listReportSightings(row.id);
      return reply.send({
        report: formatAgentReport(row),
        sightings: sightings.map(formatReportSighting),
      });
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

  // POST /reports: an account reports a problem with the graph's machinery
  // to the people who maintain it. The same report the raise_issue tool
  // files over MCP, for a caller that holds a key and speaks REST: a
  // deployment of Minerval sending on one of its own agents' reports
  // (docs/outward-acts.md) is one such caller, and gets nothing the others
  // do not.
  app.post<{ Body: Record<string, unknown> }>("/", {
    preHandler: [app.authenticate, app.requireUser],
    schema: {
      tags: ["reports"],
      summary: "Report a problem with this graph's tools or machinery to the people who maintain it",
      description:
        "For a failure of the machinery, a tool that is missing or misdescribed, or a concrete improvement: never a judgment about a claim, which is a " +
        "contribution. The report goes to the maintainers and affects no claim, contribution or review. It is attributed to your account and limited " +
        "to the same number an hour as raise_issue, because each one takes maintainer attention nothing prices. Cite ids and do not paste content. " +
        "With private: true the report is kept to the maintainers' own view and is not filed anywhere the public can read. A repeat of a report " +
        "already on record under the same title is counted on that report.",
      body: {
        type: "object",
        required: ["kind", "severity", "title"],
        properties: {
          kind: { type: "string", enum: [...reportKindEnum.options] },
          severity: { type: "string", enum: [...reportSeverityEnum.options] },
          title: { type: "string", minLength: 1, maxLength: REPORT_TITLE_MAX_CHARS },
          body: { type: "string", maxLength: REPORT_BODY_MAX_CHARS },
          surface: { type: "string", maxLength: 200 },
          context_refs: { type: "object", additionalProperties: true },
          private: { type: "boolean" },
        },
      },
    },
    handler: async (request, reply) => {
      const userId = request.auth!.userId!;
      const rate = checkReportRateLimit(userId);
      if (rate.limited) {
        return reply.code(429).send({ error: `Report rate limit (${rate.limitPerHour}/hour) exceeded; retry later`, code: "REPORT_RATE_LIMITED" });
      }
      const body = request.body as { kind: string; severity: string; title: string; body?: string; surface?: string; context_refs?: Record<string, unknown>; private?: boolean };
      const result = await raiseIssue({
        kind: body.kind,
        severity: body.severity,
        title: body.title,
        body: body.body ?? "",
        surface: body.surface ?? null,
        contextRefs: { ...(body.context_refs ?? {}), ...(body.private === true ? { private: true } : {}) },
        origin: "external",
        agent: "api",
        reporterContributorId: userId,
      });
      if (!result.reportId) {
        return reply.code(400).send({ error: result.problem ?? "The report could not be recorded; retry later", code: "REPORT_NOT_RECORDED" });
      }
      return reply.code(result.deduplicated ? 200 : 201).send({
        report: {
          id: result.reportId,
          status: result.existing?.status ?? "new",
          occurrence_count: result.occurrenceCount,
          deduplicated: result.deduplicated,
        },
      });
    },
  });

  // GET /reports/mine/:id: what the maintainers' record says of a report the account filed.
  app.get<{ Params: { id: string } }>("/mine/:id", {
    preHandler: [app.authenticate, app.requireUser],
    schema: {
      tags: ["reports"],
      summary: "Where a report your account filed stands: its status and the maintainers' note",
      description:
        "Status is new, triaged, duplicate, actioned (the gap is closed), wontfix or withdrawn. The note is the maintainers' reading of the report, " +
        "which is where a fix and the version it shipped in are said. Only the account that filed a report can read it here.",
      params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
    },
    handler: async (request, reply) => {
      const row = await getAgentReportById(request.params.id);
      if (!row || row.reporter_contributor_id !== request.auth!.userId) {
        return reply.code(404).send({ error: "No report with that id was filed by your account.", code: "NOT_FOUND" });
      }
      return reply.send({
        report: {
          id: row.id,
          status: row.status,
          maintainers_note: row.triage_note,
          issue_url: row.github_issue_url ?? null,
          occurrence_count: Number(row.occurrence_count),
          first_seen_at: row.first_seen_at,
          last_seen_at: row.last_seen_at,
        },
      });
    },
  });
}
