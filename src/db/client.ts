import { readFileSync } from "fs";
import { join } from "path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";
import { loadConfig } from "../config.js";
import { observeStatement } from "./statement-observer.js";
import {
  CLEARED_ROLE,
  ClearanceError,
  clearedRolePassword,
  scramVerifier,
  currentSession,
  describeRefusal,
  enforcementKnownOff,
  enforcementOn,
  normalizeClearance,
  noteStatement,
  resetClearanceState,
  sessionKey,
  sessionOptions,
  type OwnerQuery,
  type Session,
} from "./clearance.js";

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

/**
 * The owner's pool: connections as the role in DATABASE_URL. On a
 * deployment whose only label is `public` this is the one pool there is and
 * every query uses it. Where enforcement is on (clearance.ts) it serves
 * named system work only, and everything else goes to a session pool below.
 */
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

const ownerQuery: OwnerQuery = async <T>(text: string, params: unknown[] = []) =>
  (await getPool().query(text, params)).rows as T[];

// ---- session pools (clearance.ts) -------------------------------------------
//
// One pool per distinct session: a clearance and a label. Every connection
// in a pool was opened with that session's settings, so a connection never
// has to be told who it is for, and none can be handed to work at another
// label.
//
// The database allows about a hundred connections in all, so what these
// pools may hold together is bounded the way the one pool always was: at
// most SESSION_CONNECTIONS are in use across all of them at once (a query
// past that waits, as it waited for the one pool), and a connection idle
// for ten seconds is closed, so a label nothing is running at holds none.
// When more than MAX_SESSION_POOLS sessions are open, the one unused
// longest is closed, once it has been quiet for ten seconds. A process
// therefore uses at most 20 connections here besides the owner pool's 20,
// plus what is idling out; a deployment has a handful of labels, each one
// session for its runs, and as many again for the distinct clearances of
// the people reading.

const SESSION_CONNECTIONS = 20;
const SESSION_POOL_IDLE_MS = 10_000;
const MAX_SESSION_POOLS = 8;
const SESSION_WAIT_MS = 5_000;

let sessionConnectionsInUse = 0;
const sessionWaiters: Array<{ grant: () => void; timer: NodeJS.Timeout }> = [];

/** Take one of the SESSION_CONNECTIONS, waiting up to SESSION_WAIT_MS for it. */
function takeSessionConnection(): Promise<void> {
  if (sessionConnectionsInUse < SESSION_CONNECTIONS) {
    sessionConnectionsInUse++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const waiter = {
      grant: () => {
        clearTimeout(waiter.timer);
        resolve();
      },
      timer: setTimeout(() => {
        const at = sessionWaiters.indexOf(waiter);
        if (at !== -1) sessionWaiters.splice(at, 1);
        reject(new Error("timeout exceeded when trying to connect"));
      }, SESSION_WAIT_MS),
    };
    sessionWaiters.push(waiter);
  });
}

/** Give one back: to the longest waiter if there is one. */
function returnSessionConnection(): void {
  const next = sessionWaiters.shift();
  if (next) next.grant();
  else sessionConnectionsInUse--;
}

const sessionPools = new Map<string, { pool: pg.Pool; usedAt: number }>();

/** The connection string of a session: the owner's, with the session's role and settings. */
function sessionConnectionString(session: Session): string {
  const config = loadConfig();
  let url: URL;
  try {
    url = new URL(config.databaseUrl);
  } catch {
    throw new ClearanceError(
      "DATABASE_URL is not a URL, so no connection held to a clearance could be opened from it"
    );
  }
  if (session.role === "cleared") {
    url.username = CLEARED_ROLE;
    url.password = clearedRolePassword(config.databaseUrl, config.clearedRolePassword);
  }
  const options = [url.searchParams.get("options"), sessionOptions(session)].filter(Boolean).join(" ");
  if (options) url.searchParams.set("options", options);
  return url.toString();
}

