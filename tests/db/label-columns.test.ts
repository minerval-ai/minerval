/**
 * The label column on every remaining table (src/labels.ts, the
 * label_columns migration).
 *
 * The migration adds `sensitivity_label` to eighty-one tables and nothing
 * else: no write stamps it yet and nothing reads it. So there are two things
 * to check, against real Postgres:
 *
 *  - The catalog: which tables have the column, its default and its key to
 *    `labels`, the two keys that are not validated yet, the views, and the
 *    tables left without a label on purpose. The list of labelled tables by
 *    name is in labels.test.ts.
 *  - That the column reaches no reader. A column added to a table rides
 *    along in any read that returns whole rows, so the busiest routes, the
 *    claim view and an agent's read of a claim are asked for rows that
 *    carry a second label, and none may show it.
 *
 * What stamps the column, and the fuller checks of every route and every
 * agent's read, come with the code that uses it.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

// Tracing is off under vitest by default; the run whose steps are read is a real run.
vi.hoisted(() => {
  process.env.TRACE_LEVEL = "full";
});

// No model is called: the provider answers from here.
vi.mock("../../src/llm/providers/index.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/providers/index.js")>()),
  getAdapter: () => ({
    complete: async (options: { model: string }) => ({
      content: "Done.",
      model: options.model,
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    }),
  }),
}));
vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this file");
  }),
}));

import { rawQuery } from "../../src/db/client.js";
import { complete } from "../../src/llm/client.js";
import { executeGraphReadTool } from "../../src/llm/tools/graph-read-tools.js";
import { getUsageContext, withAgent } from "../../src/llm/usage-context.js";
import { addArgument } from "../../src/services/argument-service.js";
import { ARGUMENT_VIEW_INCLUDES } from "../../src/services/argument-view-service.js";
import { CLAIM_VIEW_INCLUDES, getClaimView } from "../../src/services/claim-view-service.js";
import { fileRequest } from "../../src/services/request-service.js";
import { getOrCreateSource } from "../../src/services/source-service.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

const SECOND = "label-columns-second";
const FOREIGN_KEY_VIOLATION = "23503";

function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

beforeAll(async () => {
  // A second label, as a deployment would define one: a row, nothing else.
  await rawQuery(
    `INSERT INTO labels (name, description) VALUES ($1, 'Readable by the people it is about.')
     ON CONFLICT (name) DO NOTHING`,
    [SECOND]
  );
});

describe("the label column, in the catalog", () => {
  /**
   * Every key from a table's sensitivity_label to labels, with whether
   * Postgres has validated it. Ordered by the catalog's own name column,
   * which sorts byte by byte in every database, as information_schema's
   * table_name does. Cast to text first it would sort by the database's
   * locale, and under en_US "agent_findings" comes before
   * "agent_finding_sightings", where byte order has them the other way.
   */
  const keys = () =>
    rawQuery<{ table_name: string; validated: boolean }>(
      `SELECT r.relname::text AS table_name, k.convalidated AS validated
         FROM pg_constraint k
         JOIN pg_class r ON r.oid = k.conrelid
         JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
        WHERE k.contype = 'f' AND k.confrelid = 'public.labels'::regclass
          AND r.relnamespace = 'public'::regnamespace
          AND array_length(k.conkey, 1) = 1 AND a.attname = 'sensitivity_label'
        ORDER BY r.relname`
    );

  it("is on ninety-seven tables, public by default, each with a key to labels", async () => {
    const columns = await rawQuery<{ table_name: string; column_default: string | null; is_nullable: string; data_type: string }>(
      `SELECT c.table_name, c.column_default, c.is_nullable, c.data_type
         FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'sensitivity_label' AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name`
    );
    expect(columns).toHaveLength(97);
    for (const column of columns) {
      expect(column, column.table_name).toMatchObject({ column_default: "'public'::text", is_nullable: "NO", data_type: "text" });
    }
    // One key each, and on no table that lacks the column.
    expect((await keys()).map((k) => k.table_name)).toEqual(columns.map((c) => c.table_name));
  });

  it("has two keys that are not validated yet, on the two tables every run appends to", async () => {
    // The migration added these two NOT VALID, so that no scan of a table
    // every live run writes to happens under the lock the new column takes.
    // The follow-up is a migration of its own that runs VALIDATE CONSTRAINT
    // on each. When it lands, this list becomes empty; until then it is
    // here so that the follow-up is not forgotten.
    const unvalidated = (await keys()).filter((k) => !k.validated).map((k) => k.table_name);
    expect(unvalidated).toEqual(["agent_steps", "llm_usage"]);
  });

  it("holds a new row to a defined label on those two tables all the same", async () => {
    // NOT VALID skips the check of the rows that existed, not of a row written or changed afterwards.
    await expect(
      rawQuery(`INSERT INTO llm_usage (model, sensitivity_label) VALUES ('dbtest-model', 'undefined-label')`)
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
    const [run] = await rawQuery<{ id: string }>(`INSERT INTO agent_runs (agent) VALUES ('steward') RETURNING id`);
    await expect(
      rawQuery(
        `INSERT INTO agent_steps (run_id, seq, kind, content, sensitivity_label) VALUES ($1, 0, 'tool', '{}', 'undefined-label')`,
        [run!.id]
      )
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
    // And a row written without naming one is public.
    const [step] = await rawQuery<{ sensitivity_label: string }>(
      `INSERT INTO agent_steps (run_id, seq, kind, content) VALUES ($1, 0, 'tool', '{}') RETURNING sensitivity_label`,
      [run!.id]
    );
    expect(step!.sensitivity_label).toBe("public");
  });

  it("is in no view a reader's SQL can reach", async () => {
    // The public_read views name their columns, and Postgres stores a view
    // with its columns spelled out, so a column added to a table a view
    // reads does not appear in it. The migration drops and recreates none.
    const views = await rawQuery<{ view: string }>(
      `SELECT c.table_schema || '.' || c.table_name AS view
         FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.column_name = 'sensitivity_label' AND t.table_type = 'VIEW'
        ORDER BY 1`
    );
    // The four views of the judgment in force carry it with the rest of
    // their table, as they have since the judgments got the column. They
    // are the app's own and not among the views query_sql reads.
    expect(views.map((v) => v.view).sort()).toEqual([
      "public.argument_evaluations_in_force",
      "public.assessments_in_force",
      "public.quantity_estimates_in_force",
      "public.question_assessments_in_force",
    ]);
  });

  it("is left off these tables, and no others, on purpose", async () => {
    const rows = await rawQuery<{ table_name: string }>(
      `SELECT t.table_name FROM information_schema.tables t
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                           WHERE c.table_schema = 'public' AND c.table_name = t.table_name
                             AND c.column_name = 'sensitivity_label')
        ORDER BY t.table_name`
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      // The groups a person's latest sign-in carried, which decide what they may read. Not itself read at a label.
      "account_groups",
      // Money placed on the ledger. It also carries a commission's brief
      // and reason, so it is not settled that it should stay without one.
      "action_allocations",
      // The log of what administrators changed about who may read what. Not itself read at a label.
      "administrative_events",
      // Accounts and their keys.
      "api_keys",
      // A per-account allowance: a number.
      "assistant_allowances",
      "contributors",
      // Scorecards of the corpus harness, written by scripts into its own database.
      "eval_runs",
      // The labels themselves.
      "label_reads",
      "labels",
      // Nothing writes or reads it any more. Not settled, as action_allocations.
      "mandate_valuations",
      // A deployment's bookkeeping about its feed of public rows, with no text of their own.
      "mirror_applied_batches",
      "mirror_feed_batches",
      "mirror_feed_rows",
      "mirror_refusals",
      "mirror_snapshot_rows",
      "oauth_authorization_requests",
      "oauth_clients",
      "oauth_tokens",
      // The owl ledger and what is paid out of it.
      "owl_ledger",
      // Whose material a source is: a name an administrator typed, as a label's name is. An outside
      // party's name can itself be private, so it is not settled that it should stay without one.
      "parties",
      // Who may do what, and at which label. Not itself read at a label.
      "permission_grants",
      // Switches and marks the platform keeps for itself.
      "platform_flags",
      "prize_payouts",
      // Counts of what waits, with no content.
      "queue_depth_snapshots",
      // Money moved between two mandates, with a note. Not settled, as action_allocations.
      "regrants",
      // Database time used by query_sql, per account and day.
      "sql_usage",
    ]);
  });
});

