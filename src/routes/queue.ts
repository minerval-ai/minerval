/**
 * Operational depth/health of the steward lane. The allocation engine's
 * public face lives on the mandate pages now (GET /mandates/:id/allocation
 * — the EV/EC computation belongs to the mandates), so this endpoint keeps
 * only what operators watch: queue depth by state and the open action
 * ledger by kind, so a silent pile-up (#97) stays observable.
 */
import type { FastifyInstance } from "fastify";
import { rawQuery } from "../db/client.js";
import { stewardQueueHealth } from "../workers/steward-pipeline.js";

export async function queueRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", {
    schema: {
      tags: ["queue"],
      summary:
        "Steward lane depth by state and open actions by kind (ops health; " +
        "the allocation views live on GET /mandates/:id/allocation)",
    },
    handler: async (_request, reply) => {
      const [health, actions] = await Promise.all([
        stewardQueueHealth(),
        rawQuery<{ kind: string; status: string; n: number }>(
          `SELECT kind, status, COUNT(*)::int AS n
             FROM actions
            WHERE status IN ('open', 'running')
            GROUP BY kind, status`
        ),
      ]);
      const ledger: Record<string, { open: number; running: number }> = {};
      for (const row of actions) {
        const entry = (ledger[row.kind] ??= { open: 0, running: 0 });
        if (row.status === "open") entry.open = row.n;
        if (row.status === "running") entry.running = row.n;
      }
      return reply.send({ depth: health, actions: ledger });
    },
  });
}
