/**
 * Publishing the mirror feed: cutting signed batches of full public rows
 * (docs/mirror.md).
 *
 * How the publisher knows what changed. Writes to the graph are spread over
 * about a thousand statements with no outbox, and nothing here may touch
 * them. So a cut does not listen to writes: it reads the replicated tables,
 * hashes each row's replicated columns in the database, and compares the
 * hashes with those of the rows as last published (mirror_feed_rows). A row
 * whose hash is new or different is sent whole; a published row that is
 * gone is sent as a deletion, and one that exists but is no longer public
 * as a retraction. The stored hashes are the outbox, filled by reading
 * state instead of by intercepting writes. That choice against triggers:
 *
 *  - Nothing is missed, whoever wrote it: a tool, a migration, a repair by
 *    hand. A merge needs no handling of its own, because a merge is rows
 *    changing (the absorbed claim's state and merged_into, the instances
 *    and edges moved to the survivor), and changed rows travel. A row that
 *    leaves the public set is found the same way a deleted one is.
 *  - A cut reads one snapshot of the database (REPEATABLE READ), so a batch
 *    cut in the middle of a write holds all of that write or none of it,
 *    and never a row without the row it points to.
 *  - A mistake corrects itself: the next cut compares state again.
 *  - It costs a pass over the replicated tables on every cut, in the
 *    database, whatever changed. That is small for a graph of a few
 *    thousand nodes. As it grows, the pass can be narrowed without changing
 *    the feed (compare a row's xmin before hashing it, hash a document by
 *    its stored content hash); the format does not know how a change was
 *    found.
 *  - A row that changes twice between cuts is sent once, as it stands. The
 *    mirror follows state, not every step; history that matters is in rows
 *    that are never rewritten (each judgment is its own row).
 *
 * Only public rows. A row is published when it is at the public label
 * (wherever the table carries one) and every replicated row it points to is
 * published too, so nothing reaches a batch by hanging off a public row.
 * And the publisher does not run at all on a deployment that defines any
 * label besides `public`: tables without a label column could not be shown
 * to be public there, and what leaves a private graph leaves through
 * redaction and release, not through this feed.
 *
 * Where a price would be checked: fetching a batch is an authenticated read
 * (routes/mirror.ts), and the account's standing to fetch would be decided
 * in that route's preHandler. Nothing here charges.
 */
import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { migrationHead, type MigrationHead } from "../db/migration-head.js";
import { PUBLIC_LABEL } from "../labels.js";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./embedding-model.js";
import {
  MIRROR_FEED_FORMAT,
  batchFileName,
  feedGenesisHash,
  keyIdOf,
  orderByReferences,
  parseSigningKey,
  publicKeyString,
  signBatch,
  type MirrorBatchBody,
  type MirrorBatchKind,
  type MirrorTableKeys,
  type MirrorTableRows,
} from "./mirror-batch.js";
import { appDb, type MirrorDb, type MirrorQuery } from "./mirror-db.js";
import { replicatedShape, replicatedTables, type ReplicatedTable } from "./mirror-manifest.js";

/** A cut could not be made, and nothing was published. The message is for an operator. */
export class MirrorPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MirrorPublishError";
  }
}

export interface CutBatchSummary {
  sequence: number;
  kind: MirrorBatchKind;
  rows: number;
  removals: number;
  bytes: number;
  hash: string;
}

export interface CutResult {
  /** The batches this cut wrote, in order; empty when nothing had changed. */
  batches: CutBatchSummary[];
}

export interface CutOptions {
  db?: MirrorDb;
  /** Send every published row, whether or not it changed. */
  snapshot?: boolean;
  /** The signing key; the configured one (MIRROR_SIGNING_KEY) when absent. */
  signingKey?: KeyObject;
  /** The most bytes of rows one batch holds before the cut is split. */
  maxBatchBytes?: number;
  migration?: MigrationHead;
  webBaseUrl?: string;
}