function closeLeastRecentlyUsed(): void {
  if (sessionPools.size <= MAX_SESSION_POOLS) return;
  // A pool is closed only when nothing holds a connection of it and nothing
  // has asked for it lately: work that was just handed the pool may still
  // be waiting its turn (SESSION_WAIT_MS at most) before it uses it.
  const quietSince = Date.now() - 2 * SESSION_WAIT_MS;
  const idle = [...sessionPools.entries()]
    .filter(
      ([, kept]) =>
        kept.pool.totalCount === kept.pool.idleCount && kept.pool.waitingCount === 0 && kept.usedAt < quietSince
    )
    .sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [key, kept] of idle) {
    if (sessionPools.size <= MAX_SESSION_POOLS) break;
    sessionPools.delete(key);
    void kept.pool.end().catch(() => {});
  }
}

function poolOf(session: Session): pg.Pool {
  if (session.role === "owner" && session.label === undefined) return getPool();
  const key = sessionKey(session);
  const kept = sessionPools.get(key);
  if (kept) {
    kept.usedAt = Date.now();
    return kept.pool;
  }
  const ssl = databaseSsl();
  const pool = new pg.Pool({
    connectionString: sessionConnectionString(session),
    max: SESSION_CONNECTIONS,
    idleTimeoutMillis: SESSION_POOL_IDLE_MS,
    connectionTimeoutMillis: 5_000,
    ...(ssl && { ssl }),
  });
  // An idle connection the server closed is dropped by the pool; without a
  // listener the event would end the process.
  pool.on("error", (err) => console.error(`[db] idle connection of session ${key} failed:`, err.message));
  sessionPools.set(key, { pool, usedAt: Date.now() });
  closeLeastRecentlyUsed();
  return pool;
}

/** The pool for the work in progress, and the session it was chosen for. */
async function sessionPool(): Promise<{ pool: pg.Pool; session: Session }> {
  const session = await currentSession(ownerQuery);
  return { pool: poolOf(session), session };
}

// The cleared role logs in with a password every process of the deployment
// works out the same (clearedRolePassword). The role is touched as little
// as can be:
//
//   - Where a login with that password already works, nothing is sent. That
//     is every start but a deployment's first with enforcement on.
//   - Where it does not, the role is given the password, as the owner. The
//     password is never in the statement: what is sent is the verifier
//     Postgres would have stored for it (scramVerifier), so a statement
//     that fails and is written to the server's log shows no secret.
//   - A process that has logged in before and is then refused does not set
//     the password back. Something newer set another one (the owner's
//     password was rotated and a newer task derived a new one), and two
//     processes that each put their own back would lock each other out in
//     turn. It fails closed, says so, and works again once it is replaced
//     or restarted. A deployment whose owner password rotates configures a
//     secret of its own (CLEARED_ROLE_PASSWORD) so that this never happens.
let loginEnsuredAt = 0;
let clearedLoginWorked = false;

const PUBLIC_SESSION: Session = { role: "cleared", clearance: ["public"] };

/** Whether a connection as the cleared role can be opened with this process's password. */
async function clearedLoginWorks(): Promise<boolean> {
  try {
    await poolOf(PUBLIC_SESSION).query("SELECT 1");
    clearedLoginWorked = true;
    return true;
  } catch (err) {
    if (loginRefused(err)) return false;
    throw err;
  }
}

async function giveClearedLogin(): Promise<void> {
  if (Date.now() - loginEnsuredAt < 30_000) return;
  loginEnsuredAt = Date.now();
  const config = loadConfig();
  // ALTER ROLE takes no bind parameters. The verifier is base64, "$" and ":".
  const verifier = scramVerifier(clearedRolePassword(config.databaseUrl, config.clearedRolePassword));
  try {
    await getPool().query(`ALTER ROLE ${CLEARED_ROLE} WITH LOGIN PASSWORD '${verifier}'`);
  } catch (err) {
    // XX000 "tuple concurrently updated": another process set it just now.
    if ((err as { code?: string }).code !== "XX000") throw err;
  }
}

/** A cleared connection was refused its login: repair it, where that is this process's to do. */
async function ensureClearedLogin(): Promise<void> {
  if (clearedLoginWorked) {
    throw new ClearanceError(
      "The database refused the login this process has used for connections held to a clearance. " +
        "Its password was changed after this process started, so the process is out of date and " +
        "must be restarted or replaced. Where the owner's password rotates, set CLEARED_ROLE_PASSWORD."
    );
  }
  await giveClearedLogin();
}

/**
 * Make sure the cleared role can log in: called when enforcement turns on
 * and at every start where it is on. Sends nothing where it already can.
 */
