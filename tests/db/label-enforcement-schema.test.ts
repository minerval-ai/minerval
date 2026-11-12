/**
 * The database's side of holding reads and writes to a clearance, as the
 * migration leaves it: inert while `public` is the only label, and switched
 * on, in the same transaction, by the insert that defines a second one.
 *
 * Nothing in the application connects as the role the policies bind yet, so
 * these tests drive the database directly, as the tables' owner, inside
 * transactions that are rolled back: the suite's database never holds a
 * second label because of this file. Other files define labels and leave
 * them, so each test first puts its own transaction into the state it is
 * about (publicOnly below) and does not depend on which files ran before.
 */
import { describe, it, expect } from "vitest";
import pg from "pg";
import { withTransaction, type TxQuery } from "../../src/db/client.js";
import { TEST_DATABASE_URL } from "./urls.js";

const sqlState = (err: unknown) => (err as { code?: string } | null)?.code;

interface Catalog {
  labelled: string[];
  secured: string[];
  policies: Record<string, number>;
  judgmentGuards: string[];
  collisionGuards: number;
  labelFixedGuards: number;
  ownLabelGuards: number;
}

async function catalog(tx: TxQuery): Promise<Catalog> {
  const tables = await tx.query<{ name: string; secured: boolean }>(
    `SELECT c.relname::text AS name, c.relrowsecurity AS secured
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'sensitivity_label' AND NOT a.attisdropped)
      ORDER BY c.relname`
  );
  const policies = await tx.query<{ name: string; n: number }>(
    `SELECT polname::text AS name, count(*)::int AS n FROM pg_policy GROUP BY polname`
  );
  const guards = await tx.query<{ name: string; table_name: string }>(
    `SELECT g.tgname::text AS name, c.relname::text AS table_name
       FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
      WHERE g.tgname IN ('judgment_label_guard', 'unseen_collision_guard', 'label_fixed_guard', 'own_label_guard')
      ORDER BY c.relname`
  );
  return {
    labelled: tables.map((t) => t.name),
    secured: tables.filter((t) => t.secured).map((t) => t.name),
    policies: Object.fromEntries(policies.map((p) => [p.name, p.n])),
    judgmentGuards: guards.filter((g) => g.name === "judgment_label_guard").map((g) => g.table_name),
    collisionGuards: guards.filter((g) => g.name === "unseen_collision_guard").length,
    labelFixedGuards: guards.filter((g) => g.name === "label_fixed_guard").length,
    ownLabelGuards: guards.filter((g) => g.name === "own_label_guard").length,
  };
}

/** Run `fn` in a transaction and roll it back, whatever it did. */
async function rolledBack<T>(fn: (tx: TxQuery) => Promise<T>): Promise<T> {
  const undo = new Error("rolled back by the test");
  let value: T | undefined;
  await withTransaction(async (tx) => {
    value = await fn(tx);
    throw undo;
  }).catch((err: unknown) => {
    if (err !== undo) throw err;
  });
  return value as T;
}

/**
 * Make this transaction's database one that has only ever had `public`:
 * every other label is removed and the step is run. Rows that carry those
 * labels stay behind for the length of the transaction, so their foreign
 * keys to `labels` must not be checked while the labels go. A superuser
 * (the suite's role locally and in CI) turns the checks off for the
 * moment. A plain owner cannot, and drops the keys instead: the
 * transaction is rolled back, so they are back when it ends
 * (`npm run test:db:owner` runs this file that way). The connection is also
 * left carrying no label, which is what every connection of a deployment
 * carries today; the suite's own carry `public` (tests/db/setup.ts).
 */
