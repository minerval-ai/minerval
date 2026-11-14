/**
 * Reads and writes held to a clearance, in the database (src/db/clearance.ts).
 *
 * A deployment with labels `public`, `enf-a`, `enf-b` and `enf-c`, where
 * `enf-a` and `enf-b` read `public`, `enf-c` reads `enf-a` and `public`,
 * and `enf-a` and `enf-b` do not read each other. The tests try to cross
 * the wall from each side: a read with no filter, a write at a label the
 * work does not read, an insert that forgot its stamp, a collision with a
 * row that cannot be seen, read-only SQL that sets its own settings.
 *
 * The rest of the suite reads and seeds as the tables' owner (tests/db/
 * setup.ts). This file does not: work with nothing in context is what it is
 * in a deployment, a connection that reads `public` alone, and everything
 * that must see more says so with withSystemClearance.
 */
import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { getDb, rawQuery, readsAreHeld, searchableClaims, withTransaction } from "../../src/db/client.js";
import {
  CLEARED_ROLE,
  ClearanceError,
  clearedRolePassword,
  isUnseenCollision,
  setNoContextSessionForTests,
  withSystemClearance,
} from "../../src/db/clearance.js";
import { armEnforcement, enforcementFacts, enforcementProblems, ensureEnforcement } from "../../src/db/enforcement.js";
import { claims } from "../../src/db/schema.js";
import { registerErrorHandler } from "../../src/server/plugins/error-handler.js";
import { loadConfig } from "../../src/config.js";
import { PUBLIC_LABEL } from "../../src/labels.js";
import { currentLabel, runAtLabel, runWithUsageContext, untraced, withAgent } from "../../src/llm/usage-context.js";
import { LABEL_ON_REOPEN_SQL } from "../../src/services/action-service.js";
import { groupAtLabel } from "../../src/services/ingest-focus-service.js";
import { labelsReadableFrom } from "../../src/services/permission-service.js";
import { keywordClaimSearch } from "../../src/services/search-service.js";
import { runReadOnlyQuery, sqlClearanceToken } from "../../src/services/sql-service.js";
import { TEST_DATABASE_URL } from "./urls.js";
import { readViewsAs } from "./helpers.js";

const A = "enf-a";
const B = "enf-b";
const C = "enf-c";
const ALL = [A, B, C, PUBLIC_LABEL];

const system = <T>(fn: () => Promise<T>) => withSystemClearance("A test seeds and checks rows at every label.", fn);
const at = <T>(label: string, fn: () => Promise<T>) => runAtLabel(label, "an enforcement test", fn);
const sorted = (labels: string[]) => [...labels].sort();
const sqlState = (err: unknown) => (err as { code?: string } | null)?.code;

/** Each way work reads, with the labels it should see. */
const READERS: Array<{ name: string; sees: string[]; read: <T>(fn: () => Promise<T>) => Promise<T> }> = [
  { name: "nothing in context", sees: [PUBLIC_LABEL], read: (fn) => fn() },
  { name: `a run at ${A}`, sees: [A, PUBLIC_LABEL], read: (fn) => at(A, fn) },
  { name: `a run at ${B}`, sees: [B, PUBLIC_LABEL], read: (fn) => at(B, fn) },
  { name: `a run at ${C}`, sees: [A, C, PUBLIC_LABEL], read: (fn) => at(C, fn) },
  { name: "a run at public", sees: [PUBLIC_LABEL], read: (fn) => at(PUBLIC_LABEL, fn) },
  {
    name: `a request cleared for ${A} and ${B}`,
    sees: [A, B, PUBLIC_LABEL],
    read: (fn) => runWithUsageContext({ clearance: [PUBLIC_LABEL, A, B] }, fn),
  },
  { name: "system work", sees: ALL, read: (fn) => system(fn) },
];

/** One claim at each label, with a word of its own to search for. */
const word = `enf${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const claimIds: Record<string, string> = {};

beforeAll(async () => {
  setNoContextSessionForTests(null);
  await system(async () => {
    await rawQuery(
      `INSERT INTO labels (name, description)
       VALUES ($1, 'One partner.'), ($2, 'Another partner.'), ($3, 'Reads the first partner.')
       ON CONFLICT (name) DO NOTHING`,
      [A, B, C]
    );
    await rawQuery(
      `INSERT INTO label_reads (label, reads) VALUES ($1, 'public'), ($2, 'public'), ($3, $1), ($3, 'public')
       ON CONFLICT DO NOTHING`,
      [A, B, C]
    );
  });
  await ensureEnforcement();
  await system(async () => {
    for (const label of ALL) {
      const [row] = await rawQuery<{ id: string }>(
        `INSERT INTO claims (text, steward_state, tagged_at, sensitivity_label)
         VALUES ($1, 'done', now(), $2) RETURNING id`,
        [`Enforcement claim at ${label} about ${word} ${randomUUID()}`, label]
      );
      claimIds[label] = row!.id;
    }
  });
});

afterAll(async () => {
  // Leave the database as it was found: no rows, pairs or labels of this file.
  await system(async () => {
    await rawQuery(`DELETE FROM claims WHERE id = ANY($1::uuid[])`, [Object.values(claimIds)]);
    // What this file's rows at these labels left in the record of changes (an argument added, a node reworded):
    // history with no key to the node, so it does not go with the node.
    await rawQuery(`DELETE FROM node_changes WHERE sensitivity_label = ANY($1::text[])`, [[A, B, C]]);
    await rawQuery(`DELETE FROM label_reads WHERE label = ANY($1::text[])`, [[A, B, C]]);
    await rawQuery(`DELETE FROM labels WHERE name = ANY($1::text[])`, [[A, B, C]]);
  });
});

// ---------------------------------------------------------------------------

describe("the switch", () => {
  // Recorded by the suite's setup on the database as migrations left it,
  // the one moment it is known to hold `public` alone (global-setup.ts).
  const recorded = inject("enforcementSwitch");

  it("is off where public is the only label: no table has row-level security and no policy exists", () => {
    expect(recorded.before.labelled.length).toBeGreaterThan(90);
    expect(recorded.before.secured).toEqual([]);
    expect(recorded.before.policies).toBe(0);
    expect(recorded.before.guards).toBe(0);
  });

  it("turns on when a second label is defined, in the same transaction, on every labelled table", () => {
    expect(recorded.during.secured).toEqual(recorded.during.labelled);
    // Three policies a table: what a cleared connection reads and changes,
    // what it may add, and what read-only SQL is shown.
    expect(recorded.during.policies).toBe(recorded.during.labelled.length * 3);
    // The four tables that hold judgments in force.
    expect(recorded.during.guards).toBe(4);
  });

  it("turns off when the last one is removed", () => {
    expect(recorded.after.secured).toEqual([]);
    expect(recorded.after.policies).toBe(0);
    expect(recorded.after.guards).toBe(0);
  });

  it("is one step that changes nothing when everything is already right", async () => {
    expect((await ensureEnforcement()).changes).toEqual([]);
    // Arming is for the moment before the first private label: it returns at once now.
    const started = Date.now();
    await armEnforcement();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("covers a table added later, without its author doing anything", async () => {
    const table = `enf_later_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    await system(() =>
      rawQuery(
        `CREATE TABLE ${table} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note text,
           sensitivity_label text NOT NULL DEFAULT minerval_default_label() REFERENCES labels(name))`
      )
    );
    try {
      // Before the step runs the table is not granted, so it cannot be read unfiltered.
      await expect(rawQuery(`SELECT * FROM ${table}`)).rejects.toSatisfy((err) => sqlState(err) === "42501");
      expect((await enforcementFacts()).uncoveredTables).toEqual([table]);
      const { changes } = await ensureEnforcement();
      expect(changes).toEqual([`+ ${table}: row-level security on`, `+ ${table}: granted to ${CLEARED_ROLE}`]);
      await system(() => rawQuery(`INSERT INTO ${table} (note, sensitivity_label) VALUES ('p', 'public'), ('a', $1)`, [A]));
      expect((await rawQuery<{ note: string }>(`SELECT note FROM ${table}`)).map((r) => r.note)).toEqual(["p"]);
      expect(sorted((await at(A, () => rawQuery<{ note: string }>(`SELECT note FROM ${table}`))).map((r) => r.note))).toEqual(["a", "p"]);
    } finally {
      await system(() => rawQuery(`DROP TABLE ${table}`));
    }
  });
});

