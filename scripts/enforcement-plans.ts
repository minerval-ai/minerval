/**
 * Query plans with and without reads held to a clearance (src/db/clearance.ts).
 *
 *   DATABASE_URL=postgresql://…/a_seeded_database npx tsx scripts/enforcement-plans.ts [--plans]
 *
 * Row-level security can cost a query its index: a policy's test runs before
 * any condition of the query's own that Postgres cannot prove harmless on
 * rows the reader may not see, and such a condition cannot be an index
 * condition. This script shows what that does to the reads that matter. It
 * runs the services' own functions against a database that already holds a
 * few hundred thousand claims at several labels, records every statement
 * they send with its parameters, and explains each statement three ways:
 *
 *   off      as the tables' owner, whom the policies do not bind. This is
 *            the plan Postgres makes with row-level security disabled.
 *   public   as a cleared connection reading `public` alone.
 *   label    as a cleared connection for a run at the label named by
 *            PLAN_LABEL (default "a"), reading it and what it reads.
 *
 * The statements for the two held columns are the ones the services send
 * when reads are held (keyword search reads through minerval_readable
 * there), so each column is what that reader's query really costs. It
 * prints one line per statement with the three execution times and whether
 * the held plans read a table whole that the unheld plan did not, and with
 * --plans the plans themselves. It writes nothing: every statement is
 * explained inside a transaction that is rolled back.
 */
import "../src/load-env.js";
import pg from "pg";
import { loadConfig } from "../src/config.js";
import { closeDb, rawQuery } from "../src/db/client.js";
import {
  CLEARED_ROLE,
  clearedRolePassword,
  sessionOptions,
  withSystemClearance,
  type Session,
} from "../src/db/clearance.js";
import { ensureEnforcement } from "../src/db/enforcement.js";
import { runAtLabel } from "../src/llm/usage-context.js";
import { getClaimById } from "../src/services/claim-service.js";
import { getClaimView } from "../src/services/claim-view-service.js";
import { findSimilarClaims, hybridSearch, keywordClaimSearch } from "../src/services/search-service.js";
import { nextRunnableAction } from "../src/services/action-service.js";

const LABEL = process.env.PLAN_LABEL ?? "a";
const SHOW_PLANS = process.argv.includes("--plans");

interface Captured {
  text: string;
  params: unknown[];
}

/** Record every statement the pools send while `fn` runs. */
async function capture(fn: () => Promise<unknown>): Promise<Captured[]> {
  const seen: Captured[] = [];
  const original = pg.Pool.prototype.query;
  pg.Pool.prototype.query = function (this: pg.Pool, ...args: unknown[]) {
    const first = args[0];
    const text = typeof first === "string" ? first : (first as { text: string }).text;
    const params = (Array.isArray(args[1]) ? args[1] : ((first as { values?: unknown[] }).values ?? [])) as unknown[];
    if (/^\s*(select|with|update|insert|delete)/i.test(text) && !/pg_policy|minerval_labels_readable_from/.test(text)) {
      // A copy: callers go on to add to the array they passed.
      seen.push({ text, params: [...params] });
    }
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof pg.Pool.prototype.query;
  try {
    await fn();
  } finally {
    pg.Pool.prototype.query = original;
  }
  return seen;
}

function connectionString(session: Session): string {
  const url = new URL(loadConfig().databaseUrl);
  if (session.role === "cleared") {
    url.username = CLEARED_ROLE;
    url.password = clearedRolePassword(loadConfig().databaseUrl);
  }
  const options = sessionOptions(session);
  if (options) url.searchParams.set("options", options);
  return url.toString();
}

interface Explained {
  ms: number;
  plan: string;
  seqScans: string[];
}

async function explain(client: pg.Client, statement: Captured): Promise<Explained> {
  await client.query("BEGIN");
  try {
    // Once to warm the cache, once to measure.
    await client.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${statement.text}`, statement.params);
    const res = await client.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${statement.text}`, statement.params);
    const lines = res.rows.map((r) => r["QUERY PLAN"] as string);
    const plan = lines.join("\n");
    const ms = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? "NaN");
    const seqScans = [...plan.matchAll(/Seq Scan on (\w+)/g)].map((m) => m[1]!);
    return { ms, plan, seqScans };
  } finally {
    await client.query("ROLLBACK");
  }
}

