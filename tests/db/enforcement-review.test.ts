/**
 * What an independent review of the label wall found, each as a test that
 * the way across is closed. The reviewer's reproductions asserted what was
 * observed; these assert what must hold. Labels are `public`, `rev-a`,
 * `rev-b` and `rev-c`: `rev-a` and `rev-b` read `public`, `rev-c` reads
 * `rev-a` and `public`, and `rev-a` and `rev-b` do not read each other.
 *
 * Work with nothing in context is what it is in a deployment: a connection
 * that reads `public` alone. Only seeding and checking run as the owner.
 * Two findings are held elsewhere: a row's label does not change
 * (tests/db/enforcement.test.ts, "a write"), and what system work writes
 * for a recipient (tests/db/system-fan-out.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { closeDb, rawQuery } from "../../src/db/client.js";
import { clearedRolePassword, scramVerifier, setNoContextSessionForTests, withSystemClearance } from "../../src/db/clearance.js";
import { enforcementFacts, enforcementProblems, ensureEnforcement } from "../../src/db/enforcement.js";
import { loadConfig } from "../../src/config.js";
import { runAtLabel, runWithUsageContext } from "../../src/llm/usage-context.js";
import { getAttemptStats } from "../../src/services/attempt-stats-service.js";
import { addLabelRead, defineLabel, removeLabelRead } from "../../src/services/label-admin-service.js";
import { getRecordedPage } from "../../src/services/recorded-page-service.js";
import { listReportsAwaitingIssue } from "../../src/services/report-service.js";
import { runReadOnlyQuery } from "../../src/services/sql-service.js";
import { TEST_DATABASE_URL } from "./urls.js";

const A = "rev-a";
const B = "rev-b";
const C = "rev-c";

const system = <T>(fn: () => Promise<T>) => withSystemClearance("A review test seeds and checks rows at every label.", fn);
const at = <T>(label: string, fn: () => Promise<T>) => runAtLabel(label, "a review test", fn);
/** A signed-in person's request, as members-only.ts enters it. */
const asPerson = <T>(clearance: string[], fn: () => Promise<T>) => runWithUsageContext({ clearance }, fn);
const sqlState = (err: unknown) => (err as { code?: string } | null)?.code;
const refusedWith = async (code: string, work: () => Promise<unknown>) => {
  const err = await work().then(
    () => null,
    (e: unknown) => e
  );
  expect(sqlState(err), err instanceof Error ? err.message : String(err)).toBe(code);
};

const claimIds: Record<string, string> = {};
const tag = randomUUID().slice(0, 8);
const SQL_ROLE = "minerval_sql_dbtest";
const SQL_PASSWORD = "dbtest-sql";
let actor = "";

function sqlRoleUrl(): string {
  const url = new URL(TEST_DATABASE_URL);
  url.username = SQL_ROLE;
  url.password = SQL_PASSWORD;
  return url.toString();
}