export async function setClearedLogin(): Promise<void> {
  if (await clearedLoginWorks()) return;
  loginEnsuredAt = 0;
  await giveClearedLogin();
}

/**
 * One query on a connection held to `public` alone, whatever the work in
 * progress is: for checking what such a connection really is and sees
 * (db/enforcement.ts). Only where enforcement is on; before that the
 * cleared role has no login.
 */
export async function queryAtPublicClearance<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const session: Session = { role: "cleared", clearance: ["public"] };
  const run = async () => (await poolOf(session).query(text, params)).rows as T[];
  try {
    return await run();
  } catch (err) {
    if (!loginRefused(err)) throw err;
    await ensureClearedLogin();
    return run();
  }
}

/**
 * The labels the work in progress may read, sorted, or null on a deployment
 * whose only label is `public`, where nothing is held. For what has to
 * carry the clearance somewhere this client does not reach: read-only SQL
 * runs on its own login role (services/sql-service.ts), and a run is told
 * what it reads (llm/label-note.ts). System work, which is held to nothing
 * here, is answered `public`: neither of those is for it.
 */
export async function currentReadClearance(): Promise<string[] | null> {
  if (!(await enforcementOn(ownerQuery))) return null;
  const session = await currentSession(ownerQuery);
  return session.role === "cleared" ? normalizeClearance(session.clearance) : ["public"];
}

/**
 * Whether this deployment holds material at more than one label, which is
 * when the database holds reads and writes to a clearance. False on the
 * public graph. For what asks a person to say which label something is for
 * (server/plugins/request-label.ts): where there is one label there is
 * nothing to ask.
 */
export async function deploymentHoldsLabels(): Promise<boolean> {
  return enforcementOn(ownerQuery);
}

/**
 * Whether the work in progress is on a connection the policies bind. False
 * on a deployment whose only label is `public`, and for system work.
 */
export async function readsAreHeld(): Promise<boolean> {
  return (await currentSession(ownerQuery)).role === "cleared";
}

/**
 * What the search queries read claims from, so that keyword search keeps
 * its index whether or not reads are held.
 *
 * Where they are not, it is the table, and the query is exactly what it
 * always was. Where they are, a full-text match on the table could not use
 * the index: a row-level security policy is tested before any condition
 * Postgres cannot prove harmless on rows the reader may not see, and a
 * full-text match is one of those, so the table would be read whole. The
 * search then reads a view that applies the same clearance as an ordinary
 * condition (minerval_readable.claims_search, created with the policies)
 * and exposes the columns search uses. Everything the search joins to is
 * still read from its table under the policy.
 */
export async function searchableClaims(): Promise<string> {
  return (await readsAreHeld()) ? "minerval_readable.claims_search" : "claims";
}

/**
 * A full-text match on requests, for the same reason: the plain condition
 * where reads are not held, and where they are, the ids the match finds
 * through a view that applies the clearance (minerval_readable.
 * requests_text), with the rows read from the table under the policy.
 */
export async function requestTextMatch(alias: string, tsquery: string): Promise<string> {
  if (!(await readsAreHeld())) return `${alias}.text_search @@ ${tsquery}`;
  return `${alias}.id IN (SELECT readable.id FROM minerval_readable.requests_text readable WHERE readable.text_search @@ ${tsquery})`;
}

/** 28P01: wrong password. 28000: the role may not log in. */
function loginRefused(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === "28P01" || code === "28000";
}

/**
 * Run `work` on the pool of the work in progress. A login the cleared role
 * was refused is repaired once and the work tried again. A write the policy
 * refused is reported as what it is.
 */
async function onSessionPool<R>(work: (pool: pg.Pool, session: Session) => Promise<R>): Promise<R> {
  const { pool, session } = await sessionPool();
  // The owner's pool bounds itself, as it always did.
  const counted = pool !== _pool;
  if (counted) await takeSessionConnection();
  let held = false;
  try {
    let result: R;
    try {
      result = await work(pool, session);
    } catch (err) {
      if (!(session.role === "cleared" && loginRefused(err))) throw err;
      await ensureClearedLogin();
      result = await work(pool, session);
    }
    if (session.role === "cleared") clearedLoginWorked = true;
    // A connection handed out for a transaction is counted until released.
    if (counted) held = holdUntilReleased(result);
    return result;
  } catch (err) {
    throw asRefusal(err, session);
  } finally {
    if (counted && !held) returnSessionConnection();
  }
}

