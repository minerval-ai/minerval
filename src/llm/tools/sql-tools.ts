/**
 * query_sql: read-only SQL over the graph's public data (services/
 * sql-service.ts). One description per audience, each fixed, so the cached
 * prefix of every run that carries it is shared.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { SqlRefusal, runReadOnlyQuery, SQL_VIEWS } from "../../services/sql-service.js";

type Tool = Anthropic.Tool;

export const QUERY_SQL = "query_sql";

function description(audience: "agent" | "caller"): string {
  return (
    "Run one read-only SQL query (PostgreSQL 16) against views of the graph's " +
    "public data: the same data the site and API serve, in tables you can join. " +
    "The views and their columns are in the sql skill; read it before your first " +
    `query. Views: ${SQL_VIEWS.join(", ")}. One SELECT (WITH is fine). Results ` +
    "come back as columns and rows, at most 500 rows, and a query runs for at most " +
    `${audience === "agent" ? 20 : 5} seconds. Before it runs, the planner estimates its cost, and a ` +
    "query estimated above the limit is refused with the estimate: filter on " +
    "indexed columns, join on ids, and aggregate in the query rather than fetching " +
    "rows to count. To search by meaning, use search_claims and filter its ids here. " +
    (audience === "agent"
      ? "Free."
      : "Each account has a daily allowance of database time, larger once it has " +
        "bought owls; past it, a query costs owls per second of database time, and " +
        "the result says what it cost. You read a replica, current to within seconds.")
  );
}

export const SQL_TOOL_DESCRIPTION_CALLER = description("caller");

export function getSqlToolDefinition(): Tool {
  return {
    name: QUERY_SQL,
    description: description("agent"),
    input_schema: {
      type: "object" as const,
      properties: {
        sql: { type: "string", description: "One SELECT statement. Put values in params and refer to them as $1, $2, and so on." },
        params: { type: "array", items: {}, description: "Values for $1, $2, … in order." },
        max_rows: { type: "number", description: "At most 500; 100 by default." },
      },
      required: ["sql"],
    },
  };
}

export async function executeSqlTool(name: string, input: Record<string, unknown>): Promise<string | null> {
  if (name !== QUERY_SQL) return null;
  try {
    const result = await runReadOnlyQuery(String(input.sql ?? ""), Array.isArray(input.params) ? input.params : [], {
      audience: "agent",
      maxRows: input.max_rows != null ? Number(input.max_rows) : undefined,
    });
    return JSON.stringify({ success: true, ...result });
  } catch (err) {
    if (err instanceof SqlRefusal) return JSON.stringify({ success: false, code: err.code, message: err.message });
    throw err;
  }
}
