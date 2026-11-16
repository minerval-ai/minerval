/**
 * What a judgment was made against, and what has changed since (#566).
 *
 * A node's judgment rests on the nodes under it and on its sources. When a
 * judgment is written, `recordJudgmentInputs` records the state of both
 * (db/schema.ts, judgment_inputs): each premise with the id of its own
 * judgment in force at that moment, and each attached source. Reading the
 * record against the graph as it stands now says what has moved since:
 *
 *   - a premise judged again (its judgment in force is a different row);
 *   - a premise added or removed (an edge that was not there, or is gone);
 *   - a source added or removed (an instance attached or detached);
 *   - a recorded source that has had a correction or a retraction since.
 *
 * A judgment with any of those is out of date in the plain sense that it
 * was made against something that is no longer the case. Whether that
 * matters, and whether it is worth a reassessment, is a judgment for the
 * Steward and the Grantmaker; this module only says what changed. A premise
 * judged again to the same verdict still counts as judged again: the record
 * is of versions, and comparing verdicts is the reader's business.
 *
 * Judgments written before the record existed have `inputs_recorded` false
 * and are reported as not recorded, never as fresh.
 *
 * Two reads serve it. `getJudgmentInputs` is the whole record of one node,
 * input by input. `summarizeJudgmentChanges` is the same fact as counts for
 * many nodes at once, which is what the places people and agents already
 * look can carry: a claim's read, a search hit, a list of candidates. A
 * reader should not have to ask claim by claim to learn that something moved.
 */
import { rawQuery } from "../db/client.js";
import { currentLabel } from "../llm/usage-context.js";
import { notSetAsideSql } from "./overlay-service.js";

export type JudgmentKind = "assessment" | "quantity_estimate" | "question_assessment";

const JUDGMENT_TABLE: Record<JudgmentKind, string> = {
  assessment: "assessments",
  quantity_estimate: "quantity_estimates",
  question_assessment: "question_assessments",
};

/** Anything that runs a query: `rawQuery`, or a transaction's `tx.query`. */
type Query = <R>(text: string, params?: unknown[]) => Promise<R[]>;

/** The judgment in force of the node aliased `alias`.id, whichever kind it is. */
const IN_FORCE_ID_SQL = (alias: string) => `COALESCE(
    (SELECT j.id FROM assessments_in_force j WHERE j.claim_id = ${alias}),
    (SELECT j.id FROM quantity_estimates_in_force j WHERE j.claim_id = ${alias}),
    (SELECT j.id FROM question_assessments_in_force j WHERE j.claim_id = ${alias}))`;

/**
 * Record what the judgment `judgmentId` of node `nodeId` was made against:
 * the nodes under it with their judgments in force, and its attached
 * sources. Call it right after the judgment row is inserted, through the
 * same transaction when there is one.
 */
export async function recordJudgmentInputs(
  query: Query,
  kind: JudgmentKind,
  judgmentId: string,
  nodeId: string
): Promise<void> {
  // The record carries the label of the run that wrote the judgment, which
  // is the judgment's own: both are stamped from the same context, one
  // after the other (src/labels.ts). It says which nodes and sources the
  // judgment rested on, so it is as restricted as the judgment is.
  const label = currentLabel();
  await query(
    `INSERT INTO judgment_inputs
       (judgment_kind, judgment_id, input_kind, node_id, relation_type, input_judgment_id, sensitivity_label)
     SELECT $1::text, $2::uuid, 'premise', r.child_claim_id, r.relation_type, ${IN_FORCE_ID_SQL("r.child_claim_id")}, $4
       FROM claim_relationships r
      WHERE r.parent_claim_id = $3${notSetAsideSql("claim_relationships", "r.id")}`,
    [kind, judgmentId, nodeId, label]
  );
  await query(
    `INSERT INTO judgment_inputs (judgment_kind, judgment_id, input_kind, source_id, content_hash, sensitivity_label)
     SELECT DISTINCT $1::text, $2::uuid, 'source', s.id, s.content_hash, $4
       FROM claim_instances i JOIN sources s ON s.id = i.source_id
      WHERE i.claim_id = $3 AND i.detached_at IS NULL`,
    [kind, judgmentId, nodeId, label]
  );
  await query(`UPDATE ${JUDGMENT_TABLE[kind]} SET inputs_recorded = true WHERE id = $1`, [judgmentId]);
}

// ---------------------------------------------------------------------------
// Reading the record against the graph as it stands.
//
// The rules for what counts as a change are written once, in the SQL below,
// for any set of nodes: `$1` is a uuid[] of node ids. The detailed read of one
// node (getJudgmentInputs) selects the rows; the summary of many
// (summarizeJudgmentChanges) counts them. Both read the same fragments, so
// they cannot come to disagree about what changed.
// ---------------------------------------------------------------------------