/**
 * When `result` is (or carries) a checked-out client, keep its place in
 * the count until the client is released, and say so.
 */
function holdUntilReleased(result: unknown): boolean {
  const candidate =
    result && typeof result === "object" && "client" in result
      ? (result as { client: unknown }).client
      : result;
  const client = candidate as { release?: (...args: unknown[]) => void; query?: unknown } | null;
  if (!client || typeof client.release !== "function" || typeof client.query !== "function") return false;
  const release = client.release.bind(client);
  let returned = false;
  client.release = (...args: unknown[]) => {
    if (!returned) {
      returned = true;
      returnSessionConnection();
    }
    // The pool hands the same client out again with its own release.
    client.release = release;
    release(...args);
  };
  return true;
}

/**
 * A write the row-level security policy refused (42501), as an error that
 * says what happened in this system's terms. The database's own error is
 * its cause, and its code is kept. Any other error is returned untouched.
 */
function asRefusal(err: unknown, session: Session): unknown {
  const e = err as { code?: string; message?: string; table?: string } | null;
  if (e?.code !== "42501" || !/row-level security/.test(e.message ?? "")) return err;
  const refusal = new ClearanceError(describeRefusal(session, e.table)) as ClearanceError & {
    code: string;
    cause: unknown;
  };
  refusal.code = "42501";
  refusal.cause = err;
  return refusal;
}

/**
 * What drizzle is handed in place of a pool: each query, and each
 * transaction's connection, is taken from the pool of the work in progress
 * at the moment it is asked for. A handle from getDb() can therefore be
 * kept and used under any label, like the functions below.
 */
class SessionRoutingPool {
  query(...args: unknown[]): Promise<unknown> {
    if (enforcementKnownOff()) return (getPool().query as (...a: unknown[]) => Promise<unknown>)(...args);
    return onSessionPool((pool) => (pool.query as (...a: unknown[]) => Promise<unknown>)(...args));
  }
  connect(): Promise<pg.PoolClient> {
    if (enforcementKnownOff()) return getPool().connect();
    return onSessionPool((pool) => pool.connect());
  }
}

// Every statement is shown to the observer (statement-observer.ts) before it
// runs; drizzle handles do it through their logger.
const observingLogger = { logQuery: (query: string) => observe(query) };

/** Show a statement to the observer, and to the clearance module (noteStatement). */
function observe(sql: string): void {
  observeStatement(sql);
  noteStatement(sql);
}

export function getDb() {
  return drizzle(new SessionRoutingPool() as unknown as pg.Pool, { schema, logger: observingLogger });
}

export type Db = ReturnType<typeof getDb>;

export async function closeDb(): Promise<void> {
  const open = [...sessionPools.values()].map((kept) => kept.pool);
  sessionPools.clear();
  await Promise.all(open.map((pool) => pool.end().catch(() => {})));
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
  resetClearanceState();
  loginEnsuredAt = 0;
  clearedLoginWorked = false;
  sessionConnectionsInUse = 0;
  for (const waiter of sessionWaiters.splice(0)) clearTimeout(waiter.timer);
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
  observe(queryText);
  // Where `public` is the only label, and this process has lately made sure
  // of it, the query goes to the one pool exactly as it always did.
  if (enforcementKnownOff()) {
    const result = await getPool().query(queryText, params);
    return result.rows as T[];
  }
  const result = await onSessionPool((pool) => pool.query(queryText, params));
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
  // The whole transaction runs on one connection, so it has one session:
  // that of the work that opened it.
  const { client, session } = enforcementKnownOff()
    ? { client: await getPool().connect(), session: { role: "owner" } as Session }
    : await onSessionPool(async (pool, session) => ({
        client: await pool.connect(),
        session,
      }));
  try {
    await client.query("BEGIN");
    const tx: TxQuery = {
      async query<R>(queryText: string, params: unknown[] = []): Promise<R[]> {
        observe(queryText);
        try {
          const result = await client.query(queryText, params);
          return result.rows as R[];
        } catch (err) {
          throw asRefusal(err, session);
        }
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
