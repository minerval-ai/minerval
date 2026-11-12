/**
 * Clearance: which rows a connection to the database may read and write.
 *
 * A row carries a label (src/labels.ts), and a clearance is a set of labels.
 * Where a deployment has more than one label, the database holds every
 * connection to a clearance with row-level security: a row is returned only
 * to a connection whose clearance includes its label, a row can be changed
 * only at such a label, and a new row can be added only at the connection's
 * own label. The filter is not in any query. A query that forgets it is
 * filtered all the same, and a query made with nothing in context reads
 * `public` alone, so a call site nobody thought about fails closed. Code
 * that writes a row belonging to another label (a document's segments, at
 * the document's) does it by running that write at that label.
 *
 * How a connection gets its clearance
 *
 * The database client (client.ts) asks this module what session the work in
 * progress should have, and takes a connection from a pool whose every
 * connection was opened with that session. There are two kinds:
 *
 *  - cleared: logged in as the role minerval_cleared, which owns no table
 *    and so is bound by the policies, with two settings fixed when the
 *    connection is made: minerval.clearance, the labels it may read, and
 *    minerval.label, the label an insert that names none is given. A
 *    setting given at connect time is the connection's own default, so
 *    nothing a query does to it survives a reset, and a pool holds
 *    connections of one session only, so nothing carries over from one
 *    piece of work to the next and there is no per-query cost.
 *  - owner: the role in DATABASE_URL, which owns the tables and is not
 *    bound by the policies. This is what named system work uses
 *    (withSystemClearance below), and it is what every query uses on a
 *    deployment whose only label is `public`, where there are no policies
 *    and this module changes nothing.
 *
 * What the session is, in order:
 *
 *  1. Enforcement is off (no label but `public` has ever been defined):
 *     owner. The public graph runs on the one pool it always had.
 *  2. Inside withSystemClearance: owner.
 *  3. A run at a label (runAtLabel in llm/usage-context.ts): cleared, reading
 *     that label and every label it reads (label_reads, followed to the
 *     end, with `public` always included), writing at that label.
 *  4. A request with a clearance (server/plugins/members-only.ts): cleared,
 *     reading that clearance.
 *  5. Both, which is a run at a label acting for a person: cleared, reading
 *     only what the label and the person's clearance both read.
 *  6. Nothing in context: cleared, reading `public` alone.
 *
 * What this does not protect against. The clearance is a setting, and the
 * cleared role's password is derived from the owner's, so whoever can run
 * arbitrary SQL on one of the application's own connections, or holds
 * DATABASE_URL, can read everything. That is the application itself and
 * its operator. SQL written by a caller or an agent never runs on these
 * connections: it runs as a separate login role over the public_read views
 * (services/sql-service.ts), whose clearance is signed and cannot be set.
 * The policies bind rows, not columns, and they do not hide that a row
 * exists from a unique index: an insert that collides with a row the
 * connection cannot read is refused, and the refusal says so.
 *
 * This module holds no connection and imports nothing that queries, so the
 * client and the run context can both depend on it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { PUBLIC_LABEL } from "../labels.js";

/** The role every connection that is held to a clearance logs in as. */
export const CLEARED_ROLE = "minerval_cleared";

/**
 * What a label's name may be (the CHECK on labels.name says the same). The
 * word null fits the pattern and is refused all the same: a clearance is
 * written into a connection's settings as an array literal, and there the
 * bare word is no label at all.
 */
const LABEL_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;
const NOT_A_NAME = "null";

/**
 * A session could not be worked out, or a write was refused by the policy.
 * Thrown instead of falling back to anything wider.
 */
export class ClearanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClearanceError";
  }
}

/**
 * Whether an insert was refused because a row with the same identity
 * already exists at a label the work does not read (the database's
 * unseen_collision_guard, SQLSTATE MVL03). A table holds one row for each
 * identity whatever the labels, so until each label keeps its own, such an
 * insert is refused and says why. A caller for whom "already there" is all
 * it needed to know (a feed item another label's poll recorded first, say)
 * asks this and carries on; everyone else lets the refusal stand.
 */
export function isUnseenCollision(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "MVL03";
}