// ---- SQL pieces, built from the manifest ---------------------------------------

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
/** A string as an SQL literal. Only for names this code wrote: a CREATE TABLE AS takes no parameters. */
const lit = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** A row's key as text: the key column, or the key columns joined with '/'. */
export function keyText(table: ReplicatedTable, alias: string): string {
  return table.key.map((k) => `${alias}.${q(k)}::text`).join(` || '/' || `);
}

/** `alias`'s key is among the keys in parameter `$n`. Uses the primary key's index where the key is one uuid. */
export function keyAmong(table: ReplicatedTable, alias: string, n: number): string {
  return table.key.length === 1
    ? `${alias}.${q(table.key[0]!)} = ANY($${n}::uuid[])`
    : `(${keyText(table, alias)}) = ANY($${n}::text[])`;
}

/** The replicated columns of `alias` as one jsonb object: a row as the feed carries it. */
export function rowJson(table: ReplicatedTable, alias: string): string {
  return `(SELECT to_jsonb(r) FROM (SELECT ${table.columns.map((c) => `${alias}.${q(c)}`).join(", ")}) r)`;
}

const pub = (table: string) => q(`mirror_pub_${table}`);
const chg = (table: string) => q(`mirror_chg_${table}`);

/** The rows of one table that may be published: at the public label, with every parent published. */
export function publishedSetSql(table: ReplicatedTable, hasLabel: boolean): string {
  const where: string[] = [];
  if (hasLabel) where.push(`x.sensitivity_label = ${lit(PUBLIC_LABEL)}`);
  for (const parent of table.parents) {
    where.push(
      `(x.${q(parent.column)} IS NULL OR EXISTS (SELECT 1 FROM ${pub(parent.table)} p WHERE p.row_key = x.${q(parent.column)}::text))`
    );
  }
  if (table.parentByKind) {
    const { kindColumn, idColumn, tables } = table.parentByKind;
    const arms = Object.entries(tables).map(
      ([kind, parent]) =>
        `WHEN ${lit(kind)} THEN EXISTS (SELECT 1 FROM ${pub(parent)} p WHERE p.row_key = x.${q(idColumn)}::text)`
    );
    where.push(`(CASE x.${q(kindColumn)} ${arms.join(" ")} ELSE false END)`);
  }
  return (
    `CREATE TEMP TABLE ${pub(table.name)} ON COMMIT DROP AS
     SELECT ${keyText(table, "x")} AS row_key,
            encode(sha256(convert_to(${rowJson(table, "x")}::text, 'UTF8')), 'hex') AS row_hash
       FROM ${q(table.name)} x` + (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "")
  );
}

/**
 * Decide what may be published, in the transaction's temporary tables: one
 * `mirror_pub_<table>` per replicated table, holding the key and the hash of
 * every row that is at the public label (where the table carries a label)
 * and points only to published rows. Built parents first, so each table's
 * set is closed over the ones before it. Everything a cut sends, it reads
 * through these sets, which is what makes "only public rows" a property of
 * the cut and not of each query in it.
 */
