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

// The suite's helpers seed rows and read them back outside any run, as the
// database's owner, naming no label. Once any test has defined a second
// label the database holds every connection to a clearance
// (src/db/clearance.ts), and work with nothing in context would read
// `public` alone and be refused an insert that names no label. So the suite
// says what its own out-of-context work is: the owner, writing `public`
// where it names nothing, which is what it always was. ENFORCEMENT_SUITE=
// public runs it as a cleared connection at `public` instead, to find what
// does not work there. The tests of enforcement itself set their own.
const { setNoContextSessionForTests } = await import("../../src/db/clearance.js");
const { setEnforcementSettleMs } = await import("../../src/db/enforcement.js");
setNoContextSessionForTests(
  process.env.ENFORCEMENT_SUITE === "public"
    ? { role: "cleared", clearance: ["public"], label: "public" }
    : { role: "owner", label: "public" }
);
// Defining the first private label waits for other processes to notice
// enforcement (armEnforcement). A test run is one process.
setEnforcementSettleMs(0);

afterAll(async () => {
  const { closeDb } = await import("../../src/db/client.js");
  await closeDb();
});
