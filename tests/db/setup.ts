/**
 * Per-worker setup for the DB-backed suite: point the app's own config at
 * the scratch database BEFORE any service module loads config, and close
 * the pool when the file's tests finish so vitest can exit.
 */
import { afterAll } from "vitest";
import { TEST_DATABASE_URL } from "./urls.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;
// Keep config in its dev posture (no SSL, default caps) regardless of the
// invoking shell.
process.env.ENVIRONMENT = "development";

afterAll(async () => {
  const { closeDb } = await import("../../src/db/client.js");
  await closeDb();
});
