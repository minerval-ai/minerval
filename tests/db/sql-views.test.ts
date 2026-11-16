/**
 * Read-only SQL against real Postgres, layer by layer: the role reads the
 * views and nothing else, the parser refuses writes, settings, row locks,
 * advisory locks and sleeps, an expensive query is refused before it runs,
 * a runaway one is stopped, nothing a query sets outlives it, and callers
 * are held to one query at a time and a daily allowance. The views expose
 * only a reviewed list of columns.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { rawQuery } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";
import {
  SQL_VIEWS,
  SqlRefusal,
  checkQuery,
  runCallerQuery,
  runReadOnlyQuery,
} from "../../src/services/sql-service.js";
import { TEST_DATABASE_URL } from "./urls.js";
import { seedClaim } from "./helpers.js";

const ROLE = "minerval_sql_dbtest";
const PASSWORD = "dbtest-sql";

/**
 * Every column a view exposes, reviewed as public: each is a field the API
 * already serves. A new column fails this test until it is reviewed here.
 */
const REVIEWED_COLUMNS: Record<string, string[]> = {
  nodes: ["id", "kind", "text", "claim_type", "state", "merged_into", "importance", "contestation", "steward_state", "stewarded_at", "proposed_by_person", "tags", "created_at", "updated_at", "steward_park_reason"],
  assessments: ["id", "node_id", "status", "confidence", "credence", "marginal_yield", "is_current", "assessed_at", "trigger", "summary", "reasoning_head", "relabeled_from"],
  edges: ["id", "parent_id", "child_id", "relation", "reasoning", "created_at"],
  arguments: ["id", "node_id", "name", "stance", "shows", "description", "created_at", "retired_at"],
  tags: ["slug", "name", "description", "status", "node_count"],
  sources: ["id", "url", "title", "source_type", "publisher", "published_date", "doi", "retrieved_at"],
  instances: ["id", "node_id", "source_id", "stance", "speaker", "publication", "source_date", "verbatim_head", "created_at", "detached_at"],
  ledger: ["action_id", "kind", "variant", "target_node_id", "target_ref", "label", "status", "spent_owls", "opened_at", "updated_at", "waiting_on", "waiting_since", "next_attempt_at", "extraction", "extraction_started_at", "queued_ahead"],
  commissions: ["commission_id", "action_id", "exclusion_group", "payer_kind", "payer_mandate_id", "budget_owls", "spent_owls", "returned_owls", "commissioned_by", "brief", "reason", "parent_action_id", "created_at", "settled_at"],
  messages: ["message_id", "node_id", "trigger", "sender_kind", "sender_node_id", "paid", "body", "created_at", "read_at", "outcome", "outcome_note"],
  mandates: ["mandate_id", "title", "objective", "status", "is_platform", "pace", "reserve_owls", "reserve_reason", "escrow_owls", "operating_policy", "created_at"],
  mandate_decisions: ["decision_id", "mandate_id", "decided_by", "item_kind", "decision", "target", "owls", "reason", "petition_id", "action_id", "created_at"],
  plan_items: ["mandate_id", "item_index", "plan_cursor", "action", "node_id", "url", "partition", "variant", "focus", "rationale", "ledger_status", "ledger_reason", "action_id", "exclusion_group", "ledger_checked_at", "proposed_kind", "proposed_text", "proposal_ref", "node_ref", "contribution_id", "added_by", "added_at", "added_run_id"],
  petitions: ["petition_id", "mandate_id", "kind", "asked_owls", "granted_owls", "requester_agent", "requester_node_id", "status", "plan", "reason", "created_at", "decided_at"],
  contributions: ["contribution_id", "node_id", "type", "review_status", "submitted_at"],
  requests: ["request_id", "ask", "why", "state", "keeper_kind", "keeper_node_id", "budget_owls", "created_at", "closed_at"],
  changes: ["kind", "node_id", "at", "summary"],
};

async function refusal(p: Promise<unknown>): Promise<SqlRefusal> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SqlRefusal) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