/**
 * `judged`: the judgment in force of each node in $1, whichever kind it is.
 * A node keeps one kind of judgment; if one ever holds two (a node converted
 * to another kind), the newest is the one read. Exported so that the other
 * read of a judgment in force for many nodes at once (coverage-service.ts)
 * means the same judgment by it.
 */
export const JUDGED_CTE = `judged AS (
    SELECT DISTINCT ON (node_id) node_id, kind, id, assessed_at, inputs_recorded, label
      FROM (
        SELECT claim_id AS node_id, 'assessment'::text AS kind, id, assessed_at, inputs_recorded, sensitivity_label AS label
          FROM assessments_in_force WHERE claim_id = ANY($1::uuid[])
        UNION ALL
        SELECT claim_id, 'quantity_estimate', id, assessed_at, inputs_recorded, sensitivity_label
          FROM quantity_estimates_in_force WHERE claim_id = ANY($1::uuid[])
        UNION ALL
        SELECT claim_id, 'question_assessment', id, assessed_at, inputs_recorded, sensitivity_label
          FROM question_assessments_in_force WHERE claim_id = ANY($1::uuid[])
      ) j
     ORDER BY node_id, assessed_at DESC, kind
  )`;

/**
 * `premise_rows`: for each recorded judgment, the premises it was made
 * against joined to the edges as they stand, both ways. `state` is the rule:
 * added (an edge that was not there), removed (an edge that is gone),
 * rejudged (the premise's judgment in force is a different row, which
 * includes a first judgment), or unchanged.
 */
// A function, so that the fragment is built when the read is made: whether an edge is set aside is asked only on a
// graph with more than one label, which a process learns with its first query (overlay-service.ts).
const premiseRowsCte = () => `premise_rows AS (
    SELECT COALESCE(t.parent_id, n.parent_id) AS parent_id,
           COALESCE(t.node_id, n.node_id) AS node_id,
           COALESCE(t.relation_type, n.relation_type) AS relation,
           t.input_judgment_id AS judged_against,
           n.in_force_now,
           CASE WHEN t.node_id IS NULL THEN 'added'
                WHEN n.node_id IS NULL THEN 'removed'
                WHEN t.input_judgment_id IS DISTINCT FROM n.in_force_now THEN 'rejudged'
                ELSE 'unchanged' END AS state
      FROM (SELECT j.node_id AS parent_id, i.node_id, i.relation_type, i.input_judgment_id
              FROM judged j
              JOIN judgment_inputs i
                ON i.judgment_kind = j.kind AND i.judgment_id = j.id AND i.input_kind = 'premise'
             WHERE j.inputs_recorded) t
      FULL JOIN
           (SELECT j.node_id AS parent_id, r.child_claim_id AS node_id, r.relation_type,
                   ${IN_FORCE_ID_SQL("r.child_claim_id")} AS in_force_now
              FROM judged j
              JOIN claim_relationships r ON r.parent_claim_id = j.node_id
             WHERE j.inputs_recorded${notSetAsideSql("claim_relationships", "r.id", "j.label")}) n
        ON n.parent_id = t.parent_id AND n.node_id = t.node_id AND n.relation_type = t.relation_type
  )`;

/**
 * `source_rows`: for each recorded judgment, the sources it was made against
 * joined to the live instances. `state` is added (attached since), removed
 * (detached since) or kept; `recorded` says the judgment was made against it.
 */
const SOURCE_ROWS_CTE = `source_rows AS (
    SELECT COALESCE(t.parent_id, n.parent_id) AS parent_id,
           COALESCE(t.source_id, n.source_id) AS source_id,
           (t.source_id IS NOT NULL) AS recorded,
           CASE WHEN t.source_id IS NULL THEN 'added'
                WHEN n.source_id IS NULL THEN 'removed'
                ELSE 'kept' END AS state
      FROM (SELECT j.node_id AS parent_id, i.source_id
              FROM judged j
              JOIN judgment_inputs i
                ON i.judgment_kind = j.kind AND i.judgment_id = j.id AND i.input_kind = 'source'
             WHERE j.inputs_recorded) t
      FULL JOIN
           (SELECT DISTINCT j.node_id AS parent_id, ci.source_id
              FROM judged j
              JOIN claim_instances ci ON ci.claim_id = j.node_id AND ci.detached_at IS NULL
             WHERE j.inputs_recorded) n
        ON n.parent_id = t.parent_id AND n.source_id = t.source_id
  )`;

