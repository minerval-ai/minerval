/**
 * /runs (#553): agent runs, read-only. A public run (one with no private
 * reasons, llm/run-visibility.ts) is served in full to anyone; any other run
 * answers with its id, agent and the reasons it is withheld. A direct service
 * caller reads a private run only by asking for it (include_private=true):
 * the web tier holds a service key and renders pages for everyone, so a
 * service key alone must not open private runs.
 *
 *   GET /runs/:run_id                 the run: agent, times, outcome, steps
 *     counted and recorded, cost, commit, its setup with part versions, and
 *     the seal on its log.
 *   GET /runs/:run_id/steps           its steps as one-line summaries, a page
 *     at a time (after = the last seq read), filterable by kind or tool.
 *   GET /runs/:run_id/steps/:seq      one step in full, with its hashes.
 *   GET /runs/:run_id/verify          whether the stored steps still chain
 *     to the run's seal (docs/run-log.md).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isDirectService, presentsCredentials } from "../server/plugins/auth.js";
import { optionalAuthHook } from "../server/optional-auth.js";
import {
  STEP_KINDS,
  getRunStep,
  getRunSummary,
  listRunSteps,
  verifyRunLog,
} from "../services/run-view-service.js";

const RUN_ID = { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } as const;

function notFound(reply: FastifyReply, request: FastifyRequest, what: string) {
  return reply.code(404).send({
    error: { code: "NOT_FOUND", message: `${what} not found`, request_id: request.id },
  });
}

export async function runRoutes(app: FastifyInstance): Promise<void> {
  const optionalAuth = optionalAuthHook(async (request: FastifyRequest, reply: FastifyReply) => {
    if (presentsCredentials(request)) await app.authenticate(request, reply);
  });
  const isService = (request: FastifyRequest) =>
    isDirectService(request.auth ?? null) &&
    (request.query as { include_private?: boolean }).include_private === true;
  const includePrivate = { include_private: { type: "boolean", default: false } } as const;

  app.get<{ Params: { run_id: string } }>("/:run_id", {
    schema: {
      tags: ["runs"],
      summary:
        "An agent run: its agent, times, outcome, cost, the commit it ran, and its setup " +
        "(constitution, role prompt, tools, model) by version. A run that read private " +
        "data answers public: false with the reasons. run_id is a run's id, or a research " +
        "run's (the research_run_id a request's work or a research report names), which " +
        "reads the Researcher's run",
      params: { type: "object", properties: { run_id: RUN_ID }, required: ["run_id"] },
      querystring: { type: "object", properties: { ...includePrivate } },
    },
    preHandler: [optionalAuth],
    handler: async (request, reply) => {
      const run = await getRunSummary(request.params.run_id, { isService: isService(request) });
      if (!run) return notFound(reply, request, "Run");
      return reply.send(run);
    },
  });

  app.get<{ Params: { run_id: string } }>("/:run_id/verify", {
    schema: {
      tags: ["runs"],
      summary:
        "Check a run's log against its seal: every step carries the hash of the one before " +
        "it, and a run that closed with every step written is sealed with the last hash. " +
        "Answers whether the stored steps still chain to that seal, and where they first " +
        "do not. get_run_step serves each step's content and hashes, so the check can be " +
        "repeated outside",
      params: { type: "object", properties: { run_id: RUN_ID }, required: ["run_id"] },
      querystring: { type: "object", properties: { ...includePrivate } },
    },
    preHandler: [optionalAuth],
    handler: async (request, reply) => {
      const check = await verifyRunLog(request.params.run_id, { isService: isService(request) });
      if (!check) return notFound(reply, request, "Run");
      return reply.send(check);
    },
  });

  app.get<{
    Params: { run_id: string };
    Querystring: { after?: number; limit?: number; kind?: string; tool?: string };
  }>("/:run_id/steps", {
    schema: {
      tags: ["runs"],
      summary:
        "A run's steps as one-line summaries (the setup, each model turn, each batch of " +
        "tool results), a page at a time; pass next_after as after for the next page",
      params: { type: "object", properties: { run_id: RUN_ID }, required: ["run_id"] },
      querystring: {
        type: "object",
        properties: {
          after: { type: "integer", minimum: -1 },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          kind: { type: "string", enum: [...STEP_KINDS] },
          tool: { type: "string", maxLength: 100 },
          ...includePrivate,
        },
      },
    },
    preHandler: [optionalAuth],
    handler: async (request, reply) => {
      const { after, limit, kind, tool } = request.query;
      const page = await listRunSteps(request.params.run_id, {
        after,
        limit,
        kind,
        tool,
        isService: isService(request),
      });
      if (!page) return notFound(reply, request, "Run");
      return reply.send(page);
    },
  });

  app.get<{ Params: { run_id: string; seq: number } }>("/:run_id/steps/:seq", {
    schema: {
      tags: ["runs"],
      summary: "One step of a run in full: the setup, a model turn, or a batch of tool results",
      params: {
        type: "object",
        properties: { run_id: RUN_ID, seq: { type: "integer", minimum: 0 } },
        required: ["run_id", "seq"],
      },
      querystring: { type: "object", properties: { ...includePrivate } },
    },
    preHandler: [optionalAuth],
    handler: async (request, reply) => {
      const step = await getRunStep(request.params.run_id, request.params.seq, {
        isService: isService(request),
      });
      if (!step) return notFound(reply, request, "Step");
      return reply.send(step);
    },
  });
}
