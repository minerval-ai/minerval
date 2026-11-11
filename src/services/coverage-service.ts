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
import { rawQuery } from "../db/client.js";
import { JUDGED_CTE } from "./judgment-inputs-service.js";

/** What a judgment can have been made on. Values are added here, never renamed. */
export const COVERAGE_EVIDENCE = ["public_evidence", "evidence_not_shown"] as const;
export type CoverageEvidence = (typeof COVERAGE_EVIDENCE)[number];

/**
 * The field as a row of a list carries it (a node of a tree, a subclaim):
 * `on` is empty exactly when `examined` is false.
 */
export interface CoverageRow {
  examined: boolean;
  on: CoverageEvidence[];
}

/**
 * The field on a read of one node: the same object, with `note` on a node
 * that has not been examined and on no other.
 */
export type Coverage = CoverageRow & { note?: string };

export const COVERAGE_UNEXAMINED_NOTE =
  "No judgment of this node is in force. That is not a finding either way.";

const UNEXAMINED: CoverageRow = { examined: false, on: [] };

/**
 * The coverage of each of `nodeIds`, in one query. Every id asked for has an
 * entry, keyed as the database writes a uuid (lower case): a node with no
 * judgment in force (or an id no node has) is not examined.
 */
export async function summarizeCoverage(nodeIds: readonly string[]): Promise<Map<string, CoverageRow>> {
  const ids = [...new Set(nodeIds.map((id) => id.toLowerCase()))];
  const out = new Map<string, CoverageRow>(ids.map((id) => [id, { ...UNEXAMINED, on: [] }]));
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
  return out;
}

/**
 * `coverage` as a read of one node serves it, beside the judgment. A node
 * that has not been examined says so in words as well, because the place a
 * verdict would stand is otherwise empty and an empty place is easy to read
 * as nothing being wrong. Undefined when the summary could not be read: the
 * key is then left off, and absent is "not said", never "examined".
 */
export function coverage(row: CoverageRow | undefined): Coverage | undefined {
  if (!row) return undefined;
  return row.examined ? row : { ...row, note: COVERAGE_UNEXAMINED_NOTE };
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

/** The same for a row of a list, which carries no `note`. */
export const COVERAGE_ROW_DESCRIPTION =
  "what examination the node has had: `examined` is whether a judgment of it is in force (a " +
  "claim's assessment, a quantity's estimate, a question's assessment), and false means it " +
  "has not been examined, which is not a finding either way; `on` lists what that " +
  "judgment was made on, `public_evidence`, and `evidence_not_shown` when a source it was " +
  "recorded against had been read as reporting a result from evidence it has not published, " +
  "and is empty when `examined` is false";
