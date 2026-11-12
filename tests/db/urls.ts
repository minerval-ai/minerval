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
 * More scratch databases, for the mirror's tests (tests/db/mirror-*.test.ts
 * and private-on-mirror.test.ts): a publisher and a private deployment are
 * two databases, and carrying a graph from one to the other needs both.
 * Named after the suite's database (`<name>_mirror_a`, `_b`, `_c`) and made
 * by the global setup as copies of it once the migrations have run. `c` is
 * the publisher of private-on-mirror.test.ts alone, so that it and the
 * round trip, which each start a feed of their own, do not meet.
 */
export const MIRROR_DATABASE_SIDES = ["a", "b", "c"] as const;
export function mirrorDatabaseUrl(side: (typeof MIRROR_DATABASE_SIDES)[number], base: string = TEST_DATABASE_URL): string {
  const url = new URL(base);
  url.pathname = `${url.pathname}_mirror_${side}`;
  return url.toString();
}
