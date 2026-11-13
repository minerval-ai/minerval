/**
 * The mirror, applied: a private deployment's read-only copy of the public
 * graph, advanced one signed batch at a time (docs/mirror.md).
 *
 * A private deployment never queries the live public graph, because what it
 * asks would show what it is working on. It pulls the whole feed, which
 * shows only that it exists, and reads the public graph from the rows the
 * feed left here: in the same tables as its own rows, marked `origin =
 * 'mirror'`.
 *
 * A batch is applied only when all of this holds, and otherwise nothing of
 * it is written and the refusal is recorded with its reason:
 *
 *  - its hash is the hash of its contents and its signature verifies under
 *    a key this deployment was configured to trust (mirror-batch.ts);
 *  - it is the next batch of the feed this mirror follows, naming the last
 *    applied batch's hash as the one before it. Batches are never skipped
 *    and never applied twice: a batch already applied is recognized by its
 *    hash and changes nothing. The one way past a batch is the start of a
 *    later snapshot, which holds every public row and so needs nothing
 *    before it;
 *  - the mirrored tables had, where it was cut, exactly the shape this
 *    deployment's code writes (replicatedShape in mirror-manifest.ts), and
 *    its vectors come from this deployment's embedding model. The schema
 *    migration it was cut from is recorded and is not itself a reason to
 *    refuse: the public graph takes several migrations a day and few of
 *    them touch a mirrored table, so a mirror that stopped at each one
 *    would be stopped most of the time. What decides is whether the rows
 *    fit, and the shape says that. A batch whose shape differs is refused,
 *    with a message that says to upgrade when the batch is the newer side.
 *
 * A batch is applied in one transaction. The applier writes the replicated
 * columns and nothing else (mirror-manifest.ts): a claim's queue state and
 * the other local columns are set once, when the row first arrives, and
 * never touched again. It writes and removes only rows whose origin is
 * 'mirror', and every row it writes carries the label `public`. A row in a
 * batch that has the id of a local row stops the batch.
 *
 * Nothing this deployment holds of its own stops a batch otherwise, at any
 * label. The applier works at system clearance, on the tables' owner's
 * connection (db/clearance.ts), because it has to see a row at any label
 * that points to a row it removes, and its own rows are the public graph's
 * and belong to no run. A key a deployment's row can share with a mirrored
 * one (an address, an edge's two nodes) is unique within a graph and not
 * across the two (db/schema.ts, the origin column), so both stand. The one
 * thing of the deployment's own a batch changes is a judgment recorded
 * here at a mirrored node's own label, which nothing should have recorded
 * (services/mirrored-node-service.ts): it is retired, not deleted, so that
 * the public graph's judgment is the one in force, and the batch's notes
 * say so.
 *
 * What a batch changed on a node that leaves no other trace (its wording,
 * an argument, a merge, a withdrawal) is written to node_changes in
 * the same transaction, and the result names the nodes whose public
 * judgment moved, for the upkeep that follows (services/mirror-upkeep.ts).
 *
 * What the public graph withdraws (a deletion, a retraction, a row absent
 * from a snapshot) is removed here too, with the exceptions the manifest
 * states (keepWhenReferenced): a mirrored claim, argument, instance or
 * source that this deployment's own rows still point to is kept, marked as
 * gone where the table has a mark, so that what the deployment recorded on
 * it is not swept away with it. Other mirrored rows are deleted and the
 * local link rows that pointed to them (a grouping of an edge) follow their
 * foreign keys; what was kept and what went is in the batch's notes. A merge
 * needs no handling: the absorbed claim arrives with its state and
 * merged_into, references to it still resolve, and local rows that hang off
 * it are left as they are and listed in the notes. Nothing of the
 * deployment's own at a private label is deleted or moved by a batch: what
 * such rows should now point to is a judgment, and the upkeep opens it for
 * the Steward at each label concerned.
 *
 * Applying a batch runs no agent and funds nothing. Mirrored claims arrive
 * deferred and marked as tagged, so they are in neither drain.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import { loadConfig } from "../config.js";
import { withSystemClearance } from "../db/clearance.js";
import { PUBLIC_LABEL } from "../labels.js";
import { noteMirrorApplied } from "./mirrored-node-service.js";
import { migrationHead, type MigrationHead } from "../db/migration-head.js";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./embedding-model.js";
import {
  MirrorRefusal,
  batchFileName,
  parsePublicKey,
  readBatch,
  sequenceOfFileName,
  verifyBatch,
  type MirrorBatch,
  type MirrorBatchKind,
  type MirrorRefusalCode,
} from "./mirror-batch.js";
import { appDb, type MirrorDb, type MirrorQuery } from "./mirror-db.js";
import { keyAmong, keyText } from "./mirror-feed-service.js";
import { replicatedShape, replicatedTable, replicatedTables, type ReplicatedTable } from "./mirror-manifest.js";

/** The mirror cannot be fed as configured. The message is for an operator. */
export class MirrorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MirrorConfigError";
  }
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Why the applier works at system clearance (tests/unit/db/system-clearance.test.ts lists it). */
const APPLIER_REASON =
  "The mirror's applier writes the public graph's rows, which belong to no run, and must see a row at any label that points to one it removes.";

/** The session setting the guard triggers read; set for the applier's transaction only. */
const APPLIER_SETTING = "minerval.mirror_applier";

/** The most entries of one kind a batch's notes hold; the count beside them is always whole. */
const NOTE_LIMIT = 200;

export interface LocalRows {
  table: string;
  column: string;
  /** What the foreign key does when the row it points to is deleted. */
  on_delete: string;
  rows: number;
}

export type WithdrawalReason = "deleted" | "retracted" | "absent_from_snapshot" | "cleared_for_snapshot";

export interface ApplyNotes {
  /** Claims the public graph merged away that local rows still point to. Nothing was changed. */
  merged_with_local_rows?: { count: number; claims: Array<{ claim_id: string; merged_into: string; local_rows: LocalRows[] }> };
  /** Mirrored claims the public graph withdrew, kept as deprecated because local rows point to them. */
  kept_claims?: { count: number; claims: Array<{ claim_id: string; reason: WithdrawalReason; local_rows: LocalRows[] }> };
  /**
   * Other mirrored rows the public graph withdrew and this deployment kept,
   * marked as gone where the table has a mark, because local rows point to
   * them: arguments, instances and sources.
   */
  kept_rows?: Array<{ table: string; reason: WithdrawalReason; count: number; keys: string[] }>;
  /** Local rows that pointed to a mirrored row this batch removed, and so were deleted or unlinked with it. */
  local_rows_followed?: Array<{ table: string; reason: WithdrawalReason; local_rows: LocalRows[] }>;
  /**
   * Judgments this deployment had recorded at a mirrored node's own label,
   * retired (not deleted) so that the public graph's is the one in force.
   */
  local_judgments_retired?: Array<{ table: string; count: number; ids: string[] }>;
}