/**
 * What a caller is told when the wall refused its write, or null when the
 * error is anything else: the policy refused a row (ClearanceError), a
 * judgment at another label stood in the way (MVL02), a row with the same
 * identity exists at a label the work does not read (MVL03), or the write
 * would have changed a row's label (MVL04). These are refusals of what was
 * asked, with a reason the caller can act on, and not faults: the routes
 * answer them as a conflict, with this text.
 */
export function refusalForCaller(err: unknown): string | null {
  const e = err as { code?: string; message?: string; hint?: string } | null;
  if (!e || typeof e.message !== "string") return null;
  if (err instanceof ClearanceError) return e.message;
  if (e.code !== "MVL02" && e.code !== "MVL03" && e.code !== "MVL04") return null;
  const sentence = `${e.message.charAt(0).toUpperCase()}${e.message.slice(1)}.`;
  return e.hint ? `${sentence} ${e.hint}` : sentence;
}

// ---- system work ------------------------------------------------------------

const systemStore = new AsyncLocalStorage<{ reason: string } | null>();

/**
 * Run `fn` seeing every row at every label, on the owner's connection.
 *
 * Some work has to: migrations, the workers that find work at any label
 * before running each piece at its own, retention, the step that turns
 * enforcement on. It says so here, with the reason, and every caller is
 * listed with that reason in tests/unit/db/system-clearance.test.ts, which
 * fails on a caller that is not listed. The reason is for the reader of the
 * code and that list; nothing reads it at run time.
 *
 * It ends where a run begins: runAtLabel leaves it, so a worker that picks
 * a job up under system clearance runs the job at the job's label.
 *
 * System work that inserts a labelled row names the label. The owner's
 * connection carries none, so on a deployment with more than one label an
 * insert that names none is refused (minerval_default_label).
 */
export function withSystemClearance<T>(reason: string, fn: () => T): T {
  if (reason.trim().length === 0) {
    throw new ClearanceError("withSystemClearance needs the reason the work must see every label");
  }
  return systemStore.run({ reason }, () => startedHere(fn()));
}

/** Run `fn` outside any enclosing withSystemClearance. Called by runAtLabel. */
export function leaveSystemClearance<T>(fn: () => T): T {
  return systemStore.getStore() ? systemStore.run(null, () => startedHere(fn())) : fn();
}

/**
 * A query builder is run when it is awaited, not when it is made. One
 * handed back unrun from a function that sets the session (this file's, or
 * runAtLabel) would be awaited by the caller, outside, and run on the
 * caller's connection: a run's query at system clearance, if the caller is
 * a worker. So what such a function hands back is started before it
 * returns: anything that can be awaited and is not already a promise is
 * turned into one here, inside. Everything else is returned as it is.
 */
export function startedHere<T>(result: T): T {
  if (result instanceof Promise) return result;
  const then = (result as { then?: unknown } | null | undefined)?.then;
  if (typeof then !== "function") return result;
  return new Promise((resolve, reject) => {
    (then as (ok: (v: unknown) => void, no: (e: unknown) => void) => void).call(result, resolve, reject);
  }) as unknown as T;
}

/** The reason of the enclosing withSystemClearance, or null outside any. */
export function systemClearanceReason(): string | null {
  return systemStore.getStore()?.reason ?? null;
}

// ---- what the context says --------------------------------------------------

/** The label and clearance of the work in progress, as its context holds them. */
export interface ContextSession {
  label?: string;
  clearance?: readonly string[];
}

let contextReader: () => ContextSession = () => ({});

/**
 * Where the label and the clearance of the work in progress are read from.
 * llm/usage-context.ts registers its own context when it loads. A process
 * that never loads it has no runs and no requests, and reads `public`.
 */
export function setSessionContextReader(reader: () => ContextSession): void {
  contextReader = reader;
}

// ---- sessions ---------------------------------------------------------------

export type Session =
  | { role: "owner"; label?: string }
  | { role: "cleared"; clearance: readonly string[]; label?: string };

const OWNER: Session = Object.freeze({ role: "owner" });
const PUBLIC_ONLY: Session = Object.freeze({ role: "cleared", clearance: Object.freeze([PUBLIC_LABEL]) });

