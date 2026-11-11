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
 */
import { rawQuery } from "../db/client.js";

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
  await query(
    `INSERT INTO judgment_inputs
       (judgment_kind, judgment_id, input_kind, node_id, relation_type, input_judgment_id)
     SELECT $1::text, $2::uuid, 'premise', r.child_claim_id, r.relation_type, ${IN_FORCE_ID_SQL("r.child_claim_id")}
       FROM claim_relationships r
      WHERE r.parent_claim_id = $3`,
    [kind, judgmentId, nodeId]
  );
  await query(
    `INSERT INTO judgment_inputs (judgment_kind, judgment_id, input_kind, source_id, content_hash)
     SELECT DISTINCT $1::text, $2::uuid, 'source', s.id, s.content_hash
       FROM claim_instances i JOIN sources s ON s.id = i.source_id
      WHERE i.claim_id = $3 AND i.detached_at IS NULL`,
    [kind, judgmentId, nodeId]
  );
  await query(`UPDATE ${JUDGMENT_TABLE[kind]} SET inputs_recorded = true WHERE id = $1`, [judgmentId]);
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
  }>(
    `SELECT 'assessment' AS kind, id, assessed_at, inputs_recorded FROM assessments_in_force WHERE claim_id = $1
     UNION ALL
     SELECT 'quantity_estimate', id, assessed_at, inputs_recorded FROM quantity_estimates_in_force WHERE claim_id = $1
     UNION ALL
     SELECT 'question_assessment', id, assessed_at, inputs_recorded FROM question_assessments_in_force WHERE claim_id = $1
     ORDER BY assessed_at DESC LIMIT 1`,
    [nodeId]
  );

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

  // Premises: the record joined to the edges as they stand, both ways.
  const premiseRows = await rawQuery<{
    node_id: string;
    relation: string;
    judged_against: string | null;
    in_force_now: string | null;
    recorded: boolean;
    present: boolean;
  }>(
    `WITH then_ AS (
       SELECT node_id, relation_type, input_judgment_id FROM judgment_inputs
        WHERE judgment_kind = $1 AND judgment_id = $2 AND input_kind = 'premise'
     ), now_ AS (
       SELECT r.child_claim_id AS node_id, r.relation_type FROM claim_relationships r
        WHERE r.parent_claim_id = $3
     )
     SELECT COALESCE(t.node_id, n.node_id) AS node_id,
            COALESCE(t.relation_type, n.relation_type) AS relation,
            t.input_judgment_id AS judged_against,
            CASE WHEN n.node_id IS NULL THEN NULL
                 ELSE ${IN_FORCE_ID_SQL("n.node_id")} END AS in_force_now,
            (t.node_id IS NOT NULL) AS recorded,
            (n.node_id IS NOT NULL) AS present
       FROM then_ t
       FULL JOIN now_ n ON n.node_id = t.node_id AND n.relation_type = t.relation_type
      ORDER BY 1, 2`,
    [judgment.kind, judgment.id, nodeId]
  );
  const premises: PremiseInput[] = premiseRows
    .filter((r) => r.recorded)
    .map((r) => ({
      node_id: r.node_id,
      relation: r.relation,
      judged_against: r.judged_against,
      in_force_now: r.in_force_now,
      state: !r.present ? "removed" : r.judged_against === r.in_force_now ? "unchanged" : "rejudged",
    }));
  const premisesAdded = premiseRows
    .filter((r) => !r.recorded)
    .map((r) => ({ node_id: r.node_id, relation: r.relation, in_force_now: r.in_force_now }));

  // Sources: the record against the live instances.
  const sourceRows = await rawQuery<{ source_id: string; recorded: boolean; present: boolean }>(
    `WITH then_ AS (
       SELECT source_id FROM judgment_inputs
        WHERE judgment_kind = $1 AND judgment_id = $2 AND input_kind = 'source'
     ), now_ AS (
       SELECT DISTINCT source_id FROM claim_instances WHERE claim_id = $3 AND detached_at IS NULL
     )
     SELECT COALESCE(t.source_id, n.source_id) AS source_id,
            (t.source_id IS NOT NULL) AS recorded, (n.source_id IS NOT NULL) AS present
       FROM then_ t FULL JOIN now_ n ON n.source_id = t.source_id
      ORDER BY 1`,
    [judgment.kind, judgment.id, nodeId]
  );
  const events = await rawQuery<{ source_id: string; kind: string; detected_at: Date }>(
    `SELECT e.source_id, e.kind, e.detected_at
       FROM source_events e
       JOIN judgment_inputs t ON t.source_id = e.source_id
      WHERE t.judgment_kind = $1 AND t.judgment_id = $2 AND t.input_kind = 'source'
        AND e.detected_at > $3
      ORDER BY e.detected_at, e.source_id`,
    [judgment.kind, judgment.id, judgment.assessed_at]
  );

  const sources = {
    recorded: sourceRows.filter((r) => r.recorded).length,
    added: sourceRows.filter((r) => !r.recorded).map((r) => r.source_id),
    removed: sourceRows.filter((r) => r.recorded && !r.present).map((r) => r.source_id),
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
    changed:
      premises.some((p) => p.state !== "unchanged") ||
      premisesAdded.length > 0 ||
      sources.added.length > 0 ||
      sources.removed.length > 0 ||
      sources.events_since.length > 0,
  };
}
