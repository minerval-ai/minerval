import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { loadConfig } from "../../config.js";
import { LlmBudgetExceededError } from "../../llm/errors.js";
import { refusalForCaller } from "../../db/clearance.js";
import { PublicGraphNodeError, mirroredRefusalForPerson } from "../../services/mirrored-node-service.js";

export async function registerErrorHandler(
  app: FastifyInstance
): Promise<void> {
  const config = loadConfig();

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const requestId = request.id;

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Validation error",
          details: error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
          request_id: requestId,
        },
      });
    }

    if (error instanceof LlmBudgetExceededError) {
      app.log.warn({ err: error, requestId }, "LLM budget exceeded");
      return reply.code(503).send({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "LLM processing temporarily unavailable due to usage limits",
          request_id: requestId,
        },
      });
    }

    // A write the database refused because of labels (db/clearance.ts): the
    // request asked for something its clearance does not allow, or that
    // collides with a row at another label. That is an answer, with its
    // reason, and not a fault of the server. It cannot happen where
    // `public` is the only label.
    // What the public graph holds is not changed here, and work at its own
    // label on one of its nodes is not done here
    // (services/mirrored-node-service.ts). Both are answers with a reason.
    // Neither can happen on a deployment that does not mirror.
    if (error instanceof PublicGraphNodeError) {
      app.log.warn({ err: error, requestId }, "Refused: the public graph's node");
      return reply.code(409).send({
        error: { code: error.code, message: error.message, request_id: requestId },
      });
    }
    const mirrored = mirroredRefusalForPerson(error);
    if (mirrored) {
      app.log.warn({ err: error, requestId }, "Refused: a mirrored row");
      return reply.code(409).send({
        error: { code: "PUBLIC_GRAPH_ROW", message: mirrored, request_id: requestId },
      });
    }

    const refusal = refusalForCaller(error);
    if (refusal) {
      app.log.warn({ err: error, requestId }, "Refused by label");
      return reply.code(409).send({
        error: { code: "REFUSED_BY_LABEL", message: refusal, request_id: requestId },
      });
    }

    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      app.log.error({ err: error, requestId }, "Internal server error");
      return reply.code(statusCode).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error",
          request_id: requestId,
        },
      });
    }

    const code = statusCode === 404 ? "NOT_FOUND" : "REQUEST_ERROR";
    app.log.warn({ err: error, requestId }, error.message);

    return reply.code(statusCode).send({
      error: {
        code,
        message: error.message,
        ...(config.env !== "production" && error.stack
          ? { stack: error.stack }
          : {}),
        request_id: requestId,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: `Route ${request.method} ${request.url} not found`,
        request_id: request.id,
      },
    });
  });
}
