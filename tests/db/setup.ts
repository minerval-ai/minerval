/**
 * Per-worker setup for the DB-backed suite: point the app's own config at
 * the scratch database BEFORE any service module loads config, and close
 * the pool when the file's tests finish so vitest can exit.
 */
import { afterAll, beforeAll, vi } from "vitest";
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
//   ENFORCEMENT_SUITE=public-app  the same, except that a statement a test
//                              file sends itself, outside any run, is the
//                              owner's (ownStatementsAsOwner below). So a
//                              test's fixtures and its own look at the rows
//                              work, and what is left failing is the
//                              application, called from outside any run,
//                              meeting the wall: either correctly, because
//                              the test calls from nowhere what a worker
//                              calls under system clearance, or as a bug.
const suite = process.env.ENFORCEMENT_SUITE;
const { setNoContextSessionForTests, withSystemClearance } = await import("../../src/db/clearance.js");
const { ensureEnforcement, setEnforcementSettleMs } = await import("../../src/db/enforcement.js");
setNoContextSessionForTests(
  suite === "public" || suite === "public-app"
    ? { role: "cleared", clearance: ["public"], label: "public" }
    : { role: "owner", label: "public" }
);
if (suite === "public-app") await ownStatementsAsOwner();
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

/**
 * For ENFORCEMENT_SUITE=public-app: put the database client behind a layer
 * that sends a statement on the owner's connection when a file under tests/
 * is what called the client and no run is in progress, and otherwise leaves
 * the client exactly as it is. The caller is read from the stack at the
 * moment of the call, which is exact: the layer is called synchronously.
 *
 * The owner's connection here is one of the suite's own, with `public` as
 * its label, because a test's fixtures name no label and the application's
 * system clearance has none to give them.
 */
async function ownStatementsAsOwner(): Promise<void> {
  const pg = (await import("pg")).default;
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("../../src/db/schema.js");
  const { noteStatement, systemClearanceReason } = await import("../../src/db/clearance.js");
  const { getUsageContext } = await import("../../src/llm/usage-context.js");
  const own = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 10, options: "-c minerval.label=public" });
  afterAll(() => own.end());
  const logger = { logQuery: (query: string) => noteStatement(query) };

  const calledByATest = (): boolean => {
    // [0] the error, [1] this function, [2] the layer, [3] who called it.
    const caller = new Error().stack?.split("\n")[3] ?? "";
    if (!/\/tests\//.test(caller)) return false;
    const context = getUsageContext();
    return context.label === undefined && context.clearance === undefined && systemClearanceReason() === null;
  };

  vi.doMock("../../src/db/client.js", async (importOriginal) => {
    const client = await importOriginal<typeof import("../../src/db/client.js")>();
    return {
      ...client,
      rawQuery: async (text: string, params: unknown[] = []) => {
        if (!calledByATest()) return client.rawQuery(text, params);
        noteStatement(text);
        return (await own.query(text, params)).rows;
      },
      getDb: () => (calledByATest() ? drizzle(own, { schema, logger }) : client.getDb()),
      withTransaction: async (fn: (tx: import("../../src/db/client.js").TxQuery) => Promise<unknown>) => {
        if (!calledByATest()) return client.withTransaction(fn);
        const connection = await own.connect();
        try {
          await connection.query("BEGIN");
          const value = await fn({
            query: async (text: string, params: unknown[] = []) => {
              noteStatement(text);
              return (await connection.query(text, params)).rows;
            },
            db: drizzle(connection, { schema, logger }),
          } as import("../../src/db/client.js").TxQuery);
          await connection.query("COMMIT");
          return value;
        } catch (err) {
          await connection.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          connection.release();
        }
      },
    };
  });
}