beforeAll(async () => {
  setNoContextSessionForTests(null);
  await system(async () => {
    await rawQuery(
      `INSERT INTO labels (name, description) VALUES ($1, 'One partner.'), ($2, 'Another partner.'), ($3, 'Reads the first.')
       ON CONFLICT (name) DO NOTHING`,
      [A, B, C]
    );
    await rawQuery(
      `INSERT INTO label_reads (label, reads) VALUES ($1, 'public'), ($2, 'public'), ($3, $1), ($3, 'public') ON CONFLICT DO NOTHING`,
      [A, B, C]
    );
  });
  await ensureEnforcement();
  await system(async () => {
    for (const label of ["public", A, B, C]) {
      const [row] = await rawQuery<{ id: string }>(
        `INSERT INTO claims (text, steward_state, tagged_at, sensitivity_label) VALUES ($1, 'done', now(), $2) RETURNING id`,
        [`Review ${tag} claim at ${label}: the ${label} partner's secret figure is 42`, label]
      );
      claimIds[label] = row!.id;
    }
    const [account] = await rawQuery<{ id: string }>(
      `INSERT INTO contributors (external_id, display_name) VALUES ($1, 'Review actor') RETURNING id`,
      [`review-actor-${tag}`]
    );
    actor = account!.id;
    // Read-only SQL's login role, as the suite's own helper makes it.
    await rawQuery(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SQL_ROLE}') THEN
        CREATE ROLE ${SQL_ROLE} LOGIN PASSWORD '${SQL_PASSWORD}' CONNECTION LIMIT 3 IN ROLE minerval_sql;
      END IF; END $$`);
  });
  Object.assign(loadConfig(), { sqlAgentDatabaseUrl: sqlRoleUrl() });
});

afterAll(async () => {
  await system(async () => {
    await rawQuery(`DELETE FROM proof_attempts WHERE claim_id = ANY($1::uuid[])`, [Object.values(claimIds)]);
    await rawQuery(`DELETE FROM claim_formalizations WHERE claim_id = ANY($1::uuid[])`, [Object.values(claimIds)]);
    await rawQuery(`DELETE FROM action_allocations WHERE claim_id = ANY($1::uuid[])`, [Object.values(claimIds)]);
    await rawQuery(`DELETE FROM claim_instances WHERE claim_id = ANY($1::uuid[])`, [Object.values(claimIds)]);
    await rawQuery(`DELETE FROM sources WHERE sensitivity_label = ANY($1::text[])`, [[A, B, C]]);
    await rawQuery(`DELETE FROM agent_reports WHERE sensitivity_label = ANY($1::text[])`, [[A, B, C]]);
    await rawQuery(`DELETE FROM claims WHERE id = ANY($1::uuid[])`, [Object.values(claimIds)]);
    await rawQuery(`DELETE FROM administrative_events WHERE actor_id = $1`, [actor]);
    await rawQuery(`DELETE FROM contributors WHERE external_id LIKE $1`, [`review-%-${tag}`]);
    await rawQuery(`DELETE FROM label_reads WHERE label = ANY($1::text[])`, [[A, B, C]]);
    await rawQuery(`DELETE FROM labels WHERE name = ANY($1::text[])`, [[A, B, C]]);
  });
});

// ---------------------------------------------------------------------------

describe("1. an in-memory cache is kept for one kind of reader", () => {
  it("getRecordedPage does not hand a reader of public the passages it found for a reader of rev-a", async () => {
    const urlHash = createHash("sha256").update(`review-${tag}`).digest("hex");
    await system(async () => {
      const [src] = await rawQuery<{ id: string }>(
        `INSERT INTO sources (title, url, page_url_hash, sensitivity_label) VALUES ('Partner A internal memo', $1, $2, $3) RETURNING id`,
        [`https://partner-a.example/${tag}`, urlHash, A]
      );
      await rawQuery(
        `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, sensitivity_label)
         VALUES ($1, $2, 'A-ONLY PASSAGE: the secret figure is 42', $3)`,
        [claimIds[A], src!.id, A]
      );
    });
    expect(await getRecordedPage(urlHash)).toBeNull();
    // A person cleared for rev-a opens the page.
    const forA = await asPerson(["public", A], () => getRecordedPage(urlHash));
    expect(forA?.passages[0]?.verbatim_text).toContain("A-ONLY PASSAGE");
    // Within the cache's minute, nobody else gets that answer.
    expect(await getRecordedPage(urlHash)).toBeNull();
    expect(await asPerson(["public", B], () => getRecordedPage(urlHash))).toBeNull();
    expect(await at(B, () => getRecordedPage(urlHash))).toBeNull();
    // A reader with the same clearance does, and so does a run whose label reads rev-a.
    expect((await asPerson([A, "public"], () => getRecordedPage(urlHash)))?.sources[0]?.title).toBe("Partner A internal memo");
    expect((await at(C, () => getRecordedPage(urlHash)))?.passages[0]?.verbatim_text).toContain("A-ONLY PASSAGE");
  });

  it("getAttemptStats does not hand a reader of public a record counted over rev-a's attempts", async () => {
    await system(async () => {
      const [f] = await rawQuery<{ id: string }>(
        `INSERT INTO claim_formalizations
           (claim_id, version, pin_id, lean_toolchain, mathlib_rev, image_digest, namespace, statement_source,
            source_hash, expr_hash, pp_type, constants, definitions_axioms, witness_present, authored_by, sensitivity_label)
         VALUES ($1, 1, 'p', 't', 'm', 'd', 'n', 's', 'h', 'e', 'pp', '[]', '[]', false, 'review', $2) RETURNING id`,
        [claimIds[A], A]
      );
      await rawQuery(
        `INSERT INTO proof_attempts
           (claim_id, formalization_id, model, variant, effort, status, outcome, ceiling_micro_usd, spent_micro_usd,
            finished_at, published_at, sensitivity_label)
         VALUES ($1, $2, 'm', 'standard', 'high', 'completed', 'proof', 5000000, 3000000, now(), now(), $3)`,
        [claimIds[A], f!.id, A]
      );
    });
    const before = (await getAttemptStats()).totals.attempts;
    const forA = await asPerson(["public", A], () => getAttemptStats());
    expect(forA.totals.attempts).toBe(before + 1);
    expect(JSON.stringify(forA)).toContain("partner's secret figure");
    const forPublic = await getAttemptStats();
    expect(forPublic.totals.attempts).toBe(before);
    expect(JSON.stringify(forPublic)).not.toContain("partner's secret figure");
    expect((await asPerson(["public", B], () => getAttemptStats())).totals.attempts).toBe(before);
  });
});