/**
 * `event_rows`: corrections, retractions and the other notices recorded on
 * a judgment's sources after it was written. Compared in the database, at
 * the timestamps' full precision.
 */
const EVENT_ROWS_CTE = `event_rows AS (
    SELECT j.node_id AS parent_id, e.source_id, e.kind, e.detected_at
      FROM judged j
      JOIN judgment_inputs i
        ON i.judgment_kind = j.kind AND i.judgment_id = j.id AND i.input_kind = 'source'
      JOIN source_events e ON e.source_id = i.source_id AND e.detected_at > j.assessed_at
     WHERE j.inputs_recorded
  )`;

/** How many of each kind of change a judgment's inputs have seen. */
export interface JudgmentChangeCounts {
  premises_rejudged: number;
  premises_added: number;
  premises_removed: number;
  sources_added: number;
  sources_removed: number;
  source_events: number;
}

const NO_CHANGES: JudgmentChangeCounts = {
  premises_rejudged: 0,
  premises_added: 0,
  premises_removed: 0,
  sources_added: 0,
  sources_removed: 0,
  source_events: 0,
};

/** Whether anything a judgment was made against has changed: any count above zero. */
function anyChange(counts: JudgmentChangeCounts): boolean {
  return (
    counts.premises_rejudged > 0 ||
    counts.premises_added > 0 ||
    counts.premises_removed > 0 ||
    counts.sources_added > 0 ||
    counts.sources_removed > 0 ||
    counts.source_events > 0
  );
}

export interface PremiseInput {
  node_id: string;
  relation: string;
  /** The premise's judgment in force when this judgment was written; null if it had none. */
  judged_against: string | null;
  /** Its judgment in force now; null if it has none, or if the premise is no longer under this node. */
  in_force_now: string | null;
  /** unchanged: the same judgment; rejudged: a different one; removed: no longer under this node. */
  state: "unchanged" | "rejudged" | "removed";
}

export interface JudgmentInputsView {
  node_id: string;
  /** The node's judgment in force; null when it has never been judged. */
  judgment: { kind: JudgmentKind; id: string; assessed_at: string } | null;
  /** False when the judgment predates the record: nothing below can then be said. */
  recorded: boolean;
  premises: PremiseInput[];
  /** Nodes under this one now that were not when the judgment was written. */
  premises_added: Array<{ node_id: string; relation: string; in_force_now: string | null }>;
  sources: {
    /** How many sources the judgment was made against. */
    recorded: number;
    /** Sources attached now that were not then, and sources attached then that are not now. */
    added: string[];
    removed: string[];
    /** Corrections and retractions recorded on its sources since the judgment was written. */
    events_since: Array<{ source_id: string; kind: string; detected_at: string }>;
  };
  /**
   * Whether anything the judgment was made against has changed: a premise
   * judged again, added or removed, a source added or removed, or an event
   * on one of its sources. Null when the judgment has no record to compare.
   */
  changed: boolean | null;
}

/**
 * What the node's judgment in force was made against and what has changed
 * since. Null when no node has this id.
 */
