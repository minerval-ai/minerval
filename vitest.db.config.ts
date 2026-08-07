import { defineConfig } from "vitest/config";

/**
 * The DB-backed integration suite: real SQL against a real Postgres with
 * pgvector, no mocks. Run with `npm run test:db`.
 *
 * Global setup drops and recreates the scratch database
 * (TEST_DATABASE_URL, default episteme_dbtest) and applies the full
 * migration chain from zero, so every run starts clean and a broken
 * migration fails the suite before any test runs.
 *
 * Files run sequentially: the suite exercises cross-table money
 * invariants (advisory locks, session-level triggers, whole-table
 * assertions) that must not interleave across worker processes.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    globalSetup: ["tests/db/global-setup.ts"],
    setupFiles: ["tests/db/setup.ts"],
    fileParallelism: false,
    // Real-DB tests do real work (migrations already ran in global setup,
    // but concurrency tests hold locks); give them room.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
