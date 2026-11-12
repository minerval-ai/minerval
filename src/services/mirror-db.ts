/**
 * The database the mirror's publisher and applier work against.
 *
 * Both take their database as a parameter, with the app's own pool as the
 * default, for one reason: a publisher and an applier are two deployments
 * with two databases, and the test that carries a graph from one to the other
 * has to run both in one process (tests/db/mirror-round-trip.test.ts).
 */
import type pg from "pg";
import { rawQuery, withTransaction } from "../db/client.js";

export interface MirrorQuery {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface MirrorDb extends MirrorQuery {
  /** Run `fn` in one transaction on one connection; a throw rolls it back. */
  transaction<T>(fn: (tx: MirrorQuery) => Promise<T>): Promise<T>;
}

/** This deployment's own database, through the app's pool. */
export const appDb: MirrorDb = {
  query: (text, params) => rawQuery(text, params),
  transaction: (fn) => withTransaction((tx) => fn(tx)),
};

/** Another database, through a pool the caller owns. */
export function poolDb(pool: pg.Pool): MirrorDb {
  return {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await pool.query(text, params)).rows as T[];
    },
    async transaction<T>(fn: (tx: MirrorQuery) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const value = await fn({
          async query<R>(text: string, params: unknown[] = []): Promise<R[]> {
            return (await client.query(text, params)).rows as R[];
          },
        });
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
    },
  };
}
