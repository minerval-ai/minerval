/**
 * What the mirror's migration adds to the schema, against real Postgres:
 * the `origin` column on the replicated tables, and the guard that keeps a
 * mirrored row the public graph's (src/db/schema.ts, "origin").
 *
 * The migration changes no behavior, and that is the first thing checked:
 * every row is 'local' unless something says otherwise, a local row is
 * written, changed and deleted as it always was, and no read shows the new
 * column. The second is the guard: a row with origin 'mirror' can be
 * inserted, changed or deleted only by a transaction that has said it is
 * the mirror's applier, except for the columns that are a deployment's own
 * working state on a claim.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this file");
  }),
}));

import { rawQuery, withTransaction, type TxQuery } from "../../src/db/client.js";
import { executeGraphReadTool } from "../../src/llm/tools/graph-read-tools.js";
import { CLAIM_VIEW_INCLUDES, getClaimView } from "../../src/services/claim-view-service.js";
import { seedClaim } from "./helpers.js";

/**
 * The replicated tables: the ones the migration gave an origin. In the order
 * JavaScript sorts strings, which every list below is put in before it is
 * compared: how Postgres orders a text expression depends on the database's
 * collation (under en_US an underscore is ignored at first, so `sources`
 * comes before `source_segments`; under C it comes after), so no comparison
 * here leans on the database's ordering.
 */
const TABLES = [
  "answer_relations",
  "argument_evaluations",
  "argument_instances",
  "argument_subclaims",
  "arguments",
  "assessments",
  "claim_instances",
  "claim_links",
  "claim_relationships",
  "claims",
  "judgment_inputs",
  "quantity_cuts",
  "quantity_definitions",
  "quantity_estimates",
  "quantity_readings",
  "question_assessments",
  "source_interests",
  "source_segments",
  "sources",
];

/** The guard's own error code. */
const GUARD = "MIR01";

function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

/** Run `fn` as the mirror's applier does: in a transaction that has said so. */
function asApplier<T>(fn: (tx: TxQuery) => Promise<T>): Promise<T> {
  return withTransaction(async (tx) => {
    await tx.query(`SELECT set_config('minerval.mirror_applier', 'on', true)`);
    return fn(tx);
  });
}

const tag = randomUUID().slice(0, 8);
const ids = {
  claim: randomUUID(),
  source: randomUUID(),
  instance: randomUUID(),
  argument: randomUUID(),
  verdict: randomUUID(),
};

beforeAll(async () => {
  // One mirrored row in each of the most-read tables, tied to one claim.
  await asApplier(async (tx) => {
    await tx.query(
      `INSERT INTO claims (id, text, origin, steward_state, tagged_at) VALUES ($1, $2, 'mirror', 'deferred', now())`,
      [ids.claim, `A mirrored claim (${tag})`]
    );
    await tx.query(`INSERT INTO sources (id, url, title, origin) VALUES ($1, $2, $3, 'mirror')`, [
      ids.source,
      `https://dbtest.example/mirror-schema/${tag}`,
      `A mirrored document (${tag})`,
    ]);
    await tx.query(
      `INSERT INTO claim_instances (id, claim_id, source_id, verbatim_text, stance, origin) VALUES ($1, $2, $3, $4, 'affirms', 'mirror')`,
      [ids.instance, ids.claim, ids.source, `The passage (${tag}).`]
    );
    await tx.query(
      `INSERT INTO arguments (id, claim_id, name, stance, content, created_by, origin) VALUES ($1, $2, $3, 'for', 'It follows.', 'claim_steward', 'mirror')`,
      [ids.argument, ids.claim, `The argument (${tag})`]
    );
    await tx.query(
      `INSERT INTO assessments (id, claim_id, status, confidence, reasoning_trace, origin) VALUES ($1, $2, 'supported', 0.7, $3, 'mirror')`,
      [ids.verdict, ids.claim, `The reasoning (${tag}).`]
    );
  });
});