export async function buildPublishedSets(tx: MirrorQuery): Promise<void> {
  const tables = replicatedTables();
  const labelled = new Set(
    (
      await tx.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND column_name = 'sensitivity_label'
            AND table_name = ANY($1::text[])`,
        [tables.map((t) => t.name)]
      )
    ).map((r) => r.table_name)
  );
  for (const table of tables) {
    await tx.query(publishedSetSql(table, labelled.has(table.name)));
    await tx.query(`CREATE UNIQUE INDEX ON ${pub(table.name)} (row_key)`);
    if (table.selfReferences.length > 0) {
      // A row that points to an unpublished row of its own table goes
      // too, and then whatever pointed to it, until nothing more does.
      const dangling = table.selfReferences
        .map(
          (c) =>
            `(x.${q(c)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${pub(table.name)} o WHERE o.row_key = x.${q(c)}::text))`
        )
        .join(" OR ");
      for (;;) {
        const removed = await count(
          tx,
          `WITH gone AS (
             DELETE FROM ${pub(table.name)} p USING ${q(table.name)} x
              WHERE ${keyText(table, "x")} = p.row_key AND (${dangling})
             RETURNING 1)
           SELECT count(*)::int AS n FROM gone`
        );
        if (removed === 0) break;
      }
    }
    await tx.query(`ANALYZE ${pub(table.name)}`);
  }
}

// ---- the cut --------------------------------------------------------------------

/** The configured signing key, or why there is none. */
export function configuredSigningKey(): KeyObject {
  const pem = loadConfig().mirrorSigningKey;
  if (!pem) {
    throw new MirrorPublishError(
      "This deployment has no signing key for the mirror feed. Set MIRROR_SIGNING_KEY to an Ed25519 " +
        "private key in PEM form (`npx tsx scripts/mirror.ts keygen` makes one)."
    );
  }
  try {
    return parseSigningKey(pem);
  } catch (err) {
    throw new MirrorPublishError(err instanceof Error ? err.message : String(err));
  }
}

function publicHalf(signingKey: KeyObject): { publicKey: string; keyId: string } {
  const publicKey = publicKeyString(createPublicKey(signingKey));
  return { publicKey, keyId: keyIdOf(publicKey) };
}

interface Head {
  sequence: number;
  feed_id: string;
  batch_hash: string;
  shape: string;
}

async function count(tx: MirrorQuery, text: string, params: unknown[] = []): Promise<number> {
  const [row] = await tx.query<{ n: number }>(text, params);
  return Number(row?.n ?? 0);
}

/**
 * Bring the feed's record tables up to the public record: contributions on
 * nodes, and requests with the nodes they bear on (db/schema.ts,
 * feed_contributions). They are a copy of the public columns of
 * `contributions`, `requests` and `request_targets`, with no account, made
 * here so that the cut reads them like any replicated table. A row is
 * written only when it differs, so an unchanged record is not sent again.
 * It runs before the cut's own transaction, and a record that changes in
 * between is carried by the next cut.
 */
export async function refreshFeedRecords(db: MirrorDb): Promise<void> {
  const [other] = await db.query<{ name: string }>(`SELECT name FROM labels WHERE name <> $1 LIMIT 1`, [PUBLIC_LABEL]);
  // A deployment with another label does not publish; the cut says so.
  if (other) return;
  await db.query(
    `INSERT INTO feed_contributions (id, claim_id, contribution_type, content, evidence_urls, about_published_page_id, submitted_at, review_status, sensitivity_label)
     SELECT c.id, c.claim_id, c.contribution_type, c.content, c.evidence_urls, c.about_published_page_id, c.submitted_at, c.review_status, '${PUBLIC_LABEL}'
       FROM contributions c WHERE c.claim_id IS NOT NULL
     ON CONFLICT (id) DO UPDATE
       SET claim_id = EXCLUDED.claim_id, contribution_type = EXCLUDED.contribution_type, content = EXCLUDED.content,
           evidence_urls = EXCLUDED.evidence_urls, about_published_page_id = EXCLUDED.about_published_page_id,
           submitted_at = EXCLUDED.submitted_at, review_status = EXCLUDED.review_status
     WHERE (feed_contributions.claim_id, feed_contributions.contribution_type, feed_contributions.content, feed_contributions.evidence_urls,
            feed_contributions.about_published_page_id, feed_contributions.submitted_at, feed_contributions.review_status)
           IS DISTINCT FROM
           (EXCLUDED.claim_id, EXCLUDED.contribution_type, EXCLUDED.content, EXCLUDED.evidence_urls,
            EXCLUDED.about_published_page_id, EXCLUDED.submitted_at, EXCLUDED.review_status)`
  );
  await db.query(
    `DELETE FROM feed_contributions f WHERE f.origin = 'local' AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.id = f.id AND c.claim_id IS NOT NULL)`
  );
  await db.query(
    `INSERT INTO feed_requests (id, ask, why, satisfied_by, who_could, addressed_to, bears_on_text, state, state_note, filed_at, closed_at, sensitivity_label)
     SELECT r.id, r.ask, r.why, r.satisfied_by, r.who_could, r.addressed_to, r.bears_on_text, r.state, r.state_note, r.created_at, r.closed_at, '${PUBLIC_LABEL}'
       FROM requests r
     ON CONFLICT (id) DO UPDATE
       SET ask = EXCLUDED.ask, why = EXCLUDED.why, satisfied_by = EXCLUDED.satisfied_by, who_could = EXCLUDED.who_could,
           addressed_to = EXCLUDED.addressed_to, bears_on_text = EXCLUDED.bears_on_text, state = EXCLUDED.state,
           state_note = EXCLUDED.state_note, filed_at = EXCLUDED.filed_at, closed_at = EXCLUDED.closed_at
     WHERE (feed_requests.ask, feed_requests.why, feed_requests.satisfied_by, feed_requests.who_could, feed_requests.addressed_to,
            feed_requests.bears_on_text, feed_requests.state, feed_requests.state_note, feed_requests.filed_at, feed_requests.closed_at)
           IS DISTINCT FROM
           (EXCLUDED.ask, EXCLUDED.why, EXCLUDED.satisfied_by, EXCLUDED.who_could, EXCLUDED.addressed_to,
            EXCLUDED.bears_on_text, EXCLUDED.state, EXCLUDED.state_note, EXCLUDED.filed_at, EXCLUDED.closed_at)`
  );
  await db.query(`DELETE FROM feed_requests f WHERE f.origin = 'local' AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.id = f.id)`);
  await db.query(
    `INSERT INTO feed_request_targets (id, request_id, claim_id, sensitivity_label)
     SELECT t.id, t.request_id, t.claim_id, '${PUBLIC_LABEL}' FROM request_targets t WHERE t.claim_id IS NOT NULL
     ON CONFLICT (id) DO NOTHING`
  );
  await db.query(
    `DELETE FROM feed_request_targets f WHERE f.origin = 'local' AND NOT EXISTS (SELECT 1 FROM request_targets t WHERE t.id = f.id AND t.claim_id IS NOT NULL)`
  );
}

/**
 * Cut the feed: publish what changed since the last batch, as one batch or,
 * when it is large, as several in a row. The first cut of a feed is a
 * snapshot of every public row, and so is the first cut after the mirrored
 * tables change shape, since every row then reads differently. Returns no
 * batches when nothing changed.
 *
 * One cut at a time: the cut holds a lock on the batches table until it
 * commits, so a second cut waits and then sees the first one's batches.
 */
export async function cutBatches(options: CutOptions = {}): Promise<CutResult> {
  const db = options.db ?? appDb;
  const config = loadConfig();
  const signingKey = options.signingKey ?? configuredSigningKey();
  const { publicKey, keyId } = publicHalf(signingKey);
  const migration = options.migration ?? migrationHead();
  const shape = replicatedShape();
  const maxBytes = Math.max(1, options.maxBatchBytes ?? config.mirrorBatchMaxBytes);
  const tables = replicatedTables();

  await refreshFeedRecords(db);

  return db.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    // Taken before the first read, so the snapshot this transaction reads is
    // one in which no other cut is half way.
    await tx.query("LOCK TABLE mirror_feed_batches IN SHARE ROW EXCLUSIVE MODE");
    // Timestamps and floats are rendered into the rows and their hashes.
    // One zone, so that a session's setting cannot make every row look
    // changed; and floats written out in full, so that none loses a digit
    // on the way.
    await tx.query("SET LOCAL TIME ZONE 'UTC'");
    await tx.query("SET LOCAL extra_float_digits = 3");

    // The first read, which fixes the snapshot: the mirror will show the
    // public graph as of this moment.
    const [clock] = await tx.query<{ cut_at: string }>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cut_at`
    );
    const others = await tx.query<{ name: string }>(
      `SELECT name FROM labels WHERE name <> $1 ORDER BY name LIMIT 3`,
      [PUBLIC_LABEL]
    );
    if (others.length > 0) {
      throw new MirrorPublishError(
        `This deployment defines labels besides "${PUBLIC_LABEL}" (${others.map((o) => `"${o.name}"`).join(", ")}), ` +
          `so it does not publish a mirror feed: the feed carries whole rows of the public graph, and what ` +
          `leaves a private graph leaves through redaction and release instead. Nothing was published.`
      );
    }

    const [head] = await tx.query<Head>(
      `SELECT sequence, feed_id, batch_hash, shape FROM mirror_feed_batches ORDER BY sequence DESC LIMIT 1`
    );

    // 1. What may be published, table by table, parents first.
    await buildPublishedSets(tx);

    // 2. What changed against the rows as last published.
    const kind: MirrorBatchKind = !head || head.shape !== shape || options.snapshot ? "snapshot" : "changes";
    const earlyRemovals = { deletions: [] as MirrorTableKeys[], retractions: [] as MirrorTableKeys[] };
    const lateRemovals = { deletions: [] as MirrorTableKeys[], retractions: [] as MirrorTableKeys[] };
    let changedRows = 0;
    let removedRows = 0;
    for (const table of tables) {
      await tx.query(
        `CREATE TEMP TABLE ${chg(table.name)} ON COMMIT DROP AS
         SELECT p.row_key FROM ${pub(table.name)} p
           LEFT JOIN mirror_feed_rows f ON f.table_name = ${lit(table.name)} AND f.row_key = p.row_key
          WHERE ${kind === "snapshot" ? "true" : "f.row_key IS NULL OR f.row_hash <> p.row_hash"}`
      );
      changedRows += await count(tx, `SELECT count(*)::int AS n FROM ${chg(table.name)}`);
      const gone = await tx.query<{ row_key: string; still_exists: boolean }>(
        `SELECT f.row_key, (x.${q(table.key[0]!)} IS NOT NULL) AS still_exists
           FROM mirror_feed_rows f
           LEFT JOIN ${q(table.name)} x ON ${keyText(table, "x")} = f.row_key
          WHERE f.table_name = $1
            AND NOT EXISTS (SELECT 1 FROM ${pub(table.name)} p WHERE p.row_key = f.row_key)
          ORDER BY f.row_key`,
        [table.name]
      );
      removedRows += gone.length;
      const into = table.removeBeforeWrite ? earlyRemovals : lateRemovals;
      const deleted = gone.filter((g) => !g.still_exists).map((g) => g.row_key);
      const retracted = gone.filter((g) => g.still_exists).map((g) => g.row_key);
      if (deleted.length > 0) into.deletions.push({ table: table.name, keys: deleted });
      if (retracted.length > 0) into.retractions.push({ table: table.name, keys: retracted });
    }
    if (changedRows === 0 && removedRows === 0 && !(kind === "snapshot" && !head)) {
      return { batches: [] };
    }

    // 3. Build the batches. Rows are read a few hundred at a time and a
    // batch is closed when it is full, so a snapshot of any size is never
    // held in memory whole. One batch is kept back so that the last one can
    // be marked as the last.
    const feedId = head?.feed_id ?? randomUUID();
    const firstSequence = (head ? Number(head.sequence) : 0) + 1;
    let sequence = firstSequence;
    let previousHash = head?.batch_hash ?? feedGenesisHash(feedId);
    const written: CutBatchSummary[] = [];

    interface Draft {
      rows: MirrorTableRows[];
      keys: Array<{ table: string; keys: string[] }>;
      bytes: number;
      count: number;
    }
    const emptyDraft = (): Draft => ({ rows: [], keys: [], bytes: 0, count: 0 });
    // In an object, because the closures below assign them.
    const open: { draft: Draft; heldBack: Draft | null } = { draft: emptyDraft(), heldBack: null };

    const write = async (d: Draft, isFirst: boolean, isLast: boolean) => {
      const deletions = [...(isFirst ? earlyRemovals.deletions : []), ...(isLast ? lateRemovals.deletions : [])];
      const retractions = [...(isFirst ? earlyRemovals.retractions : []), ...(isLast ? lateRemovals.retractions : [])];
      const body: MirrorBatchBody = {
        format: MIRROR_FEED_FORMAT,
        feed_id: feedId,
        sequence,
        kind,
        part: { first: firstSequence, last: isLast },
        cut_at: clock!.cut_at,
        migration: { number: migration.number, tag: migration.tag },
        shape,
        embedding: { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS },
        publisher: { web_base_url: options.webBaseUrl ?? config.publicWebBaseUrl },
        previous_hash: previousHash,
        rows: d.rows,
        deletions,
        retractions,
        key_id: keyId,
        public_key: publicKey,
      };
      const batch = signBatch(body, signingKey);
      const text = JSON.stringify(batch);
      const removals = [...deletions, ...retractions];
      const removalCount = removals.reduce((n, r) => n + r.keys.length, 0);
      await tx.query(
        `INSERT INTO mirror_feed_batches
           (sequence, feed_id, kind, part_first, part_last, migration_number, migration_tag, shape,
            cut_at, previous_hash, batch_hash, key_id, row_count, removal_count, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          sequence, feedId, kind, firstSequence, isLast, migration.number, migration.tag, shape,
          body.cut_at, previousHash, batch.hash, keyId, d.count, removalCount, text,
        ]
      );
      for (const { table, keys } of d.keys) {
        await tx.query(
          `INSERT INTO mirror_feed_rows (table_name, row_key, row_hash, sequence)
           SELECT $1, p.row_key, p.row_hash, $2 FROM ${pub(table)} p WHERE p.row_key = ANY($3::text[])
           ON CONFLICT (table_name, row_key) DO UPDATE SET row_hash = EXCLUDED.row_hash, sequence = EXCLUDED.sequence`,
          [table, sequence, keys]
        );
      }
      for (const { table, keys } of removals) {
        await tx.query(`DELETE FROM mirror_feed_rows WHERE table_name = $1 AND row_key = ANY($2::text[])`, [table, keys]);
      }
      written.push({ sequence, kind, rows: d.count, removals: removalCount, bytes: text.length, hash: batch.hash });
      previousHash = batch.hash;
      sequence++;
    };

    const close = async () => {
      if (open.heldBack) await write(open.heldBack, written.length === 0, false);
      open.heldBack = open.draft;
      open.draft = emptyDraft();
    };

    const add = (table: string, group: Array<{ key: string; row: Record<string, unknown>; bytes: number }>) => {
      const draft = open.draft;
      let rows = draft.rows.at(-1);
      if (!rows || rows.table !== table) {
        rows = { table, rows: [] };
        draft.rows.push(rows);
        draft.keys.push({ table, keys: [] });
      }
      const keys = draft.keys.at(-1)!;
      for (const member of group) {
        rows.rows.push(member.row);
        keys.keys.push(member.key);
        draft.bytes += member.bytes;
        draft.count++;
      }
    };

    const CHUNK = 200;
    for (const table of tables) {
      // The changed rows' keys in the order they must be written, with what
      // each points to in its own table.
      const selfRefs = table.selfReferences.map((c, i) => `x.${q(c)}::text AS r${i}`).join(", ");
      const ordered = await tx.query<Record<string, string | null>>(
        `SELECT c.row_key${selfRefs ? `, ${selfRefs}` : ""}
           FROM ${chg(table.name)} c JOIN ${q(table.name)} x ON ${keyText(table, "x")} = c.row_key
          ORDER BY ${table.writeOrder.split(",").map((part) => `x.${part.trim()}`).join(", ")}`
      );
      if (ordered.length === 0) continue;
      const refs = new Map<string, string[]>();
      for (const r of ordered) {
        refs.set(
          r.row_key!,
          table.selfReferences.map((_, i) => r[`r${i}`]).filter((v): v is string => typeof v === "string")
        );
      }
      const keys = ordered.map((r) => r.row_key!);
      const groups =
        table.selfReferences.length > 0 ? orderByReferences(keys, (k) => refs.get(k) ?? []) : keys.map((k) => [k]);

      for (let at = 0; at < groups.length; ) {
        // Whole groups, about CHUNK rows at a time.
        const take: string[][] = [];
        let n = 0;
        while (at < groups.length && (n === 0 || n + groups[at]!.length <= CHUNK)) {
          take.push(groups[at]!);
          n += groups[at]!.length;
          at++;
        }
        const wanted = take.flat();
        const fetched = await tx.query<{ row_key: string; row: Record<string, unknown> }>(
          `SELECT ${keyText(table, "x")} AS row_key, ${rowJson(table, "x")} AS row
             FROM ${q(table.name)} x WHERE ${keyAmong(table, "x", 1)}`,
          [wanted]
        );
        const byKey = new Map(fetched.map((f) => [f.row_key, f.row]));
        for (const group of take) {
          const members = group.map((key) => {
            const row = byKey.get(key);
            if (!row) throw new MirrorPublishError(`row ${key} of ${table.name} vanished inside the cut's snapshot`);
            return { key, row, bytes: JSON.stringify(row).length };
          });
          const size = members.reduce((sum, m) => sum + m.bytes, 0);
          if (open.draft.count > 0 && open.draft.bytes + size > maxBytes) await close();
          add(table.name, members);
        }
      }
    }
    if (open.draft.count > 0 || !open.heldBack) await close();
    await write(open.heldBack!, written.length === 0, true);
    return { batches: written };
  });
}