async function publicOnly(tx: TxQuery): Promise<void> {
  await tx.query(`SET LOCAL minerval.label = ''`);
  const [role] = await tx.query<{ is_superuser: string }>(`SHOW is_superuser`);
  if (role!.is_superuser === "on") {
    await tx.query(`SET LOCAL session_replication_role = replica`);
    await tx.query(`DELETE FROM label_reads`);
    await tx.query(`DELETE FROM labels WHERE name <> 'public'`);
    await tx.query(`SET LOCAL session_replication_role = origin`);
  } else {
    await tx.query(
      `DO $$
       DECLARE k record;
       BEGIN
         FOR k IN SELECT conrelid::regclass AS on_table, conname FROM pg_constraint
                   WHERE contype = 'f' AND confrelid = 'public.labels'::regclass
         LOOP
           EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', k.on_table, k.conname);
         END LOOP;
       END $$`
    );
    await tx.query(`DELETE FROM label_reads`);
    await tx.query(`DELETE FROM labels WHERE name <> 'public'`);
  }
  await tx.query(`SELECT minerval_enforcement_sync(false)`);
}

const defineSecondLabel = (tx: TxQuery) =>
  tx.query(`INSERT INTO labels (name, description) VALUES ('schema-probe', 'Defined inside a transaction that is rolled back.')`);

describe("with public the only label", () => {
  it("has no table under row-level security, no policy and no guard", async () => {
    const now = await rolledBack(async (tx) => {
      await publicOnly(tx);
      return catalog(tx);
    });
    expect(now.labelled.length).toBe(99);
    expect(now.secured).toEqual([]);
    expect(now.policies).toEqual({});
    expect(now.judgmentGuards).toEqual([]);
    expect(now.collisionGuards).toBe(0);
    expect(now.labelFixedGuards).toBe(0);
    expect(now.ownLabelGuards).toBe(0);
  });

  it("has every view in public reading with its caller's rights all the same, so none is ever a way past the policies", async () => {
    // Set by the migration and said in the schema, not left to the step: a
    // view replaced by a later migration is created with it.
    const views = await rolledBack(async (tx) => {
      await publicOnly(tx);
      return tx.query<{ name: string; invoker: boolean }>(
        `SELECT c.relname::text AS name,
                COALESCE((SELECT option_value = 'true' FROM pg_options_to_table(c.reloptions)
                           WHERE option_name = 'security_invoker'), false) AS invoker
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'v' ORDER BY c.relname`
      );
    });
    expect(views).toEqual(
      [
        "argument_evaluations_in_force", "argument_evaluations_versions",
        "assessments_in_force", "assessments_versions",
        "quantity_estimates_in_force", "quantity_estimates_versions",
        "question_assessments_in_force", "question_assessments_versions",
      ].map((name) => ({ name, invoker: true }))
    );
  });

  it("shows the ledger's money whole through two views that leave out the text beside it", async () => {
    const columns = await rolledBack((tx) =>
      tx.query<{ view: string; columns: string[] }>(
        `SELECT table_name::text AS view, array_agg(column_name::text ORDER BY ordinal_position) AS columns
           FROM information_schema.columns WHERE table_schema = 'minerval_whole' GROUP BY table_name ORDER BY table_name`
      )
    );
    expect(columns).toEqual([
      {
        view: "allocation_money",
        columns: ["id", "exclusion_group", "action_id", "claim_id", "grant_id", "user_id", "amount_micro_usd",
          "spent_micro_usd", "released_at", "created_at", "commissioned_by", "parent_action_id"],
      },
      { view: "regrant_money", columns: ["id", "from_grant_id", "to_grant_id", "amount_micro_usd", "refunded_micro_usd", "created_at"] },
    ]);
  });

  it("gives a row written without a label the label public, as before", async () => {
    const label = await rolledBack(async (tx) => {
      await publicOnly(tx);
      const [row] = await tx.query<{ sensitivity_label: string }>(
        `INSERT INTO claims (text) VALUES ('label enforcement schema test') RETURNING sensitivity_label`
      );
      return row!.sensitivity_label;
    });
    expect(label).toBe("public");
  });

  it("runs the step and finds nothing to do", async () => {
    const changes = await rolledBack(async (tx) => {
      await publicOnly(tx);
      return tx.query(`SELECT minerval_enforcement_sync() AS line`);
    });
    expect(changes).toEqual([]);
  });

  it("refuses a pair that would have public read another label", async () => {
    await expect(
      rolledBack(async (tx) => {
        await tx.query(`INSERT INTO labels (name, description) VALUES ('schema-probe', 'x')`);
        await tx.query(`INSERT INTO label_reads (label, reads) VALUES ('public', 'schema-probe')`);
      })
    ).rejects.toSatisfy((err) => sqlState(err) === "23514");
  });

  it("holds a label's name to a plain word, and not the word null", async () => {
    for (const name of ["Not Plain", "a b", "a}", "", "1a", "a'b", "null"]) {
      await expect(
        rolledBack((tx) => tx.query(`INSERT INTO labels (name, description) VALUES ($1, 'x')`, [name])),
        name
      ).rejects.toSatisfy((err) => sqlState(err) === "23514");
    }
  });
});