/** The nodes a batch touched in a way something of this deployment's own may rest on. */
export interface TouchedNodes {
  /** Nodes whose public judgment was written or removed: a verdict, an estimate, an answer, an argument's evaluation. */
  judged: string[];
  /** Mirrored nodes this batch brought for the first time. */
  arrived: string[];
  /** Nodes the public graph merged into another, with the node each was merged into. */
  merged: Array<{ claim_id: string; merged_into: string }>;
  /** Nodes the public graph withdrew: no longer active there, or gone and kept here because local rows point to them. */
  withdrawn: string[];
}

export interface TableCounts {
  inserted: number;
  updated: number;
  removed: number;
  kept: number;
}

/** The keys of the mirrored rows a batch changed, by table. */
export interface ChangedKeys {
  /** Inserted, or updated because a replicated column differed. */
  written: string[];
  removed: string[];
  /** Withdrawn by the public graph and kept here, as deprecated. */
  kept: string[];
}

export interface ApplyResult {
  status: "applied" | "already_applied";
  sequence: number;
  kind: MirrorBatchKind;
  hash: string;
  cut_at: string;
  counts: Record<string, TableCounts>;
  /**
   * Which mirrored rows moved. Not stored: it is for whatever acts on a
   * mirror update in the same process (marking a private judgment as made
   * against an earlier version of a public one, when that is built).
   */
  changed: Record<string, ChangedKeys>;
  /** The nodes those rows belong to, for the upkeep that follows a batch (services/mirror-upkeep.ts). Not stored. */
  nodes: TouchedNodes;
  notes: ApplyNotes;
}

export interface ApplyOptions {
  db?: MirrorDb;
  /** The keys a batch's signature may verify under; the configured ones when absent. */
  trustedKeys?: readonly KeyObject[];
  /** Where the batch came from, for the record: the feed's address or a file's name. */
  receivedFrom?: string;
  /** This deployment's schema migration; read from the journal when absent. */
  migration?: MigrationHead;
  /** The shape of the mirrored tables as this deployment's code writes them; computed when absent. */
  shape?: string;
}

