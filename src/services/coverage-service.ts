/**
 * What examination a node has had (#543).
 *
 * A status says what the evidence shows. Coverage says what evidence was
 * looked at, and first of all whether any was. The two are separate facts:
 * a node with no judgment in force has not been examined, and a reader of
 * the claim above it must be able to tell that apart from a part that was
 * examined and found sound. An assessed `unknown` is the opposite case: the
 * evidence was looked at and found insufficient, which is a finding.
 *
 * Coverage is read from the record, never written. Nobody sets it and no
 * agent chooses it:
 *
 *   - `examined` is whether the node has a judgment in force (a claim's
 *     assessment, a quantity's estimate, a question's assessment). A seed
 *     credence from the parent's Steward, attached sources and readings of
 *     them are not a judgment, so a node that has those and nothing else is
 *     not examined.
 *   - `on` lists what the judgment in force was made on. On the public graph
 *     every judgment is made on public evidence, since the graph holds
 *     nothing else (labels.ts), so `public_evidence` is there whenever the
 *     node is examined. `evidence_not_shown` joins it when at least one
 *     source the judgment was recorded against (judgment_inputs) had been
 *     read, by the time the judgment was written, as reporting a result from
 *     evidence it has not published (constitution §9; the reading kind of
 *     the same name). That is the public graph's form of "examined on
 *     evidence the reader cannot inspect".
 *
 * `on` is a list from a fixed vocabulary so that the values the issue names
 * and the public graph cannot yet state (evidence held at a private label,
 * a judgment held from the public copy) are added as words in the list, with
 * no change to the field's shape. A request that was put to a party and
 * refused is not here either: a request records whom it is addressed to,
 * but nothing records that the party declined or never answered (`declined`
 * is the keeper's or the Researcher's refusal of the request itself), so a
 * count of refusals would be a guess.
 *
 * A judgment keeps its sources in judgment_inputs and not how each was read,
 * so the reading is taken from the reading log, which keeps every reading
 * with its time: the newest one of each instance at or before the judgment.
 * A reading recorded after the judgment in force does not change what that
 * judgment was made on; it shows once the node is judged again. A judgment
 * whose inputs were not recorded (it predates the record, which also
 * predates the reading kind, or the write of its inputs failed) names no
 * sources, so `evidence_not_shown` is never listed for it.
 *
 * One query serves any number of nodes, so a tree of five hundred nodes
 * costs what one node does, and the read of one node is the same query with
 * one id: the two cannot come to disagree.
 */
import { currentReadClearance, rawQuery } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";
import { oneLabelOnly } from "./judgment-version-service.js";
import { JUDGED_CTE } from "./judgment-inputs-service.js";

/** What a judgment can have been made on. Values are added here, never renamed. */
export const COVERAGE_EVIDENCE = ["public_evidence", "evidence_not_shown"] as const;

/**
 * What a judgment can have been made on where a deployment holds material
 * at more than one label. There "public evidence" would be false of a
 * judgment made on sources only some readers read, so coverage is said to
 * the reader it is served to: evidence that reader can read, and evidence
 * that was examined and that reader cannot read. The second is true of a
 * judgment that took in a page shown from a label the reader does not read
 * (services/showing-service.ts), and of a shown page's own coverage as its
 * destination reads it. `evidence_not_shown` keeps its meaning. The public
 * graph has one label and none of these is ever said there.
 */
export const READER_COVERAGE_EVIDENCE = ["evidence_this_reader_can_read", "evidence_this_reader_cannot_read"] as const;

export type CoverageEvidence = (typeof COVERAGE_EVIDENCE)[number] | (typeof READER_COVERAGE_EVIDENCE)[number];

/** The words that say only that the judgment was made on what its reader can read: the ordinary case, left off a row. */
const ORDINARY: ReadonlySet<string> = new Set(["public_evidence", "evidence_this_reader_can_read"]);

/**
 * What the record says of one node: whether it is examined, and everything
 * its judgment in force was made on. `on` is empty exactly when `examined`
 * is false. Both forms the reads serve are made from this.
 */
export interface CoverageSummary {
  examined: boolean;
  on: CoverageEvidence[];
}

/**
 * The field on a read of one node: the summary whole, with `note` on a node
 * that has not been examined and on no other.
 */
export type Coverage = CoverageSummary & { note?: string };

/**
 * The field on one row of a list (a node of a tree, a subclaim), kept as
 * small as the fact allows. `examined` is always there, since a row that
 * said nothing would be read as nothing being wrong. `on` lists only what
 * the judgment was made on beyond public evidence, and is left out when
 * there is nothing beyond it.
 */
export interface CoverageRow {
  examined: boolean;
  on?: Exclude<CoverageEvidence, "public_evidence" | "evidence_this_reader_can_read">[];
}

export const COVERAGE_UNEXAMINED_NOTE =
  "No judgment of this node is in force. That is not a finding either way.";

const UNEXAMINED: CoverageSummary = { examined: false, on: [] };