function plainName(label: string): string {
  if (!LABEL_NAME_RE.test(label) || label === NOT_A_NAME) {
    throw new ClearanceError(
      `"${label}" is not a label's name, so no connection was opened for it: a name is a short ` +
        `lower-case word (letters, digits, hyphens and underscores, starting with a letter)`
    );
  }
  return label;
}

/** A clearance as it is keyed and written: each label once, `public` included, sorted. */
export function normalizeClearance(labels: readonly string[]): string[] {
  return [...new Set([PUBLIC_LABEL, ...labels.map(plainName)])].sort();
}

/** One string per distinct session: the key of its pool. */
export function sessionKey(session: Session): string {
  const label = session.label ?? "";
  return session.role === "owner"
    ? `owner|${label}`
    : `cleared|${normalizeClearance(session.clearance).join(",")}|${label}`;
}

/**
 * The settings a session's connections are opened with, as the `options`
 * of the connection: "-c name=value" for each. Label names are plain words
 * (checked above, and by the table), so nothing in a value needs quoting
 * and nothing in a name can end the setting it is written in.
 */
export function sessionOptions(session: Session): string {
  const parts: string[] = [];
  if (session.role === "cleared") {
    parts.push(`-c minerval.clearance={${normalizeClearance(session.clearance).join(",")}}`);
  }
  if (session.label !== undefined) parts.push(`-c minerval.label=${plainName(session.label)}`);
  return parts.join(" ");
}

/**
 * The cleared role's password. By default it is derived from the owner's
 * credentials in DATABASE_URL: every process of a deployment shares those
 * and so derives the same one, with no second secret to configure. It gives
 * nothing to anyone who does not already hold the owner's credentials.
 *
 * Only the credentials go in, not the host or the database's name: a role
 * belongs to the whole database server, so every database on it that the
 * same owner uses must agree on the password. Two deployments with
 * different owners on one server would not, and cannot share one.
 *
 * A derived password changes when the owner's does. Where that happens
 * while tasks run (managed rotation), or all the time (a short-lived token
 * for a password), the deployment sets a secret of its own instead
 * (CLEARED_ROLE_PASSWORD), and `configured` is that secret.
 */
export function clearedRolePassword(databaseUrl: string, configured?: string | null): string {
  if (configured) {
    // It is sent as typed and the server prepares what it receives, so it
    // is held to characters that are the same before and after.
    if (!/^[\x21-\x7e]{24,}$/.test(configured)) {
      throw new ClearanceError(
        "CLEARED_ROLE_PASSWORD must be at least 24 printable ASCII characters with no spaces, so no connection held to a clearance was opened"
      );
    }
    return configured;
  }
  let credentials = databaseUrl;
  try {
    const url = new URL(databaseUrl);
    credentials = `${url.username}:${url.password}`;
  } catch {
    // Not a URL: the whole string is the secret.
  }
  return createHmac("sha256", credentials).update(`${CLEARED_ROLE} login`).digest("hex");
}

/**
 * What Postgres stores for a password under SCRAM-SHA-256, worked out here.
 *
 * The cleared role's password is set with ALTER ROLE, which takes no bind
 * parameters, and a statement that fails is written whole to the server's
 * log. So the password itself is never sent: this is sent in its place, and
 * Postgres stores a string of this form as it is given. It is what the
 * server would have computed from the password, and the password cannot be
 * read back out of it.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

// ---- whether enforcement is on ----------------------------------------------

/** A query on the owner's connection, given by the client. */
export type OwnerQuery = <T>(text: string, params?: unknown[]) => Promise<T[]>;

/**
 * How long a process may go on believing enforcement is off without asking
 * again. A process that has not yet noticed reads on the owner's connection,
 * unfiltered, so this is the longest that can last. Defining the first
 * private label turns enforcement on and then waits this long before the
 * label exists (armEnforcement in db/enforcement.ts), so by the time a row
 * can carry the label every process is holding its reads to a clearance.
 * On the public graph it costs one catalog lookup per process per interval.
 */
export const ENFORCEMENT_OFF_RECHECK_MS = 10_000;
/** How long before asking again once it is on. Turning off only widens. */
export const ENFORCEMENT_ON_RECHECK_MS = 60_000;