afterAll(async () => {
  // Leave the shared scratch database without mirrored rows.
  await asApplier(async (tx) => {
    await tx.query(`DELETE FROM claims WHERE id = $1`, [ids.claim]);
    await tx.query(`DELETE FROM sources WHERE id = $1`, [ids.source]);
  });
});

describe("the origin column, in the catalog", () => {
  it("is on the nineteen replicated tables, 'local' by default, and holds one of two values", async () => {
    const columns = await rawQuery<{ table_name: string; column_default: string | null; is_nullable: string; data_type: string }>(
      `SELECT c.table_name, c.column_default, c.is_nullable, c.data_type
         FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'origin' AND t.table_type = 'BASE TABLE'
          AND c.column_default = '''local''::text'`
    );
    expect(columns.map((c) => c.table_name).sort()).toEqual(TABLES);
    for (const column of columns) {
      expect(column, column.table_name).toMatchObject({ is_nullable: "NO", data_type: "text" });
    }
    const checks = await rawQuery<{ table_name: string }>(
      `SELECT conrelid::regclass::text AS table_name FROM pg_constraint
        WHERE contype = 'c' AND conname = 'ck_' || conrelid::regclass::text || '_origin'`
    );
    expect(checks.map((c) => c.table_name).sort()).toEqual(TABLES);
    await expect(rawQuery(`INSERT INTO claims (text, origin) VALUES ('x', 'elsewhere')`)).rejects.toSatisfy(
      (err) => sqlState(err) === "23514"
    );
  });

  it("has three guard triggers on each of those tables, each limited to mirrored rows", async () => {
    const triggers = await rawQuery<{ table_name: string; name: string; when_clause: string }>(
      `SELECT t.tgrelid::regclass::text AS table_name, t.tgname AS name, pg_get_triggerdef(t.oid) AS when_clause
         FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE 'mirror_row_guard_%'`
    );
    expect(triggers.map((t) => `${t.table_name}.${t.name}`).sort()).toEqual(
      TABLES.flatMap((table) => ["delete", "insert", "update"].map((op) => `${table}.mirror_row_guard_${op}`)).sort()
    );
    for (const trigger of triggers) {
      // Never called for a local row: the condition is on the row's origin.
      expect(trigger.when_clause, `${trigger.table_name}.${trigger.name}`).toMatch(/WHEN \(.*origin = 'mirror'/);
      expect(trigger.when_clause).toContain("BEFORE");
    }
  });

  it("is in no view a reader's SQL can reach", async () => {
    const views = await rawQuery<{ view: string }>(
      `SELECT c.table_schema || '.' || c.table_name AS view
         FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         JOIN information_schema.view_column_usage u
           ON u.view_schema = c.table_schema AND u.view_name = c.table_name AND u.column_name = 'origin'
          AND u.table_name = ANY($1::text[])
        WHERE c.column_name = 'origin' AND t.table_type = 'VIEW'
        GROUP BY 1`,
      [TABLES]
    );
    // The four views of the judgment in force carry every column of their
    // table and are the app's own; query_sql reads the public_read views,
    // which name their columns.
    expect(views.map((v) => v.view).sort()).toEqual([
      "public.argument_evaluations_in_force",
      "public.assessments_in_force",
      "public.quantity_estimates_in_force",
      "public.question_assessments_in_force",
    ]);
  });
});

describe("a local row", () => {
  it("is what every write makes, and is written, changed and deleted as before", async () => {
    const id = await seedClaim(`mirror-schema local ${tag}`);
    const [row] = await rawQuery<{ origin: string }>(`SELECT origin FROM claims WHERE id = $1`, [id]);
    expect(row!.origin).toBe("local");
    await rawQuery(`UPDATE claims SET text = text || ' (edited)', importance = 0.9, steward_state = 'done' WHERE id = $1`, [id]);
    const [source] = await rawQuery<{ id: string; origin: string }>(
      `INSERT INTO sources (title) VALUES ($1) RETURNING id, origin`,
      [`mirror-schema local source ${tag}`]
    );
    expect(source!.origin).toBe("local");
    await rawQuery(`DELETE FROM sources WHERE id = $1`, [source!.id]);
    await rawQuery(`DELETE FROM claims WHERE id = $1`, [id]);
    expect(await rawQuery(`SELECT 1 FROM claims WHERE id = $1`, [id])).toEqual([]);
  });

  it("cannot be turned into a mirrored one", async () => {
    const id = await seedClaim(`mirror-schema stays local ${tag}`);
    await expect(rawQuery(`UPDATE claims SET origin = 'mirror' WHERE id = $1`, [id])).rejects.toSatisfy(
      (err) => sqlState(err) === GUARD
    );
  });
});

describe("a mirrored row", () => {
  it("cannot be inserted by anything but the applier", async () => {
    for (const [table, columns, values] of [
      ["claims", "text", "'a forged mirror row'"],
      ["sources", "title", "'a forged mirror source'"],
    ] as const) {
      await expect(rawQuery(`INSERT INTO ${table} (${columns}, origin) VALUES (${values}, 'mirror')`)).rejects.toSatisfy(
        (err) => sqlState(err) === GUARD && /can be written to ".*" only by the mirror's applier/.test((err as Error).message)
      );
    }
  });

  it("lets a deployment move its own queue state on a mirrored claim", async () => {
    await rawQuery(
      `UPDATE claims
          SET steward_state = 'pending', steward_trigger = 'funded', queue_priority = 0.8, stewarded_at = now(),
              steward_requeued = true, steward_attempts = 1, steward_error = 'x', steward_error_reason = 'y',
              tagged_at = NULL, tagging_leased_at = now(), tagging_attempts = 2, updated_at = now()
        WHERE id = $1`,
      [ids.claim]
    );
    const [row] = await rawQuery<{ steward_state: string; tagging_attempts: number }>(
      `SELECT steward_state, tagging_attempts FROM claims WHERE id = $1`,
      [ids.claim]
    );
    expect(row).toEqual({ steward_state: "pending", tagging_attempts: 2 });
    // Writing a replicated column its own value changes nothing, so it passes.
    await rawQuery(`UPDATE claims SET text = text, steward_state = 'deferred', tagged_at = now() WHERE id = $1`, [ids.claim]);
  });

  it("refuses a change to anything the feed carries, and names what was changed", async () => {
    const changes: Array<[string, string, string]> = [
      ["claims", `text = 'our wording', importance = 0.1`, "importance, text"],
      ["claims", `state = 'archived'`, "state"],
      ["claims", `merged_into = id`, "merged_into"],
      ["claims", `embedding = NULL, domains = '{x}'`, "domains"],
      ["sources", `title = 'our title'`, "title"],
      ["sources", `raw_content = 'our text', sensitivity_label = 'public'`, "raw_content"],
      ["claim_instances", `stance = 'denies'`, "stance"],
      ["claim_instances", `detached_at = now(), detached_reason = 'ours', detached_by = 'us'`, "detached_at, detached_by, detached_reason"],
      ["arguments", `retired_at = now()`, "retired_at"],
      ["assessments", `is_current = false`, "is_current"],
      ["assessments", `status = 'verified', confidence = 1`, "confidence, status"],
    ];
    const idOf: Record<string, string> = {
      claims: ids.claim,
      sources: ids.source,
      claim_instances: ids.instance,
      arguments: ids.argument,
      assessments: ids.verdict,
    };
    for (const [table, set, named] of changes) {
      await expect(rawQuery(`UPDATE ${table} SET ${set} WHERE id = $1`, [idOf[table]]), `${table}: ${set}`).rejects.toSatisfy(
        (err) =>
          sqlState(err) === GUARD &&
          (err as Error).message ===
            `this row of "${table}" is mirrored from the public graph, and only the mirror's applier may change: ${named}`
      );
    }
    // A change of its label is refused like any other.
    await rawQuery(`INSERT INTO labels (name, description) VALUES ('mirror-schema-second', 'A second label.') ON CONFLICT DO NOTHING`);
    await expect(
      rawQuery(`UPDATE sources SET sensitivity_label = 'mirror-schema-second' WHERE id = $1`, [ids.source])
    ).rejects.toSatisfy((err) => sqlState(err) === GUARD);
    await rawQuery(`DELETE FROM labels WHERE name = 'mirror-schema-second'`);
  });

  it("cannot be made local, or deleted, by anything but the applier", async () => {
    await expect(rawQuery(`UPDATE claims SET origin = 'local' WHERE id = $1`, [ids.claim])).rejects.toSatisfy(
      (err) => sqlState(err) === GUARD && /the origin of a row of "claims" cannot be changed/.test((err as Error).message)
    );
    for (const [table, id] of [["assessments", ids.verdict], ["claim_instances", ids.instance], ["claims", ids.claim], ["sources", ids.source]]) {
      await expect(rawQuery(`DELETE FROM ${table} WHERE id = $1`, [id]), table).rejects.toSatisfy(
        (err) => sqlState(err) === GUARD && /can be deleted only by the mirror's applier/.test((err as Error).message)
      );
    }
    // Still there, unchanged.
    const [row] = await rawQuery<{ text: string; origin: string }>(`SELECT text, origin FROM claims WHERE id = $1`, [ids.claim]);
    expect(row).toEqual({ text: `A mirrored claim (${tag})`, origin: "mirror" });
  });

  it("is the applier's to write, for the length of its transaction and no longer", async () => {
    await asApplier(async (tx) => {
      await tx.query(`UPDATE claims SET importance = 0.25 WHERE id = $1`, [ids.claim]);
    });
    const [row] = await rawQuery<{ importance: number }>(`SELECT importance FROM claims WHERE id = $1`, [ids.claim]);
    expect(row!.importance).toBeCloseTo(0.25);
    // The setting ended with the transaction: the same pool is guarded again.
    for (let i = 0; i < 25; i++) {
      await expect(rawQuery(`UPDATE claims SET importance = 0.5 WHERE id = $1`, [ids.claim])).rejects.toSatisfy(
        (err) => sqlState(err) === GUARD
      );
    }
  });
});

describe("what a reader is shown", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildApp } = await import("../../src/server/app.js");
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  /** The column by name, or its one distinctive value as a JSON string. */
  const carriesIt = (text: string) => /"origin"/.test(text) || text.includes(`"mirror"`);

  it("has no response of the busiest claim, argument and source routes that carries the column", async () => {
    const routes: Array<[string, string]> = [
      [`/claims/${ids.claim}?information_depth=cursory`, tag],
      [`/claims/${ids.claim}?information_depth=standard`, tag],
      [`/claims/${ids.claim}?information_depth=deep`, ids.argument],
      [`/claims/${ids.claim}/assessments`, ids.verdict],
      [`/claims/${ids.claim}/events`, ids.claim],
      [`/claims/${ids.claim}/provenance`, ids.claim],
      [`/claims/${ids.claim}/card`, tag],
      [`/arguments/${ids.argument}`, tag],
      [`/sources/${ids.source}`, tag],
    ];
    for (const [url, shows] of routes) {
      const res = await app.inject({ method: "GET", url });
      // The check means something only if the route answered with the row.
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain(shows);
      expect(carriesIt(res.body), url).toBe(false);
    }
  });

  it("has no claim view, and no agent's read of a claim, that carries it", async () => {
    const reads: Array<[string, string]> = [
      ["the claim view", JSON.stringify(await getClaimView(ids.claim, { include: [...CLAIM_VIEW_INCLUDES] }))],
      ["get_claim", (await executeGraphReadTool("get_claim", { claim_id: ids.claim, include: [...CLAIM_VIEW_INCLUDES] }))!],
    ];
    for (const [read, out] of reads) {
      expect(out, read).toContain(ids.argument);
      expect(carriesIt(out), read).toBe(false);
    }
  });
});