/** The keys MIRROR_FEED_PUBLIC_KEYS names. */
export function configuredTrustedKeys(): KeyObject[] {
  const stated = loadConfig().mirrorFeedPublicKeys;
  if (stated.length === 0) {
    throw new MirrorConfigError(
      "This deployment has no public key for the mirror feed, so no batch can be checked. Set " +
        "MIRROR_FEED_PUBLIC_KEYS to the feed's key as GET /mirror/feed/key gives it, confirmed with the " +
        "publisher by another route."
    );
  }
  try {
    return stated.map(parsePublicKey);
  } catch (err) {
    throw new MirrorConfigError(`MIRROR_FEED_PUBLIC_KEYS: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- foreign keys into the mirrored tables ---------------------------------------

interface ForeignKey {
  from_table: string;
  from_column: string;
  to_table: string;
  on_delete: string;
  has_origin: boolean;
}

const ON_DELETE: Record<string, string> = { a: "no action", r: "restrict", c: "cascade", n: "set null", d: "set default" };

/** Every single-column foreign key that points into a replicated table, from the catalog. */
async function foreignKeysInto(tx: MirrorQuery): Promise<ForeignKey[]> {
  const rows = await tx.query<ForeignKey & { on_delete: string }>(
    `SELECT c.conrelid::regclass::text AS from_table, a.attname AS from_column,
            c.confrelid::regclass::text AS to_table, c.confdeltype AS on_delete,
            EXISTS (SELECT 1 FROM pg_attribute o
                     WHERE o.attrelid = c.conrelid AND o.attname = 'origin' AND NOT o.attisdropped) AS has_origin
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
        AND c.confrelid = ANY($1::text[]::regclass[])
      ORDER BY 1, 2`,
    [replicatedTables().map((t) => t.name)]
  );
  return rows.map((r) => ({ ...r, on_delete: ON_DELETE[r.on_delete] ?? r.on_delete }));
}

/**
 * The local rows that point to each of `keys` in `table`: rows of this
 * deployment's own in a replicated table, and any row in a table that is not
 * replicated. Mirrored rows that point there are the feed's own business.
 */
async function localReferences(
  tx: MirrorQuery,
  fks: readonly ForeignKey[],
  table: ReplicatedTable,
  keys: readonly string[]
): Promise<Map<string, LocalRows[]>> {
  const found = new Map<string, LocalRows[]>();
  if (table.key.length !== 1 || keys.length === 0) return found;
  for (const fk of fks) {
    if (fk.to_table !== table.name) continue;
    const rows = await tx.query<{ key: string; rows: number }>(
      `SELECT r.${q(fk.from_column)}::text AS key, count(*)::int AS rows
         FROM ${fk.from_table} r
        WHERE r.${q(fk.from_column)} = ANY($1::uuid[])${fk.has_origin ? " AND r.origin = 'local'" : ""}
        GROUP BY 1`,
      [keys]
    );
    for (const r of rows) {
      const list = found.get(r.key) ?? [];
      list.push({ table: fk.from_table, column: fk.from_column, on_delete: fk.on_delete, rows: r.rows });
      found.set(r.key, list);
    }
  }
  return found;
}

/**
 * Which of `keys` in `table` a mirrored row still points to, from a table
 * whose withdrawn rows are kept when this deployment's own point to them.
 * The public graph removes what hangs off a row with the row, in the same
 * cut and before it here, so a mirrored row that still points to one being
 * removed is one that was kept.
 */
async function heldByKeptRows(
  tx: MirrorQuery,
  fks: readonly ForeignKey[],
  table: ReplicatedTable,
  keys: readonly string[]
): Promise<Set<string>> {
  const held = new Set<string>();
  if (table.key.length !== 1 || keys.length === 0) return held;
  for (const fk of fks) {
    if (fk.to_table !== table.name || !fk.has_origin || fk.from_table === table.name) continue;
    if (replicatedTable(fk.from_table)?.keepWhenReferenced === undefined) continue;
    const rows = await tx.query<{ key: string }>(
      `SELECT DISTINCT r.${q(fk.from_column)}::text AS key FROM ${fk.from_table} r
        WHERE r.${q(fk.from_column)} = ANY($1::uuid[]) AND r.origin = 'mirror'`,
      [keys]
    );
    for (const r of rows) held.add(r.key);
  }
  return held;
}

function sumLocalRows(lists: Iterable<LocalRows[]>): LocalRows[] {
  const total = new Map<string, LocalRows>();
  for (const list of lists) {
    for (const entry of list) {
      const id = `${entry.table}.${entry.column}`;
      const have = total.get(id);
      if (have) have.rows += entry.rows;
      else total.set(id, { ...entry });
    }
  }
  return [...total.values()];
}

// ---- writing ---------------------------------------------------------------------

function upsertSql(table: ReplicatedTable): string {
  const rest = table.columns.filter((c) => !table.key.includes(c));
  // The label is named: where a deployment has more than one, an insert
  // that names none on the owner's connection is refused
  // (minerval_default_label), and a mirrored row is public by what it is.
  const insertColumns = [...table.columns, "origin", "sensitivity_label", ...Object.keys(table.onInsert)];
  const values = [
    ...table.columns.map((c) => `r.${q(c)}`),
    "'mirror'",
    `'${PUBLIC_LABEL}'`,
    ...Object.values(table.onInsert),
  ];
  const sets = rest.map((c) => `${q(c)} = EXCLUDED.${q(c)}`);
  if (table.touchOnWrite) sets.push(`${q(table.touchOnWrite)} = now()`);
  // Written only where a replicated column differs, so that a row a
  // snapshot repeats unchanged is not rewritten, and a local row with the
  // same key is never written at all (the caller has already refused that).
  const onConflict =
    rest.length === 0
      ? "DO NOTHING"
      : `DO UPDATE SET ${sets.join(", ")}
           WHERE t.origin = 'mirror'
             AND (${rest.map((c) => `t.${q(c)}`).join(", ")}) IS DISTINCT FROM (${rest.map((c) => `EXCLUDED.${q(c)}`).join(", ")})`;
  return `INSERT INTO ${q(table.name)} AS t (${insertColumns.map(q).join(", ")})
          SELECT ${values.join(", ")}
            FROM jsonb_populate_recordset(null::${q(table.name)}, $1::jsonb) r
           ORDER BY ${table.writeOrder.split(",").map((part) => `r.${part.trim()}`).join(", ")}
          ON CONFLICT (${table.primaryKey.map(q).join(", ")}) ${onConflict}
          RETURNING ${keyText(table, "t")} AS row_key, (t.xmax = 0) AS inserted`;
}

function keyOfRow(table: ReplicatedTable, row: Record<string, unknown>): string {
  return table.key.map((k) => String(row[k])).join("/");
}

interface Working {
  tx: MirrorQuery;
  batch: MirrorBatch;
  counts: Record<string, TableCounts>;
  changed: Record<string, ChangedKeys>;
  notes: ApplyNotes;
  fks: ForeignKey[] | null;
  /** The nodes whose public judgment this batch wrote or removed. */
  judged: Set<string>;
  /** Mirrored claims first written by this batch. */
  arrived: Set<string>;
  merged: Map<string, string>;
  withdrawn: Set<string>;
}

/** The node a judgment is of, as SQL over the judgment's row aliased `alias`. */
const JUDGED_NODE: Record<string, (alias: string) => string> = {
  assessments: (alias) => `${alias}.claim_id`,
  quantity_estimates: (alias) => `${alias}.claim_id`,
  question_assessments: (alias) => `${alias}.claim_id`,
  argument_evaluations: (alias) => `(SELECT a.claim_id FROM arguments a WHERE a.id = ${alias}.argument_id)`,
};

/** The column that names what a judgment is of: its node, or for an evaluation its argument. */
const JUDGED_COLUMN: Record<string, string> = {
  assessments: "claim_id",
  quantity_estimates: "claim_id",
  question_assessments: "claim_id",
  argument_evaluations: "argument_id",
};

type NodeChange = "reworded" | "argument_added" | "argument_rewritten" | "argument_retired" | "argument_removed" | "merged" | "withdrawn";

/** Record what this batch changed on a mirrored node (db/schema.ts, node_changes). */
async function recordNodeChanges(
  w: Working,
  changes: Array<{ claim_id: string; change: NodeChange; detail: Record<string, unknown> }>
): Promise<void> {
  if (changes.length === 0) return;
  await w.tx.query(
    `INSERT INTO node_changes (claim_id, sequence, cut_at, change, detail, sensitivity_label)
     SELECT c.claim_id, $2, $3, c.change, c.detail, '${PUBLIC_LABEL}'
       FROM jsonb_to_recordset($1::jsonb) AS c(claim_id uuid, change text, detail jsonb)`,
    [JSON.stringify(changes), w.batch.sequence, w.batch.cut_at]
  );
}

function countsFor(w: Working, table: string): TableCounts {
  return (w.counts[table] ??= { inserted: 0, updated: 0, removed: 0, kept: 0 });
}

function changedFor(w: Working, table: string): ChangedKeys {
  return (w.changed[table] ??= { written: [], removed: [], kept: [] });
}

async function fksOf(w: Working): Promise<ForeignKey[]> {
  return (w.fks ??= await foreignKeysInto(w.tx));
}

/** Remove mirrored rows the public graph has withdrawn; see the header for what is kept. */
async function removeRows(w: Working, table: ReplicatedTable, keys: readonly string[], reason: WithdrawalReason): Promise<void> {
  if (keys.length === 0) return;
  const counts = countsFor(w, table.name);
  const fks = await fksOf(w);
  const refs = await localReferences(w.tx, fks, table, keys);
  // A row a kept row points to is kept with it: deleting it would take the
  // kept row, and what this deployment recorded on that, by the foreign key.
  const held = table.keepWhenReferenced === undefined ? new Set<string>() : await heldByKeptRows(w.tx, fks, table, keys);
  const isKept = (k: string) => refs.has(k) || held.has(k);
  let toDelete = [...keys];
  if (table.keepWhenReferenced !== undefined && keys.some(isKept)) {
    const kept = keys.filter(isKept);
    toDelete = keys.filter((k) => !isKept(k));
    // A row kept at an earlier batch is met again by every later snapshot,
    // which does not hold it either. What is recorded and told below is for
    // the rows this batch is the first to keep.
    const firstKept = new Set(
      table.name === "claims" || table.name === "arguments"
        ? (
            await w.tx.query<{ id: string }>(
              `SELECT id::text FROM ${q(table.name)} x WHERE x.id = ANY($1::uuid[])
                  AND ${table.name === "claims" ? "x.state <> 'deprecated'" : "x.retired_at IS NULL"}`,
              [kept]
            )
          ).map((r) => r.id)
        : kept
    );
    const marks = [table.keepWhenReferenced, table.touchOnWrite ? `${q(table.touchOnWrite)} = now()` : ""].filter((m) => m !== "");
    if (marks.length > 0) {
      await w.tx.query(
        `UPDATE ${q(table.name)} x SET ${marks.join(", ")} WHERE ${keyAmong(table, "x", 1)} AND x.origin = 'mirror'`,
        [kept]
      );
    }
    counts.kept += kept.length;
    changedFor(w, table.name).kept.push(...kept);
    if (table.name !== "claims") {
      (w.notes.kept_rows ??= []).push({ table: table.name, reason, count: kept.length, keys: kept.slice(0, NOTE_LIMIT) });
    }
    if (table.name === "arguments") {
      const of = await w.tx.query<{ id: string; claim_id: string; name: string }>(
        `SELECT id::text, claim_id::text, name FROM arguments WHERE id = ANY($1::uuid[])`,
        [kept]
      );
      await recordNodeChanges(
        w,
        of
          .filter((a) => firstKept.has(a.id))
          .map((a) => ({ claim_id: a.claim_id, change: "argument_removed" as const, detail: { argument_id: a.id, name: a.name } }))
      );
    }
    if (table.name === "claims") {
      const fresh = kept.filter((key) => firstKept.has(key));
      for (const key of fresh) w.withdrawn.add(key);
      await recordNodeChanges(
        w,
        fresh.map((claim_id) => ({ claim_id, change: "withdrawn" as const, detail: { how: reason } }))
      );
    }
    if (table.name === "claims") {
      const note = (w.notes.kept_claims ??= { count: 0, claims: [] });
      note.count += kept.length;
      for (const key of kept) {
        if (note.claims.length < NOTE_LIMIT) note.claims.push({ claim_id: key, reason, local_rows: refs.get(key) ?? [] });
      }
    }
  } else if (refs.size > 0) {
    (w.notes.local_rows_followed ??= []).push({ table: table.name, reason, local_rows: sumLocalRows(refs.values()) });
  }
  if (toDelete.length === 0) return;
  // The node a removed judgment was of, and a removed argument's node and
  // name, are read as the row goes: afterwards nothing says.
  const node = JUDGED_NODE[table.name];
  const returning =
    table.name === "arguments" ? `, x.claim_id::text AS node, x.name` : node ? `, ${node("x")}::text AS node` : "";
  const removed = await w.tx.query<{ row_key: string; node?: string | null; name?: string }>(
    `DELETE FROM ${q(table.name)} x WHERE ${keyAmong(table, "x", 1)} AND x.origin = 'mirror'
     RETURNING ${keyText(table, "x")} AS row_key${returning}`,
    [toDelete]
  );
  counts.removed += removed.length;
  changedFor(w, table.name).removed.push(...removed.map((r) => r.row_key));
  if (node) for (const r of removed) if (r.node) w.judged.add(r.node);
  if (table.name === "arguments") {
    // An argument that goes with its node says nothing the node's own
    // removal does not.
    const [still] = await w.tx.query<{ ids: string[] }>(
      `SELECT COALESCE(array_agg(id::text), '{}') AS ids FROM claims WHERE id = ANY($1::uuid[])`,
      [removed.map((r) => r.node)]
    );
    const there = new Set(still?.ids ?? []);
    await recordNodeChanges(
      w,
      removed
        .filter((r) => r.node && there.has(r.node))
        .map((r) => ({ claim_id: r.node!, change: "argument_removed" as const, detail: { argument_id: r.row_key, name: r.name } }))
    );
  }
}

async function writeRows(w: Working, table: ReplicatedTable, rows: Array<Record<string, unknown>>): Promise<void> {
  if (rows.length === 0) return;
  const keys = rows.map((row) => keyOfRow(table, row));
  // A table whose key names other rows may hold a row of this deployment's
  // own with the same key; it stands beside the mirrored one (keyPerGraph).
  const collisions = table.keyPerGraph
    ? []
    : await w.tx.query<{ row_key: string }>(
        `SELECT ${keyText(table, "x")} AS row_key FROM ${q(table.name)} x
          WHERE ${keyAmong(table, "x", 1)} AND x.origin = 'local' LIMIT 5`,
        [keys]
      );
  if (collisions.length > 0) {
    throw new MirrorRefusal(
      "id_collision",
      `Batch ${w.batch.sequence} was not applied: it carries ${table.name} row ${collisions.map((c) => c.row_key).join(", ")}, ` +
        `and this deployment already holds ${collisions.length === 1 ? "a row" : "rows"} of its own with ` +
        `${collisions.length === 1 ? "that id" : "those ids"}. A mirrored row and a local row never share an id, so ` +
        `this database was probably loaded with rows copied from the public graph. Nothing was written; ` +
        `the local row has to be removed or re-identified by hand before the mirror can go on.`,
      { sequence: w.batch.sequence, hash: w.batch.hash }
    );
  }
  const judgedColumn = JUDGED_COLUMN[table.name];
  if (judgedColumn) await retireLocalJudgmentsInTheWay(w, table, judgedColumn, rows);
  const before = await nodeFactsBefore(w, table, keys);
  const written = await w.tx.query<{ row_key: string; inserted: boolean }>(upsertSql(table), [JSON.stringify(rows)]);
  const counts = countsFor(w, table.name);
  for (const row of written) {
    if (row.inserted) counts.inserted++;
    else counts.updated++;
  }
  if (written.length > 0) changedFor(w, table.name).written.push(...written.map((r) => r.row_key));
  await noteWhatMoved(w, table, rows, written, before);
  if (w.batch.kind === "snapshot") {
    await w.tx.query(
      `INSERT INTO mirror_snapshot_rows (table_name, row_key)
       SELECT $1, k FROM unnest($2::text[]) AS k ON CONFLICT DO NOTHING`,
      [table.name, keys]
    );
  }
}

/**
 * A judgment this deployment recorded at a mirrored node's own label stands
 * where the public graph's must: one current judgment for a node at a
 * label. Nothing should have recorded one (mirrored-node-service.ts), and
 * the public graph's is the one a reader is owed, so the local one is
 * retired to history before the mirrored current row is written. It is the
 * only row of the deployment's own that a batch changes, and it is at the
 * label everyone reads.
 */
async function retireLocalJudgmentsInTheWay(
  w: Working,
  table: ReplicatedTable,
  judgedColumn: string,
  rows: Array<Record<string, unknown>>
): Promise<void> {
  const of = [...new Set(rows.filter((r) => r.is_current === true).map((r) => String(r[judgedColumn])))];
  if (of.length === 0) return;
  const retired = await w.tx.query<{ id: string }>(
    `UPDATE ${q(table.name)} x SET is_current = false
      WHERE x.${q(judgedColumn)} = ANY($1::uuid[]) AND x.is_current AND x.origin = 'local'
        AND x.sensitivity_label = '${PUBLIC_LABEL}'
      RETURNING x.id`,
    [of]
  );
  if (retired.length === 0) return;
  (w.notes.local_judgments_retired ??= []).push({
    table: table.name,
    count: retired.length,
    ids: retired.slice(0, NOTE_LIMIT).map((r) => r.id),
  });
}

interface NodeFactsBefore {
  claims: Map<string, { text: string; state: string; merged_into: string | null }>;
  arguments: Map<string, { content: string | null; retired: boolean }>;
}

/** What the mirrored rows about to be written say now, where a change to it is worth recording. */
async function nodeFactsBefore(w: Working, table: ReplicatedTable, keys: readonly string[]): Promise<NodeFactsBefore> {
  const before: NodeFactsBefore = { claims: new Map(), arguments: new Map() };
  if (table.name === "claims") {
    const rows = await w.tx.query<{ id: string; text: string; state: string; merged_into: string | null }>(
      `SELECT id::text, text, state, merged_into::text FROM claims WHERE id = ANY($1::uuid[]) AND origin = 'mirror'`,
      [keys]
    );
    for (const r of rows) before.claims.set(r.id, r);
  } else if (table.name === "arguments") {
    const rows = await w.tx.query<{ id: string; content: string | null; retired: boolean }>(
      `SELECT id::text, content, retired_at IS NOT NULL AS retired FROM arguments
        WHERE id = ANY($1::uuid[]) AND origin = 'mirror'`,
      [keys]
    );
    for (const r of rows) before.arguments.set(r.id, r);
  }
  return before;
}

/**
 * After a table's rows are written: which nodes' public judgment moved, and
 * what changed on a node that nothing else records (a wording, an
 * argument, a merge, a withdrawal).
 */
async function noteWhatMoved(
  w: Working,
  table: ReplicatedTable,
  rows: Array<Record<string, unknown>>,
  written: Array<{ row_key: string; inserted: boolean }>,
  before: NodeFactsBefore
): Promise<void> {
  if (written.length === 0) return;
  const moved = new Set(written.map((r) => r.row_key));
  const node = JUDGED_NODE[table.name];
  if (node) {
    const of = await w.tx.query<{ node: string | null }>(
      `SELECT DISTINCT ${node("x")}::text AS node FROM ${q(table.name)} x WHERE ${keyAmong(table, "x", 1)}`,
      [[...moved]]
    );
    for (const r of of) if (r.node) w.judged.add(r.node);
    return;
  }
  const changes: Array<{ claim_id: string; change: NodeChange; detail: Record<string, unknown> }> = [];
  if (table.name === "claims") {
    for (const r of written) if (r.inserted) w.arrived.add(r.row_key);
    for (const row of rows) {
      const id = String(row.id);
      const was = before.claims.get(id);
      if (!was || !moved.has(id)) continue;
      if (typeof row.text === "string" && row.text !== was.text) {
        changes.push({ claim_id: id, change: "reworded", detail: { was: was.text, now: row.text } });
      }
      if (row.state === "merged" && typeof row.merged_into === "string" && was.merged_into !== row.merged_into) {
        w.merged.set(id, row.merged_into);
        changes.push({ claim_id: id, change: "merged", detail: { merged_into: row.merged_into } });
      } else if (was.state === "active" && typeof row.state === "string" && row.state !== "active" && row.state !== "merged") {
        w.withdrawn.add(id);
        changes.push({ claim_id: id, change: "withdrawn", detail: { how: "state", state: row.state } });
      }
    }
  } else if (table.name === "arguments") {
    for (const row of rows) {
      const id = String(row.id);
      if (!moved.has(id)) continue;
      const claim = String(row.claim_id);
      const was = before.arguments.get(id);
      const detail = { argument_id: id, name: row.name };
      if (!was) {
        // An argument that arrives with its node is part of the node as it arrived.
        if (!w.arrived.has(claim)) changes.push({ claim_id: claim, change: "argument_added", detail });
      } else if (!was.retired && row.retired_at != null) {
        changes.push({ claim_id: claim, change: "argument_retired", detail: { ...detail, reason: row.retired_reason ?? null } });
      } else if ((row.content ?? null) !== was.content) {
        changes.push({ claim_id: claim, change: "argument_rewritten", detail });
      }
    }
  }
  await recordNodeChanges(w, changes);
}

/** Every mirrored row's key in a table, or only those a finished snapshot did not hold. */
async function mirroredKeys(tx: MirrorQuery, table: ReplicatedTable, onlyUnseen: boolean): Promise<string[]> {
  const rows = await tx.query<{ row_key: string }>(
    `SELECT ${keyText(table, "x")} AS row_key FROM ${q(table.name)} x
      WHERE x.origin = 'mirror'` +
      (onlyUnseen
        ? ` AND NOT EXISTS (SELECT 1 FROM mirror_snapshot_rows s
                             WHERE s.table_name = $1 AND s.row_key = ${keyText(table, "x")})`
        : ""),
    onlyUnseen ? [table.name] : []
  );
  return rows.map((r) => r.row_key);
}

interface Head {
  sequence: string;
  feed_id: string;
  batch_hash: string;
}

async function applyVerified(tx: MirrorQuery, batch: MirrorBatch, options: ApplyOptions): Promise<ApplyResult> {
  const at = { sequence: batch.sequence, hash: batch.hash };
  const refuse = (code: MirrorRefusalCode, why: string) =>
    new MirrorRefusal(code, `Batch ${batch.sequence} was not applied: ${why}`, at);

  // One applier at a time, and the head read under the lock.
  await tx.query("LOCK TABLE mirror_applied_batches IN SHARE ROW EXCLUSIVE MODE");
  const [head] = await tx.query<Head>(
    `SELECT sequence, feed_id, batch_hash FROM mirror_applied_batches ORDER BY sequence DESC LIMIT 1`
  );
  const headSequence = head ? Number(head.sequence) : 0;
  const startsSnapshot = batch.kind === "snapshot" && batch.part.first === batch.sequence;
  const whatItIs =
    batch.kind === "snapshot"
      ? `a later part of the snapshot that begins at batch ${batch.part.first}`
      : "a batch of changes";

  if (head) {
    if (batch.feed_id !== head.feed_id) {
      throw refuse(
        "other_feed",
        `it belongs to feed ${batch.feed_id}, and this mirror follows feed ${head.feed_id}. A mirror follows one feed from its first batch on.`
      );
    }
    if (batch.sequence <= headSequence) {
      const [prior] = await tx.query<{ batch_hash: string; cut_at: string }>(
        `SELECT batch_hash, to_char(cut_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cut_at
           FROM mirror_applied_batches WHERE sequence = $1`,
        [batch.sequence]
      );
      if (prior?.batch_hash === batch.hash) {
        return {
          status: "already_applied",
          sequence: batch.sequence,
          kind: batch.kind,
          hash: batch.hash,
          cut_at: prior.cut_at,
          counts: {},
          changed: {},
          nodes: { judged: [], arrived: [], merged: [], withdrawn: [] },
          notes: {},
        };
      }
      if (prior) {
        throw refuse(
          "sequence_conflict",
          `this mirror already applied a different batch at sequence ${batch.sequence} (hash ${prior.batch_hash.slice(0, 16)}). ` +
            `Two batches with one sequence number cannot both be the feed's; ask the publisher which is.`
        );
      }
      throw refuse(
        "sequence_gap",
        `this mirror is already at batch ${headSequence}, which it reached from a snapshot that came after batch ${batch.sequence}.`
      );
    }
    if (batch.sequence === headSequence + 1) {
      if (batch.previous_hash !== head.batch_hash) {
        throw refuse(
          "chain_broken",
          `it names ${batch.previous_hash.slice(0, 16)} as the batch before it, and the batch this mirror applied before it ` +
            `has hash ${head.batch_hash.slice(0, 16)}. It does not continue the feed this mirror has been following.`
        );
      }
    } else if (!startsSnapshot) {
      throw refuse(
        "sequence_gap",
        `this mirror is at batch ${headSequence}, so the next batch it can apply is ${headSequence + 1}, or the first batch of a ` +
          `later snapshot. Batch ${batch.sequence} is ${whatItIs}. Batches are applied in order and none is skipped.`
      );
    }
  } else if (!startsSnapshot) {
    throw refuse(
      "not_a_snapshot",
      `this mirror has applied nothing yet, and a mirror starts from the first batch of a snapshot. Batch ${batch.sequence} is ` +
        `${whatItIs}. GET /mirror/feed on the publisher names the latest snapshot.`
    );
  }

  // The migration a batch was cut from does not decide whether it is
  // applied: the shape of the mirrored tables does. A batch from a newer
  // migration with the same shape fits these tables row for row, and is
  // applied. The migration number says which side has to move when the
  // shapes differ.
  const mine = options.migration ?? migrationHead();
  if (batch.shape !== (options.shape ?? replicatedShape())) {
    if (batch.migration.number > mine.number) {
      throw refuse(
        "schema_newer",
        `it was cut from schema migration ${batch.migration.number} (${batch.migration.tag}), and this deployment's code is at ` +
          `migration ${mine.number} (${mine.tag}). Between the two the mirrored tables changed (their columns, or what a ` +
          `column's values mean), so its rows do not fit here. Upgrade this deployment to a release that includes migration ` +
          `${batch.migration.number}, then apply the batch again. The mirror stays ${head ? `at batch ${headSequence}` : "empty"} until then.`
      );
    }
    throw refuse(
      "shape_differs",
      `it was cut at schema migration ${batch.migration.number} (${batch.migration.tag}), when the mirrored tables had a ` +
        `different shape (their columns, or what a column's values mean) from the one this deployment's code (migration ` +
        `${mine.number}) writes, so its rows do not fit. The publisher cuts a full snapshot once it runs the same schema; ` +
        `the mirror goes on from that snapshot.`
    );
  }
  if (batch.embedding.model !== EMBEDDING_MODEL || batch.embedding.dimensions !== EMBEDDING_DIMENSIONS) {
    throw refuse(
      "embedding_differs",
      `its vectors come from the embedding model ${batch.embedding.model} (${batch.embedding.dimensions} dimensions), and this ` +
        `deployment embeds with ${EMBEDDING_MODEL} (${EMBEDDING_DIMENSIONS}). Mirrored and local claims are matched by comparing ` +
        `their vectors, which only works when one model made them all.`
    );
  }

  const tables = replicatedTables();
  for (const entry of [...batch.rows, ...batch.deletions, ...batch.retractions]) {
    if (!replicatedTable(entry.table)) {
      throw new MirrorRefusal(
        "malformed",
        `Batch ${batch.sequence} was not applied: it carries rows for "${entry.table}", which is not a table this deployment mirrors.`,
        at
      );
    }
  }

  // From here on this transaction is the applier: the guard on mirrored
  // rows lets it write them, until the transaction ends.
  await tx.query(`SELECT set_config('${APPLIER_SETTING}', 'on', true)`);
  const w: Working = {
    tx,
    batch,
    counts: {},
    changed: {},
    notes: {},
    fks: null,
    judged: new Set(),
    arrived: new Set(),
    merged: new Map(),
    withdrawn: new Set(),
  };
  const childrenFirst = [...tables].reverse();

  const jumped = head !== undefined && batch.sequence !== headSequence + 1;
  if (startsSnapshot) {
    await tx.query(`DELETE FROM mirror_snapshot_rows`);
    if (jumped) {
      // Batches were passed over, so this mirror may hold rows the public
      // graph has since replaced under the same natural key (an edge
      // removed and added again). The snapshot sends every such row, so
      // the tables where that happens are emptied of mirrored rows first.
      for (const table of childrenFirst) {
        if (table.removeBeforeWrite) await removeRows(w, table, await mirroredKeys(tx, table, false), "cleared_for_snapshot");
      }
    }
  }

  const removals = new Map<string, Array<{ keys: string[]; reason: WithdrawalReason }>>();
  for (const [list, reason] of [[batch.deletions, "deleted"], [batch.retractions, "retracted"]] as const) {
    for (const { table, keys } of list) {
      removals.set(table, [...(removals.get(table) ?? []), { keys: keys.map(String), reason }]);
    }
  }
  const removeListed = async (early: boolean) => {
    for (const table of childrenFirst) {
      if (table.removeBeforeWrite !== early) continue;
      for (const { keys, reason } of removals.get(table.name) ?? []) await removeRows(w, table, keys, reason);
    }
  };

  await removeListed(true);
  const rowsByTable = new Map<string, Array<Record<string, unknown>>>();
  for (const { table, rows } of batch.rows) rowsByTable.set(table, [...(rowsByTable.get(table) ?? []), ...rows]);
  for (const table of tables) await writeRows(w, table, rowsByTable.get(table.name) ?? []);
  await removeListed(false);

  if (batch.kind === "snapshot" && batch.part.last) {
    // The snapshot is whole: a mirrored row it did not hold is one the
    // public graph no longer has.
    for (const table of childrenFirst) await removeRows(w, table, await mirroredKeys(tx, table, true), "absent_from_snapshot");
    await tx.query(`DELETE FROM mirror_snapshot_rows`);
  }

  // Local rows that hang off a claim this batch says was merged away.
  const merged = (rowsByTable.get("claims") ?? []).filter(
    (row) => row.state === "merged" && typeof row.merged_into === "string"
  );
  if (merged.length > 0) {
    const claims = replicatedTable("claims")!;
    const refs = await localReferences(tx, await fksOf(w), claims, merged.map((row) => String(row.id)));
    if (refs.size > 0) {
      const note = (w.notes.merged_with_local_rows = { count: refs.size, claims: [] as Array<{ claim_id: string; merged_into: string; local_rows: LocalRows[] }> });
      for (const row of merged) {
        const local = refs.get(String(row.id));
        if (local && note.claims.length < NOTE_LIMIT) {
          note.claims.push({ claim_id: String(row.id), merged_into: String(row.merged_into), local_rows: local });
        }
      }
    }
  }

  await tx.query(
    `INSERT INTO mirror_applied_batches
       (sequence, feed_id, kind, part_first, part_last, migration_number, cut_at, previous_hash, batch_hash,
        key_id, publisher_web_base_url, counts, notes, received_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14)`,
    [
      batch.sequence, batch.feed_id, batch.kind, batch.part.first, batch.part.last, batch.migration.number,
      batch.cut_at, batch.previous_hash, batch.hash, batch.key_id, batch.publisher.web_base_url,
      JSON.stringify(w.counts), JSON.stringify(w.notes), options.receivedFrom ?? null,
    ]
  );
  return {
    status: "applied",
    sequence: batch.sequence,
    kind: batch.kind,
    hash: batch.hash,
    cut_at: batch.cut_at,
    counts: w.counts,
    changed: w.changed,
    nodes: {
      judged: [...w.judged],
      arrived: [...w.arrived],
      merged: [...w.merged].map(([claim_id, merged_into]) => ({ claim_id, merged_into })),
      withdrawn: [...w.withdrawn],
    },
    notes: w.notes,
  };
}

