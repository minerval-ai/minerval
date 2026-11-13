/**
 * Layers: one rule for a key that more than one layer holds.
 *
 * A graph at a label is that label's own rows over the graph of the labels
 * it reads, down to the public graph's rows, which a deployment holds
 * through its mirror (docs/architecture.md, "Each layer keeps its own
 * identity"). A row's layer is its label and its origin. The mirror is the
 * lowest layer; among a deployment's own rows a label lies below every
 * label that reads it, and two labels that do not read each other are
 * neither below the other.
 *
 * Identity is per layer: a key holds `sensitivity_label`, and `origin`
 * where the table is replicated (db/schema.ts, "The layer"). So work at a
 * label is never stopped by a row at a label it does not read and is told
 * nothing of it: its insert finds no row and makes its own. What is left is
 * a reader, or a run, that reads two layers holding the same key. This
 * module is the one place that says what it is given:
 *
 *  - A write asks first whether a layer below holds the key (heldBelow).
 *    Where one does, that row is the row. A get-or-create is handed it and
 *    records nothing; a write that would revise it is refused with the
 *    reason (refuseWhereHeldBelow), because work at one label does not put
 *    its words into another label's row. This is what a run was already
 *    given against the mirror, asked now of every layer below.
 *  - A row recorded first at a higher layer stays where it is when a lower
 *    layer later records the same thing: nothing is moved or deleted, so
 *    what hangs from it by id (a grouping, an instance, a tagging) is
 *    where it was. A read that lists the thing lists the lowest layer's
 *    row once, with what the higher layer wrote beside it (lowerRowSql);
 *    a read that takes one row for a key takes the reader's own layer's
 *    where it has one, else the lowest (oneForKeySql and the two reads
 *    written with it).
 *  - Two labels that do not read each other may each hold the key. A
 *    reader of both is given both where the thing is listed. A label
 *    defined later that reads both is in the same position: neither row is
 *    below the other, both are listed, and a write at that label is handed
 *    one of them.
 *
 * Nothing here is asked on a graph with one label and no mirror (layered):
 * no query is made and every statement is what it was.
 */
import { ClearanceError, enforcementLastKnown } from "../db/clearance.js";
import { currentLabel } from "../llm/usage-context.js";
import { holdsMirror, mirroredRowMessage } from "./mirrored-node-service.js";

/** Whether this deployment has more than one layer: a mirror under its own rows, or more than one label. */
export function layered(): boolean {
  return holdsMirror() || enforcementLastKnown() === true;
}

/** The replicated tables among those asked about here: their rows carry `origin`, and the mirror is a layer of theirs. */
const PER_GRAPH = new Set([
  "claim_relationships",
  "claim_links",
  "answer_relations",
  "argument_subclaims",
  "quantity_cuts",
  "quantity_definitions",
  "sources",
]);

const NAME_RE = /^[a-z_][a-z0-9_]*$/;

function named(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a table's or a column's name`);
  return name;
}

/** The origin of a row of `table` aliased `alias`, as SQL: its column where it has one, else 'local'. */
function originSql(table: string, alias: string): string {
  return PER_GRAPH.has(table) ? `${alias}.origin` : `'local'`;
}

type Query = <R>(text: string, params?: unknown[]) => Promise<R[]>;

/** The row a layer below holds, as heldBelow returns it. */
export type HeldBelow<T> = T & { origin: "local" | "mirror" };

/**
 * The row a layer below the work in progress holds under `key` (column to
 * value), the lowest first; null where none does, and on a graph with one
 * layer, where nothing is asked. `columns` is what to read of it.
 *
 * "Below" is asked of the database and not assumed from what the
 * connection can read: system work reads every label, and a row at a label
 * the work's own label does not read is not below it.
 */
export async function heldBelow<T = { id: string }>(
  query: Query,
  table: string,
  key: Record<string, unknown>,
  columns = "id"
): Promise<HeldBelow<T> | null> {
  if (!layered()) return null;
  const t = named(table);
  const names = Object.keys(key).map(named);
  const where = names.map((c, i) => `held.${c} = $${i + 1}`).join(" AND ");
  const origin = originSql(t, "held");
  const [row] = await query<HeldBelow<T>>(
    `SELECT ${columns}, ${origin} AS origin
       FROM ${t} held
      WHERE ${where}
        AND minerval_layer_below(held.sensitivity_label, ${origin}, $${names.length + 1}, 'local')
      ORDER BY minerval_layer_depth(held.sensitivity_label, ${origin})
      LIMIT 1`,
    [...Object.values(key), currentLabel()]
  );
  return row ?? null;
}

/**
 * What a run is told when it would revise something a label it reads
 * already holds. `what` names the thing, lower case. A row the public
 * graph holds has its own words (mirroredRowMessage).
 */
export function heldAtALabelBelowMessage(what: string): string {
  return (
    `This was not written: ${what} already exists at another label than this work's, one this work reads, ` +
    `and that row is the one this work goes by. Work at one label does not write its words into a row at ` +
    `another, where that label's readers would read them. Nothing was changed.`
  );
}