async function main() {
  const { on } = await ensureEnforcement();
  if (!on) throw new Error("this database defines no label besides public, so there is nothing to compare");
  const system = <T>(fn: () => Promise<T>) => withSystemClearance("Measuring plans reads the seeded rows as the owner.", fn);

  const [claim] = await system(() =>
    rawQuery<{ id: string; embedding: string; text: string }>(
      `SELECT c.id, c.embedding::text AS embedding, c.text FROM claims c
        WHERE c.sensitivity_label = 'public'
          AND EXISTS (SELECT 1 FROM claim_relationships r WHERE r.parent_claim_id = c.id)
          AND EXISTS (SELECT 1 FROM assessments a WHERE a.claim_id = c.id)
        ORDER BY c.id LIMIT 1`
    )
  );
  if (!claim) throw new Error("no seeded claim to read");
  const embedding = JSON.parse(claim.embedding) as number[];
  // A rare word (one claim's own) and a common one (an eighth of the graph).
  const rare = /the (\w+) effect/.exec(claim.text)?.[1] ?? "effect";
  // Site search asks for an embedding of the query; give it one without a provider.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding }], model: "m", usage: { prompt_tokens: 1, total_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const reads: Array<[string, () => Promise<unknown>]> = [
    ["claim by id", () => getClaimById(claim.id)],
    ["claim page", () => getClaimView(claim.id, {})],
    ["keyword search, a rare word (Matcher candidates)", () => keywordClaimSearch(rare, { limit: 20 })],
    ["keyword search, a common word (Matcher candidates)", () => keywordClaimSearch("employment", { limit: 20 })],
    ["vector search (Matcher candidates)", () => findSimilarClaims(embedding, { limit: 20, minSimilarity: 0.85 })],
    ["site search, keyword or vector", () => hybridSearch(`${rare} employment`, { limit: 20 })],
    ["queue: next funded ledger action", () => nextRunnableAction(["assess", "reassess", "curate", "audit", "ingest"])],
  ];
  // The Steward's fallback lane claims with an UPDATE; its SELECT is what finds the row.
  const stewardPoll: Captured = {
    text: `SELECT id FROM claims
            WHERE state = 'active'
              AND (steward_state = 'pending'
                   OR (steward_state = 'running' AND stewarded_at < now() - make_interval(mins => 30)))
            ORDER BY queue_priority DESC, updated_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED`,
    params: [],
  };

  const sessions: Array<[string, Session]> = [
    ["off", { role: "owner" }],
    ["public", { role: "cleared", clearance: ["public"] }],
    ["label", { role: "cleared", clearance: (await system(() => rawQuery<{ l: string[] }>(`SELECT minerval_labels_readable_from($1::text[]) AS l`, [[LABEL]])))[0]!.l, label: LABEL }],
  ];
  const clients = new Map<string, pg.Client>();
  for (const [name, session] of sessions) {
    const client = new pg.Client({ connectionString: connectionString(session) });
    await client.connect();
    clients.set(name, client);
  }

  console.log(`statement | off ms | public ms | ${LABEL} ms | tables read whole only when held`);
  const report = async (label: string, statements: Record<string, Captured[]>) => {
    const count = statements.off!.length;
    for (let i = 0; i < count; i++) {
      const results: Record<string, Explained> = {};
      for (const [name] of sessions) {
        const s = statements[name]![i];
        if (!s) continue;
        try {
          results[name] = await explain(clients.get(name)!, s);
        } catch (err) {
          console.error(`could not explain (${name}): ${s.text.replace(/\s+/g, " ").slice(0, 300)} :: ${JSON.stringify(s.params).slice(0, 200)}`);
          throw err;
        }
      }
      const off = results.off!;
      const lost = [...new Set([...(results.public?.seqScans ?? []), ...(results.label?.seqScans ?? [])])].filter(
        (t) => !off.seqScans.includes(t)
      );
      const head = statements.off![i]!.text.replace(/\s+/g, " ").trim().slice(0, 70);
      console.log(
        `${label}${count > 1 ? ` [${i + 1}/${count}]` : ""} | ${off.ms.toFixed(2)} | ${results.public?.ms.toFixed(2) ?? "-"} | ` +
          `${results.label?.ms.toFixed(2) ?? "-"} | ${lost.join(", ") || "none"} | ${head}`
      );
      if (SHOW_PLANS) {
        for (const [name] of sessions) console.log(`\n--- ${label}${count > 1 ? ` [${i + 1}/${count}]` : ""}, ${name}\n${results[name]?.plan ?? ""}`);
        console.log("");
      }
    }
  };

  for (const [label, read] of reads) {
    // The statements each reader's own work sends: the services write a
    // keyword search differently where reads are held.
    const statements: Record<string, Captured[]> = {
      off: await capture(() => system(read)),
      public: await capture(() => runAtLabel("public", "plan measurement", read)),
      label: await capture(() => runAtLabel(LABEL, "plan measurement", read)),
    };
    await report(label, statements);
  }
  await report("queue: the Steward lane's next pending claim", { off: [stewardPoll], public: [stewardPoll], label: [stewardPoll] });

  globalThis.fetch = realFetch;
  for (const client of clients.values()) await client.end();
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
