/**
 * A judgment at each label (src/labels.ts, db/schema.ts "The judgment in
 * force, and a version at each label").
 *
 * A node may carry one current judgment at each label: a version. A run
 * writes its own label's version and no other, a version is replaced only
 * by work at its own label, and a version on a node that carries another
 * label rests on material at the version's own label or is not stored. The
 * database holds all three (the unique index, minerval_judgment_label_guard,
 * minerval_material_at). This module is the application's side: what a
 * write seam asks before it writes, what it tells the agent when the
 * answer is no, and the reads that show a node's versions side by side.
 *
 * On the public graph there is one label and one version. Every function
 * here that would ask the database something about labels returns at once
 * where this process knows that (enforcementLastKnown), so nothing the
 * public graph does or serves changes.
 */
import { enforcementLastKnown } from "../db/clearance.js";
import { rawQuery } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";
import { currentLabel } from "../llm/usage-context.js";

/** The four tables that hold judgments, by the name the database's rule knows them by. */
export type JudgmentTable = "assessments" | "quantity_estimates" | "question_assessments" | "argument_evaluations";

/**
 * Whether this process has no reason to think the deployment has a second
 * label: it has asked and the answer was no, or it has not yet run a query
 * at all. Nothing is asked here, so that the public graph pays nothing for
 * the question and its statements stay word for word what they were.
 *
 * A process learns the answer with its first query (db/client.ts asks
 * before it runs one) and the API asks at start, so "not yet asked" is the
 * moment before a process has touched the database. A caller that took the
 * one-label path in that moment on a deployment with more labels has done
 * nothing the database does not catch: a write to a row at another label
 * is refused there, and so is a version with nothing at its label to rest
 * on.
 */
export function oneLabelOnly(): boolean {
  return enforcementLastKnown() !== true;
}

/**
 * A version at the label of the work in progress cannot be recorded on this
 * node, because the node carries another label and nothing at this label
 * bears on it. Null when it can be: the node is at this label, or material
 * at this label is attached.
 */
export async function versionWithoutMaterial(
  nodeId: string
): Promise<{ label: string; nodeLabel: string } | null> {
  if (oneLabelOnly()) return null;
  const label = currentLabel();
  const [row] = await rawQuery<{ node_label: string; bears: boolean }>(
    `SELECT c.sensitivity_label AS node_label,
            (c.sensitivity_label = $2 OR minerval_material_at(c.id, $2)) AS bears
       FROM claims c WHERE c.id = $1`,
    [nodeId, label]
  );
  if (!row || row.bears) return null;
  return { label, nodeLabel: row.node_label };
}

/**
 * What the agent is told when its version is refused for want of material
 * at its label. It states what the tool does and why, and what would
 * satisfy it; whether anything at the label really bears on the node stays
 * the agent's judgment.
 */
export function versionWithoutMaterialMessage(
  refusal: { label: string; nodeLabel: string },
  what: string
): string {
  const { label, nodeLabel } = refusal;
  return (
    `Not recorded. This node carries the label \`${nodeLabel}\` and this run works at \`${label}\`. ` +
    `${what} at \`${label}\` is stored only when material at \`${label}\` bears on the node, and none is ` +
    `attached to it: no source labeled \`${label}\` on the node, no node labeled \`${label}\` under it, and no ` +
    `node under it that carries a version at \`${label}\`. That keeps a \`${label}\` version different from ` +
    `the one it reads only where \`${label}\` material makes the difference. With none, there is nothing at ` +
    `\`${label}\` to judge, and the version you read stands for readers at \`${label}\`. If material at ` +
    `\`${label}\` does bear on this node, attach it first (a source with record_claim_instance, or the node ` +
    `that carries it as a subclaim or a premise), say in your reasoning what it shows, and record again. ` +
    `If none does, record no version here and say so with log_stewardship_decision.`
  );
}

/**
 * The node carries another label than the work in progress, so it is not
 * this work's to change: null where it is the work's own (always, where
 * `public` is the only label), else the two labels.
 */