/**
 * Refuse a write that would revise, or say a second time, what a layer
 * below already holds under `key`. Returns where none does. Where the
 * public graph holds it the caller's own error carries the mirror's words
 * (`mirrored`, which defaults to the same error the label's refusal is);
 * where a label the work reads holds it, the refusal is one the routes and
 * the tools already answer as a conflict (ClearanceError).
 */
export async function refuseWhereHeldBelow(
  query: Query,
  table: string,
  key: Record<string, unknown>,
  what: string,
  mirrored: (message: string) => Error = (message) => new ClearanceError(message)
): Promise<void> {
  const held = await heldBelow<Record<string, never>>(query, table, key, "1 AS found");
  if (!held) return;
  if (held.origin === "mirror") throw mirrored(mirroredRowMessage(what));
  throw new ClearanceError(heldAtALabelBelowMessage(what));
}

/**
 * The label of the work in progress, as SQL: the connection's own
 * (minerval_write_label), which is what a run's rows are stamped with and
 * `public` for a reader who has none.
 */
const OWN_LABEL_SQL = "minerval_write_label()";

/**
 * How a read that takes one row for a key ranks the row of `table` aliased
 * `alias`, as SQL: the reader's own layer's row first (what its label
 * wrote), then the lowest layer.
 */
function rankSql(table: string, alias: string): string {
  const origin = originSql(table, alias);
  return (
    `(CASE WHEN ${origin} = 'local' AND ${alias}.sensitivity_label = ${OWN_LABEL_SQL} THEN -1 ` +
    `ELSE minerval_layer_depth(${alias}.sensitivity_label, ${origin}) END)`
  );
}

/**
 * SQL condition for a read of `table` aliased `alias` that wants one row
 * for each key (`keyColumns`): the row of the reader's own layer where it
 * has one, else the lowest layer's. Two rows at one depth (two labels that
 * do not read each other, read by someone who holds both) are told apart
 * by label, so the read still takes one. Empty on a graph with one layer,
 * where a key has one row and the statement is what it was.
 */
export function oneForKeySql(table: string, alias: string, keyColumns: readonly string[]): string {
  if (!layered()) return "";
  const t = named(table);
  const a = named(alias);
  const same = keyColumns.map((c) => `other_layer.${named(c)} = ${a}.${c}`).join(" AND ");
  const order = (x: string) => `(${rankSql(t, x)}, ${x}.sensitivity_label, ${originSql(t, x)})`;
  return ` AND NOT EXISTS (SELECT 1 FROM ${t} other_layer WHERE ${same} AND ${order("other_layer")} < ${order(a)})`;
}

/**
 * One cut for a claim, for a read of `quantity_cuts` aliased `alias`: the
 * cut recorded at the reader's own label, else the lowest layer's (the
 * public graph's where it holds one).
 */
export function oneCutForClaimSql(alias: string): string {
  return oneForKeySql("quantity_cuts", alias, ["claim_id"]);
}

/**
 * One definition for a quantity, for a read of `quantity_definitions`
 * aliased `alias`, by the same rule.
 */
export function oneDefinitionForQuantitySql(alias: string): string {
  return oneForKeySql("quantity_definitions", alias, ["claim_id"]);
}

/**
 * One reading for an instance, for a read of `claim_instance_readings`
 * aliased `alias`, by the same rule: the reader's own label's reading of
 * the passage where it has one, else the lowest layer's.
 */