describe("what a reader is shown", () => {
  let app: FastifyInstance;
  const tag = randomUUID().slice(0, 8);
  const ids = {} as {
    claim: string; source: string; instance: string; argument: string; request: string; grant: string; run: string;
  };

  /** Wait for the run to close with its seal, which in the default mode comes after it returns. */
  async function sealed(runId: string): Promise<void> {
    for (let i = 0; i < 250; i++) {
      const [row] = await rawQuery(`SELECT 1 FROM agent_runs WHERE id = $1 AND finished_at IS NOT NULL`, [runId]);
      if (row) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("the run did not close");
  }

  beforeAll(async () => {
    const { buildApp } = await import("../../src/server/app.js");
    app = await buildApp();

    // One row in each of the most-read tables, tied to one claim.
    ids.claim = await seedClaim(`label columns ${tag}`);
    ids.source = (await getOrCreateSource({ url: `https://dbtest.example/label-columns/${tag}`, title: `A document (${tag})` })).id;
    const [instance] = await rawQuery<{ id: string }>(
      `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, stance)
       VALUES ($1, $2, $3, 'affirms') RETURNING id`,
      [ids.claim, ids.source, `The passage (${tag}).`]
    );
    ids.instance = instance!.id;
    ids.argument = (
      await addArgument({ claimId: ids.claim, stance: "for", name: `The argument (${tag})`, content: "It follows.", createdBy: "claim_steward" })
    ).id;
    ids.request = (
      await fileRequest({
        ask: `Find the original survey (${tag}).`,
        why: "The claim turns on it.",
        satisfiedBy: "The survey's own tables.",
        claimIds: [ids.claim],
        filer: { kind: "admin", agent: "claim_steward" },
      })
    ).id;
    ids.grant = (await seedGrantWithJob({ funderId: await seedUser("label-columns"), budgetMicroUsd: 50 * OWL })).grantId;
    // A run with a transcript: a matcher's, whose steps anyone may read.
    ids.run = await withAgent("matcher", async () => {
      await complete({ model: "claude-sonnet-5-5", system: `You are a test (${tag}).`, messages: [{ role: "user", content: "Say done." }] });
      return getUsageContext().trace!.runId;
    });
    await sealed(ids.run);

    // Nothing stamps the new columns yet, so the rows are given a second
    // label here: a response that carried the column would then carry a
    // value no response has another reason to hold.
    const relabel: Array<[string, string, string]> = [
      ["claims", "id", ids.claim],
      ["sources", "id", ids.source],
      ["claim_instances", "id", ids.instance],
      ["arguments", "id", ids.argument],
      ["requests", "id", ids.request],
      ["request_targets", "request_id", ids.request],
      ["grants", "id", ids.grant],
      ["agent_steps", "run_id", ids.run],
      ["llm_usage", "run_id", ids.run],
    ];
    for (const [table, column, id] of relabel) {
      await rawQuery(`UPDATE ${table} SET sensitivity_label = $1 WHERE ${column} = $2`, [SECOND, id]);
    }
    const [steps] = await rawQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM agent_steps WHERE run_id = $1 AND sensitivity_label = $2`,
      [ids.run, SECOND]
    );
    expect(Number(steps!.n)).toBeGreaterThanOrEqual(2);
  });

  afterAll(async () => {
    await app.close();
  });

  const carriesIt = (text: string) => /sensitivity[_ ]?label/i.test(text);
  /** The label's name as a JSON value. */
  const namesIt = (text: string) => text.includes(`"${SECOND}"`);

  it("has no response of the busiest claim, source, request, mandate and run routes that carries the column", async () => {
    // Each route, and something its answer holds when it has read the seeded row.
    const routes: Array<[string, string]> = [
      [`/claims/${ids.claim}?information_depth=cursory`, tag],
      [`/claims/${ids.claim}?information_depth=standard`, tag],
      [`/claims/${ids.claim}?information_depth=deep`, ids.argument],
      [`/claims/${ids.claim}/events`, ids.claim],
      [`/claims/${ids.claim}/provenance`, ids.claim],
      [`/arguments/${ids.argument}`, tag],
      [`/sources/${ids.source}`, tag],
      [`/sources/${ids.source}/context`, `"claims_read":1`],
      [`/requests/${ids.request}`, tag],
      [`/requests`, ids.request],
      [`/mandates/${ids.grant}`, ids.grant],
      [`/runs/${ids.run}`, `"steps_recorded":2`],
      [`/runs/${ids.run}/steps`, "Done."],
      [`/runs/${ids.run}/steps/0`, tag],
      [`/runs/${ids.run}/steps/1`, "Done."],
    ];
    for (const [url, shows] of routes) {
      const res = await app.inject({ method: "GET", url });
      // The check means something only if the route answered with the row.
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain(shows);
      expect(carriesIt(res.body), url).toBe(false);
      expect(namesIt(res.body), url).toBe(false);
    }
  });

  it("has no claim view, and no agent's read of a claim or an argument, that carries it", async () => {
    // What MCP's get_claim and the agents' graph reads return does not pass
    // through a route's response schema, so it is read here directly, with
    // every section asked for.
    const reads: Array<[string, string, string]> = [
      ["the claim view", JSON.stringify(await getClaimView(ids.claim, { include: [...CLAIM_VIEW_INCLUDES] })), ids.argument],
      ["get_claim", (await executeGraphReadTool("get_claim", { claim_id: ids.claim, include: [...CLAIM_VIEW_INCLUDES] }))!, ids.argument],
      ["get_argument", (await executeGraphReadTool("get_argument", { argument_id: ids.argument, include: [...ARGUMENT_VIEW_INCLUDES] }))!, ids.claim],
    ];
    for (const [read, out, shows] of reads) {
      // The check means something only if the read returned the rows.
      expect(out, read).toContain(shows);
      expect(carriesIt(out), read).toBe(false);
      expect(namesIt(out), read).toBe(false);
    }
  });

  it("leaves a run's log intact: the column on a step is outside the hash chain", async () => {
    // The steps above were given another label after the run was sealed. The
    // chain covers prev_hash, seq, kind and content, so the log still verifies.
    const res = await app.inject({ method: "GET", url: `/runs/${ids.run}/verify` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ sealed: true, intact: true, problem: null });
    expect(carriesIt(res.body)).toBe(false);
    expect(namesIt(res.body)).toBe(false);
  });
});