beforeAll(async () => {
  await rawQuery(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
      CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}' CONNECTION LIMIT 3 IN ROLE minerval_sql;
    END IF; END $$`);
  const url = new URL(TEST_DATABASE_URL);
  url.username = ROLE;
  url.password = PASSWORD;
  Object.assign(loadConfig(), {
    sqlAgentDatabaseUrl: url.toString(),
    sqlCallerDatabaseUrl: url.toString(),
    sqlCallerTimeoutSeconds: 2,
    sqlFreeAllowanceSeconds: 60,
  });
});

describe("read-only SQL", () => {
  it("exposes only the reviewed columns", async () => {
    const rows = await rawQuery<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public_read' ORDER BY table_name, ordinal_position`
    );
    const byView: Record<string, string[]> = {};
    for (const r of rows) (byView[r.table_name] ??= []).push(r.column_name);
    expect(Object.keys(byView).sort()).toEqual([...SQL_VIEWS].sort());
    for (const v of SQL_VIEWS) expect(byView[v], v).toEqual(REVIEWED_COLUMNS[v]);
  });

  it("answers a query over the views", async () => {
    const id = await seedClaim("sql reader");
    const res = await runReadOnlyQuery(`SELECT id, text FROM nodes WHERE id = $1`, [id], { audience: "agent" });
    expect(res.columns).toEqual(["id", "text"]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]![0]).toBe(id);
  });

  it("runs the sql skill's relabeled-status backlog query (#848)", async () => {
    // The recipe as the skill states it, so a renamed column fails here.
    const skill = readFileSync(new URL("../../skills/sql/SKILL.md", import.meta.url), "utf8");
    const recipe = skill.split("```sql").map((b) => b.split("```")[0]!).find((b) => b.includes("relabeled_from IS NOT NULL"));
    expect(recipe).toBeTruthy();
    const id = await seedClaim("relabeled backlog");
    await rawQuery(`UPDATE claims SET importance = 1 WHERE id = $1`, [id]);
    await rawQuery(
      `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, relabeled_from)
       VALUES ($1, 'inconclusive', 0.6, 'carried over', 'contested')`,
      [id]
    );
    const res = await runReadOnlyQuery(recipe!, [], { audience: "agent" });
    expect(res.columns).toEqual(["id", "text", "importance", "status", "relabeled_from", "assessed_at", "open_reassess", "committed_owls"]);
    const row = res.rows.find((r) => r[0] === id);
    expect(row?.[4]).toBe("contested");
  });

  it("refuses what isn't a single SELECT, before anything runs", async () => {
    for (const sql of [
      "DELETE FROM nodes",
      "SET statement_timeout = 0",
      "SELECT 1; SELECT 2",
      "SELECT * INTO copied FROM nodes",
      "WITH gone AS (DELETE FROM nodes RETURNING id) SELECT * FROM gone",
    ]) {
      const r = await refusal(checkQuery(sql));
      expect(["NOT_A_QUERY", "NOT_ALLOWED", "SQL_ERROR"], sql).toContain(r.code);
    }
  });

  it("refuses functions off the list, row locks, and the base tables", async () => {
    for (const sql of [
      "SELECT pg_advisory_lock(1)",
      "SELECT pg_try_advisory_xact_lock(42)",
      "SELECT pg_sleep(10)",
      "SELECT set_config('statement_timeout', '0', false)",
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT id FROM nodes FOR UPDATE",
      "SELECT * FROM claims",
      "SELECT * FROM public.contributors",
      "SELECT * FROM pg_catalog.pg_authid",
    ]) {
      const r = await refusal(checkQuery(sql));
      expect(r.code, sql).toBe("NOT_ALLOWED");
    }
  });

  it("can't read a base table even if the parser were bypassed: the role has no grant", async () => {
    const url = new URL(TEST_DATABASE_URL);
    url.username = ROLE;
    url.password = PASSWORD;
    const pg = await import("pg");
    const c = new pg.default.Client({ connectionString: url.toString() });
    await c.connect();
    try {
      await expect(c.query("SELECT id FROM public.claims LIMIT 1")).rejects.toMatchObject({ code: "42501" });
      await c.query("BEGIN READ ONLY");
      await expect(c.query("CREATE TEMP TABLE t (x int)")).rejects.toBeTruthy();
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      await c.end();
    }
  });

  it("refuses a query the planner prices above the limit, without running it", async () => {
    const saved = loadConfig().sqlMaxPlanCost;
    loadConfig().sqlMaxPlanCost = 1;
    try {
      const r = await refusal(runReadOnlyQuery(`SELECT a.id FROM nodes a, nodes b, nodes c`, [], { audience: "agent" }));
      expect(r.code).toBe("TOO_EXPENSIVE");
      expect(r.message).toContain("Nothing was run");
    } finally {
      loadConfig().sqlMaxPlanCost = saved;
    }
  });

  it("holds a caller to one query at a time and to the day's allowance", async () => {
    const account = `dbtest:${Math.random()}`;
    await rawQuery(
      `INSERT INTO sql_usage (account_key, day, running_until) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, now() + interval '1 minute')`,
      [account]
    );
    const busy = await refusal(runCallerQuery({ accountKey: account, userId: null, paid: false, sql: "SELECT 1 AS one FROM tags LIMIT 1", params: [] }));
    expect(busy.code).toBe("ONE_AT_A_TIME");
    await rawQuery(`UPDATE sql_usage SET running_until = NULL, seconds = 61 WHERE account_key = $1`, [account]);
    const spent = await refusal(runCallerQuery({ accountKey: account, userId: null, paid: false, sql: "SELECT 2 AS two FROM tags LIMIT 1", params: [] }));
    expect(spent.code).toBe("ALLOWANCE");

    const fresh = `dbtest:${Math.random()}`;
    const ok = await runCallerQuery({ accountKey: fresh, userId: null, paid: false, sql: "SELECT count(*) AS n FROM nodes", params: [] });
    expect(ok.cached).toBe(false);
    const again = await runCallerQuery({ accountKey: fresh, userId: null, paid: false, sql: "SELECT count(*) AS n FROM nodes", params: [] });
    expect(again.cached).toBe(true);
    const [u] = await rawQuery<{ queries: number; running_until: Date | null }>(
      `SELECT queries, running_until FROM sql_usage WHERE account_key = $1`,
      [fresh]
    );
    expect(u).toMatchObject({ queries: 1, running_until: null });
  });
});
