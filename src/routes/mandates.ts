/**
 * Public mandate routes — grants as public things.
 *
 *   GET  /mandates                — discovery: live mandates, platform-run
 *     first, then largest budgets.
 *   GET  /mandates/:id            — the public dashboard payload; its
 *     sections scale with the mandate's action mix (ingestion pipelines
 *     included). A signed-in manager also receives the conversation id for
 *     talking to the Grantmaker.
 *   POST /mandates/:id/contribute — put your owls behind someone's mandate.
 *
 * Reads are public like claim reads: no credentials required. When
 * credentials ARE presented (the web BFF acting for a session), they are
 * honoured so the payload can include manager-only fields.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  listPublicMandates,
  getPublicMandate,
  contributeToMandate,
} from "../services/mandate-service.js";

export async function mandateRoutes(app: FastifyInstance): Promise<void> {
  // Authenticate only when the caller presented credentials; anonymous
  // reads stay open (mandates are public).
  const optionalAuth = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    if (request.headers["x-api-key"] || request.headers.authorization) {
      await app.authenticate(request, reply);
    }
  };

  app.get<{ Querystring: { limit?: number } }>("/", {
    schema: {
      tags: ["mandates"],
      summary:
        "Public mandates open to contribution: platform-run first, then " +
        "largest budgets",
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
      },
    },
    handler: async (request, reply) => {
      const mandates = await listPublicMandates(request.query.limit ?? 50);
      return reply.send({ mandates });
    },
  });

  app.get<{ Params: { id: string } }>("/:id", {
    schema: {
      tags: ["mandates"],
      summary:
        "One mandate's public dashboard: budget, spend, contributors, plan " +
        "progress, funded assessments, and (when it ingests) the pipeline",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
    },
    preHandler: [optionalAuth],
    handler: async (request, reply) => {
      const mandate = await getPublicMandate(
        request.params.id,
        request.auth?.userId ?? null
      );
      if (!mandate) {
        return reply
          .code(404)
          .send({ error: "Mandate not found", code: "NOT_FOUND" });
      }
      return reply.send({ mandate });
    },
  });

  app.post<{ Params: { id: string }; Body: { owls: number } }>(
    "/:id/contribute",
    {
      schema: {
        tags: ["mandates"],
        summary:
          "Contribute owls to a public mandate (escrowed; unspent budget " +
          "refunds contributors pro rata)",
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["owls"],
          properties: {
            owls: { type: "number", exclusiveMinimum: 0, maximum: 10000 },
          },
        },
      },
      preHandler: [app.authenticate, app.requireUser],
      handler: async (request, reply) => {
        const result = await contributeToMandate({
          grantId: request.params.id,
          userId: request.auth!.userId!,
          owls: request.body.owls,
        });
        if (!result.ok) {
          const status =
            result.code === "NOT_FOUND"
              ? 404
              : result.code === "INSUFFICIENT_OWLS"
                ? 402
                : 409;
          return reply
            .code(status)
            .send({ error: result.message, code: result.code });
        }
        return reply.send({ mandate: result.mandate });
      },
    }
  );
}
