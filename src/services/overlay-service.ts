/**
 * A label's overlay on the structure below it.
 *
 * A graph at a label is that label's own rows over the graph of the labels
 * it reads, down to the public graph (docs/architecture.md, "A label's
 * overlay on the structure below"). Two things make up a label's own rows.
 * What it adds: a node, an edge, an argument, an instance, each a row in
 * the table the thing lives in, at the label. And what it says about a row
 * below where it judges differently for its own readers: a row at its own
 * label keyed by the row below, which is never touched. A judgment at each
 * label is the first case of the second kind (judgment-version-service.ts).
 * This module is the rest of it:
 *
 *  - a label's own importance and contestation for a node below;
 *  - an edge or an argument below set aside at the label, with the reason:
 *    it stays where it is, readers at the label see it marked, and the
 *    judgment at the label does not rest on it.
 *
 * (A cut or a reading of its own beside one below needs no row here: each
 * layer has its own row under the same key, and layer-service.ts says
 * which a reader goes by.)
 *
 * One rule composes them, the rule that says which judgment is in force. A
 * reader, or work at a label, goes by the live overlay of the nearest
 * layer among those it reads, its own first, and by the row below where
 * none of them holds one. So a label that reads another sees that label's
 * overlays and may lay its own over them, and two labels that do not read
 * each other never see each other's. "Nearest" is the deepest layer
 * (minerval_layer_depth): a label that reads another is always deeper.
 *
 * Nothing here is asked on a graph with one label: no query is made, and
 * every statement another module builds with these fragments is the text
 * it was.
 */
import { rawQuery } from "../db/client.js";
import { ClearanceError, enforcementLastKnown } from "../db/clearance.js";
import { currentLabel } from "../llm/usage-context.js";

export type OverlayKind = "importance" | "contestation" | "set_aside";
export type OverlayTable = "claims" | "claim_relationships" | "arguments";

type Query = <R>(text: string, params?: unknown[]) => Promise<R[]>;

/** Whether a label here can hold an overlay at all: the deployment has more than one label. */
export function overlaid(): boolean {
  return enforcementLastKnown() === true;
}

const NAME_RE = /^[a-z_][a-z0-9_.]*$/;
function named(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a column's name`);
  return name;
}

/**
 * The overlays a statement may go by, as a condition on `o`: the live
 * ones, and, where the statement is not itself run at one label (a sweep
 * over rows at every label), those of the labels `labelSql` reads. A run's
 * own connection already reads only its label's layers.
 */
function inReach(labelSql?: string): string {
  return (
    `o.ended_at IS NULL` +
    (labelSql ? ` AND o.sensitivity_label = ANY (minerval_labels_readable_from(ARRAY[${labelSql}]::text[]))` : "")
  );
}

/** The nearest layer's overlay first. */
const NEAREST = `ORDER BY minerval_layer_depth(o.sensitivity_label) DESC, o.created_at DESC, o.id LIMIT 1`;

function valueSql(kind: "importance" | "contestation", idSql: string, labelSql?: string): string {
  return (
    `(SELECT o.value FROM overlays o WHERE o.target_table = 'claims' AND o.target_id = ${idSql} ` +
    `AND o.kind = '${kind}' AND ${inReach(labelSql)} ${NEAREST})`
  );
}

/**
 * SQL: the importance of the node aliased `c` for the work in progress, or
 * for work at the label `labelSql` names: the nearest layer's own value
 * where a label it reads holds one, else the node's. On a graph with one
 * label it is the node's column, word for word.
 */
export function importanceSql(c = "c", labelSql?: string): string {
  const col = `${named(c)}.importance`;
  if (!overlaid()) return col;
  return `COALESCE(${valueSql("importance", `${c}.id`, labelSql)}, ${col})`;
}

/** SQL: the contestation of the node aliased `c`, by the same rule. */
export function contestationSql(c = "c", labelSql?: string): string {
  const col = `${named(c)}.contestation`;
  if (!overlaid()) return col;
  return `COALESCE(${valueSql("contestation", `${c}.id`, labelSql)}, ${col})`;
}

/**
 * SQL condition: the edge or argument whose id is `idSql` is set aside for
 * the work in progress (or for work at `labelSql`): the nearest layer's
 * overlay on it says so. `FALSE` on a graph with one label.
 */
export function setAsideSql(table: "claim_relationships" | "arguments", idSql: string, labelSql?: string): string {
  if (!overlaid()) return "FALSE";
  return (
    `COALESCE((SELECT o.value = 1 FROM overlays o WHERE o.target_table = '${table}' AND o.target_id = ${idSql} ` +
    `AND o.kind = 'set_aside' AND ${inReach(labelSql)} ${NEAREST}), FALSE)`
  );
}

