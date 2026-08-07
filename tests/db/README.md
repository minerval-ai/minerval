# DB-backed integration tests

Real SQL against a real Postgres — no mocks. The mocked unit suite
(`npm test`) string-matches SQL and therefore cannot see autocommit-lock
no-ops, `ON CONFLICT` / partial-index inference, CHECK constraints,
transaction rollback, or race guards; this suite exists precisely to
cover that class of bug on the money/allocation paths.

## Running locally

Requirements: Postgres 16 on `localhost:5432` with the pgvector package
installed, and a role that can create databases (the dev default is
`episteme` / `episteme`).

```sh
npm run test:db
```

Every run starts from a clean slate: the global setup
(`tests/db/global-setup.ts`) drops and recreates the scratch database
(`episteme_dbtest` by default), enables the `vector` extension, and
applies the full migration chain (`src/db/migrations/0000` onward) with
drizzle-kit — so migration-from-zero is itself under test, and a broken
migration fails the suite loudly before any test runs.

Non-default Postgres? Override the URLs:

```sh
TEST_DATABASE_URL=postgresql://user:pass@host:5432/my_scratch_db \
TEST_DATABASE_ADMIN_URL=postgresql://user:pass@host:5432/postgres \
npm run test:db
```

The admin URL is used only to drop/recreate the scratch database. The
setup refuses to run against a database named `episteme` (the dev DB).

## Layout

- `vitest.db.config.ts` — the suite's own vitest config. `npm test`
  excludes `tests/db/**`, so the mocked suite never needs a database.
- `global-setup.ts` — scratch DB from zero + migrations.
- `setup.ts` — points the app's `DATABASE_URL` at the scratch DB per
  worker and closes the pool after each file.
- `helpers.ts` — seeders minting unique identities per test, so tests
  never couple through shared rows.
- Test files run sequentially (`fileParallelism: false`): they assert
  cross-table money invariants and run genuine concurrency tests
  (parallel promises against the real DB) that must not interleave with
  other files.

## What it covers

- **Schema guards** (`schema-guards.test.ts`): the migration 0038 CHECK
  constraints (`spent <= amount`, exactly-one-funder, positive amounts,
  `refunded <= amount` on regrants) and partial unique indexes (one open
  assessment order per user × claim; one live allocator placement per
  grant × group × pin, with released/fully-spent rows not blocking).
- **Action completion** (`action-completion.test.ts`): pro-rata
  consumption, losing-pin release with owl refund, settlement of unspent
  remainders exactly once, sibling supersession, second-completion
  no-op, genuine transaction rollback (induced mid-flight failure), and
  two racing completers.
- **Budget refunds** (`budget-refund.test.ts`): grant-backed escrow
  accounting (shares + non-ledger metering, regrants-out held back,
  outstanding allocations released first) and the regrant-return paths
  (live source stamped without a budget credit; dead source's funder
  credited exactly once). One `it.fails` documents a known
  idempotency bug — see the comment in the file.
- **Regrants** (`regrants.test.ts`): headroom enforcement, guarded
  target credit (dead target → no regrant row), paused-target resume,
  racing regrants never overcommitting the escrow.
- **Owl ledger** (`owl-ledger.test.ts`): `chargeOwls` idempotency key
  (same key twice → one debit, same entry id), raced, plus the balance
  guard.
- **Allocator concurrency** (`allocator-concurrency.test.ts`): N
  parallel `runMandateAllocator` passes commit the daily rate once.

## CI

`.github/workflows/ci.yml` job `db-tests`: a `pgvector/pgvector:pg16`
service container (health-checked), `npm ci`, then `npm run test:db` —
the same migration-from-zero flow as local runs.
