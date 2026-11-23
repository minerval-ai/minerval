/**
 * Connection URLs for the DB-backed suite. Defaults match both the local
 * dev Postgres (role episteme/episteme on 5432) and the CI service
 * container; override with env vars when yours differ.
 *
 * The suite's files run in several workers at once (vitest.db.config.ts),
 * each on a database of its own: the global setup migrates the suite's
 * database once (TEST_DATABASE_TEMPLATE_URL, named by TEST_DATABASE_URL in
 * the environment) and copies it for each worker as `<name>_w<n>`. Inside a
 * worker TEST_DATABASE_URL is that worker's copy, so a file sees a database
 * no other file is using at the same moment, and the money tests' advisory
 * locks and whole-table assertions meet nothing from another worker.
 */
const BASE_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://episteme:episteme@localhost:5432/episteme_dbtest";

/**
 * How many workers the suite runs, and so how many copies the global setup
 * makes. DB_TEST_WORKERS sets it; 1 runs the files one after another, as
 * the suite did before it had copies.
 */
export const DB_TEST_WORKERS = Math.max(1, Number(process.env.DB_TEST_WORKERS ?? 4) || 1);

/** The vitest worker this process is (1 to DB_TEST_WORKERS), or null in the global setup's own process. */
export const DB_TEST_WORKER: number | null = process.env.VITEST_POOL_ID ? Number(process.env.VITEST_POOL_ID) : null;

/** The database a worker's copy is named after: `<name>_w<n>`. */
export function workerDatabaseUrl(worker: number, base: string = TEST_DATABASE_TEMPLATE_URL): string {
  const url = new URL(base);
  url.pathname = `${url.pathname}_w${worker}`;
  return url.toString();
}

/**
 * The database the migrations run on, which the workers' copies are taken
 * from. Only the global setup uses it; a file never does.
 *
 * tests/db/setup.ts puts this worker's URL into TEST_DATABASE_URL for the
 * files that read the environment before any import (vi.hoisted), so a URL
 * that already names this worker's copy is the copy's, not its template's.
 */
export const TEST_DATABASE_TEMPLATE_URL =
  DB_TEST_WORKER !== null && BASE_DATABASE_URL.replace(/\/?$/, "").endsWith(`_w${DB_TEST_WORKER}`)
    ? BASE_DATABASE_URL.replace(new RegExp(`_w${DB_TEST_WORKER}$`), "")
    : BASE_DATABASE_URL;

/** The database this process works on: its worker's copy, or the template outside any worker. */
export const TEST_DATABASE_URL =
  DB_TEST_WORKER === null ? TEST_DATABASE_TEMPLATE_URL : workerDatabaseUrl(DB_TEST_WORKER);

/** Maintenance connection used only to drop/recreate the scratch DB. */
export const TEST_DATABASE_ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgresql://episteme:episteme@localhost:5432/postgres";

/**
 * The login role the read-only SQL tests connect as. A role belongs to the
 * whole server, not to one database, so each worker has its own: two
 * workers making the same role at once would collide, and its connection
 * limit would be shared between them.
 */
export const SQL_TEST_ROLE = DB_TEST_WORKER === null ? "minerval_sql_dbtest" : `minerval_sql_dbtest_w${DB_TEST_WORKER}`;
export const SQL_TEST_PASSWORD = "dbtest-sql";

/**
 * More scratch databases, for the mirror's tests (tests/db/mirror-*.test.ts
 * and private-on-mirror.test.ts): a publisher and a private deployment are
 * two databases, and carrying a graph from one to the other needs both.
 * Named after the worker's database (`<name>_mirror_a` to `_g`) and made
 * by the global setup as copies of it once the migrations have run. `a` and
 * `b` are the round trip's alone, which expects to find them empty. `c` is
 * the publisher of private-on-mirror.test.ts alone, so that it and the
 * round trip, which each start a feed of their own, do not meet. `d` is the
 * public graph of published-pages.test.ts, which runs the app on it as a
 * second process, and `e` is the public graph of outward-acts.test.ts, which
 * does the same. `f` and `g` are the publisher and the private side of
 * mirror-routes.test.ts. No two files share one: the suite's files run in
 * no fixed order.
 */
export const MIRROR_DATABASE_SIDES = ["a", "b", "c", "d", "e", "f", "g"] as const;
export function mirrorDatabaseUrl(side: (typeof MIRROR_DATABASE_SIDES)[number], base: string = TEST_DATABASE_URL): string {
  const url = new URL(base);
  url.pathname = `${url.pathname}_mirror_${side}`;
  return url.toString();
}

/**
 * Databases a single file has to itself in place of its worker's copy,
 * because what the file does cannot be undone for the files that follow
 * it on that copy. The split of `public` into its three bottom layers
 * (src/services/label-split.ts) is such a thing: it happens once to a
 * deployment and is never reversed. `split` is a deployment that had
 * labels of its own and a mirror before it was split, and `split_bare`
 * one that had `public` alone (tests/db/label-split.test.ts). The file
 * points the app at one before anything loads the config (vi.hoisted).
 * Named after the worker's database (`<name>_own_<which>`), made by the
 * global setup as copies of it, and owned as it is.
 */
export const OWN_DATABASES = ["split", "split_bare", "split_hooks"] as const;
export function ownDatabaseUrl(which: (typeof OWN_DATABASES)[number], base: string = TEST_DATABASE_URL): string {
  const url = new URL(base);
  url.pathname = `${url.pathname}_own_${which}`;
  return url.toString();
}
