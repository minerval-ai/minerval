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

/** Whether this process knows `public` is the deployment's only label, without asking. */
export function oneLabelOnly(): boolean {
  return enforcementLastKnown() === false;
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
