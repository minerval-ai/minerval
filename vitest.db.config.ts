import { defineConfig } from "vitest/config";
import { DB_TEST_WORKERS } from "./tests/db/urls.js";

/**
 * The DB-backed integration suite: real SQL against a real Postgres with
 * pgvector, no mocks. Run with `npm run test:db`.
 *
 * Global setup drops and recreates the scratch database
 * (TEST_DATABASE_URL, default episteme_dbtest), applies the full
 * migration chain from zero, so every run starts clean and a broken
 * migration fails the suite before any test runs, and then copies the
 * migrated database once for each worker (tests/db/urls.ts).
 *
 * Files run DB_TEST_WORKERS at a time (4 unless set), each worker on its
 * own copy. Within a worker files still run one after another: the suite
 * exercises cross-table money invariants (advisory locks, session-level
 * triggers, whole-table assertions) that must not interleave, and they
 * cannot, because nothing else uses that worker's database meanwhile.
 *
 * What a database does not hold is shared by every worker: the server's
 * roles. A file that changes a role the application logs in as is listed in
 * SERVER_WIDE and runs alone, after the others have finished, so that no
 * other worker opens a connection while that role's password is not the one
 * it expects.
 */
const SERVER_WIDE = [
  // Sets minerval_cleared's password to another deployment's, to show a
  // process fails closed (src/db/client.ts, ensureClearedLogin).
  "tests/db/enforcement-review.test.ts",
];

const shared = {
  globals: true,
  environment: "node",
  setupFiles: ["tests/db/setup.ts"],
  // Real-DB tests do real work (migrations already ran in global setup,
  // but concurrency tests hold locks); give them room.
  testTimeout: 30_000,
  hookTimeout: 60_000,
} as const;

export default defineConfig({
  test: {
    globalSetup: ["tests/db/global-setup.ts"],
    maxWorkers: DB_TEST_WORKERS,
    projects: [
      {
        test: {
          ...shared,
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          exclude: SERVER_WIDE,
          maxWorkers: DB_TEST_WORKERS,
          fileParallelism: DB_TEST_WORKERS > 1,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          ...shared,
          name: "db-server-wide",
          include: SERVER_WIDE,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
