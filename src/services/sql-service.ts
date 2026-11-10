/**
 * Read-only SQL over the graph's public data, for the graph's own agents
 * (query_sql) and for outside callers (MCP and POST /sql).
 *
 * Layers, each enough on its own against a different failure:
 *
 *  1. The query is parsed with Postgres's own parser (libpg-query) and must
 *     be one SELECT over the public_read views and its own CTEs, calling only
 *     allowlisted functions. That refuses writes, SET, SELECT INTO, row
 *     locks, and every function that could reach outside a read: advisory
 *     locks (the money paths depend on them), pg_sleep, set_config, file and
 *     large-object functions. A parser allowlist is used because revoking
 *     system functions from one role needs superuser rights a managed
 *     database does not grant.
 *  2. It runs on a separate login role (SQL_AGENT_DATABASE_URL for agents,
 *     SQL_CALLER_DATABASE_URL for callers) that can read the views and
 *     nothing else, never the app's role switched with SET ROLE (RESET ROLE
 *     would undo it). Callers' role points at a read replica, so the worst a
 *     flood can do is slow callers' SQL; the graph's writes, its money and
 *     its agents don't share it.
 *  3. Inside BEGIN READ ONLY … ROLLBACK, with statement and lock timeouts
 *     set locally, wrapped as SELECT * FROM (…) q LIMIT n, on a connection
 *     opened for this query and closed after it, so nothing a query sets
 *     outlives it.
 *  4. The planner's estimate is checked first: a query estimated above the
 *     limit is refused before it runs, with the estimate.
 *  5. Callers: one query at a time per account and a daily allowance of
 *     database time, both held in the database so they hold across API
 *     tasks; past the allowance, a query is priced in owls by the second.
 *     The login roles' CONNECTION LIMITs cap how many run at once; a full
 *     pool answers at once rather than queueing. Identical queries within 30
 *     seconds are served from cache.
 */
import pg from "pg";
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";

/** The views callers and agents may read (migration 0091). */
export const SQL_VIEWS = [
  "nodes",
  "assessments",
  "edges",
  "arguments",
  "tags",
  "sources",
  "instances",
  "ledger",
  "commissions",
  "messages",
  "mandates",
  "mandate_decisions",
  "plan_items",
  "petitions",
  "contributions",
  "requests",
  "changes",
] as const;

/**
 * The functions a query may call: aggregates, arithmetic, text, dates,
 * arrays and JSON reads. Anything else (advisory locks, sleeps, settings,
 * files, sequences, dblink) is refused by name before the query runs.
 */
export const SQL_ALLOWED_FUNCTIONS = new Set([
  // aggregates
  "count", "sum", "avg", "min", "max", "bool_and", "bool_or", "every", "array_agg", "string_agg",
  "jsonb_agg", "json_agg", "jsonb_object_agg", "percentile_cont", "percentile_disc", "mode",
  "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop", "var_samp", "corr", "covar_pop",
  "regr_slope", "regr_intercept",
  // window
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead",
  "first_value", "last_value", "nth_value",
  // conditionals and math
  "coalesce", "nullif", "greatest", "least", "abs", "round", "trunc", "ceil", "ceiling", "floor",
  "sqrt", "power", "exp", "ln", "log", "log10", "mod", "sign", "width_bucket", "div",
  // text
  "lower", "upper", "length", "char_length", "substring", "substr", "left", "right", "trim",
  "btrim", "ltrim", "rtrim", "position", "strpos", "replace", "concat", "concat_ws", "split_part",
  "starts_with", "initcap", "regexp_replace", "regexp_match", "regexp_matches", "to_char",
  "format", "md5",
  // dates and times
  "now", "current_date", "current_timestamp", "date_trunc", "date_part", "extract", "age",
  "make_interval", "to_timestamp", "to_date", "justify_interval",
  // arrays
  "array_length", "cardinality", "unnest", "array_position", "array_to_string", "array_remove",
  "array_append", "array_cat",
  // json
  "jsonb_array_length", "jsonb_extract_path", "jsonb_extract_path_text", "jsonb_typeof",
  "jsonb_array_elements", "jsonb_array_elements_text", "jsonb_each", "jsonb_each_text",
  "jsonb_object_keys", "jsonb_build_object", "jsonb_build_array", "to_jsonb",
]);

