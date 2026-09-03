/**
 * Routes for the attempts surfaces (docs/mathematics.md §11.1). Registered
 * without a prefix because the paths span /claims, /attempts, and /admin.
 *
 *   GET  /claims/:id/attempts        — the attempt log: variant, cost,
 *     outcome, dates; the report and notebook once published.
 *   GET  /attempts/:id               — one attempt; `?include=transcript`
 *     adds the agent_runs/agent_steps transcript for service callers.
 *   POST /admin/attempts/:id/cancel  — service key: a running attempt
 *     becomes `cancelling`, which the solver polls each turn.
 *
 * Reads are public, like claim reads. Credentials are honoured when
 * presented so the transcript can be served to a service caller.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { isDirectService } from "../server/plugins/auth.js";
import { loadAttemptExtras } from "../services/attempt-extras.js";
import { cancelAttempt, getAttempt, getAttemptPublic } from "../services/attempt-service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function attemptsRoutes(app: FastifyInstance): Promise<void> {
  // Authenticate only when the caller presented credentials; anonymous
  // reads stay open.
  const optionalAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers["x-api-key"] || request.headers.authorization) {
      await app.authenticate(request, reply);
    }
  };

  app.get<{ Params: { id: string } }>("/claims/:id/attempts", {
    schema: {
      tags: ["attempts"],
      summary:
        "The platform's own solver attempts on a claim, newest first: variant, " +
        "cost, outcome, dates; the report and notebook once published",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
        required: ["id"],
      },
    },
    handler: async (request, reply) => {
      const attempts = await loadAttemptExtras(request.params.id);
      return reply.send({ claim_id: request.params.id, attempts });
    },
  });

  app.get<{ Params: { id: string }; Querystring: { include?: string } }>("/attempts/:id", {
    schema: {
      tags: ["attempts"],
      summary:
        "One solver attempt: the report and notebook once published; " +
        "?include=transcript adds the transcript for service callers",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
        required: ["id"],
      },
      querystring: {
        type: "object",
        properties: { include: { type: "string" } },
      },
    },
    preHandler: [optionalAuth],
    handler: async (request, reply) => {
      const wantsTranscript = (request.query.include ?? "")
        .split(",")
        .map((s) => s.trim())
        .includes("transcript");
      if (wantsTranscript && !isDirectService(request.auth)) {
        return reply.code(403).send({
          error: "The transcript is available to service callers only",
          code: "SERVICE_KEY_REQUIRED",
        });
      }
      const attempt = await getAttemptPublic(request.params.id, {
        includeTranscript: wantsTranscript,
      });
      if (!attempt) return reply.code(404).send({ error: "Attempt not found" });
      return reply.send(attempt);
    },
  });

  app.post<{ Params: { id: string } }>("/admin/attempts/:id/cancel", {
    schema: {
      tags: ["attempts"],
      summary:
        "Cancel a running solver attempt (service key): the attempt becomes " +
        "cancelling and stops at its next turn, keeping its notebook and transcript",
      params: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    preHandler: [app.authenticate, app.requireService],
    handler: async (request, reply) => {
      const id = request.params.id;
      if (!UUID_RE.test(id)) return reply.code(404).send({ error: "Attempt not found" });
      const cancelled = await cancelAttempt(id);
      if (cancelled) {
        return reply.send({ id: cancelled.id, status: cancelled.status });
      }
      const existing = await getAttempt(id);
      if (!existing) return reply.code(404).send({ error: "Attempt not found" });
      return reply.code(409).send({
        error: `Attempt is ${existing.status}; only a running attempt can be cancelled`,
        code: "ATTEMPT_NOT_RUNNING",
        id: existing.id,
        status: existing.status,
      });
    },
  });
}