/** ` AND NOT (set aside)` for a statement that reads the edges a judgment rests on; empty on a graph with one label. */
export function notSetAsideSql(table: "claim_relationships" | "arguments", idSql: string, labelSql?: string): string {
  return overlaid() ? ` AND NOT ${setAsideSql(table, idSql, labelSql)}` : "";
}

// ---------------------------------------------------------------------------
// Which layer a row is at
// ---------------------------------------------------------------------------

/**
 * The label of each of `ids` in `table`, for a read that says which layer
 * each row it returns is at. A row's label is always one the reader reads,
 * since the row came back. Empty on a graph with one label, where there is
 * one layer and nothing to say.
 */
export async function layersOf(table: string, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!overlaid()) return out;
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (wanted.length === 0) return out;
  const rows = await rawQuery<{ id: string; label: string }>(
    `SELECT id::text AS id, sensitivity_label AS label FROM ${named(table)} WHERE id = ANY($1::uuid[])`,
    [wanted]
  );
  for (const r of rows) out.set(r.id, r.label);
  return out;
}

/**
 * `rows` with the label each is at as `label`, read by `idOf`. The rows are
 * returned as they came on a graph with one label, and a row whose id is
 * not found keeps none.
 */
export async function withLayer<T extends object>(
  table: string,
  rows: readonly T[],
  idOf: (row: T) => string | null | undefined
): Promise<(T & { label?: string })[]> {
  if (!overlaid() || rows.length === 0) return rows as (T & { label?: string })[];
  const labels = await layersOf(table, rows.map(idOf)).catch(() => new Map<string, string>());
  return rows.map((row) => {
    const label = labels.get(String(idOf(row) ?? "").toLowerCase());
    return label ? { ...row, label } : row;
  });
}

// ---------------------------------------------------------------------------
// Reading overlays
// ---------------------------------------------------------------------------

/** One label's live overlay on a row, as a read serves it. */
export interface OverlayView {
  /** The label that holds it: one the reader reads. */
  label: string;
  /** Whether it is the one the reader goes by: the nearest layer's. */
  in_effect: boolean;
  since: string;
}

export interface ValueOverlayView extends OverlayView {
  value: number;
}

export interface SetAsideView extends OverlayView {
  /** False where the label counts a row that a label it reads set aside. */
  set_aside: boolean;
  reason: string | null;
}

interface OverlayRow {
  target_id: string;
  kind: OverlayKind;
  value: number;
  reason: string | null;
  label: string;
  created_at: Date;
  depth: number;
}