export type SqlAudience = "agent" | "caller";

export class SqlRefusal extends Error {
  constructor(
    public readonly code:
      | "NOT_CONFIGURED"
      | "NOT_A_QUERY"
      | "NOT_ALLOWED"
      | "TOO_EXPENSIVE"
      | "TIMED_OUT"
      | "SQL_ERROR"
      | "BUSY"
      | "ONE_AT_A_TIME"
      | "ALLOWANCE",
    message: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
  }
}

let parserReady: Promise<(sql: string) => unknown> | null = null;

async function parser(): Promise<(sql: string) => unknown> {
  parserReady ??= (async () => {
    const mod = (await import("libpg-query")) as unknown as {
      loadModule?: () => Promise<void>;
      parseSync: (sql: string) => unknown;
    };
    if (mod.loadModule) await mod.loadModule();
    return mod.parseSync;
  })();
  return parserReady;
}

/** Walk a parse tree, calling `visit` on every node object. */
function walk(node: unknown, visit: (key: string, value: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (value && typeof value === "object" && !Array.isArray(value)) visit(key, value as Record<string, unknown>);
    walk(value, visit);
  }
}

function names(list: unknown): string[] {
  return Array.isArray(list)
    ? list.map((n) => ((n as { String?: { sval?: string } }).String?.sval ?? "").toLowerCase())
    : [];
}

/**
 * Check a query against the allowlists. Throws SqlRefusal; returns nothing
 * when the query may run.
 */
export async function checkQuery(sql: string): Promise<void> {
  const parse = await parser();
  let tree: { stmts?: Array<{ stmt: Record<string, unknown> }> };
  try {
    tree = parse(sql) as typeof tree;
  } catch (err) {
    throw new SqlRefusal("SQL_ERROR", `The query doesn't parse: ${err instanceof Error ? err.message : String(err)}`);
  }
  const stmts = tree.stmts ?? [];
  if (stmts.length !== 1 || !stmts[0]!.stmt.SelectStmt) {
    throw new SqlRefusal("NOT_A_QUERY", "Only a single SELECT (or WITH … SELECT) runs here. Nothing was run.");
  }
  const ctes = new Set<string>();
  walk(stmts[0]!.stmt, (key, value) => {
    if (key === "CommonTableExpr" && typeof value.ctename === "string") ctes.add(value.ctename.toLowerCase());
  });
  const problems: string[] = [];
  walk(stmts[0]!.stmt, (key, value) => {
    if (key === "InsertStmt" || key === "UpdateStmt" || key === "DeleteStmt" || key === "MergeStmt") {
      problems.push("statements that write (even inside WITH) aren't allowed");
    }
    if (key === "SelectStmt") {
      if (value.intoClause) problems.push("SELECT INTO creates a table; only reads run here");
      if (value.lockingClause) problems.push("row locks (FOR UPDATE and the like) aren't allowed");
    }
    if (key === "FuncCall") {
      const fn = names(value.funcname);
      const name = fn.at(-1) ?? "";
      const schema = fn.length > 1 ? fn[0] : null;
      if ((schema && schema !== "pg_catalog") || !SQL_ALLOWED_FUNCTIONS.has(name)) {
        problems.push(`the function ${fn.join(".")} isn't available here`);
      }
    }
    if (key === "RangeVar") {
      const rel = String(value.relname ?? "").toLowerCase();
      const schema = value.schemaname ? String(value.schemaname).toLowerCase() : null;
      const ok = schema ? schema === "public_read" && (SQL_VIEWS as readonly string[]).includes(rel) : (SQL_VIEWS as readonly string[]).includes(rel) || ctes.has(rel);
      if (!ok) problems.push(`${schema ? `${schema}.` : ""}${rel} isn't one of the views (the sql skill lists them)`);
    }
  });
  if (problems.length > 0) {
    throw new SqlRefusal("NOT_ALLOWED", `Nothing was run: ${[...new Set(problems)].join("; ")}.`);
  }
}

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  plan_cost: number;
}