// ---- reading the feed ------------------------------------------------------------

export interface FeedKey {
  algorithm: "ed25519";
  /** The 32 bytes of the public key, base64. */
  public_key: string;
  /** sha256 of those bytes: how batches name the key. */
  key_id: string;
  /** The feed this deployment publishes; null until its first batch is cut. */
  feed_id: string | null;
}

export async function feedKey(db: MirrorDb = appDb, signingKey: KeyObject = configuredSigningKey()): Promise<FeedKey> {
  const { publicKey, keyId } = publicHalf(signingKey);
  const [head] = await db.query<{ feed_id: string }>(
    `SELECT feed_id FROM mirror_feed_batches ORDER BY sequence DESC LIMIT 1`
  );
  return { algorithm: "ed25519", public_key: publicKey, key_id: keyId, feed_id: head?.feed_id ?? null };
}

export interface FeedBatchListing {
  sequence: number;
  kind: MirrorBatchKind;
  part: { first: number; last: boolean };
  cut_at: string;
  migration: { number: number; tag: string };
  shape: string;
  previous_hash: string;
  hash: string;
  key_id: string;
  rows: number;
  removals: number;
  bytes: number;
}

export interface FeedListing {
  feed_id: string | null;
  /** The newest batch's sequence; null when none has been cut. */
  head: number | null;
  /**
   * Where a mirror that has applied nothing starts: the first batch of the
   * newest snapshot whose every part has been cut.
   */
  latest_snapshot: number | null;
  batches: FeedBatchListing[];
  has_more: boolean;
}

