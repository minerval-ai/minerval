import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The DB-backed integration suite needs a real Postgres and runs via
    // `npm run test:db` (vitest.db.config.ts); the mocked unit suite must
    // never pick it up.
    exclude: ["tests/db/**", "**/node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