describe("defining a second label", () => {
  it("turns enforcement on in the same transaction, on every labelled table, and removing it turns it off", async () => {
    const { during, after } = await rolledBack(async (tx) => {
      await publicOnly(tx);
      await defineSecondLabel(tx);
      const during = await catalog(tx);
      await tx.query(`DELETE FROM labels WHERE name = 'schema-probe'`);
      return { during, after: await catalog(tx) };
    });
    expect(during.secured).toEqual(during.labelled);
    expect(during.policies).toEqual({ label_clearance: 99, label_own_insert: 99, label_sql_read: 99 });
    expect(during.judgmentGuards).toEqual(["argument_evaluations", "assessments", "quantity_estimates", "question_assessments"]);
    expect(during.collisionGuards).toBeGreaterThan(30);
    // Every labelled table keeps a row's label as it was written.
    expect(during.labelFixedGuards).toBe(99);
    // And lets a cleared connection change or delete one only at its own label.
    expect(during.ownLabelGuards).toBe(99);
    expect(after.secured).toEqual([]);
    expect(after.policies).toEqual({});
    expect(after.judgmentGuards).toEqual([]);
    expect(after.collisionGuards).toBe(0);
    expect(after.labelFixedGuards).toBe(0);
    expect(after.ownLabelGuards).toBe(0);
  });

  it("lets the role the policies bind read the tables that say what a clearance is, and write none of them", async () => {
    const rights = await rolledBack(async (tx) => {
      await publicOnly(tx);
      await defineSecondLabel(tx);
      return tx.query<{ name: string; rights: string }>(
        `SELECT c.relname::text AS name,
                concat_ws(' ', CASE WHEN has_table_privilege('minerval_cleared', c.oid, 'SELECT') THEN 'select' END,
                               CASE WHEN has_table_privilege('minerval_cleared', c.oid, 'INSERT') THEN 'insert' END,
                               CASE WHEN has_table_privilege('minerval_cleared', c.oid, 'UPDATE') THEN 'update' END,
                               CASE WHEN has_table_privilege('minerval_cleared', c.oid, 'DELETE') THEN 'delete' END,
                               CASE WHEN has_table_privilege('minerval_cleared', c.oid, 'TRUNCATE') THEN 'truncate' END) AS rights
           FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace
            AND c.relname IN ('labels', 'label_reads', 'permission_grants', 'account_groups', 'administrative_events', 'claims',
                              'api_keys', 'oauth_tokens', 'oauth_clients', 'oauth_authorization_requests', 'contributors')
          ORDER BY c.relname`
      );
    });
    const expected: Record<string, string> = {
      account_groups: "select",
      // The administrators' log: added to, never changed.
      administrative_events: "select insert",
      // What says who a request is: a key or a token is as good as the account it names.
      api_keys: "select",
      // Any other table, for comparison.
      claims: "select insert update delete",
      // An account's row, all but the sign-in it belongs to (the trigger below).
      contributors: "select insert update delete",
      label_reads: "select",
      labels: "select",
      oauth_authorization_requests: "select",
      oauth_clients: "select",
      oauth_tokens: "select",
      permission_grants: "select",
    };
    const found = Object.fromEntries(rights.map((r) => [r.name, r.rights]));
    // The grants, the groups and the log come with the permissions
    // migration; where this runs before it, the step has nothing of theirs
    // to hold and the rest is checked.
    expect(Object.keys(found)).toEqual(expect.arrayContaining(["api_keys", "claims", "label_reads", "labels", "oauth_tokens"]));
    expect(found).toEqual(Object.fromEntries(Object.keys(found).map((name) => [name, expected[name]])));
    // And nothing at all in the schema that holds the signing key.
    const key = await rolledBack(async (tx) => {
      await publicOnly(tx);
      await defineSecondLabel(tx);
      return tx.query<{ usage: boolean }>(`SELECT has_schema_privilege('minerval_cleared', 'minerval_private', 'USAGE') AS usage`);
    });
    expect(key).toEqual([{ usage: false }]);
  });

  it("lets that role change through the money views only what settling money writes, column by column", async () => {
    const rights = await rolledBack(async (tx) => {
      await publicOnly(tx);
      await defineSecondLabel(tx);
      return tx.query<{ view: string; whole_row: string; columns: string | null }>(
        `SELECT c.relname::text AS view,
                concat_ws(' ', CASE WHEN has_table_privilege('minerval_cleared', c.oid, 'SELECT') THEN 'select' END,
                               CASE WHEN has_table_privilege('minerval_cleared', c.oid, 'INSERT') THEN 'insert' END,
                               CASE WHEN has_table_privilege('minerval_cleared', c.oid, 'UPDATE') THEN 'update' END,
                               CASE WHEN has_table_privilege('minerval_cleared', c.oid, 'DELETE') THEN 'delete' END) AS whole_row,
                (SELECT string_agg(a.attname::text, ', ' ORDER BY a.attnum) FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attnum > 0
                    AND has_column_privilege('minerval_cleared', c.oid, a.attnum, 'UPDATE')) AS columns
           FROM pg_class c WHERE c.relnamespace = 'minerval_whole'::regnamespace ORDER BY c.relname`
      );
    });
    expect(rights).toEqual([
      // No allocation is deleted through the view, and its key and its commissioner are not written.
      { view: "allocation_money", whole_row: "select", columns: "amount_micro_usd, spent_micro_usd, released_at" },
      // A regrant returned in full is deleted (mandate-terms-service.ts).
      { view: "regrant_money", whole_row: "select delete", columns: "amount_micro_usd, refunded_micro_usd" },
    ]);
  });

  it("holds the sign-in an account belongs to, with a trigger on that one column", async () => {
    const guards = await rolledBack(async (tx) => {
      await publicOnly(tx);
      const before = await tx.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'identity_fixed_guard'`);
      await defineSecondLabel(tx);
      const during = await tx.query<{ on_table: string; def: string }>(
        `SELECT tgrelid::regclass::text AS on_table, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'identity_fixed_guard'`
      );
      await tx.query(`DELETE FROM labels WHERE name = 'schema-probe'`);
      const after = await tx.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'identity_fixed_guard'`);
      return { before, during, after };
    });
    expect(guards.before).toEqual([]);
    expect(guards.during).toHaveLength(1);
    expect(guards.during[0]!.on_table).toBe("contributors");
    expect(guards.during[0]!.def).toContain("BEFORE UPDATE OF external_id");
    expect(guards.after).toEqual([]);
  });

  it("leaves temporary tables to the database's owner", async () => {
    const open = await rolledBack(async (tx) => {
      await publicOnly(tx);
      const [before] = await tx.query<{ open: boolean }>(`SELECT has_database_privilege('public', current_database(), 'TEMPORARY') AS open`);
      await defineSecondLabel(tx);
      const [during] = await tx.query<{ open: boolean }>(`SELECT has_database_privilege('public', current_database(), 'TEMPORARY') AS open`);
      return { before: before!.open, during: during!.open };
    });
    expect(open.during).toBe(false);
  });

  it("leaves the tables' owner reading and writing every row: the policies are not forced on it", async () => {
    const seen = await rolledBack(async (tx) => {
      await publicOnly(tx);
      await defineSecondLabel(tx);
      await tx.query(
        `INSERT INTO claims (text, sensitivity_label) VALUES ('schema probe, public', 'public'), ('schema probe, other', 'schema-probe')`
      );
      return tx.query<{ sensitivity_label: string }>(
        `SELECT sensitivity_label FROM claims WHERE text LIKE 'schema probe, %' ORDER BY text`
      );
    });
    expect(seen.map((r) => r.sensitivity_label)).toEqual(["schema-probe", "public"]);
  });

  it("refuses a row written without a label where the connection carries none, and gives it the connection's where it carries one", async () => {
    await expect(
      rolledBack(async (tx) => {
        await publicOnly(tx);
        await defineSecondLabel(tx);
        await tx.query(`INSERT INTO claims (text) VALUES ('schema probe, forgot')`);
      })
    ).rejects.toSatisfy((err) => sqlState(err) === "MVL01");
    const label = await rolledBack(async (tx) => {
      await publicOnly(tx);
      await defineSecondLabel(tx);
      await tx.query(`SET LOCAL minerval.label = 'schema-probe'`);
      const [row] = await tx.query<{ sensitivity_label: string }>(
        `INSERT INTO claims (text) VALUES ('schema probe, forgot') RETURNING sensitivity_label`
      );
      return row!.sensitivity_label;
    });
    expect(label).toBe("schema-probe");
  });

  it("makes every view in public read as its caller, and hands the read-only SQL views to the role the policies bind", async () => {
    const { invoker, owners } = await rolledBack(async (tx) => {
      await publicOnly(tx);
      await defineSecondLabel(tx);
      const invoker = await tx.query<{ name: string }>(
        `SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'v'
            AND NOT COALESCE((SELECT option_value = 'true' FROM pg_options_to_table(c.reloptions)
                               WHERE option_name = 'security_invoker'), false)`
      );
      const owners = await tx.query<{ owner: string }>(
        `SELECT DISTINCT o.rolname::text AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_roles o ON o.oid = c.relowner WHERE n.nspname = 'public_read' AND c.relkind = 'v'`
      );
      return { invoker, owners };
    });
    expect(invoker).toEqual([]);
    expect(owners).toEqual([{ owner: "minerval_sql_views" }]);
  });
});