describe("2. a commission's text carries the label of the run that wrote it, and its money is still read whole", () => {
  it("is not shown by read-only SQL to a reader who does not read that label, and the node it is on is not named", async () => {
    const [payer] = await system(() =>
      rawQuery<{ id: string }>(`INSERT INTO contributors (external_id, display_name) VALUES ($1, 'Review payer') RETURNING id`, [
        `review-payer-${tag}`,
      ])
    );
    const group = `assess:${claimIds[A]}`;
    // The statement names no label, as the reviewer's did: the row takes the run's.
    await at(A, () =>
      rawQuery(
        `INSERT INTO action_allocations (exclusion_group, claim_id, user_id, amount_micro_usd, commissioned_by, brief, reason)
         VALUES ($1, $2, $3, 1000000, 'claim_steward',
                 'A-ONLY BRIEF: check whether partner A''s unreleased trial really shows the 42% effect', 'follow-up')`,
        [group, claimIds[A], payer!.id]
      )
    );
    const [row] = await system(() =>
      rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM action_allocations WHERE exclusion_group = $1`, [group])
    );
    expect(row!.l).toBe(A);

    const briefs = (label: string | null) => {
      const read = () => runReadOnlyQuery(`SELECT brief FROM commissions WHERE brief LIKE 'A-ONLY%'`, [], { audience: "agent" });
      return label ? at(label, read) : read();
    };
    expect((await briefs(null)).rows).toEqual([]);
    expect((await briefs(B)).rows).toEqual([]);
    expect((await briefs(A)).rows).toHaveLength(1);
    expect((await briefs(C)).rows).toHaveLength(1);
    const changes = await runReadOnlyQuery(
      `SELECT node_id FROM changes WHERE kind = 'work_commissioned' AND node_id = $1`,
      [claimIds[A]],
      { audience: "agent" }
    );
    expect(changes.rows).toEqual([]);

    // On the application's own connection the table shows the row by its
    // label, and the money view shows the amount to every label, without
    // the text: a run's cost is split across everyone who paid for it.
    const onTable = () => rawQuery(`SELECT 1 FROM action_allocations WHERE exclusion_group = $1`, [group]);
    const money = () =>
      rawQuery<{ placed: string }>(
        `SELECT COALESCE(SUM(amount_micro_usd), 0)::text AS placed FROM minerval_whole.allocation_money WHERE exclusion_group = $1`,
        [group]
      );
    expect(await at(B, onTable)).toEqual([]);
    expect(await at(A, onTable)).toHaveLength(1);
    expect(await at(B, money)).toEqual([{ placed: "1000000" }]);
    expect(await money()).toEqual([{ placed: "1000000" }]);
    await refusedWith("42703", () => at(A, () => rawQuery(`SELECT brief FROM minerval_whole.allocation_money LIMIT 1`)));
  });
});

describe("3. a temporary table cannot stand in for a catalog the wall reads", () => {
  const asSqlRole = async <T>(fn: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new pg.Client({ connectionString: sqlRoleUrl() });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  };
  const shadow = `CREATE TEMP TABLE pg_roles AS SELECT session_user::name AS rolname, true AS rolsuper, 0::oid AS oid`;

  it("because a read-only SQL login may not make one", async () => {
    await asSqlRole(async (client) => {
      await refusedWith("42501", () => client.query(shadow));
    });
  });

  it("and because one that exists is not looked at: the clearance stays public alone", async () => {
    const database = new URL(TEST_DATABASE_URL).pathname.slice(1);
    // Hand the login the right back, as an operator's mistake would.
    await system(() => rawQuery(`GRANT TEMPORARY ON DATABASE ${database} TO ${SQL_ROLE}`));
    try {
      await asSqlRole(async (client) => {
        const clearance = async () => (await client.query<{ c: string[] }>(`SELECT public.minerval_sql_clearance() AS c`)).rows[0]!.c;
        expect(await clearance()).toEqual(["public"]);
        await client.query(shadow);
        await client.query(`GRANT SELECT ON pg_roles TO PUBLIC`);
        expect(await clearance()).toEqual(["public"]);
        const seen = await client.query(`SELECT text FROM public_read.nodes WHERE id = ANY($1::uuid[])`, [Object.values(claimIds)]);
        expect(seen.rows).toHaveLength(1);
      });
    } finally {
      await system(() => rawQuery(`REVOKE TEMPORARY ON DATABASE ${database} FROM ${SQL_ROLE}`));
    }
  });
});

describe("5. only public reports are ever chosen for the issue tracker", () => {
  it("whoever asks, the owner included", async () => {
    const title = `A-ONLY REPORT ${tag}: tool failed on partner A document /internal/q3-forecast`;
    await at(A, () =>
      rawQuery(
        `INSERT INTO agent_reports (dedupe_key, title, body, agent, severity, kind)
         VALUES ($1, $2, 'details of a''s material', 'claim_steward', 'medium', 'tool_gap')`,
        [`review-${tag}`, title]
      )
    );
    const open = `Public report ${tag}`;
    await rawQuery(
      `INSERT INTO agent_reports (dedupe_key, title, body, agent, severity, kind, sensitivity_label)
       VALUES ($1, $2, 'public details', 'claim_steward', 'medium', 'tool_gap', 'public')`,
      [`review-public-${tag}`, open]
    );
    const titles = async (read: <T>(fn: () => Promise<T>) => Promise<T>) =>
      (await read(() => listReportsAwaitingIssue(500, { includeExternal: true })))
        .map((r) => r.title)
        .filter((t) => t.includes(tag));
    // As the worker runs it now (nothing in context), and as it ran before (system clearance).
    expect(await titles((fn) => fn())).toEqual([open]);
    expect(await titles(system)).toEqual([open]);
    expect(await titles((fn) => at(A, fn))).toEqual([open]);
    await system(() => rawQuery(`DELETE FROM agent_reports WHERE dedupe_key = $1`, [`review-public-${tag}`]));
  });
});

describe("7. a view in public that reads as its owner is found before anything is served", () => {
  it("the startup check names it, and the step sets it right", async () => {
    // What CREATE OR REPLACE VIEW without the option does to a view: the
    // schema and a unit test keep a migration from doing it
    // (tests/unit/db/migration-views.test.ts); this is the net under them.
    const view = "assessments_in_force";
    const [def] = await system(() => rawQuery<{ def: string }>(`SELECT pg_get_viewdef('public.${view}'::regclass) AS def`));
    await system(() => rawQuery(`CREATE OR REPLACE VIEW public.${view} AS ${def!.def}`));
    try {
      const facts = await enforcementFacts();
      expect(facts.viewsReadingAsOwner).toEqual([view]);
      expect(enforcementProblems(facts).join(" ")).toContain(view);
    } finally {
      const { changes } = await ensureEnforcement();
      expect(changes).toEqual([`+ view ${view}: reads with its caller's rights`]);
    }
    expect((await enforcementFacts()).viewsReadingAsOwner).toEqual([]);
    // Replaced as the schema now says it, the view never stops being held.
    await system(() => rawQuery(`CREATE OR REPLACE VIEW public.${view} WITH (security_invoker = true) AS ${def!.def}`));
    expect((await enforcementFacts()).viewsReadingAsOwner).toEqual([]);
  });
});

