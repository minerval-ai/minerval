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
      WHERE g.tgname IN ('judgment_label_guard', 'unseen_collision_guard')
      ORDER BY c.relname`
  );
  return {
    labelled: tables.map((t) => t.name),
    secured: tables.filter((t) => t.secured).map((t) => t.name),
    policies: Object.fromEntries(policies.map((p) => [p.name, p.n])),
    judgmentGuards: guards.filter((g) => g.name === "judgment_label_guard").map((g) => g.table_name),
    collisionGuards: guards.filter((g) => g.name === "unseen_collision_guard").length,
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
 * labels stay behind for the length of the transaction, which is why their
 * foreign keys are not checked while the labels go (the suite's role is a
 * superuser, locally and in CI). The connection is also left carrying no
 * label, which is what every connection of a deployment carries today; the
 * suite's own carry `public` (tests/db/setup.ts).
 */
async function publicOnly(tx: TxQuery): Promise<void> {
  await tx.query(`SET LOCAL minerval.label = ''`);
  await tx.query(`SET LOCAL session_replication_role = replica`);
  await tx.query(`DELETE FROM label_reads`);
  await tx.query(`DELETE FROM labels WHERE name <> 'public'`);
  await tx.query(`SET LOCAL session_replication_role = origin`);
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
    expect(now.labelled.length).toBe(95);
    expect(now.secured).toEqual([]);
    expect(now.policies).toEqual({});
    expect(now.judgmentGuards).toEqual([]);
    expect(now.collisionGuards).toBe(0);
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

  it("holds a label's name to a plain word", async () => {
    for (const name of ["Not Plain", "a b", "a}", "", "1a", "a'b"]) {
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
    expect(during.policies).toEqual({ label_clearance: 95, label_own_insert: 95, label_sql_read: 95 });
    expect(during.judgmentGuards).toEqual(["argument_evaluations", "assessments", "quantity_estimates", "question_assessments"]);
    expect(during.collisionGuards).toBeGreaterThan(30);
    expect(after.secured).toEqual([]);
    expect(after.policies).toEqual({});
    expect(after.judgmentGuards).toEqual([]);
    expect(after.collisionGuards).toBe(0);
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