export async function anotherLabelsNode(nodeId: string): Promise<{ label: string; nodeLabel: string } | null> {
  if (oneLabelOnly()) return null;
  const label = currentLabel();
  const [row] = await rawQuery<{ node_label: string }>(
    `SELECT sensitivity_label AS node_label FROM claims WHERE id = $1`,
    [nodeId]
  );
  return !row || row.node_label === label ? null : { label, nodeLabel: row.node_label };
}

/** What an agent is told when it tries to change a node that carries another label. `what` names the thing, lower case. */
export function anotherLabelsNodeMessage(at: { label: string; nodeLabel: string }, what: string): string {
  return (
    `Not changed. This node carries the label \`${at.nodeLabel}\` and this run works at \`${at.label}\`. ` +
    `A node's ${what} belongs to the Steward that works at the node's own label, and a change made from ` +
    `\`${at.label}\` would be read by readers of \`${at.nodeLabel}\` as their own label's work. What ` +
    `\`${at.label}\` has to add to the node is recorded at \`${at.label}\`, beside what is there: an ` +
    `argument, a subclaim, a source, a version of its judgment. If the node should change on grounds its ` +
    `own label could see, record that as a request (file_request).`
  );
}

/** The same refusal as the database words it (MVL07), turned into the agent's message; null for any other error. */
export function versionRefusalFromDatabase(err: unknown, nodeLabelFallback: string, what: string): string | null {
  if ((err as { code?: string } | null)?.code !== "MVL07") return null;
  return versionWithoutMaterialMessage({ label: currentLabel(), nodeLabel: nodeLabelFallback }, what);
}

/**
 * Record the versions a new version was made beside: the current version
 * of the same node at each other label the writer's label reads. Call it
 * right after the version is inserted, through the same transaction where
 * there is one. `nodeColumn` is the judgment table's column for its node.
 */
export async function recordMadeBeside(
  query: <R>(text: string, params?: unknown[]) => Promise<R[]>,
  table: JudgmentTable,
  kind: "assessment" | "quantity_estimate" | "question_assessment" | "argument_evaluation",
  judgmentId: string,
  nodeId: string
): Promise<void> {
  if (oneLabelOnly()) return;
  const label = currentLabel();
  const nodeColumn = table === "argument_evaluations" ? "argument_id" : "claim_id";
  await query(
    `INSERT INTO judgment_inputs (judgment_kind, judgment_id, input_kind, input_judgment_id, input_label, sensitivity_label)
     SELECT $1::text, $2::uuid, 'beside', v.id, v.sensitivity_label, $4
       FROM ${table}_versions v
      WHERE v.${nodeColumn} = $3 AND v.sensitivity_label <> $4
        AND v.sensitivity_label = ANY (minerval_labels_readable_from(ARRAY[$4::text]))`,
    [kind, judgmentId, nodeId, label]
  );
}

/** One version of a node's judgment that a version was made beside, and whether it still stands. */
export interface MadeBeside {
  label: string;
  /** The version it was made beside. */
  judgment_id: string;
  /** True when that version has since been replaced or retired: this one was made against an earlier version. */
  replaced: boolean;
}

/**
 * For each of the given current versions (ids in `table`), the versions it
 * was made beside and whether each still stands, and the labels it reads
 * that have gained a version since. Read from the record alone; it writes
 * nothing.
 */