export function oneReadingForInstanceSql(alias: string): string {
  return oneForKeySql("claim_instance_readings", alias, ["instance_id"]);
}

/**
 * The end of a read of `sources` by address that wants one row. The same
 * address recorded at two layers is two rows (db/schema.ts, "The layer").
 * The one taken is the row at the label of the work in progress (what that
 * label wrote: its fetched text, its readings), else the lowest layer's:
 * the public graph's where it holds one, then a label the work reads.
 * Empty on a graph with one layer, where an address has one row and the
 * statement is what it always was. `alias` is the table's alias in the
 * statement, where it has one.
 */
export function oneSourceForAddressSql(alias?: string): string {
  if (!layered()) return "";
  const c = (name: string) => (alias ? `${named(alias)}.${name}` : name);
  return (
    ` ORDER BY (${c("origin")} = 'local' AND ${c("sensitivity_label")} = ${OWN_LABEL_SQL}) DESC, ` +
    `minerval_layer_depth(${c("sensitivity_label")}, ${c("origin")}), ${c("retrieved_at")}, ${c("id")} LIMIT 1`
  );
}

/**
 * A select-list expression for a read that lists rows of `table` aliased
 * `alias`: the id of the row a layer below this row's own holds under the
 * same key, or null. A row that has one is the same thing recorded again
 * at a higher layer, and the read lists the thing once, by the lower row.
 * `NULL::uuid` on a graph with one layer.
 */
export function lowerRowSql(table: string, alias: string, keyColumns: readonly string[]): string {
  if (!layered()) return "NULL::uuid";
  const t = named(table);
  const a = named(alias);
  const same = keyColumns.map((c) => `lower_layer.${named(c)} = ${a}.${c}`).join(" AND ");
  return (
    `(SELECT lower_layer.id FROM ${t} lower_layer WHERE ${same} AND lower_layer.id <> ${a}.id ` +
    `AND minerval_layer_below(lower_layer.sensitivity_label, ${originSql(t, "lower_layer")}, ` +
    `${a}.sensitivity_label, ${originSql(t, a)}) ` +
    `ORDER BY minerval_layer_depth(lower_layer.sensitivity_label, ${originSql(t, "lower_layer")}) LIMIT 1)`
  );
}

/**
 * What a read of a source adds where a label below the source's own holds
 * the same address: that row's id, so the two are read as one document
 * recorded twice. Null otherwise, and on a graph with one label. (Where
 * the public graph holds the address, the read says so in its own field:
 * mirrored-node-service.ts, sourceMirrorFacts.)
 */
export async function sourceHeldAtALabelBelow(
  query: Query,
  sourceId: string
): Promise<{ same_address_source_id: string } | null> {
  if (enforcementLastKnown() !== true) return null;
  const [row] = await query<{ id: string }>(
    `SELECT lower_layer.id
       FROM sources s
       JOIN sources lower_layer ON lower_layer.url = s.url AND lower_layer.id <> s.id AND lower_layer.origin = 'local'
      WHERE s.id = $1 AND s.origin = 'local'
        AND minerval_layer_below(lower_layer.sensitivity_label, lower_layer.origin, s.sensitivity_label, s.origin)
      ORDER BY minerval_layer_depth(lower_layer.sensitivity_label, lower_layer.origin), lower_layer.retrieved_at
      LIMIT 1`,
    [sourceId]
  );
  return row ? { same_address_source_id: row.id } : null;
}

/**
 * For an `INSERT ... SELECT` that adds several rows at once: the WHERE
 * that leaves out a row whose key a layer below the work's own already
 * holds, so nothing is recorded beside it. `match` is the key's condition
 * on the row aliased `held`. (A row at the work's own label is the
 * statement's ON CONFLICT's to handle.) Empty on a graph with one layer.
 */
export function unlessHeldBelowSql(table: string, match: string): string {
  if (!layered()) return "";
  const t = named(table);
  return (
    ` WHERE NOT EXISTS (SELECT 1 FROM ${t} held WHERE ${match} ` +
    `AND minerval_layer_below(held.sensitivity_label, ${originSql(t, "held")}, ${OWN_LABEL_SQL}, 'local'))`
  );
}