let enforcement: { on: boolean; at: number } | null = null;
let enforcementCheck: Promise<boolean> | null = null;

async function readEnforcement(ownerQuery: OwnerQuery): Promise<boolean> {
  // The policy the step creates (minerval_enforcement_sync) is the fact:
  // enforcement is on exactly when it exists. pg_policy is in every
  // database, so this needs no migration to have run.
  const [row] = await ownerQuery<{ on: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polname = 'label_clearance') AS on`
  );
  const on = row?.on === true;
  enforcement = { on, at: Date.now() };
  return on;
}

/**
 * This process has just changed `labels` or `label_reads` itself. What it
 * remembers about enforcement and about what each label reads may be out of
 * date from the moment that statement commits, so for a few seconds it
 * remembers nothing and asks the database each time. A process is thereby
 * never behind its own change; other processes notice within their
 * interval. The client calls this with every statement it sends.
 */
export function noteStatement(sql: string): void {
  if (!sql.includes("label")) return;
  if (LABEL_TABLE_WRITE_RE.test(sql)) unsettledUntil = Date.now() + UNSETTLED_MS;
}

const LABEL_TABLE_WRITE_RE = /\b(?:insert\s+into|delete\s+from|update)\s+"?(?:labels|label_reads)"?(?![\w"])/i;
const UNSETTLED_MS = 5_000;
let unsettledUntil = 0;

/** Whether enforcement is on, asked of the database at most once per interval. */
export async function enforcementOn(ownerQuery: OwnerQuery): Promise<boolean> {
  if (enforcement && Date.now() >= unsettledUntil) {
    const fresh = enforcement.on ? ENFORCEMENT_ON_RECHECK_MS : ENFORCEMENT_OFF_RECHECK_MS;
    if (Date.now() - enforcement.at < fresh) return enforcement.on;
  }
  enforcementCheck ??= readEnforcement(ownerQuery).finally(() => {
    enforcementCheck = null;
  });
  return enforcementCheck;
}

/**
 * Whether this process knows, without asking and without waiting, that
 * enforcement is off: it asked within the interval, the answer was no, and
 * it has not changed the label tables since. The client takes the owner's
 * pool straight away when this is so, which is every query on a
 * deployment whose only label is `public` but the one that asks, so that
 * such a deployment's queries take the path they always took.
 */
export function enforcementKnownOff(): boolean {
  if (!enforcement || enforcement.on) return false;
  const now = Date.now();
  return now >= unsettledUntil && now - enforcement.at < ENFORCEMENT_OFF_RECHECK_MS;
}

/**
 * What an in-memory cache adds to its key, so that an answer worked out for
 * one reader is never handed to another.
 *
 * The database shows each connection the rows its clearance reads, so what
 * a function returns depends on who asked. A cache in front of it that is
 * keyed by the question alone hands the first asker's answer to everyone
 * who asks within its lifetime, past the wall. Every module-level cache of
 * something read from a labelled table puts this in its key
 * (tests/unit/db/memory-caches.test.ts lists them all).
 *
 * It is the context's own account of the reader: the label of the run and
 * the clearance of the request, as they stand, and one key for system work.
 * Two readers with the same label and clearance share an entry. It asks the
 * database nothing. Where this process knows enforcement is off there is
 * one reader, and the key is empty: a cache on the public graph is the
 * cache it always was.
 */
export function readerKey(): string {
  if (enforcement && !enforcement.on) return "";
  if (systemStore.getStore()) return "system";
  const { label, clearance } = contextReader();
  return `${label ?? ""}|${clearance === undefined ? "" : normalizeClearance(clearance).join(",")}`;
}

/** What this process last learned, without asking: null before the first check. */
export function enforcementLastKnown(): boolean | null {
  return enforcement?.on ?? null;
}

/** Tell this process what the step just did, so it does not wait to notice. */
export function noteEnforcement(on: boolean): void {
  enforcement = { on, at: Date.now() };
  if (!on) labelClearances.clear();
}

// ---- a label's clearance ----------------------------------------------------

/**
 * How long a label's clearance is kept before label_reads is read again:
 * the longest a removed pair goes on being read through by runs.
 */
export const LABEL_CLEARANCE_TTL_MS = 10_000;

const labelClearances = new Map<string, { clearance: string[]; at: number }>();

/**
 * What a run at `label` may read: the label, every label it reads, and so
 * on, with `public` always included. The answer is the database's
 * (minerval_labels_readable_from), the same function a person's clearance
 * is worked out with, so there is one definition of what a label reads.
 */
export async function clearanceOfLabel(label: string, ownerQuery: OwnerQuery): Promise<string[]> {
  plainName(label);
  const kept = labelClearances.get(label);
  if (kept && Date.now() >= unsettledUntil && Date.now() - kept.at < LABEL_CLEARANCE_TTL_MS) {
    return kept.clearance;
  }
  const [row] = await ownerQuery<{ labels: string[] }>(
    `SELECT minerval_labels_readable_from($1::text[]) AS labels`,
    [[label]]
  );
  const clearance = normalizeClearance(row?.labels ?? [label]);
  labelClearances.set(label, { clearance, at: Date.now() });
  return clearance;
}

// ---- tests ------------------------------------------------------------------

// Kept on the process, not in this module: a test that reloads its modules
// (vi.resetModules) gets a fresh copy of this file, and the suite's choice
// has to outlive that.
const NO_CONTEXT_SESSION = Symbol.for("minerval.noContextSessionForTests");
const processSlots = globalThis as unknown as Record<symbol, Session | null | undefined>;

/**
 * What work with nothing in context is, for a test process. The database
 * suite's helpers seed and read back outside any run, as the owner; once a
 * test has defined a second label, enforcement would otherwise hold every
 * later helper to `public`. tests/db/setup.ts sets this, and the tests of
 * enforcement itself clear it. Refused outside a test run: in a deployment,
 * nothing in context reads `public` and nothing else.
 */
export function setNoContextSessionForTests(session: Session | null): void {
  if (!process.env.VITEST) {
    throw new ClearanceError("setNoContextSessionForTests is for test runs only");
  }
  processSlots[NO_CONTEXT_SESSION] = session;
}

/** Forget everything this module has learned (closeDb, and tests). */
export function resetClearanceState(): void {
  enforcement = null;
  enforcementCheck = null;
  unsettledUntil = 0;
  labelClearances.clear();
}

// ---- the session of the work in progress ------------------------------------

/**
 * The session the work in progress should have (the list at the top of this
 * file). Called by the client for every query.
 */
export async function currentSession(ownerQuery: OwnerQuery): Promise<Session> {
  if (!(await enforcementOn(ownerQuery))) return OWNER;
  if (systemStore.getStore()) return OWNER;
  const context = contextReader();
  if (context.label === undefined && context.clearance === undefined) {
    return processSlots[NO_CONTEXT_SESSION] ?? PUBLIC_ONLY;
  }
  if (context.label === undefined) {
    return { role: "cleared", clearance: normalizeClearance(context.clearance!) };
  }
  const ofLabel = await clearanceOfLabel(context.label, ownerQuery);
  if (context.clearance === undefined) return { role: "cleared", clearance: ofLabel, label: context.label };
  // Both: a run at a label acting for a person (the Assistant's tools run
  // as its user, inside its turn). It reads what both may read, so nothing
  // comes back into the run that its label does not read, and nothing that
  // the person may not.
  const held = new Set(normalizeClearance(context.clearance));
  return { role: "cleared", clearance: ofLabel.filter((l) => held.has(l)), label: context.label };
}

/**
 * What a caller is told when the policy refuses a write or a collision
 * hides behind a row it cannot read. Postgres reports both with a message
 * about row-level security; this says what that means here.
 */
export function describeRefusal(session: Session, table: string | undefined): string {
  const where = table ? ` in ${table}` : "";
  if (session.role !== "cleared") return `The write${where} was refused by the database.`;
  const reads = normalizeClearance(session.clearance)
    .map((l) => `"${l}"`)
    .join(", ");
  const own = session.label ?? PUBLIC_LABEL;
  return (
    `The write${where} was refused. This work is at the label "${own}" and reads ${reads}: it may ` +
    `add a row only at its own label, and change one only at a label it reads. Either the row it ` +
    `tried to write carries another label, or a row that is already there carries one this work ` +
    `does not read.`
  );
}