async function liveOverlays(table: OverlayTable, ids: readonly string[]): Promise<Map<string, OverlayRow[]>> {
  const out = new Map<string, OverlayRow[]>();
  if (!overlaid() || ids.length === 0) return out;
  const rows = await rawQuery<OverlayRow>(
    `SELECT o.target_id::text AS target_id, o.kind, o.value, o.reason, o.sensitivity_label AS label, o.created_at,
            minerval_layer_depth(o.sensitivity_label) AS depth
       FROM overlays o
      WHERE o.target_table = $1 AND o.target_id = ANY($2::uuid[]) AND o.ended_at IS NULL
      ORDER BY minerval_layer_depth(o.sensitivity_label) DESC, o.created_at DESC, o.id`,
    [table, [...new Set(ids)]]
  );
  for (const r of rows) {
    const key = `${r.target_id}:${r.kind}`;
    out.set(key, [...(out.get(key) ?? []), r]);
  }
  return out;
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/**
 * What the labels a reader reads hold for a node's importance and
 * contestation, beside the node's own values: null on a graph with one
 * label and where no label holds any. `importance` and `contestation` are
 * what the reader goes by; `below` is the node's own, at the node's label.
 */
export async function nodeValueOverlays(
  nodeId: string,
  own: { importance: number; contestation: number | null }
): Promise<{
  importance: number;
  contestation: number | null;
  held: { importance?: ValueOverlayView[]; contestation?: ValueOverlayView[] };
  below: { importance: number; contestation: number | null };
} | null> {
  const live = await liveOverlays("claims", [nodeId]);
  const views = (kind: "importance" | "contestation"): ValueOverlayView[] =>
    (live.get(`${nodeId.toLowerCase()}:${kind}`) ?? []).map((r, i) => ({
      label: r.label,
      value: Number(r.value),
      in_effect: i === 0,
      since: iso(r.created_at),
    }));
  const importance = views("importance");
  const contestation = views("contestation");
  if (importance.length === 0 && contestation.length === 0) return null;
  return {
    importance: importance[0]?.value ?? own.importance,
    contestation: contestation[0]?.value ?? own.contestation,
    held: {
      ...(importance.length > 0 ? { importance } : {}),
      ...(contestation.length > 0 ? { contestation } : {}),
    },
    below: own,
  };
}

/**
 * For each of `ids` (edges, or arguments) that a label the reader reads has
 * an overlay on: what the reader goes by. An edge or argument with no entry
 * counts as the layer below has it.
 */
export async function setAsides(
  table: "claim_relationships" | "arguments",
  ids: readonly string[]
): Promise<Map<string, SetAsideView>> {
  const out = new Map<string, SetAsideView>();
  const live = await liveOverlays(table, ids);
  for (const [key, rows] of live) {
    const r = rows[0]!;
    out.set(r.target_id, {
      label: r.label,
      set_aside: Number(r.value) === 1,
      reason: r.reason,
      in_effect: true,
      since: iso(r.created_at),
    });
    void key;
  }
  return out;
}

/**
 * `rows` with `set_aside` on each that is set aside for the reader: the
 * label that set it aside, its reason and since when. A row that a nearer
 * label counts again carries nothing.
 */
export async function withSetAside<T extends object>(
  table: "claim_relationships" | "arguments",
  rows: readonly T[],
  idOf: (row: T) => string | null | undefined
): Promise<(T & { set_aside?: { at: string; reason: string | null; since: string } })[]> {
  if (!overlaid() || rows.length === 0) return rows as T[];
  const held = await setAsides(table, rows.map(idOf).filter((id): id is string => Boolean(id))).catch(
    () => new Map<string, SetAsideView>()
  );
  return rows.map((row) => {
    const o = held.get(String(idOf(row) ?? "").toLowerCase());
    return o?.set_aside ? { ...row, set_aside: { at: o.label, reason: o.reason, since: o.since } } : row;
  });
}

// ---------------------------------------------------------------------------
// Writing overlays
// ---------------------------------------------------------------------------

/** Where a row lies for the work in progress. */
export interface Placement {
  label: string;
  origin: string;
  /** The row is at a layer below the work's label: a label it reads, or the public graph's row in the mirror. */
  below: boolean;
  /** The row is at the work's own label and is the deployment's own. */
  own: boolean;
  /** The node whose page the row is read on. */
  claimId: string;
}

const PLACE: Record<OverlayTable, { origin: string; claim: string }> = {
  claims: { origin: "t.origin", claim: "t.id" },
  claim_relationships: { origin: "t.origin", claim: "t.parent_claim_id" },
  arguments: { origin: "t.origin", claim: "t.claim_id" },
};

/** Where the row `id` of `table` lies for the work in progress; null where the work does not read it. */
export async function placementOf(table: OverlayTable, id: string, query: Query = rawQuery): Promise<Placement | null> {
  const label = currentLabel();
  const p = PLACE[table];
  const [row] = await query<{ label: string; origin: string; claim_id: string; below: boolean }>(
    `SELECT t.sensitivity_label AS label, ${p.origin} AS origin, ${p.claim}::text AS claim_id,
            ${overlaid() ? `minerval_layer_below(t.sensitivity_label, ${p.origin}, $2, 'local') AND t.sensitivity_label <> $2` : "FALSE"} AS below
       FROM ${table} t WHERE t.id = $1`,
    overlaid() ? [id, label] : [id]
  );
  if (!row) return null;
  return {
    label: row.label,
    origin: row.origin,
    below: row.below === true,
    own: row.label === label && row.origin === "local",
    claimId: row.claim_id,
  };
}

/** The live overlay the work's own label holds on a row, if it holds one. */
export async function ownOverlay(
  table: OverlayTable,
  id: string,
  kind: OverlayKind,
  query: Query = rawQuery
): Promise<{ id: string; value: number; reason: string | null } | null> {
  if (!overlaid()) return null;
  const [row] = await query<{ id: string; value: number; reason: string | null }>(
    `SELECT id, value, reason FROM overlays
      WHERE target_table = $1 AND target_id = $2 AND kind = $3 AND sensitivity_label = $4 AND ended_at IS NULL`,
    [table, id, kind, currentLabel()]
  );
  return row ? { ...row, value: Number(row.value) } : null;
}

/**
 * Record what the work's label holds over a row below: its own importance
 * or contestation for a node, or that an edge or argument is set aside
 * (`value` 1) or counted where a label it reads set it aside (`value` 0).
 * The row is written at the work's label. A live one it replaces is ended
 * and kept. Refused where the row is not below the work's label: a row at
 * the work's own label is changed in place, and one the work does not read
 * is not there for it.
 */
export async function recordOverlay(input: {
  table: OverlayTable;
  id: string;
  kind: OverlayKind;
  value: number;
  reason?: string | null;
  createdBy: string;
  query?: Query;
}): Promise<{ id: string; label: string; below: string; replaced: boolean }> {
  const query = input.query ?? rawQuery;
  const label = currentLabel();
  const at = await placementOf(input.table, input.id, query);
  if (!at || !at.below) {
    throw new ClearanceError(
      `This was not recorded: a label holds a value or a setting aside of its own only over a row at a label it reads.`
    );
  }
  const ended = await query<{ id: string }>(
    `UPDATE overlays SET ended_at = now(), ended_because = 'replaced'
      WHERE target_table = $1 AND target_id = $2 AND kind = $3 AND sensitivity_label = $4 AND ended_at IS NULL
      RETURNING id`,
    [input.table, input.id, input.kind, label]
  );
  const [row] = await query<{ id: string }>(
    `INSERT INTO overlays (target_table, target_id, claim_id, kind, value, reason, created_by, sensitivity_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [input.table, input.id, at.claimId, input.kind, input.value, input.reason ?? null, input.createdBy, label]
  );
  return { id: row!.id, label, below: at.origin === "mirror" ? "the public graph" : at.label, replaced: ended.length > 0 };
}

/** Take back the live overlay the work's own label holds on a row. Returns whether there was one. */
export async function takeBackOverlay(
  table: OverlayTable,
  id: string,
  kind: OverlayKind,
  query: Query = rawQuery
): Promise<boolean> {
  if (!overlaid()) return false;
  const ended = await query<{ id: string }>(
    `UPDATE overlays SET ended_at = now(), ended_because = 'taken_back'
      WHERE target_table = $1 AND target_id = $2 AND kind = $3 AND sensitivity_label = $4 AND ended_at IS NULL
      RETURNING id`,
    [table, id, kind, currentLabel()]
  );
  return ended.length > 0;
}

/** Whether the edge or argument is set aside for the work in progress, and by which label. */
export async function setAsideFor(
  table: "claim_relationships" | "arguments",
  id: string
): Promise<SetAsideView | null> {
  if (!overlaid()) return null;
  const view = (await setAsides(table, [id])).get(id.toLowerCase());
  return view ?? null;
}

// ---------------------------------------------------------------------------
// What ended because the layer below changed
// ---------------------------------------------------------------------------

export interface EndedOverlay {
  kind: OverlayKind;
  target_table: OverlayTable;
  target_id: string;
  claim_id: string;
  value: number;
  reason: string | null;
  ended_at: Date;
  ended_because: "removed_below" | "retyped_below" | "retired_below" | "merged_below" | "withdrawn_below";
  ended_detail: Record<string, unknown> | null;
}

/**
 * The overlays the work's own label held on this node, on the edges and
 * arguments under it, and on nodes since merged into it, that the database
 * ended because the layer below changed the row (migration 0163), since
 * `since`. Oldest first.
 */
export async function overlaysEndedBelow(nodeId: string, since: Date | null): Promise<EndedOverlay[]> {
  if (!overlaid()) return [];
  return rawQuery<EndedOverlay>(
    `SELECT o.kind, o.target_table, o.target_id::text AS target_id, o.claim_id::text AS claim_id, o.value, o.reason,
            o.ended_at, o.ended_because, o.ended_detail
       FROM overlays o
      WHERE o.sensitivity_label = $2
        AND o.ended_because IN ('removed_below', 'retyped_below', 'retired_below', 'merged_below', 'withdrawn_below')
        AND (o.claim_id = $1 OR (o.ended_because = 'merged_below' AND o.ended_detail->>'merged_into' = $1::text))
        AND ($3::timestamptz IS NULL OR o.ended_at > $3)
      ORDER BY o.ended_at, o.id`,
    [nodeId, currentLabel(), since]
  );
}

/** What a read of a node adds where labels the reader reads hold their own importance or contestation for it. */
export function valuesByLabelOf(claim: unknown): Record<string, unknown> {
  return (claim as { valuesByLabel?: Record<string, unknown> } | null)?.valuesByLabel ?? {};
}
