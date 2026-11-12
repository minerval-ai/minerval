/**
 * Which SQL statements write to the graph (#552 groundwork).
 *
 * A run that wrote to the graph keeps its transcript for good: the verdicts,
 * arguments, tags and records it left behind are public, and the transcript
 * is how anyone can see how they were made. Every other run expires with the
 * retention sweep (workers/trace-retention.ts).
 *
 * "Wrote to the graph" is decided here, mechanically, from the statements a
 * run sends, not from a list of write sites that new code would have to
 * remember to join. db/client.ts shows every statement to an observer; the
 * usage context (llm/usage-context.ts) marks the open run when a statement
 * classified here as a graph write passes through.
 *
 * Every table in the schema counts as graph state except the bookkeeping
 * below, so a new table is graph state until someone says otherwise. The
 * rule leans toward keeping: a write that later rolls back still marks the
 * run, and so does a lease update on a claim row.
 */
import { getTableName, isTable } from "drizzle-orm";
import * as schema from "./schema.js";

/**
 * Tables whose writes are not graph state: the run's own telemetry, money
 * and queue bookkeeping, credentials, and a reader's private analyses.
 */
export const BOOKKEEPING_TABLES: ReadonlySet<string> = new Set([
  // Telemetry about runs, including the write that marks a run.
  "agent_runs",
  "agent_steps",
  "llm_usage",
  "enqueue_events",
  "queue_depth_snapshots",
  "eval_runs",
  // The setups runs ran under: recorded by every run, not graph state.
  "setup_parts",
  // A paused run's transcript, kept so it can resume: run machinery.
  "agent_sessions",
  // Money and the work queue: charges, escrow, leases.
  "owl_ledger",
  "budget_jobs",
  "jobs",
  "action_allocations",
  // Credentials.
  "api_keys",
  "oauth_clients",
  "oauth_tokens",
  "oauth_authorization_requests",
  // A reader's own page analyses (#356): never traced, never graph state.
  "shared_page_analyses",
  // A deployment's connections and the record of calls through them
  // (src/connections.ts): settings and a run's own telemetry. A run that
  // only looked marks nothing; one that keeps a reading writes `sources`,
  // which is graph state.
  "connections",
  "connection_tools",
  "connection_calls",
  // A deployment's file sets and the record of commands run against them
  // (src/file-sets.ts): what people added and a run's own telemetry. A run
  // that only explored marks nothing; one that keeps an analysis or a file
  // writes `sources`, which is graph state.
  "file_sets",
  "file_set_files",
  "file_set_keeps",
  "sandbox_calls",
]);

const SCHEMA_TABLES: ReadonlySet<string> = new Set(
  Object.values(schema)
    .filter((v) => isTable(v))
    .map((t) => getTableName(t as Parameters<typeof getTableName>[0]))
);

const WRITE_TARGET =
  /\b(?:insert\s+into|update|delete\s+from)\s+(?:"?public"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?/gi;

/**
 * Whether `sql` writes to a graph table: an INSERT, UPDATE or DELETE whose
 * target is a schema table outside BOOKKEEPING_TABLES. Targets that are not
 * schema tables (the "SKIP" of "FOR UPDATE SKIP LOCKED", a CTE name) are
 * ignored.
 */
export function writesGraph(sql: string): boolean {
  if (!/\b(?:insert|update|delete)\b/i.test(sql)) return false;
  for (const m of sql.matchAll(WRITE_TARGET)) {
    const table = m[1]!.toLowerCase();
    if (SCHEMA_TABLES.has(table) && !BOOKKEEPING_TABLES.has(table)) return true;
  }
  return false;
}
