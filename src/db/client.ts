import { readFileSync } from "fs";
import { join } from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";
import { loadConfig } from "../config.js";

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (_pool) return _pool;
  const config = loadConfig();
  _pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(config.env === "production" && {
      ssl: {
        ca: readFileSync(join(process.cwd(), "rds-ca-bundle.pem"), "utf8"),
        rejectUnauthorized: true,
      },
    }),
  });
  return _pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
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
  const result = await pool.query(queryText, params);
  return result.rows as T[];
}

/** Query runner bound to one transaction's connection. */
export interface TxQuery {
  query<T>(queryText: string, params?: unknown[]): Promise<T[]>;
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
        const result = await client.query(queryText, params);
        return result.rows as R[];
      },
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