describe("8. a connection held to a clearance cannot change what a clearance is", () => {
  const DENIED = "42501";

  it("cannot add a pair, define a label, grant a permission or join a group", async () => {
    for (const work of [
      () => rawQuery(`INSERT INTO label_reads (label, reads) VALUES ('public', $1)`, [A]),
      () => rawQuery(`INSERT INTO label_reads (label, reads) VALUES ($1, $2)`, [B, A]),
      () => rawQuery(`DELETE FROM label_reads WHERE label = $1`, [A]),
      () => rawQuery(`INSERT INTO labels (name, description) VALUES ('rev-made-up', 'x')`),
      () => rawQuery(`UPDATE labels SET description = 'x' WHERE name = $1`, [A]),
      () => rawQuery(`INSERT INTO permission_grants (permission, account_id, label, granted_via) VALUES ('read', $1, $2, 'operator')`, [actor, A]),
      () => rawQuery(`UPDATE permission_grants SET removed_at = NULL`),
      () => rawQuery(`INSERT INTO account_groups (account_id, group_name) VALUES ($1, 'everyone')`, [actor]),
      () => rawQuery(`UPDATE administrative_events SET detail = '{}'::jsonb`),
      () => rawQuery(`DELETE FROM administrative_events`),
    ]) {
      await refusedWith(DENIED, work);
      await refusedWith(DENIED, () => at(C, work));
      await refusedWith(DENIED, () => asPerson(["public", A, B, C], work));
    }
    // It reads them, as the application must to know what a label reads.
    expect((await rawQuery(`SELECT 1 FROM label_reads WHERE label = $1`, [C])).length).toBe(2);
  });

  it("and public reads no other label even on the owner's connection", async () => {
    await refusedWith("23514", () => system(() => rawQuery(`INSERT INTO label_reads (label, reads) VALUES ('public', $1)`, [A])));
  });

  it("while an administrator's change, made through the service, is written on the owner's connection and logged", async () => {
    // From a request held to public alone, as an administrator's request is.
    expect(await addLabelRead({ label: B, reads: A, actorId: actor })).toEqual({ ok: true });
    expect(await at(B, () => rawQuery(`SELECT 1 FROM claims WHERE id = $1`, [claimIds[A]]))).toHaveLength(1);
    expect(await removeLabelRead({ label: B, reads: A, actorId: actor })).toEqual({ ok: true });
    const logged = await rawQuery<{ action: string }>(
      `SELECT action FROM administrative_events WHERE actor_id = $1 ORDER BY created_at`,
      [actor]
    );
    expect(logged.map((e) => e.action)).toEqual(["label_read_added", "label_read_removed"]);
    // A label cannot be called null: the word is no label where a clearance is written.
    expect(await defineLabel({ name: "null", description: "x", actorId: actor })).toMatchObject({ ok: false, code: "INVALID_NAME" });
  });
});

