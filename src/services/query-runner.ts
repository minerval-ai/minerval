/**
 * A query runner: a transaction's `query`, or the pool's autocommit one.
 * The prize services take an optional runner so a caller inside a
 * transaction (the payout, the check worker, a bounty transition) can keep
 * every write of one step in the same transaction, and a caller outside
 * one gets the pool.
 */
import { rawQuery, type TxQuery } from "../db/client.js";

export interface Runner {
  query<T>(queryText: string, params?: unknown[]): Promise<T[]>;
}

export const poolRunner: Runner = {
  query: <T>(q: string, p: unknown[] = []) => rawQuery<T>(q, p),
};

export function asRunner(tx?: TxQuery | Runner | null): Runner {
  return tx ?? poolRunner;
}