/** A database error inside a batch, as a refusal an operator can read. */
function rowRefused(err: unknown, batch: MirrorBatch): MirrorRefusal | null {
  const e = err as { code?: unknown; message?: string; detail?: string; table?: string; constraint?: string } | null;
  if (!e || typeof e.code !== "string" || !/^(23|22|MIR)/.test(e.code)) return null;
  const where = [e.table ? `table ${e.table}` : null, e.constraint ? `constraint ${e.constraint}` : null].filter(Boolean).join(", ");
  return new MirrorRefusal(
    "row_refused",
    `Batch ${batch.sequence} was not applied: the database refused one of its rows${where ? ` (${where})` : ""}: ` +
      `${e.message ?? "no message"}${e.detail ? ` ${e.detail}` : ""} ` +
      (e.code === "23505"
        ? "A row this deployment made itself may hold the same key as a row the public graph now has. "
        : "") +
      "Nothing of the batch was written.",
    { sequence: batch.sequence, hash: batch.hash }
  );
}

async function recordRefusal(db: MirrorDb, refusal: MirrorRefusal, receivedFrom: string | undefined): Promise<void> {
  try {
    // A worker that meets the same refusal on every tick records it once.
    const [last] = await db.query<{ sequence: string | null; batch_hash: string | null; code: string }>(
      `SELECT sequence, batch_hash, code FROM mirror_refusals ORDER BY refused_at DESC, id DESC LIMIT 1`
    );
    const sameAsLast =
      last &&
      last.code === refusal.code &&
      (last.sequence === null ? null : Number(last.sequence)) === refusal.batch.sequence &&
      last.batch_hash === refusal.batch.hash;
    if (sameAsLast) return;
    await db.query(
      `INSERT INTO mirror_refusals (sequence, batch_hash, code, message, received_from) VALUES ($1, $2, $3, $4, $5)`,
      [refusal.batch.sequence, refusal.batch.hash, refusal.code, refusal.message, receivedFrom ?? null]
    );
  } catch {
    // The refusal itself is what the caller must see.
  }
}

