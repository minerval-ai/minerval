/**
 * Per-worker setup for the DB-backed suite: point the app's own config at
 * the scratch database BEFORE any service module loads config, and close
 * the pool when the file's tests finish so vitest can exit.
 */
import { afterAll, beforeAll } from "vitest";
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
// where it names nothing, which is what it always was. The tests of
// enforcement itself set their own.
//
// ENFORCEMENT_SUITE runs the whole suite as on a deployment that has a
// second label from the start, so every file runs with the policies on:
//   ENFORCEMENT_SUITE=system   out-of-context work is the owner's, as above;
//   ENFORCEMENT_SUITE=public   it is a cleared connection at `public`, which
//                              is what a deployment's own would be. Tests
//                              that seed rows at other labels from outside
//                              any run, or change tables, are refused there.
const { setNoContextSessionForTests, withSystemClearance } = await import("../../src/db/clearance.js");
const { ensureEnforcement, setEnforcementSettleMs } = await import("../../src/db/enforcement.js");
setNoContextSessionForTests(
  process.env.ENFORCEMENT_SUITE === "public"
    ? { role: "cleared", clearance: ["public"], label: "public" }
    : { role: "owner", label: "public" }
);
if (process.env.ENFORCEMENT_SUITE) {
  beforeAll(async () => {
    const { rawQuery } = await import("../../src/db/client.js");
    await withSystemClearance("The suite defines a second label before each file, to run it with the policies on.", () =>
      rawQuery(
        `INSERT INTO labels (name, description) VALUES ('suite-second', 'Defined by the suite when ENFORCEMENT_SUITE is set.')
         ON CONFLICT (name) DO NOTHING`
      )
    );
    await ensureEnforcement();
  });
}
// Defining the first private label waits for other processes to notice
// enforcement (armEnforcement). A test run is one process.
setEnforcementSettleMs(0);

afterAll(async () => {
  const { closeDb } = await import("../../src/db/client.js");
  await closeDb();
});
