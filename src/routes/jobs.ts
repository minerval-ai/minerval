import type { FastifyInstance } from "fastify";
import { getJobById } from "../services/job-service.js";

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  // GET /jobs/:job_id
  app.get<{ Params: { job_id: string } }>(
    "/:job_id",
    {
      schema: {
        tags: ["jobs"],
        summary: "Get job status",
        params: {
          type: "object",
          properties: {
            job_id: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              type: { type: "string" },
              status: { type: "string", enum: ["pending", "processing", "complete", "failed"] },
              // Same fast-json-stringify trap: a property-less object schema
              // serializes to {}, so a completed job's result vanished.
              result: { type: "object", nullable: true, additionalProperties: true },
              error: { type: "string", nullable: true },
            },
          },
        },
      },
      handler: async (request, reply) => {
        const { job_id } = request.params;
        const job = await getJobById(job_id);

        if (!job) {
          return reply.code(404).send({
            error: {
              code: "NOT_FOUND",
              message: "Job not found",
              request_id: request.id,
            },
          });
        }

        return reply.send({
          id: job.id,
          type: job.type,
          status: job.status,
          result: job.result,
          error: job.error,
        });
      },
    }
  );
}