/**
 * Check one batch and apply it. Returns what it wrote, or "already_applied"
 * for a batch this mirror has (which changes nothing). Throws MirrorRefusal,
 * recorded in mirror_refusals, when the batch may not be applied; then
 * nothing of it was written.
 */
export async function applyBatch(input: unknown, options: ApplyOptions = {}): Promise<ApplyResult> {
  const db = options.db ?? appDb;
  let batch: MirrorBatch | null = null;
  try {
    batch = readBatch(input);
    verifyBatch(batch, options.trustedKeys ?? configuredTrustedKeys());
    const verified = batch;
    const result = await withSystemClearance(APPLIER_REASON, () =>
      db.transaction((tx) => applyVerified(tx, verified, options))
    );
    // From here on this process knows it holds a mirror (mirrored-node-service.ts).
    if (db === appDb) noteMirrorApplied();
    return result;
  } catch (err) {
    const refusal = err instanceof MirrorRefusal ? err : batch ? rowRefused(err, batch) : null;
    if (!refusal) throw err;
    await recordRefusal(db, refusal, options.receivedFrom);
    throw refusal;
  }
}

// ---- how current the mirror is -----------------------------------------------------

export interface MirrorStatus {
  /** Whether this mirror has applied any batch. */
  applied: boolean;
  /**
   * The mirror shows the public graph as it stood at this time: when the
   * publisher cut the newest batch applied here. Null before the first.
   */
  public_graph_as_of: string | null;
  /**
   * False while a cut that came in several batches is only partly applied
   * (a snapshot, usually): the rows here are then not yet the whole of any
   * one moment.
   */
  complete: boolean;
  sequence: number | null;
  batch_hash: string | null;
  applied_at: string | null;
  feed_id: string | null;
  key_id: string | null;
  /** Where the public graph's own pages are, as its feed states it. */
  public_web_base_url: string | null;
  /** Mirrored claims a search can find: active, with a vector. */
  searchable_claims: number;
  /** The newest batch that was refused since the last one applied, if any. */
  last_refusal: { sequence: number | null; code: string; message: string; refused_at: string } | null;
}