// ---------------------------------------------------------------------------

describe("the catalog, with a second label defined", () => {
  it("has every labelled table covered, every view reading as its caller, and a cleared role that is bound", async () => {
    const facts = await enforcementFacts();
    expect(facts.on).toBe(true);
    expect(facts.labels).toEqual(expect.arrayContaining(ALL));
    // The schema's ninety-nine (tests/db/label-columns.test.ts lists them).
    expect(facts.labelledTables.length).toBe(144);
    expect(facts.uncoveredTables).toEqual([]);
    expect(facts.viewsReadingAsOwner).toEqual([]);
    expect(facts.sqlViewsUnheld).toEqual([]);
    expect(facts.outsideTheStep).toEqual([]);
    expect(facts.temporaryTablesOpen).toBe(false);
    expect(facts.cleared).toEqual({
      exists: true,
      canLogIn: true,
      superuser: false,
      bypassesRowSecurity: false,
      ownsTables: [],
      memberOf: [],
    });
    expect(facts.liveConnection).toEqual({ role: CLEARED_ROLE, seesBeyondPublic: false });
    expect(enforcementProblems(facts)).toEqual([]);
  });

  it("says what is wrong when something is", () => {
    const sound = {
      on: true,
      labels: [A, PUBLIC_LABEL],
      labelledTables: ["claims"],
      uncoveredTables: [],
      viewsReadingAsOwner: [],
      sqlViewsUnheld: [],
      outsideTheStep: [],
      temporaryTablesOpen: false,
      owner: { role: "owner", superuser: false, bypassesRowSecurity: false },
      cleared: { exists: true, canLogIn: true, superuser: false, bypassesRowSecurity: false, ownsTables: [], memberOf: [] },
      liveConnection: { role: CLEARED_ROLE, seesBeyondPublic: false },
    };
    expect(enforcementProblems(sound)).toEqual([]);
    // Nothing to hold on the public graph.
    expect(enforcementProblems({ ...sound, on: false, labels: [PUBLIC_LABEL], liveConnection: null })).toEqual([]);
    expect(enforcementProblems({ ...sound, on: false, liveConnection: null })).toHaveLength(1);
    expect(enforcementProblems({ ...sound, uncoveredTables: ["claims"] })[0]).toContain("claims");
    expect(enforcementProblems({ ...sound, cleared: { ...sound.cleared, superuser: true } })).toHaveLength(1);
    expect(enforcementProblems({ ...sound, cleared: { ...sound.cleared, bypassesRowSecurity: true } })).toHaveLength(1);
    expect(enforcementProblems({ ...sound, cleared: { ...sound.cleared, ownsTables: ["claims"] } })).toHaveLength(1);
    expect(enforcementProblems({ ...sound, cleared: { ...sound.cleared, memberOf: ["owner"] } })).toHaveLength(1);
    expect(enforcementProblems({ ...sound, liveConnection: { role: "owner", seesBeyondPublic: true } })).toHaveLength(2);
    expect(enforcementProblems({ ...sound, liveConnection: { error: "no login" } })).toHaveLength(1);
    expect(enforcementProblems({ ...sound, outsideTheStep: ["materialized view public.digest"] })[0]).toContain("public.digest");
    expect(enforcementProblems({ ...sound, temporaryTablesOpen: true })[0]).toContain("REVOKE TEMPORARY");
  });

  it("reports a materialized view, and a labelled table outside public, which the step does not cover", async () => {
    // A materialized view is a copy of rows taken as its owner: no policy
    // applies to it, and a grant on it would show every label. A labelled
    // table in another schema is not one the step looks at.
    await system(async () => {
      await rawQuery(`CREATE MATERIALIZED VIEW public.enf_claim_digest AS SELECT id, text, sensitivity_label FROM claims`);
      await rawQuery(`CREATE SCHEMA enf_other`);
      await rawQuery(
        `CREATE TABLE enf_other.notes (id int, body text,
           sensitivity_label text NOT NULL DEFAULT minerval_default_label() REFERENCES labels(name))`
      );
    });
    try {
      const facts = await enforcementFacts();
      expect(facts.outsideTheStep).toEqual(["materialized view public.enf_claim_digest", "table enf_other.notes"]);
      expect(enforcementProblems(facts)).toHaveLength(1);
      expect(enforcementProblems(facts)[0]).toMatch(/no policy reaches them/);
    } finally {
      await system(async () => {
        await rawQuery(`DROP MATERIALIZED VIEW public.enf_claim_digest`);
        await rawQuery(`DROP SCHEMA enf_other CASCADE`);
      });
    }
    expect((await enforcementFacts()).outsideTheStep).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

/**
 * A row at each label in every labelled table, written from the catalog so
 * that a table added later is covered without a test of its own.
 *
 * The rows are not meaningful: each required column gets a value of its
 * type, and their foreign keys are not checked while they are there. A
 * superuser (the suite's role locally and in CI) turns the checks off while
 * it writes (session_replication_role). A plain owner cannot, so it takes
 * the labelled tables' keys away for the length of this block and puts
 * them back when the rows are gone: `npm run test:db:owner` runs this file
 * that way, as a deployment's owner is on a managed Postgres. What is under
 * test is the one thing every such row has: a label.
 */
describe("every labelled table", () => {
  interface Column {
    name: string;
    type: string;
    required: boolean;
    literals: string[];
  }
  const written = new Map<string, string[]>();
  const unwritable: string[] = [];
  let owner: pg.Client;
  let superuser = true;
  /** The keys a plain owner took away, to put back. */
  let setAside: Array<{ on_table: string; conname: string; def: string }> = [];

  /** Stop checking the labelled tables' foreign keys (all but the one to labels), or start again. */
  async function foreignKeys(checked: boolean): Promise<void> {
    if (superuser) {
      await owner.query(`SET session_replication_role = ${checked ? "origin" : "replica"}`);
      return;
    }
    if (checked) {
      for (const k of setAside) await owner.query(`ALTER TABLE ${k.on_table} ADD CONSTRAINT "${k.conname}" ${k.def}`);
      setAside = [];
      return;
    }
    const keys = await owner.query<{ on_table: string; conname: string; def: string }>(
      `SELECT k.conrelid::regclass::text AS on_table, k.conname::text AS conname, pg_get_constraintdef(k.oid) AS def
         FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid
        WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace
          AND k.confrelid <> 'public.labels'::regclass
          AND EXISTS (SELECT 1 FROM pg_attribute l
                       WHERE l.attrelid = c.oid AND l.attname = 'sensitivity_label' AND NOT l.attisdropped)
        ORDER BY 1, 2`
    );
    for (const k of keys.rows) await owner.query(`ALTER TABLE ${k.on_table} DROP CONSTRAINT "${k.conname}"`);
    setAside = keys.rows;
  }

  /**
   * What a CHECK across several columns needs, for the tables that have
   * one a row of bare required values does not meet. A table added with
   * such a constraint fails "can be given a row" until it is listed here.
   */
  const ALSO: Record<string, Record<string, string>> = {
    // The body is in the row or in storage.
    attachments: { storage: "'db'", body: "'enf'" },
    // Money placed by a mandate or by a person, one of the two.
    action_allocations: { grant_id: "gen_random_uuid()" },
    // About a node or about a source, one of the two.
    request_targets: { claim_id: "gen_random_uuid()" },
    // Taken up from the public graph's request or from one at a label read, one of the two.
    adopted_requests: { from_request_id: "gen_random_uuid()" },
    // A face stands for a label other than the one it is shown at, and that label is defined.
    label_faces: { for_label: "(SELECT name FROM labels WHERE name <> $1 ORDER BY name LIMIT 1)" },
    argument_instances: { argument_id: "gen_random_uuid()" },
    // Kept by a Steward exactly when it names the node.
    requests: { keeper_kind: "'steward'", keeper_claim_id: "gen_random_uuid()" },
    // A source is an input by its id alone.
    judgment_inputs: { input_kind: "'source'", source_id: "gen_random_uuid()" },
    // Shown to a label or outside, one of the two; and a flow for one node names the node.
    showings: { to_outside: "true", node_id: "gen_random_uuid()" },
    // An item that is not a node's page says what it was composed from.
    showing_pages: { version_key: "'enf'" },
    // A removal is a span with an end after its start.
    showing_removals: { end_offset: "2" },
    // The page's side of a policy names the label pages are written at.
    redaction_policies: { from_label: "'public'" },
    // A label's own importance is held over a node.
    overlays: { kind: "'importance'", target_table: "'claims'" },
  };

  /** The value for one required column. `row` and `position` make a row's ids ascend by column. */
  function valueFor(column: Column, row: string, position: number): string {
    const t = column.type;
    if (column.literals.length > 0 && (t === "text" || t.startsWith("character"))) {
      return `'${column.literals[0]!.replace(/'/g, "''")}'`;
    }
    // Two tables hold a pair of nodes in order (claim_a_id < claim_b_id), so
    // the ids of one row share a random head and count up by column.
    if (t === "uuid") return `'${row}-0000-4000-8000-${String(position).padStart(12, "0")}'::uuid`;
    if (t === "text" || t.startsWith("character")) return `'enf-' || gen_random_uuid()::text`;
    if (t === "integer" || t === "bigint" || t === "smallint") return "1";
    if (t === "real" || t === "double precision" || t.startsWith("numeric")) return "0.5";
    if (t === "boolean") return "false";
    if (t.startsWith("timestamp")) return "now()";
    if (t === "date") return "current_date";
    if (t === "jsonb" || t === "json") return `'{}'::${t}`;
    if (t.endsWith("[]")) return `'{}'::${t}`;
    if (t === "tsvector") return `''::tsvector`;
    const vector = /^vector\((\d+)\)$/.exec(t);
    if (vector) return `array_fill(0, ARRAY[${vector[1]}])::vector`;
    throw new Error(`no test value for a column of type ${t}`);
  }

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await owner.connect();
    const [role] = (await owner.query<{ is_superuser: string }>(`SHOW is_superuser`)).rows;
    superuser = role!.is_superuser === "on";

    const columns = await owner.query<{ table_name: string; name: string; type: string; required: boolean; literals: string[] | null }>(
      `SELECT c.relname::text AS table_name, a.attname::text AS name,
              format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AND NOT a.atthasdef AND a.attgenerated = '' AND a.attidentity = '' AS required,
              -- The values a CHECK on the column allows, where it lists them.
              (SELECT array_agg(m[1])
                 FROM pg_constraint k,
                      LATERAL regexp_matches(pg_get_constraintdef(k.oid), '''([^'']*)''::text', 'g') AS m
                WHERE k.conrelid = c.oid AND k.contype = 'c' AND k.conkey = ARRAY[a.attnum]) AS literals
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM pg_attribute l
                       WHERE l.attrelid = c.oid AND l.attname = 'sensitivity_label' AND NOT l.attisdropped)
        ORDER BY c.relname, a.attnum`
    );
    const byTable = new Map<string, Column[]>();
    for (const row of columns.rows) {
      const list = byTable.get(row.table_name) ?? [];
      list.push({ name: row.name, type: row.type, required: row.required, literals: row.literals ?? [] });
      byTable.set(row.table_name, list);
    }

    await foreignKeys(false);
    for (const [table, cols] of byTable) {
      const also = ALSO[table] ?? {};
      const required = cols.filter((c) => c.required && c.name !== "sensitivity_label" && !(c.name in also));
      const names = [...required.map((c) => `"${c.name}"`), ...Object.keys(also).map((n) => `"${n}"`), "sensitivity_label"].join(", ");
      const ctids: string[] = [];
      try {
        for (const label of ALL) {
          const row = randomUUID().slice(0, 8);
          const values = [...required.map((c, i) => valueFor(c, row, i)), ...Object.values(also), "$1"].join(", ");
          const res = await owner.query<{ ctid: string }>(
            `INSERT INTO "${table}" (${names}) VALUES (${values}) RETURNING ctid::text`,
            [label]
          );
          ctids.push(res.rows[0]!.ctid);
        }
        written.set(table, ctids);
      } catch (err) {
        unwritable.push(`${table}: ${err instanceof Error ? err.message : String(err)}`);
        if (ctids.length > 0) await owner.query(`DELETE FROM "${table}" WHERE ctid = ANY($1::tid[])`, [ctids]);
      }
    }
    // A superuser checks them again now; the rows are its to leave. A plain
    // owner's keys stay away until the rows are gone.
    if (superuser) await foreignKeys(true);
  }, 240_000);

  afterAll(async () => {
    if (superuser) await foreignKeys(false);
    for (const [table, ctids] of written) {
      await owner.query(`DELETE FROM "${table}" WHERE ctid = ANY($1::tid[])`, [ctids]);
    }
    await foreignKeys(true);
    await owner.end();
  }, 240_000);

  it("can be given a row at each label by this test", () => {
    // A table here needs a value this test does not know how to make: teach valueFor.
    expect(unwritable).toEqual([]);
    expect(written.size).toBe(144);
  });

  for (const reader of READERS) {
    it(`shows ${reader.name} the rows at ${sorted(reader.sees).join(", ")} and no others`, async () => {
      const wrong: string[] = [];
      for (const [table, ctids] of written) {
        const rows = await reader.read(() =>
          rawQuery<{ sensitivity_label: string }>(
            `SELECT sensitivity_label FROM "${table}" WHERE ctid = ANY($1::tid[])`,
            [ctids]
          )
        );
        const seen = sorted(rows.map((r) => r.sensitivity_label));
        if (JSON.stringify(seen) !== JSON.stringify(sorted(reader.sees))) wrong.push(`${table}: ${seen.join(", ")}`);
      }
      expect(wrong).toEqual([]);
    });
  }

  it("lets a run change only the rows at its own label, and refuses a change to one it reads at another", async () => {
    // An UPDATE reaches what the clearance reaches and nothing else, and of
    // those it changes only the rows at the run's own label. It is rolled
    // back, so the rows stay as the other tests expect them.
    const rollback = new Error("rolled back by the test");
    const wrong: string[] = [];
    for (const [table, ctids] of written) {
      let touched: string[] = [];
      await at(A, () =>
        withTransaction(async (tx) => {
          // Its own label's rows change. The statement names no label but
          // the run's own: a row at B or C is not there for it at all.
          const rows = await tx.query<{ sensitivity_label: string }>(
            `UPDATE "${table}" SET sensitivity_label = sensitivity_label
              WHERE ctid = ANY($1::tid[]) AND sensitivity_label <> 'public' RETURNING sensitivity_label`,
            [ctids]
          );
          touched = sorted(rows.map((r) => r.sensitivity_label));
          // A row it reads at another label is not its to change, and the
          // refusal says so (the own_label_guard, MVL06).
          const refused = await tx
            .query(
              `UPDATE "${table}" SET sensitivity_label = sensitivity_label WHERE ctid = ANY($1::tid[]) AND sensitivity_label = 'public'`,
              [ctids]
            )
            .then(
              () => "changed",
              (e: unknown) => (e as { code?: string }).code ?? String(e)
            );
          touched.push(refused);
          throw rollback;
        })
      ).catch((err: unknown) => {
        if (err !== rollback) touched = [`error: ${err instanceof Error ? err.message : String(err)}`];
      });
      // The two tables that hold money let settlement through: an update
      // that changes nothing but an amount, as this one changes nothing at
      // all, is allowed on another label's row (the money views' rule).
      const other = table === "action_allocations" || table === "regrants" ? "changed" : "MVL06";
      if (JSON.stringify(touched) !== JSON.stringify([A, other])) wrong.push(`${table}: ${touched.join(", ")}`);
    }
    expect(wrong).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("a read", () => {
  const seen = async (query: () => Promise<Array<{ sensitivity_label: string }>>) =>
    sorted((await query()).map((r) => r.sensitivity_label));
  const bare = () =>
    rawQuery<{ sensitivity_label: string }>(`SELECT * FROM claims WHERE id = ANY($1::uuid[])`, [Object.values(claimIds)]);

  it("that forgets every filter returns only what the clearance allows", async () => {
    for (const reader of READERS) {
      expect(await reader.read(() => seen(bare)), reader.name).toEqual(sorted(reader.sees));
    }
    // And a count over the whole table differs by exactly the rows withheld.
    const total = (label: string) => at(label, async () => (await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM claims`))[0]!.n);
    const all = await system(async () => (await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM claims`))[0]!.n);
    const hiddenFrom = async (label: string, reads: string[]) =>
      system(async () => (await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM claims WHERE sensitivity_label <> ALL($1::text[])`, [reads]))[0]!.n);
    expect(await total(A)).toBe(all - (await hiddenFrom(A, [A, PUBLIC_LABEL])));
    expect(await total(C)).toBe(all - (await hiddenFrom(C, [A, C, PUBLIC_LABEL])));
  });

  it("is held the same through the query builder, a transaction and a view", async () => {
    const ids = Object.values(claimIds);
    // The builder is handed back unrun: it runs at the label it was made
    // under all the same (runAtLabel starts it before returning).
    const drizzled = await at(C, () =>
      getDb().select({ sensitivity_label: claims.sensitivityLabel }).from(claims).where(sql`${claims.id} = ANY(${sql.raw(`'{${ids.join(",")}}'::uuid[]`)})`)
    );
    expect(sorted(drizzled.map((r) => r.sensitivity_label))).toEqual([A, C, PUBLIC_LABEL]);
    const inTransaction = await at(B, () =>
      withTransaction((tx) => tx.query<{ sensitivity_label: string }>(`SELECT sensitivity_label FROM claims WHERE id = ANY($1::uuid[])`, [ids]))
    );
    expect(sorted(inTransaction.map((r) => r.sensitivity_label))).toEqual([B, PUBLIC_LABEL]);
    // A view in public reads its tables as its caller, so the judgment in
    // force of a node the reader cannot see is not there either.
    const [assessment] = await system(() =>
      rawQuery<{ id: string }>(
        `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current, sensitivity_label)
         VALUES ($1, 'supported', 0.7, 'Reasons.', true, $2) RETURNING id`,
        [claimIds[A], A]
      )
    );
    try {
      const inForce = () => rawQuery(`SELECT id FROM assessments_in_force WHERE id = $1`, [assessment!.id]);
      expect(await inForce()).toEqual([]);
      expect(await at(B, inForce)).toEqual([]);
      expect(await at(A, inForce)).toHaveLength(1);
      expect(await at(C, inForce)).toHaveLength(1);
    } finally {
      await system(() => rawQuery(`DELETE FROM assessments WHERE id = $1`, [assessment!.id]));
    }
  });

  it("is of what both read, for a run at a label acting for a person", async () => {
    const reads = (context: { label?: string; clearance?: string[] }) => runWithUsageContext(context, () => seen(bare));
    expect(await reads({ label: C, clearance: [PUBLIC_LABEL, B] })).toEqual([PUBLIC_LABEL]);
    expect(await reads({ label: C, clearance: [PUBLIC_LABEL, A, B] })).toEqual(sorted([A, PUBLIC_LABEL]));
    expect(await reads({ label: PUBLIC_LABEL, clearance: [PUBLIC_LABEL, A, B, C] })).toEqual([PUBLIC_LABEL]);
  });

  it("by an agent's run is never at system clearance, and never at the clearance of the request that started it", async () => {
    // Untraced, so that the runs leave no log rows at this file's labels behind.
    const run = <T>(fn: () => Promise<T>) => untraced(() => withAgent("enforcement-test", fn));
    // Opened under system clearance, with no label: the run works at public.
    const underSystem = await system(() => run(async () => ({ label: currentLabel(), seen: await seen(bare) })));
    expect(underSystem).toEqual({ label: PUBLIC_LABEL, seen: [PUBLIC_LABEL] });
    // Opened inside a request cleared for more: the same.
    const inRequest = await runWithUsageContext({ clearance: [PUBLIC_LABEL, A, B, C] }, () => run(() => seen(bare)));
    expect(inRequest).toEqual([PUBLIC_LABEL]);
    // Opened at a label: that label's reads.
    expect(await system(() => at(C, () => run(() => seen(bare))))).toEqual(sorted([A, C, PUBLIC_LABEL]));
  });

  it("follows label_reads as it stands: one definition for runs and for people, and a removed pair stops being read", async () => {
    expect(await labelsReadableFrom([C])).toEqual(sorted([A, C, PUBLIC_LABEL]));
    expect(await labelsReadableFrom([A, B])).toEqual(sorted([A, B, PUBLIC_LABEL]));
    // A run reads public with no pair saying so, as a person does.
    const lone = `enf-lone-${randomUUID().slice(0, 6)}`;
    await system(() => rawQuery(`INSERT INTO labels (name, description) VALUES ($1, 'Reads nothing by any pair.')`, [lone]));
    expect(await at(lone, () => seen(bare))).toEqual([PUBLIC_LABEL]);
    await system(() => rawQuery(`DELETE FROM labels WHERE name = $1`, [lone]));
    // Take the pair away: the run at C no longer reads A. The change is this
    // process's own, so it is not behind it.
    await system(() => rawQuery(`DELETE FROM label_reads WHERE label = $1 AND reads = $2`, [C, A]));
    try {
      expect(await at(C, () => seen(bare))).toEqual(sorted([C, PUBLIC_LABEL]));
    } finally {
      await system(() => rawQuery(`INSERT INTO label_reads (label, reads) VALUES ($1, $2)`, [C, A]));
    }
    expect(await at(C, () => seen(bare))).toEqual(sorted([A, C, PUBLIC_LABEL]));
  });
});

// ---------------------------------------------------------------------------

describe("a write", () => {
  const insertAt = (label: string | null) =>
    rawQuery<{ id: string; sensitivity_label: string }>(
      label === null
        ? `INSERT INTO claims (text) VALUES ($1) RETURNING id, sensitivity_label`
        : `INSERT INTO claims (text, sensitivity_label) VALUES ($1, $2) RETURNING id, sensitivity_label`,
      label === null ? [`Enforcement write ${randomUUID()}`] : [`Enforcement write ${randomUUID()}`, label]
    );
  const cleanup: string[] = [];
  afterAll(() => system(() => rawQuery(`DELETE FROM claims WHERE id = ANY($1::uuid[])`, [cleanup])));

  it("that forgot its stamp lands at the run's label", async () => {
    for (const label of [A, C, PUBLIC_LABEL]) {
      const [row] = await at(label, () => insertAt(null));
      cleanup.push(row!.id);
      expect(row!.sensitivity_label).toBe(label);
    }
    // Through the query builder, which sends DEFAULT for the column it was not given.
    const [built] = await at(B, () =>
      getDb().insert(claims).values({ text: `Enforcement write ${randomUUID()}` }).returning({ id: claims.id, label: claims.sensitivityLabel })
    );
    cleanup.push(built!.id);
    expect(built!.label).toBe(B);
  });

  it("that forgot its stamp is refused where nothing says which label it is for", async () => {
    // Nothing in context, a request with a clearance, and system work: none carries a label.
    for (const write of [
      () => insertAt(null),
      () => runWithUsageContext({ clearance: [PUBLIC_LABEL, A] }, () => insertAt(null)),
      () => system(() => insertAt(null)),
    ]) {
      await expect(write()).rejects.toSatisfy(
        (err) => sqlState(err) === "MVL01" && /without a label/.test((err as Error).message)
      );
    }
  });

  /** The policy refused the write, and the refusal says what the work may write. */
  const refusedAsOutside = async (write: () => Promise<unknown>) => {
    const err = await write().then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ClearanceError);
    expect(sqlState(err)).toBe("42501");
  };

  it("at a label outside the clearance is refused, and says why", async () => {
    const refused = async (write: () => Promise<unknown>) => {
      const err = await write().then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(ClearanceError);
      expect((err as Error).message).toMatch(/may add a row only at its own label, and change one only at a label it reads/);
      expect(sqlState(err)).toBe("42501");
    };
    await refused(() => at(A, () => insertAt(B)));
    await refused(() => at(A, () => insertAt(C)));
    await refused(() => insertAt(A));
    await refused(() => at(PUBLIC_LABEL, () => insertAt(A)));
  });

  /** The write was refused because it would have changed a row's label (MVL04). */
  const refusedWith = async (code: string, write: () => Promise<unknown>) => {
    const err = await write().then(
      () => null,
      (e: unknown) => e
    );
    expect(sqlState(err), err instanceof Error ? err.message : String(err)).toBe(code);
  };
  const labelStays = async (write: () => Promise<unknown>) => {
    const err = await write().then(
      () => null,
      (e: unknown) => e
    );
    // The query builder wraps the database's error; the code is on its cause.
    const refusal = (sqlState(err) ? err : (err as { cause?: unknown } | null)?.cause) as Error | undefined;
    expect(sqlState(refusal)).toBe("MVL04");
    expect(refusal!.message).toMatch(/a row's label does not change/);
  };
  const labelOfClaim = async (id: string) =>
    (await system(() => rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM claims WHERE id = $1`, [id])))[0]!.l;

  // A reviewer moved rows with a plain UPDATE: down to public from a run
  // that read them, across from a person cleared for both labels, and up,
  // which took a public row out of everyone else's sight. The policy allows
  // all three (the new label is one the connection reads); the trigger on
  // the column refuses them.
  it("never changes a row's label: not down to public, not across, not up, and not through an upsert", async () => {
    const [atC] = await at(C, () => insertAt(C));
    const [atA] = await at(A, () => insertAt(A));
    const [open] = await insertAt(PUBLIC_LABEL);
    cleanup.push(atC!.id, atA!.id, open!.id);

    // Down: a run at c reads c, a and public.
    await labelStays(() =>
      at(C, () => rawQuery(`UPDATE claims SET sensitivity_label = 'public' WHERE id = ANY($1::uuid[])`, [[atC!.id, atA!.id]]))
    );
    // Across: a person cleared for a and b, whose request writes at public.
    await labelStays(() =>
      runWithUsageContext({ clearance: [PUBLIC_LABEL, A, B] }, () =>
        rawQuery(`UPDATE claims SET sensitivity_label = $2 WHERE id = $1`, [atA!.id, B])
      )
    );
    // Up: a run at a would hide a public row from everyone who does not read a.
    await labelStays(() => at(A, () => rawQuery(`UPDATE claims SET sensitivity_label = $2 WHERE id = $1`, [open!.id, A])));
    // Out of the clearance altogether: the trigger answers before the policy does.
    await labelStays(() => at(A, () => rawQuery(`UPDATE claims SET sensitivity_label = $2 WHERE id = $1`, [atA!.id, B])));
    // Through an upsert that takes the label from the incoming row.
    await labelStays(() =>
      at(A, () =>
        rawQuery(
          `INSERT INTO claims (id, text, sensitivity_label) VALUES ($1, 'Enforcement upsert', $2)
           ON CONFLICT (id) DO UPDATE SET sensitivity_label = EXCLUDED.sensitivity_label`,
          [open!.id, A]
        )
      )
    );
    // Through the query builder.
    await labelStays(() =>
      at(C, () => getDb().update(claims).set({ sensitivityLabel: PUBLIC_LABEL }).where(sql`${claims.id} = ${atA!.id}`))
    );

    expect(await labelOfClaim(atC!.id)).toBe(C);
    expect(await labelOfClaim(atA!.id)).toBe(A);
    expect(await labelOfClaim(open!.id)).toBe(PUBLIC_LABEL);
    // Nothing came into sight, and nothing went out of it.
    expect(await rawQuery(`SELECT 1 FROM claims WHERE id = ANY($1::uuid[])`, [[atC!.id, atA!.id]])).toEqual([]);
    expect(await rawQuery(`SELECT 1 FROM claims WHERE id = $1`, [open!.id])).toHaveLength(1);

    // A statement that names the column and leaves it as it is goes through,
    // as does every update that does not name it.
    await at(A, () => rawQuery(`UPDATE claims SET sensitivity_label = sensitivity_label, importance = 0.4 WHERE id = $1`, [atA!.id]));
    await at(A, () => rawQuery(`UPDATE claims SET importance = 0.5 WHERE id = $1`, [atA!.id]));
    // The owner is not held: moving a row to a label more people read (a
    // release) will be its to do.
    await system(() => rawQuery(`UPDATE claims SET sensitivity_label = $2 WHERE id = $1`, [atA!.id, B]));
    expect(await labelOfClaim(atA!.id)).toBe(B);
    await system(() => rawQuery(`UPDATE claims SET sensitivity_label = $2 WHERE id = $1`, [atA!.id, A]));
  });

  // A ledger row's label never changes. Work on something several labels
  // can work on has a key for each label (groupAtLabel in
  // services/ingest-focus-service.ts), so a finished row is only ever
  // reopened by work at its own label, and the exception the trigger used
  // to make for a reopening is gone: work at another label that names the
  // same key is refused, and the row stays as it was.
  it("keeps a ledger row at the label it was opened at, whoever names its key again", async () => {
    const group = `enf-reopen:${randomUUID()}`;
    const [row] = await system(() =>
      rawQuery<{ id: string }>(
        `INSERT INTO actions (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, status, sensitivity_label)
         VALUES ('assess', $1, 'standard', 'the public work''s target', 'The public work''s words', 1, 'done', 'public') RETURNING id`,
        [group]
      )
    );
    const state = async () =>
      (await system(() =>
        rawQuery<{ status: string; l: string; label: string; target_ref: string | null }>(
          `SELECT status, sensitivity_label AS l, label, target_ref FROM actions WHERE id = $1`,
          [row!.id]
        )
      ))[0]!;
    /** The application's own upsert, as every producer writes it. */
    const reopen = (stamp: string, words: string) =>
      rawQuery(
        `INSERT INTO actions (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, sensitivity_label)
         VALUES ('assess', $1, 'standard', $3, $4, 1, $2)
         ON CONFLICT (exclusion_group, variant) DO UPDATE
           SET status = CASE WHEN actions.status = 'running' THEN actions.status ELSE 'open' END,
               ${LABEL_ON_REOPEN_SQL}`,
        [group, stamp, `${words} (target)`, words]
      );
    const asIs = { status: "done", l: PUBLIC_LABEL, label: "The public work's words", target_ref: "the public work's target" };
    try {
      // Work at a, which reads the row, names the same key. The row is not
      // a's to change, and nothing of a's is written into it.
      await refusedWith("MVL06", () => at(A, () => reopen(A, "Words at a")));
      expect(await state()).toEqual(asIs);
      // Nor is its label changed by a plain update, to any label, by anyone held to a clearance.
      await labelStays(() => at(A, () => rawQuery(`UPDATE actions SET sensitivity_label = $2 WHERE id = $1`, [row!.id, A])));
      await labelStays(() =>
        at(PUBLIC_LABEL, () => rawQuery(`UPDATE actions SET status = 'open', sensitivity_label = $2 WHERE id = $1`, [row!.id, A]))
      );
      expect(await state()).toEqual(asIs);
      // Work at the row's own label reopens it, and it is that work's row: its text and its target are replaced.
      await at(PUBLIC_LABEL, () => reopen(PUBLIC_LABEL, "The next public work"));
      expect(await state()).toEqual({
        status: "open", l: PUBLIC_LABEL, label: "The next public work", target_ref: "The next public work (target)",
      });
      // The key the application gives work at a on the same subject is a's own.
      expect(groupAtLabel(group, A)).toBe(`${group} @${A}`);
      expect(groupAtLabel(group, PUBLIC_LABEL)).toBe(group);
    } finally {
      await system(() => rawQuery(`DELETE FROM actions WHERE id = $1`, [row!.id]));
    }
  });

  it("that is refused is answered by a route as a conflict, with the reason, and not as a fault", async () => {
    const app = Fastify();
    await registerErrorHandler(app);
    app.post("/outside", () => at(A, () => insertAt(B)));
    app.post("/forgot", () => insertAt(null));
    const outside = await app.inject({ method: "POST", url: "/outside" });
    expect(outside.statusCode).toBe(409);
    expect(outside.json().error).toMatchObject({ code: "REFUSED_BY_LABEL" });
    expect(outside.json().error.message).toMatch(/may add a row only at its own label/);
    // A stamp forgotten where nothing gives a label is a fault of the code, and is answered as one.
    const forgot = await app.inject({ method: "POST", url: "/forgot" });
    expect(forgot.statusCode).toBe(500);
    expect(forgot.json().error.message).toBe("Internal server error");
    await app.close();
  });

  it("adds a row only at the run's own label: not at one it reads, so a wrong stamp is refused as a missing one is filled", async () => {
    await refusedAsOutside(() => at(C, () => insertAt(A)));
    await refusedAsOutside(() => at(A, () => insertAt(PUBLIC_LABEL)));
    // A request has no label of its own: what it adds is public, whatever it reads.
    await refusedAsOutside(() => runWithUsageContext({ clearance: [PUBLIC_LABEL, A] }, () => insertAt(A)));
    const [open] = await runWithUsageContext({ clearance: [PUBLIC_LABEL, A] }, () => insertAt(PUBLIC_LABEL));
    cleanup.push(open!.id);
    expect(open!.sensitivity_label).toBe(PUBLIC_LABEL);
  });

  it("writes a row that belongs to another label by running the write at that label, as a document's segments are", async () => {
    // A run at C reads A. What is derived from a row at A is written at A
    // by work that says so (runAtLabel), which is how segmentSource and
    // recordSourceEvent keep a document's rows at the document's label.
    const [derived] = await at(C, () => at(A, () => insertAt(A)));
    cleanup.push(derived!.id);
    expect(derived!.sensitivity_label).toBe(A);
    // A change to a row it reads at another label takes the same step:
    // made from C it is refused, and made at A it lands.
    await refusedWith("MVL06", () => at(C, () => rawQuery(`UPDATE claims SET importance = importance WHERE id = $1 RETURNING id`, [derived!.id])));
    expect(
      await at(C, () => at(A, () => rawQuery(`UPDATE claims SET importance = importance WHERE id = $1 RETURNING id`, [derived!.id])))
    ).toHaveLength(1);
  });

  it("cannot reach a row the run does not read: an update or a delete finds nothing", async () => {
    const touch = (label: string) =>
      at(label, () => rawQuery(`UPDATE claims SET importance = importance WHERE id = $1 RETURNING id`, [claimIds[B]]));
    expect(await touch(A)).toEqual([]);
    expect(await touch(B)).toHaveLength(1);
    expect(await at(A, () => rawQuery(`DELETE FROM claims WHERE id = $1 RETURNING id`, [claimIds[B]]))).toEqual([]);
    expect(await system(() => rawQuery(`SELECT 1 FROM claims WHERE id = $1`, [claimIds[B]]))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("a collision with a row the run cannot read", () => {
  // A key that holds the label cannot collide across labels: each label
  // keeps its own row, and work at one is told nothing of another's
  // (tests/db/layer-identity.test.ts). The guard is for the keys that are
  // still one for the whole deployment (tests/db/layer-identity-keys.test.ts).
  it("does not happen on a key that holds the label: each label has its own row, and neither is told of the other's", async () => {
    const slug = `enf-${randomUUID().slice(0, 8)}`;
    const insertTag = (suffix: string) =>
      `INSERT INTO tags (slug, name, sensitivity_label) VALUES ($1, $2, $3) ${suffix} RETURNING id`;
    await at(B, () => rawQuery(insertTag(""), [slug, "Held at B", B]));
    try {
      expect(await at(A, () => rawQuery(insertTag(""), [slug, "Wanted at A", A]))).toHaveLength(1);
      expect(await at(A, () => rawQuery(insertTag("ON CONFLICT (slug, sensitivity_label) DO NOTHING"), [slug, "Again at A", A]))).toEqual([]);
      expect(await at(A, () => rawQuery<{ name: string }>(`SELECT name FROM tags WHERE slug = $1`, [slug]))).toEqual([{ name: "Wanted at A" }]);
      expect(await at(B, () => rawQuery<{ name: string }>(`SELECT name FROM tags WHERE slug = $1`, [slug]))).toEqual([{ name: "Held at B" }]);
    } finally {
      await system(() => rawQuery(`DELETE FROM tags WHERE slug = $1`, [slug]));
    }
  });

  // Left to Postgres the three would differ: a duplicate-key error, nothing
  // at all, and a refusal by the policy. The guard makes them one refusal.
  it("is refused with the reason on a key held once for the whole deployment, whether the insert is plain, does nothing on conflict, or updates on conflict", async () => {
    const group = `ingest:https://enf.example/${randomUUID()}`;
    const insertFocus = (suffix: string) =>
      `INSERT INTO ingest_focuses (exclusion_group, url, focus, sensitivity_label) VALUES ($1, 'https://enf.example/', $2, $3) ${suffix} RETURNING exclusion_group`;
    await at(B, () => rawQuery(insertFocus(""), [group, "Held at B", B]));
    try {
      for (const onConflict of ["", "ON CONFLICT (exclusion_group) DO NOTHING", "ON CONFLICT (exclusion_group) DO UPDATE SET focus = EXCLUDED.focus"]) {
        const err = await at(A, () => rawQuery(insertFocus(onConflict), [group, "Wanted at A", A])).then(
          () => null,
          (e: unknown) => e
        );
        expect(isUnseenCollision(err), onConflict).toBe(true);
        expect((err as Error).message, onConflict).toBe(
          "this was not written: a row with the same identity already exists at a label this work does not read"
        );
        expect((err as { hint?: string }).hint, onConflict).toBe(
          "This key is held once for the whole deployment, whatever the labels. Nothing was changed."
        );
      }
      // The refusal tells the writer a row is there. It does not show the row.
      expect(await at(A, () => rawQuery(`SELECT 1 FROM ingest_focuses WHERE exclusion_group = $1`, [group]))).toEqual([]);
      // The row at B is as it was, and work that reads B meets it as it always did.
      expect(await at(B, () => rawQuery<{ focus: string }>(`SELECT focus FROM ingest_focuses WHERE exclusion_group = $1`, [group]))).toEqual([{ focus: "Held at B" }]);
      expect(await at(B, () => rawQuery(insertFocus("ON CONFLICT (exclusion_group) DO NOTHING"), [group, "Again at B", B]))).toEqual([]);
      // The owner's connection is not held to it: a duplicate there is a duplicate.
      await expect(system(() => rawQuery(insertFocus(""), [group, "As the owner", A]))).rejects.toSatisfy((err) => sqlState(err) === "23505");
    } finally {
      await system(() => rawQuery(`DELETE FROM ingest_focuses WHERE exclusion_group = $1`, [group]));
    }
  });
});

describe("a node's judgment in force", () => {
  const assess = (claimId: string) =>
    withTransaction(async (tx) => {
      await tx.query(`UPDATE assessments SET is_current = false WHERE claim_id = $1 AND is_current = true`, [claimId]);
      const [row] = await tx.query<{ id: string; sensitivity_label: string }>(
        `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current, sensitivity_label)
         VALUES ($1, 'supported', 0.7, 'Reasons.', true, $2) RETURNING id, sensitivity_label`,
        [claimId, currentLabel()]
      );
      return row!;
    });
  const inForce = (claimId: string) =>
    system(() =>
      rawQuery<{ sensitivity_label: string }>(`SELECT sensitivity_label FROM assessments WHERE claim_id = $1 AND is_current`, [claimId])
    );
  let claimId: string;
  beforeAll(async () => {
    [{ id: claimId }] = (await at(PUBLIC_LABEL, () =>
      rawQuery<{ id: string }>(`INSERT INTO claims (text, steward_state) VALUES ($1, 'done') RETURNING id`, [`Enforcement judged claim ${randomUUID()}`])
    )) as [{ id: string }];
  });
  afterAll(() => system(() => rawQuery(`DELETE FROM claims WHERE id = $1`, [claimId])));

  it("is replaced by work at its own label", async () => {
    await at(PUBLIC_LABEL, () => assess(claimId));
    await at(PUBLIC_LABEL, () => assess(claimId));
    expect(await inForce(claimId)).toEqual([{ sensitivity_label: PUBLIC_LABEL }]);
  });

  it("is not retired by a run at another label that reads it: each label keeps its own version", async () => {
    // This helper retires whatever is current on the node, as no write seam
    // does any more: the public version is not a run at A's to retire.
    const err = await at(A, () => assess(claimId)).then(
      () => null,
      (e: unknown) => e
    );
    expect(sqlState(err)).toBe("MVL02");
    expect((err as Error).message).toBe(
      "this version of the node's judgment was recorded at another label, and this work may neither retire it nor bring it back"
    );
    expect(await inForce(claimId)).toEqual([{ sensitivity_label: PUBLIC_LABEL }]);
  });

  it("at a label a run cannot see is no obstacle to its own, which is recorded beside it", async () => {
    await system(async () => {
      await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1`, [claimId]);
      await rawQuery(
        `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current, sensitivity_label)
         VALUES ($1, 'doubtful', 0.6, 'Reasons at B.', true, $2)`,
        [claimId, B]
      );
    });
    // A run at A sees no judgment on this public claim. A version of its own
    // does not collide with B's, which it cannot see: a node carries one at
    // each label, and nothing tests what is attached to the node at A
    // (tests/db/judgments-per-label.test.ts, tests/db/left-standing.test.ts).
    await at(A, () => assess(claimId));
    expect((await inForce(claimId)).map((r) => r.sensitivity_label).sort()).toEqual([A, B].sort());
  });

  it("is the owner's to change whatever its label, as a migration or a repair must", async () => {
    await system(() => rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1`, [claimId]));
    expect(await inForce(claimId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the connection", () => {
  const who = () =>
    rawQuery<{ role: string; clearance: string; label: string }>(
      // A setting a session never had reads as null, and one it had and gave
      // up reads as empty; both mean none.
      `SELECT current_user::text AS role, COALESCE(current_setting('minerval.clearance', true), '') AS clearance,
              COALESCE(current_setting('minerval.label', true), '') AS label`
    );

  it("is the cleared role with its clearance and label fixed when it was made, and the owner for system work", async () => {
    expect(await who()).toEqual([{ role: CLEARED_ROLE, clearance: "{public}", label: "" }]);
    expect(await at(C, who)).toEqual([{ role: CLEARED_ROLE, clearance: `{${A},${C},public}`, label: C }]);
    const owner = new URL(loadConfig().databaseUrl).username;
    expect(await system(who)).toEqual([{ role: owner, clearance: "", label: "" }]);
    expect((await system(who))[0]!.role).not.toBe(CLEARED_ROLE);
  });

  it("keeps its clearance through a reset, because the clearance is the connection's own default", async () => {
    const afterReset = await at(A, () =>
      withTransaction(async (tx) => {
        await tx.query(`RESET ALL`);
        return tx.query<{ clearance: string }>(`SELECT current_setting('minerval.clearance', true) AS clearance`);
      })
    );
    expect(afterReset).toEqual([{ clearance: `{${A},public}` }]);
  });

  it("cannot act as the owner, read the signing key, or run the step", async () => {
    const owner = new URL(loadConfig().databaseUrl).username;
    await expect(withTransaction((tx) => tx.query(`SET LOCAL ROLE ${owner}`))).rejects.toSatisfy((err) => sqlState(err) === "42501");
    await expect(rawQuery(`SELECT key FROM minerval_private.sql_clearance_key`)).rejects.toSatisfy((err) => sqlState(err) === "42501");
    await expect(rawQuery(`SELECT minerval_enforcement_sync(false)`)).rejects.toSatisfy((err) => sqlState(err) === "42501");
    await expect(rawQuery(`ALTER TABLE claims DISABLE ROW LEVEL SECURITY`)).rejects.toSatisfy((err) => sqlState(err) === "42501");
    await expect(rawQuery(`DROP POLICY label_clearance ON claims`)).rejects.toSatisfy((err) => sqlState(err) === "42501");
  });

  // The stated limit, shown and not hidden: the clearance is a setting, and
  // SQL run on one of the application's own connections can set it. No
  // caller's or agent's SQL runs here; that goes through read-only SQL,
  // below, which a setting does not open.
  it("carries its clearance in a setting, which SQL on the application's own connection could change", async () => {
    const widened = await withTransaction(async (tx) => {
      await tx.query(`SET LOCAL minerval.clearance = '{${B}}'`);
      return tx.query<{ sensitivity_label: string }>(`SELECT sensitivity_label FROM claims WHERE id = $1`, [claimIds[B]]);
    });
    expect(widened).toEqual([{ sensitivity_label: B }]);
    // It was local to that transaction: the next read is held as before.
    expect(await rawQuery(`SELECT 1 FROM claims WHERE id = $1`, [claimIds[B]])).toEqual([]);
  });

  it("refuses a label whose name is not a plain word, before any connection is opened for it", async () => {
    for (const name of ["a b", "a}", "x -c role=postgres", "A", "", "a,b", "a'--"]) {
      await expect(runWithUsageContext({ label: name }, who), name).rejects.toBeInstanceOf(ClearanceError);
      await expect(runWithUsageContext({ clearance: [name] }, who), name).rejects.toBeInstanceOf(ClearanceError);
    }
    // And the table holds a name to the same rule.
    await expect(system(() => rawQuery(`INSERT INTO labels (name, description) VALUES ('Not Plain', 'x')`))).rejects.toSatisfy(
      (err) => sqlState(err) === "23514"
    );
  });

  it("derives the cleared role's password from the owner's credentials alone", () => {
    const a = clearedRolePassword("postgresql://owner:secret@host-one:5432/one");
    expect(a).toBe(clearedRolePassword("postgresql://owner:secret@host-two:6543/two?sslmode=require"));
    expect(a).not.toBe(clearedRolePassword("postgresql://owner:other@host-one:5432/one"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------

describe("keyword search where reads are held", () => {
  it("returns only what the clearance allows", async () => {
    const found = async () => sorted((await keywordClaimSearch(word, { limit: 20 })).map((r) => r.id));
    const ids = (labels: string[]) => sorted(labels.map((l) => claimIds[l]!));
    expect(await found()).toEqual(ids([PUBLIC_LABEL]));
    expect(await at(A, found)).toEqual(ids([A, PUBLIC_LABEL]));
    expect(await at(C, found)).toEqual(ids([A, C, PUBLIC_LABEL]));
    expect(await system(found)).toEqual(ids(ALL));
  });

  it("reads through the view that keeps its index, and system work reads the table", async () => {
    expect(await readsAreHeld()).toBe(true);
    expect(await searchableClaims()).toBe("minerval_readable.claims_search");
    expect(await system(() => readsAreHeld())).toBe(false);
    expect(await system(() => searchableClaims())).toBe("claims");
  });

  it("uses the full-text index through the view, which the table under its policy cannot", async () => {
    // With sequential scans discouraged, the planner takes the index
    // wherever it is allowed to. Under the policy it is not allowed to.
    const plan = (from: string) =>
      at(A, () =>
        withTransaction(async (tx) => {
          await tx.query(`SET LOCAL enable_seqscan = off`);
          const rows = await tx.query<{ "QUERY PLAN": string }>(
            `EXPLAIN (COSTS OFF) SELECT c.id FROM ${from} c WHERE c.text_search @@ websearch_to_tsquery('english', $1)`,
            [word]
          );
          return rows.map((r) => r["QUERY PLAN"]).join("\n");
        })
      );
    expect(await plan("minerval_readable.claims_search")).toContain("idx_claims_text_search");
    expect(await plan("claims")).not.toContain("idx_claims_text_search");
  });
});

// ---------------------------------------------------------------------------

describe("read-only SQL", () => {
  const ROLE = "minerval_sql_dbtest";
  const PASSWORD = "dbtest-sql";
  const ids = () => Object.values(claimIds);
  const labelsOf = (rows: Array<Record<string, unknown>>) =>
    sorted(rows.map((r) => Object.entries(claimIds).find(([, id]) => id === r.id)![0]));

  /** A session of the SQL login role itself, as whoever writes the SQL holds it. */
  async function asSqlRole<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const url = new URL(TEST_DATABASE_URL);
    url.username = ROLE;
    url.password = PASSWORD;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const visible = async (client: pg.Client) =>
    labelsOf((await client.query(`SELECT id FROM public_read.nodes WHERE id = ANY($1::uuid[])`, [ids()])).rows);

  it("shows public rows alone to an asker with no clearance, and each asker the labels it reads", async () => {
    const q = `SELECT id FROM nodes WHERE id = ANY($1::uuid[])`;
    expect(labelsOf(await readViewsAs([], q, [ids()]))).toEqual([PUBLIC_LABEL]);
    expect(labelsOf(await readViewsAs([A], q, [ids()]))).toEqual(sorted([A, PUBLIC_LABEL]));
    expect(labelsOf(await readViewsAs([A, B], q, [ids()]))).toEqual(sorted([A, B, PUBLIC_LABEL]));
    // An agent's query_sql reads what its run reads.
    const asRun = await at(C, () => runReadOnlyQuery(q, [ids()], { audience: "agent" }));
    expect(asRun.rows.map((r) => r[0]).sort()).toEqual(sorted([claimIds[A]!, claimIds[C]!, claimIds[PUBLIC_LABEL]!]));
  });

  it("tells the asker which labels were read, and that the rest was left out", async () => {
    const result = await at(A, () => runReadOnlyQuery(`SELECT count(*) FROM nodes`, [], { audience: "agent" }));
    expect(result.note).toBe(
      "This graph holds material that only some of its readers may see. These views showed you the rows " +
        `labeled \`public\` and \`${A}\`, which is what you may read. Rows at any other label were left out before your ` +
        "query ran, so a count, a sum or an empty result here is over what you can read and not over " +
        "everything the graph holds."
    );
    const open = await runReadOnlyQuery(`SELECT count(*) FROM nodes`, [], { audience: "agent" });
    expect(open.note).toContain("labeled `public`, which is what you may read");
  });

  it("is not opened by any setting the SQL's author can make", async () => {
    await asSqlRole(async (client) => {
      expect(await visible(client)).toEqual([PUBLIC_LABEL]);
      // The setting the application's own connections are held by.
      await client.query(`SET minerval.clearance = '{${A},${B},${C}}'`);
      await client.query(`SET minerval.label = '${B}'`);
      expect(await visible(client)).toEqual([PUBLIC_LABEL]);
      // A made-up token, an unsigned one, and one with a signature from a guessed key.
      const pid = (await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
      const soon = Date.now() / 1000 + 600;
      for (const forged of [
        "forged",
        `${Math.floor(soon)}.${pid}.${A},${B}`,
        `${Math.floor(soon)}.${pid}.${A},${B}.${"0".repeat(64)}`,
        sqlClearanceToken({ key: "guess", labels: [A, B], backendPid: pid, expiresAtEpochSeconds: soon }),
      ]) {
        await client.query(`SELECT set_config('minerval.sql_clearance', $1, false)`, [forged]);
        expect(await visible(client), forged).toEqual([PUBLIC_LABEL]);
      }
    });
  });

  it("is opened by a token the service signed for that connection, and by nothing made from it", async () => {
    const key = (await system(() => rawQuery<{ key: string }>(`SELECT key FROM minerval_private.sql_clearance_key`)))[0]!.key;
    await asSqlRole(async (client) => {
      const pid = (await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
      const soon = Date.now() / 1000 + 600;
      const set = (token: string) => client.query(`SELECT set_config('minerval.sql_clearance', $1, false)`, [token]);
      const good = sqlClearanceToken({ key, labels: [A], backendPid: pid, expiresAtEpochSeconds: soon });
      await set(good);
      expect(await visible(client)).toEqual(sorted([A, PUBLIC_LABEL]));
      // The same token with a label added: the signature no longer matches.
      const [expiry, backend, labels, signature] = good.split(".");
      await set(`${expiry}.${backend}.${labels},${B}.${signature}`);
      expect(await visible(client)).toEqual([PUBLIC_LABEL]);
      // A rightly signed token for another connection, and one that has expired.
      await set(sqlClearanceToken({ key, labels: [A], backendPid: pid + 1, expiresAtEpochSeconds: soon }));
      expect(await visible(client)).toEqual([PUBLIC_LABEL]);
      await set(sqlClearanceToken({ key, labels: [A], backendPid: pid, expiresAtEpochSeconds: Date.now() / 1000 - 5 }));
      expect(await visible(client)).toEqual([PUBLIC_LABEL]);
      // The good one again, taken from this session's own setting: it is the
      // session's own clearance and gives nothing more.
      await set(good);
      expect(await visible(client)).toEqual(sorted([A, PUBLIC_LABEL]));
    });
    // The good token is for that backend. On any other connection it is nothing.
    await asSqlRole(async (client) => {
      const pid = (await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
      const other = sqlClearanceToken({ key, labels: [A], backendPid: pid + 7, expiresAtEpochSeconds: Date.now() / 1000 + 600 });
      await client.query(`SELECT set_config('minerval.sql_clearance', $1, false)`, [other]);
      expect(await visible(client)).toEqual([PUBLIC_LABEL]);
    });
  });

  it("cannot read the key, the tables, or the views that apply the application's clearance", async () => {
    await asSqlRole(async (client) => {
      for (const statement of [
        `SELECT key FROM minerval_private.sql_clearance_key`,
        `SELECT id FROM public.claims LIMIT 1`,
        `SELECT id FROM minerval_readable.claims_search LIMIT 1`,
        `INSERT INTO public.labels (name, description) VALUES ('enf-forged', 'x')`,
        `INSERT INTO public.label_reads (label, reads) VALUES ('public', '${A}')`,
        `SELECT minerval_enforcement_sync(false)`,
      ]) {
        await expect(client.query(statement), statement).rejects.toSatisfy((err) => sqlState(err) === "42501");
      }
      // The function that checks a token can be called; it answers for this session alone.
      expect((await client.query(`SELECT minerval_sql_clearance() AS c`)).rows[0]!.c).toEqual([PUBLIC_LABEL]);
    });
  });
});
