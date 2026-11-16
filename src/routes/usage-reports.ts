/**
 * Usage reports (docs/usage-report.md; services/usage-report-service.ts).
 *
 * The receiving side, mounted on every deployment and of use on the public
 * graph:
 *
 *   POST /usage-reports: a private deployment's report of the owls its
 *     runs spent in one closed UTC day, sent under the organization's
 *     account and recorded against it. Nothing is billed from it yet.
 *
 * The sending side, mounted only in a members-only deployment
 * (server/app.ts):
 *
 *   GET  /usage-reports/outgoing: whether this deployment reports, what a
 *     report says and never says, and every report exactly as it is sent.
 *     Administrators.
 *   POST /usage-reports/outgoing/send: prepare the reports for the days
 *     that have closed and send what has not been sent, now instead of at
 *     the worker's next pass. Administrators, from a signed-in session.
 */
import type { FastifyInstance } from "fastify";
import { requirePermission } from "../server/require-permission.js";
import {
  USAGE_REPORT_FORMAT,
  USAGE_REPORT_KIND,
  outgoingUsageReports,
  prepareUsageReports,
  receiveUsageReport,
  sendUsageReports,
  usageReporting,
} from "../services/usage-report-service.js";

export async function usageReportReceivingRoutes(app: FastifyInstance): Promise<void> {
  app.post("/usage-reports", {
    schema: {
      tags: ["usage"],
      summary:
        "Record a private deployment's usage report against the account that sends it",
      description:
        "Sent by a private deployment's own worker, once for each UTC day that has ended: the " +
        "owls its agents' runs spent that day, as one total. The body is the report and " +
        "nothing else. The same report sent again changes nothing; a different report for a " +
        "day and revision already recorded is refused, and a correction is sent as the next " +
        "revision. Recording a report charges nothing.",
      body: {
        type: "object",
        required: ["format", "kind", "deployment", "period", "revision", "owls_spent"],
        additionalProperties: true,
        properties: {
          format: { type: "integer", enum: [USAGE_REPORT_FORMAT] },
          kind: { type: "string", enum: [USAGE_REPORT_KIND] },
          deployment: { type: "string", format: "uuid" },
          period: { type: "string", description: "The UTC day the report is of, YYYY-MM-DD" },
          revision: { type: "integer", minimum: 0 },
          owls_spent: {
            type: "string",
            description: 'The day\'s total in owls, with six decimal places, for example "12.500000"',
          },
        },
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const result = await receiveUsageReport(request.auth!.userId!, request.body);
      if (!result.ok) {
        return reply
          .code(result.code === "REPORT_DIFFERS" ? 409 : 400)
          .send({ error: result.message, code: result.code });
      }
      return reply.code(result.recorded ? 201 : 200).send({
        recorded: result.recorded,
        period: result.period,
        revision: result.revision,
        body_hash: result.body_hash,
        received_at: result.received_at,
        // The price per owl is not decided, so a report is recorded and nothing more.
        charged: false,
      });
    },
  });
}

export async function usageReportSendingRoutes(app: FastifyInstance): Promise<void> {
  const administrator = [app.authenticate, app.requireUser, requirePermission("administer")];
  const administratorSession = [
    app.authenticate,
    app.requireSession,
    app.requireUser,
    requirePermission("administer"),
  ];

  app.get<{ Querystring: { limit?: number } }>("/usage-reports/outgoing", {
    schema: {
      tags: ["usage"],
      summary:
        "What this deployment reports to the public graph of its own owl spend: the setting in force, what a report says and never says, and every report exactly as it is sent (administrators)",
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 2000, description: "Reports to return, newest day first (default 400)" },
        },
      },
    },
    preHandler: administrator,
    handler: async (request, reply) => reply.send(await outgoingUsageReports(request.query.limit ?? 400)),
  });

  app.post<{ Body: { recount_from?: string } | undefined }>("/usage-reports/outgoing/send", {
    schema: {
      tags: ["usage"],
      summary:
        "Prepare the usage reports for the days that have ended and send what has not been sent (administrators, from a signed-in session)",
      description:
        "The worker does this on its own schedule; this does it now. recount_from asks for " +
        "every day from that one on to be counted again, and a day whose count has changed " +
        "gets a correction as a new report. On the flat price nothing is prepared or sent.",
      body: {
        type: "object",
        properties: {
          recount_from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "A UTC day, YYYY-MM-DD" },
        },
      },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      if (!usageReporting()) {
        return reply.send({ prepared: 0, sent: 0, stopped: null, ...(await outgoingUsageReports()) });
      }
      const prepared = await prepareUsageReports(new Date(), { recountFrom: request.body?.recount_from });
      const outcome = await sendUsageReports();
      return reply.send({
        prepared: prepared.length,
        sent: outcome.sent,
        stopped: outcome.stopped,
        ...(await outgoingUsageReports()),
      });
    },
  });
}