/**
 * What a member is told of a batch the database refused. The full message
 * names a row this deployment holds, which may be one at a label the reader
 * does not hold, so only the operator's script reads it (`detail`).
 */
export const ROW_REFUSAL_FOR_MEMBERS =
  "A batch from the public graph was not applied because a row in it could not be written here. " +
  "Nothing of it was written, and the mirror waits at the batch before it. " +
  "The operator of this deployment can read the reason with `npx tsx scripts/mirror.ts status`.";
const REFUSALS_NAMING_A_ROW = new Set<string>(["id_collision", "row_refused"]);

export async function mirrorStatus(db: MirrorDb = appDb, options: { detail?: boolean } = {}): Promise<MirrorStatus> {
  const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  const [head] = await db.query<{
    sequence: string;
    batch_hash: string;
    cut_at: string;
    applied_at: string;
    part_last: boolean;
    feed_id: string;
    key_id: string;
    publisher_web_base_url: string | null;
  }>(
    `SELECT sequence, batch_hash, ${iso("cut_at")} AS cut_at, ${iso("applied_at")} AS applied_at, part_last,
            feed_id, key_id, publisher_web_base_url
       FROM mirror_applied_batches ORDER BY sequence DESC LIMIT 1`
  );
  const [refusal] = await db.query<{ sequence: string | null; code: string; message: string; refused_at: string }>(
    `SELECT r.sequence, r.code, r.message, ${iso("r.refused_at")} AS refused_at
       FROM mirror_refusals r
      WHERE r.refused_at > COALESCE((SELECT max(applied_at) FROM mirror_applied_batches), '-infinity')
      ORDER BY r.refused_at DESC, r.id DESC LIMIT 1`
  );
  const [claims] = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM claims WHERE origin = 'mirror' AND state = 'active' AND embedding IS NOT NULL`
  );
  return {
    applied: head !== undefined,
    public_graph_as_of: head?.cut_at ?? null,
    complete: head ? head.part_last : false,
    sequence: head ? Number(head.sequence) : null,
    batch_hash: head?.batch_hash ?? null,
    applied_at: head?.applied_at ?? null,
    feed_id: head?.feed_id ?? null,
    key_id: head?.key_id ?? null,
    public_web_base_url: head?.publisher_web_base_url ?? null,
    searchable_claims: Number(claims?.n ?? 0),
    last_refusal: refusal
      ? {
          sequence: refusal.sequence === null ? null : Number(refusal.sequence),
          code: refusal.code,
          message: REFUSALS_NAMING_A_ROW.has(refusal.code) && !options.detail ? ROW_REFUSAL_FOR_MEMBERS : refusal.message,
          refused_at: refusal.refused_at,
        }
      : null,
  };
}

// ---- following a feed ---------------------------------------------------------------

/** Where batches come from: by sequence, plus where a mirror with nothing may start. */
export interface BatchSource {
  /** For the record: the feed's address or the directory's path. */
  name: string;
  /** The newest batch the source has, or null when it has none. */
  head(): Promise<number | null>;
  /** The first batch of the newest complete snapshot, or null when the source has none. */
  latestSnapshot(): Promise<number | null>;
  /** The batch at a sequence, as received; null when the source does not have it (yet). */
  fetch(sequence: number): Promise<string | null>;
}

/** A directory of batch files, as `scripts/mirror.ts export` writes them. */
export function directorySource(dir: string): BatchSource {
  const sequences = () =>
    readdirSync(dir)
      .map(sequenceOfFileName)
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
  const read = (sequence: number) => readFileSync(join(dir, batchFileName(sequence)), "utf8");
  return {
    name: dir,
    async head() {
      return sequences().at(-1) ?? null;
    },
    async latestSnapshot() {
      // The newest file that closes a snapshot says where that snapshot began.
      for (const sequence of sequences().reverse()) {
        const batch = JSON.parse(read(sequence)) as Partial<MirrorBatch>;
        if (batch.kind === "snapshot" && batch.part?.last === true && Number.isSafeInteger(batch.part.first)) {
          return batch.part.first;
        }
      }
      return null;
    },
    async fetch(sequence) {
      return sequences().includes(sequence) ? read(sequence) : null;
    },
  };
}

/** A publisher's API (routes/mirror.ts). */
export function urlSource(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): BatchSource {
  const base = baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = apiKey ? { "x-api-key": apiKey } : {};
  const get = async (path: string): Promise<Response> => {
    const res = await fetchImpl(`${base}${path}`, { headers, signal: AbortSignal.timeout(120_000) });
    return res;
  };
  const listing = async (): Promise<{ head?: number | null; latest_snapshot?: number | null }> => {
    const res = await get("/mirror/feed?limit=1");
    if (!res.ok) {
      throw new MirrorConfigError(`The mirror feed at ${base} answered ${res.status} to GET /mirror/feed.`);
    }
    return (await res.json()) as { head?: number | null; latest_snapshot?: number | null };
  };
  return {
    name: base,
    async head() {
      const { head } = await listing();
      return typeof head === "number" ? head : null;
    },
    async latestSnapshot() {
      const { latest_snapshot } = await listing();
      return typeof latest_snapshot === "number" ? latest_snapshot : null;
    },
    async fetch(sequence) {
      const res = await get(`/mirror/feed/${sequence}`);
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new MirrorConfigError(
          `The mirror feed at ${base} answered ${res.status} to GET /mirror/feed/${sequence}` +
            (res.status === 401 || res.status === 403 ? " (check MIRROR_FEED_API_KEY)." : ".")
        );
      }
      return res.text();
    },
  };
}

/** The source this deployment is configured to follow, or null when it is not an applier. */
export function configuredSource(): BatchSource | null {
  const config = loadConfig();
  if (config.mirrorFeedDir) return directorySource(config.mirrorFeedDir);
  if (config.mirrorFeedUrl) return urlSource(config.mirrorFeedUrl, config.mirrorFeedApiKey);
  return null;
}

export interface SyncResult {
  /** The batches applied by this call, in order. */
  applied: ApplyResult[];
  /** Why it stopped short of the source's newest batch, if it did. */
  refusal: MirrorRefusal | null;
}

/**
 * Bring the mirror up to the source: apply the next batch, and the next,
 * until the source has no more or one is refused. A mirror that has applied
 * nothing starts at the source's latest snapshot. A mirror whose next batch
 * was cut in an older shape of the tables than its code writes cannot apply
 * it, and goes on from the latest snapshot instead when there is a later
 * one. (A batch in a newer shape is not passed over this way: every later
 * snapshot is in that shape too, and the deployment has to upgrade.)
 */
export async function syncMirror(source: BatchSource, options: ApplyOptions & { maxBatches?: number } = {}): Promise<SyncResult> {
  const db = options.db ?? appDb;
  const applied: ApplyResult[] = [];
  const limit = options.maxBatches ?? Number.POSITIVE_INFINITY;
  const headOf = async (): Promise<number | null> => {
    const [row] = await db.query<{ sequence: string }>(
      `SELECT sequence FROM mirror_applied_batches ORDER BY sequence DESC LIMIT 1`
    );
    return row ? Number(row.sequence) : null;
  };

  let head = await headOf();
  // One question to the source when there is nothing new, which is most of the time.
  const sourceHead = await source.head();
  if (sourceHead === null || (head !== null && sourceHead <= head)) return { applied, refusal: null };
  let next = head === null ? await source.latestSnapshot() : head + 1;
  let triedSnapshot = head === null;
  while (next !== null && applied.length < limit) {
    let text = await source.fetch(next);
    if (text === null && !triedSnapshot) {
      // The source no longer has the next batch, or never will: a later
      // snapshot is the way on, when there is one.
      triedSnapshot = true;
      const snapshot = await source.latestSnapshot();
      if (snapshot !== null && head !== null && snapshot > head + 1) {
        next = snapshot;
        text = await source.fetch(next);
      }
    }
    if (text === null) break;
    try {
      applied.push(await applyBatch(text, { ...options, receivedFrom: options.receivedFrom ?? source.name }));
    } catch (err) {
      if (!(err instanceof MirrorRefusal)) throw err;
      if (err.code === "shape_differs" && !triedSnapshot) {
        triedSnapshot = true;
        const snapshot = await source.latestSnapshot();
        if (snapshot !== null && snapshot > next) {
          next = snapshot;
          continue;
        }
      }
      return { applied, refusal: err };
    }
    head = next;
    next = head + 1;
  }
  return { applied, refusal: null };
}