const MAX_ROWS = 500;
const MAX_RESULT_BYTES = 1_000_000;

function connectionString(audience: SqlAudience): string | null {
  const config = loadConfig();
  return (audience === "agent" ? config.sqlAgentDatabaseUrl : config.sqlCallerDatabaseUrl) ?? null;
}

/**
 * Run one checked query on the audience's role, read-only, with the
 * audience's limits. The connection is opened for this query and closed
 * after it.
 */
export async function runReadOnlyQuery(
  sql: string,
  params: unknown[],
  opts: { audience: SqlAudience; maxRows?: number }
): Promise<SqlResult> {
  const config = loadConfig();
  const url = connectionString(opts.audience);
  if (!url) {
    throw new SqlRefusal("NOT_CONFIGURED", "Read-only SQL is not configured in this deployment yet.");
  }
  await checkQuery(sql);
  const timeoutMs = (opts.audience === "agent" ? config.sqlAgentTimeoutSeconds : config.sqlCallerTimeoutSeconds) * 1000;
  const maxRows = Math.max(1, Math.min(MAX_ROWS, Math.floor(opts.maxRows ?? 100)));
  const body = sql.trim().replace(/;\s*$/, "");
  const wrapped = `SELECT * FROM (${body}) q LIMIT ${maxRows + 1}`;
  const client = new pg.Client({ connectionString: url, query_timeout: timeoutMs + 2000, statement_timeout: timeoutMs });
  const started = Date.now();
  try {
    try {
      await client.connect();
    } catch (err) {
      // 53300: the role's CONNECTION LIMIT is reached. Answer now; never queue.
      if ((err as { code?: string }).code === "53300") {
        throw new SqlRefusal("BUSY", "SQL is at capacity right now. Try again shortly.", 5);
      }
      throw err;
    }
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await client.query("SET LOCAL lock_timeout = 1000");
    await client.query("SET LOCAL search_path = public_read");
    const explained = await client.query(`EXPLAIN (FORMAT JSON) ${wrapped}`, params);
    const planCost = Number(
      (explained.rows[0]?.["QUERY PLAN"] as Array<{ Plan?: { "Total Cost"?: number } }> | undefined)?.[0]?.Plan?.["Total Cost"] ?? 0
    );
    if (planCost > config.sqlMaxPlanCost) {
      throw new SqlRefusal(
        "TOO_EXPENSIVE",
        `The planner estimates this query at ${Math.round(planCost)}, above the limit of ${config.sqlMaxPlanCost}. ` +
          `Nothing was run. Narrow it: filter on an indexed column (ids, node_id, tags, importance, ` +
          `assessed_at, created_at), join on ids, or aggregate instead of returning rows.`
      );
    }
    const res = await client.query({ text: wrapped, values: params, rowMode: "array" });
    let rows = res.rows as unknown[][];
    let truncated = rows.length > maxRows;
    if (truncated) rows = rows.slice(0, maxRows);
    let bytes = 0;
    const kept: unknown[][] = [];
    for (const r of rows) {
      bytes += JSON.stringify(r).length;
      if (bytes > MAX_RESULT_BYTES) {
        truncated = true;
        break;
      }
      kept.push(r);
    }
    return {
      columns: res.fields.map((f) => f.name),
      rows: kept,
      row_count: kept.length,
      truncated,
      elapsed_ms: Date.now() - started,
      plan_cost: Math.round(planCost),
    };
  } catch (err) {
    if (err instanceof SqlRefusal) throw err;
    const code = (err as { code?: string }).code;
    if (code === "57014") {
      throw new SqlRefusal("TIMED_OUT", `The query ran past ${timeoutMs / 1000} seconds and was stopped. Narrow it as for a query that is too expensive.`);
    }
    throw new SqlRefusal("SQL_ERROR", `${err instanceof Error ? err.message : String(err)}. The sql skill lists every view's columns.`);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Callers: one at a time, a daily allowance, a short cache
// ---------------------------------------------------------------------------

const cache = new Map<string, { at: number; result: SqlResult }>();
const CACHE_MS = 30_000;

export interface CallerSqlResult extends SqlResult {
  cost_owls: number;
  allowance_left_seconds: number;
  cached: boolean;
}

/**
 * A caller's query: refused while the account has one running, charged
 * against the day's allowance (larger for accounts that have bought owls),
 * priced past it, and served from cache when an identical query ran in the
 * last 30 seconds.
 */
export async function runCallerQuery(input: {
  accountKey: string;
  userId: string | null;
  paid: boolean;
  sql: string;
  params: unknown[];
  maxRows?: number;
  /** The account's owl balance: past the allowance, a query runs only when it could pay for its whole time limit. */
  balanceOwls?: number;
  /** Debit owls for database time past the allowance. */
  charge?: (owls: number) => Promise<boolean>;
}): Promise<CallerSqlResult> {
  const config = loadConfig();
  const allowance = input.paid ? config.sqlPaidAllowanceSeconds : config.sqlFreeAllowanceSeconds;
  const key = JSON.stringify([input.sql.trim(), input.params, input.maxRows ?? 100]);
  const hit = cache.get(key);
  const [usage] = await rawQuery<{ seconds: number }>(
    `SELECT seconds FROM sql_usage WHERE account_key = $1 AND day = (now() AT TIME ZONE 'UTC')::date`,
    [input.accountKey]
  );
  const used = Number(usage?.seconds ?? 0);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return { ...hit.result, cost_owls: 0, allowance_left_seconds: Math.max(0, allowance - used), cached: true };
  }
  if (used >= allowance) {
    const worstCase = config.sqlCallerTimeoutSeconds * config.sqlOwlsPerSecond;
    if (!input.charge || (input.balanceOwls ?? 0) < worstCase) {
      throw new SqlRefusal(
        "ALLOWANCE",
        `Today's free query time (${allowance} seconds) is used. Further queries cost ` +
          `${config.sqlOwlsPerSecond} owls per second of database time, and your balance is ` +
          `${input.balanceOwls ?? 0} owls. Buy owls, or wait until midnight UTC.`
      );
    }
  }
  // One query at a time per account, held in the database across API tasks.
  const lease = await rawQuery<{ account_key: string }>(
    `INSERT INTO sql_usage (account_key, day, running_until)
     VALUES ($1, (now() AT TIME ZONE 'UTC')::date, now() + interval '1 minute')
     ON CONFLICT (account_key, day) DO UPDATE SET running_until = EXCLUDED.running_until
       WHERE sql_usage.running_until IS NULL OR sql_usage.running_until < now()
     RETURNING account_key`,
    [input.accountKey]
  );
  if (lease.length === 0) {
    throw new SqlRefusal("ONE_AT_A_TIME", "Your account already has a query running. Send the next one when it returns.", 2);
  }
  const started = Date.now();
  let result: SqlResult | null = null;
  try {
    result = await runReadOnlyQuery(input.sql, input.params, { audience: "caller", maxRows: input.maxRows });
    return await settle(result);
  } finally {
    if (!result) {
      await rawQuery(
        `UPDATE sql_usage SET running_until = NULL, seconds = seconds + $2, queries = queries + 1
          WHERE account_key = $1 AND day = (now() AT TIME ZONE 'UTC')::date`,
        [input.accountKey, (Date.now() - started) / 1000]
      ).catch(() => {});
    }
  }

  async function settle(r: SqlResult): Promise<CallerSqlResult> {
    const seconds = Math.max(0.001, r.elapsed_ms / 1000);
    const over = Math.max(0, used + seconds - allowance) - Math.max(0, used - allowance);
    let cost = 0;
    if (over > 0) {
      cost = Math.round(over * config.sqlOwlsPerSecond * 10_000) / 10_000;
      const ok = input.charge ? await input.charge(cost) : false;
      if (!ok) cost = 0;
    }
    await rawQuery(
      `UPDATE sql_usage SET running_until = NULL, seconds = seconds + $2, queries = queries + 1
        WHERE account_key = $1 AND day = (now() AT TIME ZONE 'UTC')::date`,
      [input.accountKey, seconds]
    );
    cache.set(key, { at: Date.now(), result: r });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    return { ...r, cost_owls: cost, allowance_left_seconds: Math.max(0, allowance - used - seconds), cached: false };
  }
}