export async function getJudgmentInputs(nodeId: string): Promise<JudgmentInputsView | null> {
  const [node] = await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE id = $1`, [nodeId]);
  if (!node) return null;

  const [judgment] = await rawQuery<{
    kind: JudgmentKind;
    id: string;
    assessed_at: Date;
    inputs_recorded: boolean;
  }>(`WITH ${JUDGED_CTE} SELECT kind, id, assessed_at, inputs_recorded FROM judged`, [[nodeId]]);

  const empty: JudgmentInputsView = {
    node_id: nodeId,
    judgment: null,
    recorded: false,
    premises: [],
    premises_added: [],
    sources: { recorded: 0, added: [], removed: [], events_since: [] },
    changed: null,
  };
  if (!judgment) return empty;
  const head = {
    kind: judgment.kind,
    id: judgment.id,
    assessed_at: new Date(judgment.assessed_at).toISOString(),
  };
  if (!judgment.inputs_recorded) return { ...empty, judgment: head };

  const [premiseRows, sourceRows, events] = await Promise.all([
    rawQuery<{
      node_id: string;
      relation: string;
      judged_against: string | null;
      in_force_now: string | null;
      state: PremiseInput["state"] | "added";
    }>(
      `WITH ${JUDGED_CTE}, ${premiseRowsCte()}
       SELECT node_id, relation, judged_against, in_force_now, state FROM premise_rows ORDER BY 1, 2`,
      [[nodeId]]
    ),
    rawQuery<{ source_id: string; recorded: boolean; state: "added" | "removed" | "kept" }>(
      `WITH ${JUDGED_CTE}, ${SOURCE_ROWS_CTE}
       SELECT source_id, recorded, state FROM source_rows ORDER BY 1`,
      [[nodeId]]
    ),
    rawQuery<{ source_id: string; kind: string; detected_at: Date }>(
      `WITH ${JUDGED_CTE}, ${EVENT_ROWS_CTE}
       SELECT source_id, kind, detected_at FROM event_rows ORDER BY detected_at, source_id`,
      [[nodeId]]
    ),
  ]);

  const premises: PremiseInput[] = premiseRows.flatMap((r) =>
    r.state === "added"
      ? []
      : [{
          node_id: r.node_id,
          relation: r.relation,
          judged_against: r.judged_against,
          in_force_now: r.in_force_now,
          state: r.state,
        }]
  );
  const premisesAdded = premiseRows
    .filter((r) => r.state === "added")
    .map((r) => ({ node_id: r.node_id, relation: r.relation, in_force_now: r.in_force_now }));
  const sources = {
    recorded: sourceRows.filter((r) => r.recorded).length,
    added: sourceRows.filter((r) => r.state === "added").map((r) => r.source_id),
    removed: sourceRows.filter((r) => r.state === "removed").map((r) => r.source_id),
    events_since: events.map((e) => ({
      source_id: e.source_id,
      kind: e.kind,
      detected_at: new Date(e.detected_at).toISOString(),
    })),
  };

  return {
    node_id: nodeId,
    judgment: head,
    recorded: true,
    premises,
    premises_added: premisesAdded,
    sources,
    changed: anyChange(countJudgmentChanges({ premises, premises_added: premisesAdded, sources })),
  };
}

/** The counts of a detailed view: what the summary of the same node reports. */
export function countJudgmentChanges(
  view: Pick<JudgmentInputsView, "premises" | "premises_added" | "sources">
): JudgmentChangeCounts {
  return {
    premises_rejudged: view.premises.filter((p) => p.state === "rejudged").length,
    premises_added: view.premises_added.length,
    premises_removed: view.premises.filter((p) => p.state === "removed").length,
    sources_added: view.sources.added.length,
    sources_removed: view.sources.removed.length,
    source_events: view.sources.events_since.length,
  };
}

/**
 * What has changed under one node's judgment in force, as counts: what a
 * list of nodes can carry for each of them without a read per node.
 */
export interface JudgmentChangeSummary extends JudgmentChangeCounts {
  /** Whether the node has a judgment in force at all. */
  judged: boolean;
  /** False when it has none, or when its judgment predates the record: the counts then say nothing. */
  recorded: boolean;
  /** Null when there is no record to compare: unknown, never unchanged. */
  changed: boolean | null;
}

/**
 * The summary for each of `nodeIds`, in one query. Every id asked for has an
 * entry, keyed as the database writes a uuid (lower case): a node never
 * judged (or an id no node has) is `judged: false`. It reports exactly what
 * getJudgmentInputs reports for the same node, because both read the
 * fragments above (tests/db/judgment-inputs.test.ts holds them to it).
 */
export async function summarizeJudgmentChanges(
  nodeIds: readonly string[]
): Promise<Map<string, JudgmentChangeSummary>> {
  const ids = [...new Set(nodeIds.map((id) => id.toLowerCase()))];
  const out = new Map<string, JudgmentChangeSummary>(
    ids.map((id) => [id, { judged: false, recorded: false, changed: null, ...NO_CHANGES }])
  );
  if (ids.length === 0) return out;
  const rows = await rawQuery<{ node_id: string; recorded: boolean } & JudgmentChangeCounts>(
    `WITH ${JUDGED_CTE}, ${premiseRowsCte()}, ${SOURCE_ROWS_CTE}, ${EVENT_ROWS_CTE}
     SELECT j.node_id, j.inputs_recorded AS recorded,
            COALESCE(p.rejudged, 0)::int AS premises_rejudged,
            COALESCE(p.added, 0)::int AS premises_added,
            COALESCE(p.removed, 0)::int AS premises_removed,
            COALESCE(s.added, 0)::int AS sources_added,
            COALESCE(s.removed, 0)::int AS sources_removed,
            COALESCE(e.n, 0)::int AS source_events
       FROM judged j
       LEFT JOIN (SELECT parent_id,
                         count(*) FILTER (WHERE state = 'rejudged') AS rejudged,
                         count(*) FILTER (WHERE state = 'added') AS added,
                         count(*) FILTER (WHERE state = 'removed') AS removed
                    FROM premise_rows GROUP BY parent_id) p ON p.parent_id = j.node_id
       LEFT JOIN (SELECT parent_id,
                         count(*) FILTER (WHERE state = 'added') AS added,
                         count(*) FILTER (WHERE state = 'removed') AS removed
                    FROM source_rows GROUP BY parent_id) s ON s.parent_id = j.node_id
       LEFT JOIN (SELECT parent_id, count(*) AS n FROM event_rows GROUP BY parent_id) e
              ON e.parent_id = j.node_id`,
    [ids]
  );
  for (const { node_id, recorded, ...counts } of rows) {
    out.set(node_id, {
      judged: true,
      recorded,
      changed: recorded ? anyChange(counts) : null,
      ...counts,
    });
  }
  return out;
}

/**
 * What a read serves beside a node's judgment, as `since_assessed`: the
 * summary in the words a reader needs. Null for a node with no judgment in
 * force, which has nothing to be out of date. A judgment that predates the
 * record says so and carries no counts, so that zeros are never read as
 * "nothing changed". This is the form a read of one node serves; a row in a
 * list carries the shorter `sinceAssessedRow`.
 */
export type SinceAssessed =
  | { recorded: false; changed: null; note: string }
  | ({ recorded: true; changed: boolean } & JudgmentChangeCounts);

export const SINCE_ASSESSED_UNRECORDED_NOTE =
  "This judgment was written before the graph recorded what a judgment was made against, " +
  "so nothing can be said about what has changed since. That is unknown, not unchanged.";

export function sinceAssessed(summary: JudgmentChangeSummary | undefined): SinceAssessed | null {
  if (!summary?.judged) return null;
  if (!summary.recorded || summary.changed === null) {
    return { recorded: false, changed: null, note: SINCE_ASSESSED_UNRECORDED_NOTE };
  }
  return {
    recorded: true,
    changed: summary.changed,
    premises_rejudged: summary.premises_rejudged,
    premises_added: summary.premises_added,
    premises_removed: summary.premises_removed,
    sources_added: summary.sources_added,
    sources_removed: summary.sources_removed,
    source_events: summary.source_events,
  };
}

/**
 * `since_assessed` on one row of a list (a search hit, a candidate), kept
 * as small as the fact allows. A search is run constantly by every agent
 * and by outside callers, and for most hits the fact is "nothing changed":
 * eight keys on every row would be paid for by every reader to say that. So
 * a row says only what is not the default: nothing at all for a node with
 * no judgment (undefined here, so the key is left off the row), `recorded:
 * false` for a judgment that predates the record, `changed: false` when
 * nothing moved, and `changed: true` with only the counts above zero.
 */
export type SinceAssessedRow =
  | { recorded: false }
  | { changed: false }
  | ({ changed: true } & Partial<JudgmentChangeCounts>);

export function sinceAssessedRow(summary: JudgmentChangeSummary | undefined): SinceAssessedRow | undefined {
  if (!summary?.judged) return undefined;
  if (!summary.recorded || summary.changed === null) return { recorded: false };
  if (!summary.changed) return { changed: false };
  const moved: Partial<JudgmentChangeCounts> = {};
  for (const key of Object.keys(NO_CHANGES) as Array<keyof JudgmentChangeCounts>) {
    if (summary[key] > 0) moved[key] = summary[key];
  }
  return { changed: true, ...moved };
}

/**
 * The description of `since_assessed`, shared by every surface that serves
 * it so that none describes it differently.
 */
export const SINCE_ASSESSED_DESCRIPTION =
  "what has changed under the judgment in force since it was written, as counts: " +
  "`premises_rejudged` (nodes under it whose own judgment in force is a newer one, whether or " +
  "not the verdict moved), `premises_added`, `premises_removed`, `sources_added`, " +
  "`sources_removed`, and `source_events` (corrections, retractions and other notices on the " +
  "sources it was made against); `changed` is true when any count is above zero; " +
  "`recorded: false` with `changed: null` and no counts means the judgment predates this " +
  "record, which is unknown, not unchanged";

/** The same for a row of a list, where the short form is served. */
export const SINCE_ASSESSED_ROW_DESCRIPTION =
  "what has changed under its judgment since it was written, kept short: `changed`, and " +
  "when it is true only the counts above zero (`premises_rejudged`, nodes under it with a " +
  "newer judgment of their own, whether or not the verdict moved; `premises_added`; " +
  "`premises_removed`; `sources_added`; `sources_removed`; `source_events`, corrections, " +
  "retractions and other notices on its sources), counts that are zero being left out; " +
  "`recorded: false` means the judgment predates this record, which is unknown, not " +
  "unchanged; no key means the node has no judgment";