/**
 * The coverage of each of `nodeIds`, in one query. Every id asked for has an
 * entry, keyed as the database writes a uuid (lower case): a node with no
 * judgment in force (or an id no node has) is not examined.
 */
export async function summarizeCoverage(
  nodeIds: readonly string[],
  opts: {
    /**
     * Say it to another reader than the one asking: the readers a page is
     * shown to (the labels they read, or nothing inside the deployment but
     * the mirrored public graph when it is shown outside). The judgment is
     * still the one in force for the asker.
     */
    saidTo?: { reads: readonly string[]; outside: boolean };
  } = {}
): Promise<Map<string, CoverageSummary>> {
  const ids = [...new Set(nodeIds.map((id) => id.toLowerCase()))];
  const out = new Map<string, CoverageSummary>(ids.map((id) => [id, { ...UNEXAMINED, on: [] }]));
  if (ids.length === 0) return out;
  const rows = await rawQuery<{ node_id: string; evidence_not_shown: boolean }>(
    // An instance counts when it was attached as the judgment was written:
    // one detached before then was no part of what the judgment was made on,
    // even where another instance of the same source was.
    `WITH ${JUDGED_CTE}
     SELECT j.node_id,
            EXISTS (
              SELECT 1
                FROM judgment_inputs i
                JOIN claim_instances ci
                  ON ci.claim_id = j.node_id AND ci.source_id = i.source_id
                 AND (ci.detached_at IS NULL OR ci.detached_at > j.assessed_at)
                JOIN LATERAL (
                  SELECT l.support
                    FROM claim_instance_reading_log l
                   WHERE l.instance_id = ci.id AND l.created_at <= j.assessed_at
                   ORDER BY l.created_at DESC, l.id DESC
                   LIMIT 1) r ON true
               WHERE i.judgment_kind = j.kind AND i.judgment_id = j.id
                 AND i.input_kind = 'source'
                 AND r.support = 'evidence_not_shown'
            ) AS evidence_not_shown
       FROM judged j`,
    [ids]
  );
  for (const row of rows) {
    out.set(row.node_id, {
      examined: true,
      on: row.evidence_not_shown ? ["public_evidence", "evidence_not_shown"] : ["public_evidence"],
    });
  }
  // Where `public` is the only label, that is the whole of it, as it always was.
  if (oneLabelOnly() || rows.length === 0) return out;

  const reads = opts.saidTo?.reads ?? (await currentReadClearance()) ?? [PUBLIC_LABEL];
  const sources = await rawQuery<{ node_id: string; readable: boolean; unreadable: boolean }>(
    // What the judgment was made on: the sources recorded against it, or,
    // for one whose inputs were not recorded, the sources attached to its
    // node now. A page shown from another label is read here and stands for
    // evidence that was examined where this reader cannot read.
    `WITH ${JUDGED_CTE}, made_on AS (
       SELECT j.node_id, s.sensitivity_label AS label, s.source_type, s.origin, s.url
         FROM judged j
         JOIN judgment_inputs i ON i.judgment_kind = j.kind AND i.judgment_id = j.id AND i.input_kind = 'source'
         JOIN sources s ON s.id = i.source_id
        WHERE j.inputs_recorded
       UNION ALL
       SELECT j.node_id, s.sensitivity_label, s.source_type, s.origin, s.url
         FROM judged j
         JOIN claim_instances ci ON ci.claim_id = j.node_id AND ci.detached_at IS NULL
         JOIN sources s ON s.id = ci.source_id
        WHERE NOT j.inputs_recorded
          -- The public graph's own judgment of a mirrored node was made there. What this deployment has
          -- attached to the node since (a page shown to public, a source of its own) was never in front
          -- of it, so only the public graph's own sources count as what it may have been made on.
          AND (s.origin = 'mirror' OR NOT (
                (j.kind = 'assessment' AND EXISTS (SELECT 1 FROM assessments x WHERE x.id = j.id AND x.origin = 'mirror'))
             OR (j.kind = 'quantity_estimate' AND EXISTS (SELECT 1 FROM quantity_estimates x WHERE x.id = j.id AND x.origin = 'mirror'))
             OR (j.kind = 'question_assessment' AND EXISTS (SELECT 1 FROM question_assessments x WHERE x.id = j.id AND x.origin = 'mirror'))))
       UNION ALL
       -- A reading through a connection, or an analysis of a set of files, that work on the node at the
       -- judgment's label kept as a source before the judgment was written. An agent keeps one when a
       -- judgment rests on it, whether or not an instance was recorded from it, so it is part of what the
       -- judgment was made on (showing-service.ts counts the same sources for a page's release).
       SELECT j.node_id, s.sensitivity_label, s.source_type, s.origin, s.url
         FROM judged j
         JOIN (SELECT claim_id, source_id, sensitivity_label, called_at FROM connection_calls
               UNION ALL
               SELECT claim_id, source_id, sensitivity_label, called_at FROM sandbox_calls) k
           ON k.claim_id = j.node_id AND k.source_id IS NOT NULL AND k.called_at <= j.assessed_at
         JOIN sources s ON s.id = k.source_id
        WHERE k.sensitivity_label = COALESCE(
                (SELECT x.sensitivity_label FROM assessments_in_force x WHERE x.id = j.id),
                (SELECT x.sensitivity_label FROM quantity_estimates_in_force x WHERE x.id = j.id),
                (SELECT x.sensitivity_label FROM question_assessments_in_force x WHERE x.id = j.id))
     )
     SELECT j.node_id,
            EXISTS (SELECT 1 FROM made_on m WHERE m.node_id = j.node_id AND m.source_type <> 'shown_page'
                       AND (m.label = ANY($2::text[]) OR ($3::boolean AND m.origin = 'mirror'))) AS readable,
            EXISTS (SELECT 1 FROM made_on m WHERE m.node_id = j.node_id
                       AND ((m.source_type = 'shown_page'
                             -- unless this reader also reads the label the page was shown from
                             AND NOT EXISTS (SELECT 1 FROM showing_pages pp
                                              WHERE m.url LIKE 'minerval:shown-page/' || pp.id::text || '/%'
                                                AND pp.sensitivity_label = ANY($2::text[])))
                            OR NOT (m.label = ANY($2::text[]) OR ($3::boolean AND m.origin = 'mirror')))) AS unreadable
       FROM judged j`,
    [ids, opts.saidTo?.outside ? [] : [...reads], opts.saidTo?.outside === true]
  );
  for (const row of sources) {
    const was = out.get(row.node_id);
    if (!was?.examined) continue;
    const on: CoverageEvidence[] = [];
    // A reader's own judgment in force is in front of them with what it cites, whether or not a source is recorded.
    if (row.readable || !opts.saidTo) on.push("evidence_this_reader_can_read");
    if (row.unreadable) on.push("evidence_this_reader_cannot_read");
    if (was.on.includes("evidence_not_shown")) on.push("evidence_not_shown");
    out.set(row.node_id, { examined: true, on });
  }
  return out;
}

