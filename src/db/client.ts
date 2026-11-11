import { readFileSync } from "fs";
import { join } from "path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";
import { loadConfig } from "../config.js";
import { observeStatement } from "./statement-observer.js";

let _pool: pg.Pool | null = null;

/**
 * TLS for every connection to the database, the pool's and read-only SQL's
 * (services/sql-service.ts) alike: in production, verified against the RDS
 * CA bundle, since RDS refuses unencrypted connections there.
 */
export function databaseSsl(): pg.ClientConfig["ssl"] {
  if (loadConfig().env !== "production") return undefined;
  return {
    ca: readFileSync(join(process.cwd(), "rds-ca-bundle.pem"), "utf8"),
    rejectUnauthorized: true,
  };
}

function getPool(): pg.Pool {
  if (_pool) return _pool;
  const config = loadConfig();
  const ssl = databaseSsl();
  _pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(ssl && { ssl }),
  });
  return _pool;
}

// Every statement is shown to the observer (statement-observer.ts) before it
// runs; drizzle handles do it through their logger.
const observingLogger = { logQuery: (query: string) => observeStatement(query) };

export function getDb() {
  return drizzle(getPool(), { schema, logger: observingLogger });
}

export type Db = ReturnType<typeof getDb>;

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/** Raw SQL query helper for complex queries not expressible in Drizzle.
 *
 * Each call is a single autocommit statement on a pooled connection. That
 * means row locks (`FOR UPDATE`) taken here release the moment the statement
 * returns — any read-then-write sequence that needs the lock held across
 * statements MUST run inside withTransaction instead. */
export async function rawQuery<T>(
  queryText: string,
  params: unknown[] = []
): Promise<T[]> {
  const pool = getPool();
  observeStatement(queryText);
  const result = await pool.query(queryText, params);
  return result.rows as T[];
}

/** Query runner bound to one transaction's connection. */
export interface TxQuery {
  query<T>(queryText: string, params?: unknown[]): Promise<T[]>;
  /**
   * A Drizzle handle on the same connection, for writes the query builder
   * expresses better than raw SQL (vector columns, wide optional rows). A
   * row inserted through `db` and a row inserted through `query` commit or
   * roll back together.
   */
  db: NodePgDatabase<typeof schema>;
}

/**
 * Run `fn` inside a single database transaction. Every statement issued
 * through the passed runner shares one connection, so `FOR UPDATE` locks
 * hold until commit/rollback and multi-statement money movements are
 * atomic. Throwing rolls the whole transaction back.
 */
export async function withTransaction<T>(
  fn: (tx: TxQuery) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx: TxQuery = {
      async query<R>(queryText: string, params: unknown[] = []): Promise<R[]> {
        observeStatement(queryText);
        const result = await client.query(queryText, params);
        return result.rows as R[];
      },
      db: drizzle(client, { schema, logger: observingLogger }),
    };
    const value = await fn(tx);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original error is the one that matters.
    }
    throw err;
  } finally {
    client.release();
  }
}