describe("9. the cleared role's password is never sent", () => {
  /**
   * Whether this server checks a password at all. A development server set
   * to trust local connections does not, and then a wrong password cannot
   * be told from a right one: the two tests below that need a refusal say
   * so and stop. CI's server checks, and so does the second local one.
   */
  async function passwordsAreChecked(): Promise<boolean> {
    const url = new URL(TEST_DATABASE_URL);
    url.username = "minerval_cleared";
    url.password = "not-the-password";
    const probe = new pg.Client({ connectionString: url.toString() });
    try {
      await probe.connect();
      await probe.end();
      return false;
    } catch {
      return true;
    }
  }

  it("what the server is given is a verifier the password cannot be read out of, and a login with the password then works", async () => {
    const config = loadConfig();
    const password = clearedRolePassword(config.databaseUrl, config.clearedRolePassword);
    const verifier = scramVerifier(password);
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(verifier).not.toContain(password);
    // Another salt each time: the same password never gives the same statement twice.
    expect(scramVerifier(password)).not.toBe(verifier);

    // Something else set the role's password. A process that has not yet
    // logged in puts its own back, as the verifier, and then logs in.
    const checked = await passwordsAreChecked();
    await system(() => rawQuery(`ALTER ROLE minerval_cleared WITH LOGIN PASSWORD '${scramVerifier("some other deployment's password")}'`));
    await closeDb();
    setNoContextSessionForTests(null);
    if (checked) {
      // The login this process is about to use does not work until it sets it.
      const url = new URL(TEST_DATABASE_URL);
      url.username = "minerval_cleared";
      url.password = password;
      const before = new pg.Client({ connectionString: url.toString() });
      await expect(before.connect()).rejects.toSatisfy((err) => sqlState(err) === "28P01");
    }
    await ensureEnforcement();
    expect(await rawQuery<{ u: string }>(`SELECT current_user::text AS u`)).toEqual([{ u: "minerval_cleared" }]);
  });

  it("a process that has logged in before and is then refused does not fight over the password: it fails closed and says why", async () => {
    expect(await rawQuery<{ u: string }>(`SELECT current_user::text AS u`)).toEqual([{ u: "minerval_cleared" }]);
    if (!(await passwordsAreChecked())) {
      console.warn("[enforcement-review] this server trusts local connections, so a refused login cannot be shown here");
      return;
    }
    const theirs = scramVerifier("a newer deployment's password");
    await system(() => rawQuery(`ALTER ROLE minerval_cleared WITH LOGIN PASSWORD '${theirs}'`));
    try {
      // A session this process has not opened a pool for yet needs a new login.
      const err = await asPerson(["public", A, B], () => rawQuery(`SELECT 1`)).then(
        () => null,
        (e: unknown) => e
      );
      expect(String((err as Error | null)?.message ?? `no error: ${JSON.stringify(err)}`)).toMatch(/password was changed after this process started/);
    } finally {
      // The start of a process puts things right: nothing has logged in yet, so it sets the password.
      await closeDb();
      setNoContextSessionForTests(null);
      await ensureEnforcement();
    }
    expect(await asPerson(["public", A, B], () => rawQuery<{ u: string }>(`SELECT current_user::text AS u`))).toEqual([
      { u: "minerval_cleared" },
    ]);
  });

  it("takes a configured secret in place of the derived one, and refuses one that is too short to be a secret", () => {
    const url = "postgresql://owner:first@localhost/db";
    expect(clearedRolePassword(url, "a-long-random-secret-of-the-deployment")).toBe("a-long-random-secret-of-the-deployment");
    // Derived: the same for one owner, another when the owner's password changes.
    expect(clearedRolePassword(url)).toBe(clearedRolePassword(url, null));
    expect(clearedRolePassword(url)).not.toBe(clearedRolePassword("postgresql://owner:second@localhost/db"));
    expect(() => clearedRolePassword(url, "short")).toThrow(/CLEARED_ROLE_PASSWORD/);
  });
});

describe("and the smaller things", () => {
  it("read-only SQL gives no planner's estimate where labels are held: it is taken over rows at every label", async () => {
    const result = await runReadOnlyQuery(`SELECT count(*) FROM nodes`, [], { audience: "agent" });
    expect(result).not.toHaveProperty("plan_cost");
    expect(result.note).toMatch(/public/);
  });
});
