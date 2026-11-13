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
 *     limit is refused before it runs, with the estimate. The estimate is
 *     taken from statistics over every row of a table, whatever its label,
 *     so where the deployment has more than one label it is not given: a
 *     reader could size what they may not read from it. The refusal still
 *     happens, and says only that the limit was passed.
 *  5. Callers: one query at a time per account and a daily allowance of
 *     database time, both held in the database so they hold across API
 *     tasks; past the allowance, a query is priced in owls by the second.
 *     The login roles' CONNECTION LIMITs cap how many run at once; a full
 *     pool answers at once rather than queueing. Identical queries within 30
 *     seconds are served from cache.
 *
 * Where a deployment has more than one label, the views show a row only at
 * a label the asker reads (db/clearance.ts). Whoever writes the SQL could
 * set any setting if a layer above failed, so the clearance is not a
 * setting taken on trust. The views are owned by a role the row-level
 * security policies bind, and the policy reads the session's clearance
 * from a token this service signs for the one connection the query runs
 * on (sqlClearanceToken below; minerval_sql_clearance in the database
 * checks it). A session with no token, a forged one, an expired one or one
 * made for another connection reads `public` alone. The key is in a schema
 * the SQL roles hold nothing on. The result says which labels were read.
 */
import { createHash } from "node:crypto";
import pg from "pg";
import { loadConfig } from "../config.js";
import { currentReadClearance, databaseSsl, rawQuery } from "../db/client.js";
import { withSystemClearance } from "../db/clearance.js";
import { PUBLIC_LABEL } from "../labels.js";
import { ASK_AN_ADMINISTRATOR_FOR_OWLS, owlsCreatedHere } from "./owl.js";

/** The views callers and agents may read (migration 0093). */
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
      | "ALLOWANCE"
      | "UNAVAILABLE",
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

/**
 * Call `visit` on every relation a query reads, with the CTE names visible
 * at that point. Postgres resolves an unqualified name to a CTE only where
 * the WITH clause is in scope: the query it is attached to (set operations
 * included), later CTEs of the same list, and a CTE's own body only under
 * RECURSIVE. Anywhere else the same name falls through to pg_catalog,
 * which is always searched. A name declared in one subquery must not
 * excuse the same name in another.
 */