export const FEED_LIST_DEFAULT = 100;
export const FEED_LIST_MAX = 500;

/** Batches after a sequence, oldest first, without their rows. */
export async function listBatches(
  input: { after?: number; limit?: number } = {},
  db: MirrorDb = appDb
): Promise<FeedListing> {
  const after = Number.isSafeInteger(input.after) && input.after! > 0 ? input.after! : 0;
  const limit = Math.min(FEED_LIST_MAX, Math.max(1, Math.round(Number(input.limit ?? FEED_LIST_DEFAULT)) || FEED_LIST_DEFAULT));
  const rows = await db.query<{
    sequence: string;
    kind: MirrorBatchKind;
    part_first: string;
    part_last: boolean;
    cut_at: string;
    migration_number: number;
    migration_tag: string;
    shape: string;
    previous_hash: string;
    batch_hash: string;
    key_id: string;
    row_count: number;
    removal_count: number;
    bytes: number;
  }>(
    `SELECT sequence, kind, part_first, part_last,
            to_char(cut_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cut_at,
            migration_number, migration_tag, shape, previous_hash, batch_hash, key_id,
            row_count, removal_count, octet_length(body) AS bytes
       FROM mirror_feed_batches WHERE sequence > $1 ORDER BY sequence ASC LIMIT $2`,
    [after, limit + 1]
  );
  const [summary] = await db.query<{ feed_id: string | null; head: string | null; latest_snapshot: string | null }>(
    `SELECT (SELECT feed_id::text FROM mirror_feed_batches ORDER BY sequence DESC LIMIT 1) AS feed_id,
            (SELECT max(sequence) FROM mirror_feed_batches) AS head,
            (SELECT max(part_first) FROM mirror_feed_batches WHERE kind = 'snapshot' AND part_last) AS latest_snapshot`
  );
  return {
    feed_id: summary?.feed_id ?? null,
    head: summary?.head == null ? null : Number(summary.head),
    latest_snapshot: summary?.latest_snapshot == null ? null : Number(summary.latest_snapshot),
    batches: rows.slice(0, limit).map((r) => ({
      sequence: Number(r.sequence),
      kind: r.kind,
      part: { first: Number(r.part_first), last: r.part_last },
      cut_at: r.cut_at,
      migration: { number: r.migration_number, tag: r.migration_tag },
      shape: r.shape,
      previous_hash: r.previous_hash,
      hash: r.batch_hash,
      key_id: r.key_id,
      rows: r.row_count,
      removals: r.removal_count,
      bytes: Number(r.bytes),
    })),
    has_more: rows.length > limit,
  };
}

