/**
 * Connection URLs for the DB-backed suite. Defaults match both the local
 * dev Postgres (role episteme/episteme on 5432) and the CI service
 * container; override with env vars when yours differ.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://episteme:episteme@localhost:5432/episteme_dbtest";

/** Maintenance connection used only to drop/recreate the scratch DB. */
export const TEST_DATABASE_ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgresql://episteme:episteme@localhost:5432/postgres";

/**
 * Two more scratch databases, for the mirror's tests (tests/db/mirror-*.test.ts):
 * a publisher and a private deployment are two databases, and carrying a
 * graph from one to the other needs both. Named after the suite's database
 * (`<name>_mirror_a`, `<name>_mirror_b`) and made by the global setup as
 * copies of it once the migrations have run.
 */
export function mirrorDatabaseUrl(side: "a" | "b", base: string = TEST_DATABASE_URL): string {
  const url = new URL(base);
  url.pathname = `${url.pathname}_mirror_${side}`;
  return url.toString();
}