export async function madeBesideOf(
  table: JudgmentTable,
  kind: "assessment" | "quantity_estimate" | "question_assessment" | "argument_evaluation",
  judgmentIds: readonly string[]
): Promise<Map<string, { beside: MadeBeside[]; since_added: string[] }>> {
  const out = new Map<string, { beside: MadeBeside[]; since_added: string[] }>();
  if (judgmentIds.length === 0 || oneLabelOnly()) return out;
  const nodeColumn = table === "argument_evaluations" ? "argument_id" : "claim_id";
  const rows = await rawQuery<{ judgment_id: string; label: string; beside_id: string | null; replaced: boolean }>(
    `SELECT i.judgment_id, i.input_label AS label, i.input_judgment_id AS beside_id,
            NOT EXISTS (SELECT 1 FROM ${table}_versions o WHERE o.id = i.input_judgment_id) AS replaced
       FROM judgment_inputs i
      WHERE i.judgment_kind = $1 AND i.judgment_id = ANY($2::uuid[]) AND i.input_kind = 'beside'
     UNION ALL
     SELECT v.id, o.sensitivity_label, NULL, false
       FROM ${table}_versions v
       JOIN ${table}_versions o
         ON o.${nodeColumn} = v.${nodeColumn} AND o.sensitivity_label <> v.sensitivity_label
        AND o.sensitivity_label = ANY (minerval_labels_readable_from(ARRAY[v.sensitivity_label]))
      WHERE v.id = ANY($2::uuid[])
        AND NOT EXISTS (SELECT 1 FROM judgment_inputs i
                         WHERE i.judgment_kind = $1 AND i.judgment_id = v.id AND i.input_kind = 'beside'
                           AND i.input_label = o.sensitivity_label)`,
    [kind, [...judgmentIds]]
  );
  for (const id of judgmentIds) out.set(id, { beside: [], since_added: [] });
  for (const r of rows) {
    const entry = out.get(r.judgment_id) ?? { beside: [], since_added: [] };
    if (r.beside_id) entry.beside.push({ label: r.label, judgment_id: r.beside_id, replaced: r.replaced });
    else entry.since_added.push(r.label);
    out.set(r.judgment_id, entry);
  }
  for (const entry of out.values()) {
    entry.beside.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    entry.since_added.sort();
  }
  return out;
}

/** Whether a version was made against an earlier version of one it reads, from madeBesideOf's entry. */
export function madeAgainstEarlier(entry: { beside: MadeBeside[]; since_added: string[] } | undefined): boolean {
  return !!entry && (entry.beside.some((b) => b.replaced) || entry.since_added.length > 0);
}

