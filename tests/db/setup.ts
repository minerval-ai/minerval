/**
 * Per-worker setup for the DB-backed suite: point the app's own config at
 * the scratch database BEFORE any service module loads config, and close
 * the pool when the file's tests finish so vitest can exit.
 */
import { afterAll } from "vitest";
import { TEST_DATABASE_URL } from "./urls.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;
// The label every connection of the suite writes at where an insert names
// none. A sensitivity_label column defaults to the label its connection
// carries (minerval_default_label), and where a second label exists an
// insert on a connection that carries none is refused, because a row is
// never public by omission. Some files define a second label and leave it,
// and the suite's helpers seed rows without naming one, as they always
// have. So the suite says what those rows are: public.
process.env.PGOPTIONS = "-c minerval.label=public";
// Keep config in its dev posture (no SSL, default caps) regardless of the
// invoking shell.
process.env.ENVIRONMENT = "development";

afterAll(async () => {
  const { closeDb } = await import("../../src/db/client.js");
  await closeDb();
});