function scanRelations(
  node: unknown,
  scope: ReadonlySet<string>,
  visit: (rangeVar: Record<string, unknown>, scope: ReadonlySet<string>) => void
): void {
  if (Array.isArray(node)) {
    for (const n of node) scanRelations(n, scope, visit);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const withClause = obj.withClause as { ctes?: unknown[]; recursive?: boolean } | undefined;
  let inner = scope;
  if (withClause && Array.isArray(withClause.ctes)) {
    const ctes = withClause.ctes
      .map((c) => (c as { CommonTableExpr?: Record<string, unknown> }).CommonTableExpr)
      .filter((c): c is Record<string, unknown> => !!c);
    const declared = ctes.map((c) => String(c.ctename ?? "").toLowerCase());
    ctes.forEach((cte, i) => {
      const visible = new Set(scope);
      for (const n of withClause.recursive ? declared : declared.slice(0, i)) visible.add(n);
      scanRelations(cte.ctequery, visible, visit);
    });
    inner = new Set([...scope, ...declared]);
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === "withClause") continue;
    if (key === "RangeVar" && value && typeof value === "object") visit(value as Record<string, unknown>, inner);
    scanRelations(value, inner, visit);
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
  const problems: string[] = [];
  walk(stmts[0]!.stmt, (key, value) => {
    // Defence in depth: a CTE can't take a catalog name, so even a scoping
    // mistake below could never let a pg_ relation through.
    if (key === "CommonTableExpr" && String(value.ctename ?? "").toLowerCase().startsWith("pg_")) {
      problems.push(`a WITH name can't begin with pg_ (${String(value.ctename)})`);
    }
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
  });
  scanRelations(stmts[0]!.stmt, new Set(), (value, ctes) => {
    const rel = String(value.relname ?? "").toLowerCase();
    const schema = value.schemaname ? String(value.schemaname).toLowerCase() : null;
    const ok = schema ? schema === "public_read" && (SQL_VIEWS as readonly string[]).includes(rel) : (SQL_VIEWS as readonly string[]).includes(rel) || ctes.has(rel);
    if (!ok) problems.push(`${schema ? `${schema}.` : ""}${rel} isn't one of the views (the sql skill lists them)`);
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
  /**
   * The planner's estimate for the query. Left out where the deployment
   * has more than one label: it is computed over rows at every label.
   */
  plan_cost?: number;
  /**
   * Present only where the deployment has more than one label: which rows
   * the views showed this asker, and why (sqlClearanceNote).
   */
  note?: string;
}

// ---------------------------------------------------------------------------
// The asker's clearance, carried to the query's own connection
// ---------------------------------------------------------------------------

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

let clearanceKey: Promise<string> | null = null;

/** The key the database checks a clearance token against. Read once, as the owner. */
function sqlClearanceKey(): Promise<string> {
  clearanceKey ??= withSystemClearance(
    "The key that signs read-only SQL's clearance is readable by the tables' owner alone.",
    async () => {
      const [row] = await rawQuery<{ key: string }>(`SELECT key FROM minerval_private.sql_clearance_key`);
      if (!row) throw new Error("no key to sign read-only SQL's clearance with");
      return row.key;
    }
  ).catch((err) => {
    clearanceKey = null;
    throw err;
  });
  return clearanceKey;
}

/**
 * A clearance for one connection: "expiry.pid.labels.signature". The
 * database returns the labels only for a token whose signature is right,
 * that has not expired, on the backend it names (minerval_sql_clearance).
 * `public` is read by every session and is left out.
 */
export function sqlClearanceToken(input: {
  key: string;
  labels: readonly string[];
  backendPid: number;
  expiresAtEpochSeconds: number;
}): string {
  const labels = [...new Set(input.labels)].filter((l) => l !== PUBLIC_LABEL).sort();
  const signed = `${Math.floor(input.expiresAtEpochSeconds)}.${input.backendPid}.${labels.join(",")}`;
  return `${signed}.${sha256Hex(input.key + sha256Hex(input.key + signed))}`;
}

/**
 * The labels the asker reads, or null where nothing is held. Working it out
 * asks the main database, which read-only SQL otherwise does not depend on
 * (callers read a replica). If that fails the query still runs, with no
 * token: where the views are held they then show `public` alone, and where
 * they are not, nothing has changed.
 */
async function askerClearance(): Promise<string[] | null> {
  try {
    return await currentReadClearance();
  } catch (err) {
    console.error("[sql] could not work out the asker's clearance; the query reads public alone:", err);
    return null;
  }
}

/**
 * What a result says about the rows it was computed over, on a deployment
 * with more than one label. The asker is told which labels it read and
 * that everything else was left out before the query ran, since a count
 * that silently covers less than the whole graph would mislead.
 */
export function sqlClearanceNote(clearance: readonly string[]): string {
  const read = [...clearance].sort((a, b) => (a === PUBLIC_LABEL ? -1 : b === PUBLIC_LABEL ? 1 : a < b ? -1 : 1));
  const names = read.map((l) => `\`${l}\``);
  const list =
    names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
  return (
    `This graph holds material that only some of its readers may see. These views showed you the rows ` +
    `labeled ${list}, which is what you may read. Rows at any other label were left out before your ` +
    `query ran, so a count, a sum or an empty result here is over what you can read and not over ` +
    `everything the graph holds.`
  );
}

const MAX_ROWS = 500;
const MAX_RESULT_BYTES = 1_000_000;

/**
 * Whether an error is the deployment's fault rather than the query's: the
 * connection or the role's login failed (SQLSTATE classes 08 and 28), the
 * server is shutting down or refusing connections (57P), the role lacks a
 * grant on a view checkQuery already allowed (42501), or the client lost the
 * connection (an error that is not the server's answer at all). 08P01 is
 * excluded: it is how the server answers params that don't match the
 * query's placeholders.
 */
function isSystemFault(err: unknown): boolean {
  if (!(err instanceof pg.DatabaseError)) return true;
  const code = err.code ?? "";
  if (code === "08P01") return false;
  return code.startsWith("08") || code.startsWith("28") || code.startsWith("57P") || code === "42501";
}

/**
 * A system fault: logged here with the raw error, answered with a fixed
 * message, so the caller learns it was not their query and nothing about
 * the database's hosts or roles.
 */
function unavailable(audience: SqlAudience, err: unknown): SqlRefusal {
  console.error(`[sql] ${audience} query failed on our side:`, err);
  return new SqlRefusal(
    "UNAVAILABLE",
    "SQL is unavailable right now because of a fault on our side, not a problem with your query. " +
      "It has been logged. Try again later."
  );
}

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
  // What the asker reads: the run's label and what it reads, or the
  // request's clearance. Null on a deployment whose only label is `public`,
  // where nothing below changes.
  const clearance = await askerClearance();
  const timeoutMs = (opts.audience === "agent" ? config.sqlAgentTimeoutSeconds : config.sqlCallerTimeoutSeconds) * 1000;
  const maxRows = Math.max(1, Math.min(MAX_ROWS, Math.floor(opts.maxRows ?? 100)));
  const body = sql.trim().replace(/;\s*$/, "");
  const wrapped = `SELECT * FROM (${body}) q LIMIT ${maxRows + 1}`;
  const ssl = databaseSsl();
  const client = new pg.Client({
    connectionString: url,
    query_timeout: timeoutMs + 2000,
    statement_timeout: timeoutMs,
    ...(ssl && { ssl }),
  });
  const started = Date.now();
  try {
    try {
      await client.connect();
    } catch (err) {
      // 53300: the role's CONNECTION LIMIT is reached. Answer now; never queue.
      if ((err as { code?: string }).code === "53300") {
        throw new SqlRefusal("BUSY", "SQL is at capacity right now. Try again shortly.", 5);
      }
      // Nothing about a failed connection is the query's doing.
      throw unavailable(opts.audience, err);
    }
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await client.query("SET LOCAL lock_timeout = 1000");
    await client.query("SET LOCAL search_path = public_read");
    if (clearance && clearance.some((l) => l !== PUBLIC_LABEL)) {
      const [backend] = (await client.query(`SELECT pg_backend_pid() AS pid`)).rows as Array<{ pid: number }>;
      const token = sqlClearanceToken({
        key: await sqlClearanceKey(),
        labels: clearance,
        backendPid: backend!.pid,
        expiresAtEpochSeconds: Date.now() / 1000 + timeoutMs / 1000 + 60,
      });
      await client.query(`SELECT set_config('minerval.sql_clearance', $1, true)`, [token]);
    }
    const explained = await client.query(`EXPLAIN (FORMAT JSON) ${wrapped}`, params);
    const planCost = Number(
      (explained.rows[0]?.["QUERY PLAN"] as Array<{ Plan?: { "Total Cost"?: number } }> | undefined)?.[0]?.Plan?.["Total Cost"] ?? 0
    );
    if (planCost > config.sqlMaxPlanCost) {
      throw new SqlRefusal(
        "TOO_EXPENSIVE",
        (clearance
          ? `The planner estimates this query above the limit for one query. `
          : `The planner estimates this query at ${Math.round(planCost)}, above the limit of ${config.sqlMaxPlanCost}. `) +
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
      ...(clearance ? { note: sqlClearanceNote(clearance) } : { plan_cost: Math.round(planCost) }),
    };
  } catch (err) {
    if (err instanceof SqlRefusal) throw err;
    const code = (err as { code?: string }).code;
    // "Query read timeout" is pg's own client-side timer, the backstop behind statement_timeout.
    if (code === "57014" || (err instanceof Error && err.message === "Query read timeout")) {
      throw new SqlRefusal("TIMED_OUT", `The query ran past ${timeoutMs / 1000} seconds and was stopped. Narrow it as for a query that is too expensive.`);
    }
    if (isSystemFault(err)) throw unavailable(opts.audience, err);
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
  // A cached result is one asker's rows: it is served again only to an
  // asker who reads the same labels.
  const key = JSON.stringify([input.sql.trim(), input.params, input.maxRows ?? 100, await askerClearance()]);
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
          `${input.balanceOwls ?? 0} owls. ` +
          (owlsCreatedHere(config)
            ? `${ASK_AN_ADMINISTRATOR_FOR_OWLS} Or wait until midnight UTC.`
            : `Buy owls, or wait until midnight UTC.`)
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