describe("the functions that run with their owner's rights", () => {
  it("search pg_catalog and then the session's temporary schema, so no temporary table can stand in for a relation they name", async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const definers = await client.query<{ name: string; config: string[] | null; body: string }>(
        `SELECT p.proname::text AS name, p.proconfig AS config, p.prosrc AS body
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname LIKE 'minerval\_%' AND p.prosecdef
          ORDER BY p.proname`
      );
      expect(definers.rows.map((d) => d.name)).toEqual([
        "minerval_enforcement_sync",
        "minerval_judgment_label_guard",
        "minerval_labels_changed",
        "minerval_sql_clearance",
        "minerval_unseen_collision_guard",
        "minerval_version_standing",
      ]);
      for (const d of definers.rows) {
        expect(d.config, d.name).toEqual(["search_path=pg_catalog, pg_temp"]);
        // Every catalog relation is named with its schema.
        expect(d.body.match(/\b(?:FROM|JOIN)\s+pg_(?!catalog\.)[a-z_]+\b/g) ?? [], d.name).toEqual([]);
      }
    } finally {
      await client.end();
    }
  });
});

describe("the roles", () => {
  it("exist without a superuser's rights or a way past row-level security, and own no table", async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const roles = await client.query<{ name: string; login: boolean; elevated: boolean; tables: number }>(
        `SELECT r.rolname::text AS name, r.rolcanlogin AS login, (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole) AS elevated,
                (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid AND c.relkind IN ('r', 'p')) AS tables
           FROM pg_roles r WHERE r.rolname IN ('minerval_cleared', 'minerval_sql_views') ORDER BY r.rolname`
      );
      expect(roles.rows.map((r) => ({ name: r.name, elevated: r.elevated, tables: r.tables }))).toEqual([
        { name: "minerval_cleared", elevated: false, tables: 0 },
        { name: "minerval_sql_views", elevated: false, tables: 0 },
      ]);
      // minerval_cleared may have been given its login already by another
      // database on this server that holds reads to a clearance; the role
      // that owns the read-only SQL views never logs in.
      expect(roles.rows[1]!.login).toBe(false);
      const [key] = (await client.query<{ n: number }>(`SELECT length(key) AS n FROM minerval_private.sql_clearance_key`)).rows;
      expect(key!.n).toBe(64);
    } finally {
      await client.end();
    }
  });
});
