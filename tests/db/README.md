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

It then copies the migrated database once per worker
(`episteme_dbtest_w1` to `_w4`, and each worker's mirror databases), and
the files run four at a time, each worker on its own copy.
`DB_TEST_WORKERS=1 npm run test:db` runs them one after another, which is
slower but easier to read when a test is being debugged. Four workers
want about 200 connections of the server (`max_connections`; Postgres's
default is 100): the compose file starts Postgres with 300, CI raises its
service container to the same, and the setup stops at once, saying so,
when the server has too few.

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
- `global-setup.ts` — scratch DB from zero + migrations, then a copy
  for each worker.
- `urls.ts` — the databases' URLs: the worker's own copy
  (`TEST_DATABASE_URL`), its mirror databases, and its read-only SQL login
  role.
- `setup.ts` — points the app's `DATABASE_URL` at the worker's copy and
  closes the pool after each file.
- `helpers.ts` — seeders minting unique identities per test, so tests
  never couple through shared rows.
- Within a worker, test files run one after another: they assert
  cross-table money invariants and run genuine concurrency tests
  (parallel promises against the real DB) that must not interleave with
  other files. Files in different workers cannot interleave, because each
  worker has a database of its own.
- What a database does not hold is shared by every worker: the server's
  roles. A file that changes a role the application logs in as goes in
  `SERVER_WIDE` in `vitest.db.config.ts`, and runs alone once the others
  have finished. A file that makes a role of its own names it after the
  worker (`SQL_TEST_ROLE` in `urls.ts`).

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
- **Owl-balance concurrency** (`budget-contribution-concurrency.test.ts`):
  parallel mandate contributions, and a contribution racing every other
  balance-guarded debit (decomposition hold, grant and conversation
  escrows, claim allocation, `chargeOwls`), never overdraw the balance.
  A test-only trigger parks each debit inside the race window, so the
  race is forced rather than left to timing.

## CI

`.github/workflows/ci.yml` job `db-tests`: a `pgvector/pgvector:pg16`
service container (health-checked), `npm ci`, then `npm run test:db` —
the same migration-from-zero flow as local runs.