/** One batch as it was signed, byte for byte; null when there is none at that sequence. */
export async function getBatchText(sequence: number, db: MirrorDb = appDb): Promise<string | null> {
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  const [row] = await db.query<{ body: string }>(`SELECT body FROM mirror_feed_batches WHERE sequence = $1`, [sequence]);
  return row?.body ?? null;
}

/**
 * Write batches to a directory as files, one each, for a deployment whose
 * network does not reach the feed. The files are the batches as signed, so
 * a mirror checks them exactly as it checks a fetched one.
 */
export async function exportBatches(
  dir: string,
  input: { from?: number } = {},
  db: MirrorDb = appDb
): Promise<{ written: number[] }> {
  mkdirSync(dir, { recursive: true });
  const written: number[] = [];
  let after = Math.max(0, (input.from ?? 1) - 1);
  for (;;) {
    const rows = await db.query<{ sequence: string; body: string }>(
      `SELECT sequence, body FROM mirror_feed_batches WHERE sequence > $1 ORDER BY sequence ASC LIMIT 5`,
      [after]
    );
    if (rows.length === 0) return { written };
    for (const row of rows) {
      const sequence = Number(row.sequence);
      writeFileSync(join(dir, batchFileName(sequence)), row.body, "utf8");
      written.push(sequence);
      after = sequence;
    }
  }
}
