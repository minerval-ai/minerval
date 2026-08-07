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
