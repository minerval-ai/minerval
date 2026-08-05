/**
 * Budget-job routes — funded open-ended work (deep decomposition today).
 *
 *   GET  /budget-jobs        — the acting user's jobs.
 *   GET  /budget-jobs/:id    — one job with live spend + checkpoint (the
 *     job page polls this: budget, spent, progress, pause state).
 *   POST /budget-jobs/:id/topup  — escrow more owls; a paused job resumes.
 *   POST /budget-jobs/:id/cancel — stop and refund the unspent budget.
 *
 * Job CREATION is claim-scoped: POST /claims/:claim_id/decompose (claims.ts)
 * — funding is the explicit act of committing owls, so the escrow happens at
 * creation, not lazily.
 */
import type { FastifyInstance } from "fastify";
import {
  listBudgetJobs,
  getBudgetJob,
  topUpBudgetJob,
  cancelBudgetJob,
  serializeBudgetJob,
} from "../services/budget-job-service.js";
import { microUsdToOwls } from "../services/owl.js";

export async function budgetJobRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", {
    schema: {
      tags: ["budget-jobs"],
      summary: "List the authenticated user's budget jobs",
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const jobs = await listBudgetJobs(request.auth!.userId!);
      return reply.send({
        jobs: await Promise.all(jobs.map(serializeBudgetJob)),
      });
    },
  });

  app.get<{ Params: { id: string } }>("/:id", {
    schema: {
      tags: ["budget-jobs"],
      summary: "Get one budget job with live spend and progress",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const job = await getBudgetJob(request.params.id);
      if (!job || job.userId !== request.auth!.userId!) {
        return reply
          .code(404)
          .send({ error: "Job not found", code: "NOT_FOUND" });
      }
      return reply.send({ job: await serializeBudgetJob(job) });
    },
  });

  app.post<{ Params: { id: string }; Body: { owls: number } }>("/:id/topup", {
    schema: {
      tags: ["budget-jobs"],
      summary: "Add owls to a job's budget (a paused job resumes)",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
      body: {
        type: "object",
        required: ["owls"],
        properties: { owls: { type: "number", exclusiveMinimum: 0 } },
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const result = await topUpBudgetJob({
        jobId: request.params.id,
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
      return reply.send({ job: await serializeBudgetJob(result.job) });
    },
  });

  app.post<{ Params: { id: string } }>("/:id/cancel", {
    schema: {
      tags: ["budget-jobs"],
      summary: "Cancel a job and refund its unspent budget",
      params: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const result = await cancelBudgetJob({
        jobId: request.params.id,
        userId: request.auth!.userId!,
      });
      if (!result.ok) {
        return reply
          .code(result.code === "NOT_FOUND" ? 404 : 409)
          .send({ error: result.message, code: result.code });
      }
      return reply.send({
        cancelled: true,
        refunded_owls: microUsdToOwls(result.refundedMicroUsd),
      });
    },
  });
}
