/**
 * POST /sql — read-only SQL over the graph's public data, for callers
 * (services/sql-service.ts). Served to MCP as `query_sql` from this route.
 *
 * Authenticated only: every caller is an account, so the one-query-at-a-time
 * rule and the daily allowance attach to someone. Past the allowance a query
 * is priced by its database time, debited from the caller's owls.
 */
import type { FastifyInstance } from "fastify";
import { SqlRefusal, runCallerQuery } from "../services/sql-service.js";
import { chargeOwls, getOwlBalanceMicroUsd } from "../services/owl-ledger-service.js";
import { microUsdToOwls } from "../services/owl.js";
import { SQL_TOOL_DESCRIPTION_CALLER } from "../llm/tools/sql-tools.js";

const STATUS: Record<SqlRefusal["code"], number> = {
  NOT_CONFIGURED: 503,
  NOT_A_QUERY: 400,
  NOT_ALLOWED: 400,
  TOO_EXPENSIVE: 400,
  TIMED_OUT: 400,
  SQL_ERROR: 400,
  BUSY: 429,
  ONE_AT_A_TIME: 429,
  ALLOWANCE: 402,
};

export async function sqlRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", {
    preHandler: [app.authenticate],
    schema: {
      tags: ["sql"],
      summary: SQL_TOOL_DESCRIPTION_CALLER,
      body: {
        type: "object",
        required: ["sql"],
        properties: {
          sql: { type: "string", minLength: 1, maxLength: 20_000, description: "One SELECT statement. Put values in params and refer to them as $1, $2, and so on." },
          params: { type: "array", maxItems: 50, description: "Values for $1, $2, … in order." },
          max_rows: { type: "integer", minimum: 1, maximum: 500, description: "At most 500; 100 by default." },
        },
      },
    },
    handler: async (request, reply) => {
      const auth = request.auth!;
      const body = request.body as { sql: string; params?: unknown[]; max_rows?: number };
      const accountKey = auth.userId ? `user:${auth.userId}` : auth.apiKeyId ? `key:${auth.apiKeyId}` : `service`;
      const balanceMicro = auth.userId ? await getOwlBalanceMicroUsd(auth.userId) : 0;
      // An account that has bought owls gets the larger allowance.
      const paid = balanceMicro > 0;
      try {
        const result = await runCallerQuery({
          accountKey,
          userId: auth.userId,
          paid,
          sql: body.sql,
          params: body.params ?? [],
          maxRows: body.max_rows,
          balanceOwls: microUsdToOwls(balanceMicro),
          charge: auth.userId
            ? async (owls) => (await chargeOwls({ userId: auth.userId!, priceOwls: owls, op: "sql_query" })).charged
            : undefined,
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof SqlRefusal) {
          if (err.retryAfterSeconds) reply.header("retry-after", String(err.retryAfterSeconds));
          return reply.code(STATUS[err.code]).send({ error: { code: err.code, message: err.message, request_id: request.id } });
        }
        throw err;
      }
    },
  });
}
