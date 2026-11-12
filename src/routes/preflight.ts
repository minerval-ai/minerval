/**
 * GET /setup/preflight: whether this deployment is ready to run
 * (src/preflight.ts; docs/deployment.md, "Preflight").
 *
 * Every other /setup route is public. This one is the operator's: its
 * answer says which keys are missing, where the agents' reports are filed
 * and how far the database is behind, which nobody outside can learn from
 * the deployment today, and a list of bare passes and fails would say most
 * of that too. So it requires the operator key (requireOperator,
 * docs/accounts.md), the credential of whoever runs the deployment, which
 * the guard takes on its own: a deployment being installed has no accounts
 * and no API keys yet. With no MINERVAL_OPERATOR_KEY set the route is
 * closed, and `npm run preflight` on the machine gives the same answer.
 *
 * Each call runs the checks afresh, the run log's test included.
 */
import type { FastifyInstance } from "fastify";
import { PREFLIGHT_CHECKS, runPreflight } from "../preflight.js";

export async function preflightRoutes(app: FastifyInstance): Promise<void> {
  app.get("/preflight", {
    preHandler: [app.requireOperator],
    schema: {
      tags: ["setup"],
      summary:
        "Whether this deployment is ready to run: each check with pass, fail or not " +
        "applicable and a sentence saying why, and whether agent work may start. " +
        "Requires the operator key",
      response: {
        200: {
          type: "object",
          properties: {
            // Whether a label other than `public` is defined; null when the
            // labels could not be read.
            holds_private_material: { type: "boolean", nullable: true },
            // No check failed.
            ready: { type: "boolean" },
            // "refused" when a blocking check failed.
            agent_work: { type: "string", enum: ["allowed", "refused"] },
            checks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", enum: PREFLIGHT_CHECKS.map((c) => c.name) },
                  status: { type: "string", enum: ["pass", "fail", "not_applicable"] },
                  // Whether a fail here stops agent work on this deployment.
                  blocking: { type: "boolean" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    handler: async (_request, reply) => reply.send(await runPreflight()),
  });
}