/** Labels in the order a reader is shown them: the given one first, `public` last, the rest by name. */
export function labelOrder(first?: string): (a: string, b: string) => number {
  const rank = (l: string) => (l === first ? 0 : l === PUBLIC_LABEL ? 2 : 1);
  return (a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

// ---------------------------------------------------------------------------
// What a reader gets: a node's versions, side by side.
// ---------------------------------------------------------------------------

/** One current version of a node's judgment, as a read of the node serves it. */
export interface NodeVersion extends Record<string, unknown> {
  /** The label the version was made at: who may read it. */
  label: string;
  /**
   * Whether it is in force for this reader: no other version the reader may
   * read was made at a label that reads this one's. A reader who holds two
   * labels that do not read each other may have two in force.
   */
  in_force: boolean;
  /** The versions it was made beside, at the labels its label reads, and whether each has since been replaced. */
  made_beside: Array<{ label: string; replaced: boolean }>;
  /** Labels its label reads that had no version when it was made and have one now. */
  versions_since: string[];
  /** True when a version it was made beside has been replaced, or a label it reads has gained one: it was made against an earlier state of what it reads. */
  made_against_earlier: boolean;
}

const VERSION_FIELDS: Record<"claim" | "quantity" | "question", { table: JudgmentTable; kind: "assessment" | "quantity_estimate" | "question_assessment"; select: string }> = {
  claim: {
    table: "assessments",
    kind: "assessment",
    select: `v.status, v.confidence, v.claim_credence, COALESCE(v.summary, v.reasoning_trace) AS summary,
             v.reasoning_trace, v.model, v.run_id`,
  },
  quantity: {
    table: "quantity_estimates",
    kind: "quantity_estimate",
    select: `v.estimate, v.summary, v.work, v.model`,
  },
  question: {
    table: "question_assessments",
    kind: "question_assessment",
    select: `v.standing, v.favored_claim_ids AS favored_answer_ids, v.summary, v.reasoning_trace, v.incomplete,
             v.confidence, v.model, v.run_id`,
  },
};

/**
 * A node's label and the current versions of its judgment that the reader
 * may read: those in force first (the one a single-judgment read serves
 * first of all), then the ones beside them. Null on a deployment whose only
 * label is `public`, where a read is what it always was, and for a node the
 * reader may not read.
 */
export async function nodeVersions(
  nodeId: string,
  kind: string
): Promise<{ label: string; versions: NodeVersion[] } | null> {
  if (oneLabelOnly()) return null;
  const { deploymentHoldsLabels } = await import("../db/client.js");
  if (!(await deploymentHoldsLabels())) return null;
  const spec = VERSION_FIELDS[(kind as "claim" | "quantity" | "question")] ?? VERSION_FIELDS.claim;
  const [node] = await rawQuery<{ sensitivity_label: string }>(
    `SELECT sensitivity_label FROM claims WHERE id = $1`,
    [nodeId]
  );
  if (!node) return null;
  const rows = await rawQuery<Record<string, unknown> & { id: string; label: string; in_force: boolean; assessed_at: Date }>(
    `SELECT v.id, v.sensitivity_label AS label, v.in_force, v.assessed_at, ${spec.select},
            minerval_version_gone_by('${spec.table}', v.claim_id, v.sensitivity_label) AS leads
       FROM ${spec.table}_versions v
      WHERE v.claim_id = $1
      ORDER BY leads DESC, v.in_force DESC, v.assessed_at DESC, v.id`,
    [nodeId]
  );
  const beside = await madeBesideOf(spec.table, spec.kind, rows.map((r) => r.id));
  return {
    label: node.sensitivity_label,
    versions: rows.map(({ leads: _leads, assessed_at, ...r }) => {
      const record = beside.get(r.id);
      return {
        ...r,
        assessed_at: new Date(assessed_at).toISOString(),
        made_beside: (record?.beside ?? []).map((b) => ({ label: b.label, replaced: b.replaced })),
        versions_since: record?.since_added ?? [],
        made_against_earlier: madeAgainstEarlier(record),
      };
    }),
  };
}

/** A source's label, for a read of the source on a deployment with more than one label; null elsewhere. */
export async function sourceLabel(sourceId: string): Promise<string | null> {
  if (oneLabelOnly()) return null;
  const { deploymentHoldsLabels } = await import("../db/client.js");
  if (!(await deploymentHoldsLabels())) return null;
  const [row] = await rawQuery<{ sensitivity_label: string }>(
    `SELECT sensitivity_label FROM sources WHERE id = $1`,
    [sourceId]
  );
  return row?.sensitivity_label ?? null;
}

/** What a read's schema says of `versions`, where a deployment serves it. */
export const VERSIONS_DESCRIPTION =
  "the current versions of this node's judgment that the reader may read, one for each label that has one. " +
  "A node can carry a judgment at each label, each made by a run at that label from what that label reads. " +
  "Each entry has its `label`, the judgment itself, and `in_force`: whether it is in force for this reader, " +
  "which it is unless another version the reader may read was made at a label that reads its label. The " +
  "versions in force come first, and the first is the one served as the node's single judgment elsewhere " +
  "in this read; a reader who holds two labels that do not read each other may have two in force, and " +
  "nothing is merged. `made_beside` lists the versions it was made beside at the labels its own label " +
  "reads, with `replaced` true for one that has since been replaced; `versions_since` lists labels it " +
  "reads that have gained a version since; `made_against_earlier` is true when either has happened";

/** What a read's schema says of a node's or a source's `label`. */
export const LABEL_DESCRIPTION =
  "the label this carries: who may read it. `public` is read by every member of the deployment; any other " +
  "label by the people granted it (GET /labels/mine lists the labels the reader holds and who reads each)";