/**
 * `coverage` as a read of one node serves it, beside the judgment. A node
 * that has not been examined says so in words as well, because the place a
 * verdict would stand is otherwise empty and an empty place is easy to read
 * as nothing being wrong. Undefined when the summary could not be read: the
 * key is then left off, and absent is "not said", never "examined".
 */
export function coverage(summary: CoverageSummary | undefined): Coverage | undefined {
  if (!summary) return undefined;
  return summary.examined ? summary : { ...summary, note: COVERAGE_UNEXAMINED_NOTE };
}

/**
 * `coverage` on one row of a list. A tree is read constantly by agents that
 * pay for every key in context, and for most nodes the fact is one of two:
 * not examined, or examined on public evidence and nothing else. So a row
 * says `examined`, and names what the judgment was made on only where that
 * goes beyond public evidence; a value added to the vocabulary later is
 * listed the same way. Undefined when the summary could not be read, so the
 * key is left off the row.
 */
export function coverageRow(summary: CoverageSummary | undefined): CoverageRow | undefined {
  if (!summary) return undefined;
  const beyond = summary.on.filter(
    (e): e is Exclude<CoverageEvidence, "public_evidence" | "evidence_this_reader_can_read"> => !ORDINARY.has(e)
  );
  return beyond.length > 0 ? { examined: summary.examined, on: beyond } : { examined: summary.examined };
}

/**
 * The description of `coverage`, shared by every surface that serves it so
 * that none describes it differently.
 */
export const COVERAGE_DESCRIPTION =
  "what examination the node has had, a separate fact from what its judgment says: " +
  "`examined` is true when a judgment of the node is in force (a claim's assessment, a " +
  "quantity's estimate, a question's assessment) and false when none is, whatever seed, " +
  "sources or readings the node carries; `on` lists what the judgment in force was made on, " +
  "from a fixed vocabulary that may gain values: `public_evidence`, and `evidence_not_shown` " +
  "when at least one source the judgment was recorded against had been read, by the time it " +
  "was written, as reporting a result from evidence it has not published. `on` is empty when " +
  "`examined` is false, and `note` then says that no judgment is in force, which is not a " +
  "finding either way. A status of `unknown` is a judgment, so the node is examined. " +
  "`evidence_not_shown` is listed only for a judgment whose inputs were recorded";

/** The same for a row of a list, where the short form is served. */
export const COVERAGE_ROW_DESCRIPTION =
  "what examination the node has had, kept short: `examined` is whether a judgment of it is " +
  "in force (a claim's assessment, a quantity's estimate, a question's assessment), and false " +
  "means it has not been examined, which is not a finding either way; on a row, `on` lists " +
  "only what the judgment was made on beyond public evidence (`evidence_not_shown` when a " +
  "source it was recorded against had been read as reporting a result from evidence it has " +
  "not published), and is left out when there is nothing beyond it; get_claim on the node " +
  "lists everything";
