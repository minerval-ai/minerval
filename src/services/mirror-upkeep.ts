/**
 * What follows a batch of the mirror for a deployment's own work
 * (docs/mirror.md, "Beside a deployment's own rows").
 *
 * A batch changes mirrored rows and nothing else. But a deployment's own
 * judgments and nodes rest on mirrored ones: a version at a private label
 * recorded beside the public assessment, a private node with a public
 * premise, a private node that says what a public node now says. So when a
 * batch is in, this looks at exactly the nodes the applier says it touched
 * (ApplyResult.nodes) and does four things, each of which opens work on the
 * ledger or raises a request and runs nothing. Whether any of it is worth
 * a run is for whoever funds it.
 *
 *  1. A node's public judgment moved. The versions at other labels made
 *     beside the earlier one are now made against an earlier state of what
 *     they read: their reassessment is opened at each version's own label
 *     (version-upkeep.ts, the same step the scheduler takes for every
 *     node, here for these nodes at once).
 *  2. The public graph merged a node into another. What this deployment
 *     recorded on the merged node stays there: nothing private is moved or
 *     deleted by a batch, because whether a judgment of one wording holds
 *     for another, with every stance reversed where the merge was with a
 *     denial, is a judgment. The Steward of the node it was merged into is
 *     told, at each label that had something of its own on the merged
 *     node, and a pass at that label is opened. So is the Steward of each
 *     node that had the merged node under it by an edge of this
 *     deployment's own.
 *  3. The public graph withdrew a node. It is kept here, no longer active,
 *     with what this deployment recorded on it. No work can be opened on a
 *     node that is not active, on this graph as on the public one, so the
 *     versions on it stand as they are and are shown as made beside a
 *     judgment that is gone. The Steward of each node that has it as a
 *     premise by an edge of this deployment's own is told, and a pass
 *     opened.
 *  4. A node arrived that a node of this deployment's own may already
 *     state. The Curator is asked, at that node's label, whether they are
 *     one (curation-service.ts, scanArrivedPublicNodes): if so, its
 *     ordinary merge folds the deployment's node into the public one, and
 *     what was recorded on it moves there and keeps its label.
 *
 * It sees every label to find what is affected, and puts each recipient's
 * piece together at the recipient's label, from rows read there
 * (tests/unit/db/system-clearance.test.ts lists it).
 */
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery } from "../db/client.js";
import { runAtLabel } from "../llm/usage-context.js";
import type { ApplyResult } from "./mirror-apply-service.js";
import { openReassessmentsForJudgmentsLeftStanding, openReassessmentsForVersionsMadeBesideEarlier } from "./version-upkeep.js";

const REASON =
  "After a batch of the mirror, finding what of this deployment's own rests on the nodes the batch touched means reading every label; each Steward's piece is then written at its own label, from rows read there.";

/** How many of each kind of thing a message names; the count beside them is whole. */
export const UPKEEP_NAMED_PER_LIST = 5;

export interface MirrorUpkeepResult {
  /** Reassessments opened for versions made beside a public judgment the batch replaced. */
  versions: number;
  /** Passes opened because the public graph merged a node. */
  merges: number;
  /** Passes opened because the public graph withdrew a node. */
  withdrawals: number;
  /** Requests to the Curator about a node of this deployment's own and one that arrived. */
  convergence: number;
  /** Contributions from the public graph given to a Steward here, and requests there put in a mandate's inbox here. */
  fromOutside: number;
}

const short = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max)}...` : text);
const named = (id: string, text: string | null | undefined) => (text ? `${id} "${short(text)}"` : id);

/** What a Steward is told of a list: at most a few by name, and how many there are. */
function listed(noun: string, items: string[]): string | null {
  if (items.length === 0) return null;
  const shown = items.slice(0, UPKEEP_NAMED_PER_LIST);
  const more = items.length > shown.length ? ` (${items.length}, the first ${shown.length} named)` : "";
  return `- ${noun}${more}: ${shown.join("; ")}`;
}

/** Send one message to a node's Steward at the label of the work in progress, once for its key. */
async function tellOnce(nodeId: string, key: string, body: string): Promise<boolean> {
  const already = await rawQuery(
    `SELECT 1 FROM node_messages
      WHERE node_id = $1 AND trigger = 'public_graph_changed' AND sender_ref = $2
        AND sensitivity_label = minerval_write_label()
      LIMIT 1`,
    [nodeId, key]
  );
  if (already.length > 0) return false;
  const [node] = await rawQuery<{ active: boolean }>(`SELECT state = 'active' AS active FROM claims WHERE id = $1`, [nodeId]);
  if (!node?.active) return false;
  const { enqueueSteward } = await import("./queue-service.js");
  await enqueueSteward({
    claimId: nodeId,
    trigger: "public_graph_changed",
    context: body,
    sender: { kind: "system", ref: key },
  });
  // Kept only where the pass could be opened: work at a mirrored node's own
  // label is not (mirrored-node-service.ts).
  const kept = await rawQuery(
    `SELECT 1 FROM node_messages
      WHERE node_id = $1 AND trigger = 'public_graph_changed' AND sender_ref = $2
        AND sensitivity_label = minerval_write_label()
      LIMIT 1`,
    [nodeId, key]
  );
  return kept.length > 0;
}

/** The labels at which this deployment recorded something of its own on a node, other than the node's own label. */
async function labelsWithWorkOn(nodeId: string): Promise<string[]> {
  const rows = await rawQuery<{ label: string }>(
    `SELECT DISTINCT x.label
       FROM (SELECT sensitivity_label AS label FROM assessments_versions WHERE claim_id = $1 AND origin = 'local'
             UNION ALL SELECT sensitivity_label FROM quantity_estimates_versions WHERE claim_id = $1 AND origin = 'local'
             UNION ALL SELECT sensitivity_label FROM question_assessments_versions WHERE claim_id = $1 AND origin = 'local'
             UNION ALL SELECT sensitivity_label FROM arguments WHERE claim_id = $1 AND origin = 'local' AND retired_at IS NULL
             UNION ALL SELECT sensitivity_label FROM claim_instances WHERE claim_id = $1 AND origin = 'local' AND detached_at IS NULL
             UNION ALL SELECT sensitivity_label FROM claim_relationships WHERE parent_claim_id = $1 AND origin = 'local') x
       JOIN claims c ON c.id = $1
      WHERE x.label <> c.sensitivity_label
      ORDER BY 1`,
    [nodeId]
  );
  return rows.map((r) => r.label);
}

/** The nodes that have `nodeId` under them by an edge of this deployment's own, with the edge's label. */
async function parentsByOwnEdges(nodeId: string): Promise<Array<{ parent: string; label: string }>> {
  return rawQuery<{ parent: string; label: string }>(
    `SELECT DISTINCT r.parent_claim_id AS parent, r.sensitivity_label AS label
       FROM claim_relationships r
       JOIN claims p ON p.id = r.parent_claim_id AND p.state = 'active'
      WHERE r.child_claim_id = $1 AND r.origin = 'local'
      ORDER BY 1, 2`,
    [nodeId]
  );
}

/** The active node a merged node now resolves to, following merges to their end; null where there is none. */
async function survivorOf(nodeId: string): Promise<string | null> {
  const [row] = await rawQuery<{ id: string; state: string }>(
    `WITH RECURSIVE chain(id, state, merged_into, depth) AS (
       SELECT id, state, merged_into, 0 FROM claims WHERE id = $1
       UNION ALL
       SELECT c.id, c.state, c.merged_into, chain.depth + 1
         FROM chain JOIN claims c ON c.id = chain.merged_into
        WHERE chain.state = 'merged' AND chain.depth < 20
     )
     SELECT id, state FROM chain ORDER BY depth DESC LIMIT 1`,
    [nodeId]
  );
  return row && row.state === "active" && row.id !== nodeId ? row.id : null;
}

/**
 * What the Steward of the node a merge ended in is told, at a label that
 * had something of its own on the merged node. Read at that label, so it
 * names only what that label reads. It states what happened and where
 * things are; what holds for the node as it is now worded is the
 * Steward's judgment.
 */
async function mergedIntoMessage(mergedId: string, label: string): Promise<string> {
  const [merged] = await rawQuery<{ text: string }>(`SELECT text FROM claims WHERE id = $1`, [mergedId]);
  // A proposition's verdict, a quantity's estimate or a question's answer: whichever the node has.
  const [version] = await rawQuery<{ status: string | null; summary: string | null; assessed_at: Date }>(
    `SELECT status, COALESCE(summary, reasoning_trace) AS summary, assessed_at FROM assessments_versions
      WHERE claim_id = $1 AND sensitivity_label = $2
     UNION ALL
     SELECT NULL, summary, assessed_at FROM quantity_estimates_versions
      WHERE claim_id = $1 AND sensitivity_label = $2
     UNION ALL
     SELECT standing, summary, assessed_at FROM question_assessments_versions
      WHERE claim_id = $1 AND sensitivity_label = $2
     LIMIT 1`,
    [mergedId, label]
  );
  const sources = await rawQuery<{ id: string; name: string | null }>(
    `SELECT DISTINCT s.id, COALESCE(NULLIF(s.title, ''), s.url) AS name
       FROM claim_instances i JOIN sources s ON s.id = i.source_id
      WHERE i.claim_id = $1 AND i.sensitivity_label = $2 AND i.detached_at IS NULL ORDER BY 1`,
    [mergedId, label]
  );
  const args = await rawQuery<{ id: string; name: string }>(
    `SELECT id, name FROM arguments WHERE claim_id = $1 AND sensitivity_label = $2 AND retired_at IS NULL ORDER BY 1`,
    [mergedId, label]
  );
  const under = await rawQuery<{ id: string; text: string }>(
    `SELECT c.id, c.text FROM claim_relationships r JOIN claims c ON c.id = r.child_claim_id
      WHERE r.parent_claim_id = $1 AND r.sensitivity_label = $2 ORDER BY 1`,
    [mergedId, label]
  );
  const lines = [
    version
      ? `- A version of its judgment at \`${label}\`, recorded ${new Date(version.assessed_at).toISOString().slice(0, 10)}` +
        (version.status ? `: ${version.status}` : "") +
        (version.summary ? `. Its summary: "${short(version.summary, 600)}"` : "")
      : null,
    listed("Sources attached at this label", sources.map((s) => named(s.id, s.name))),
    listed("Arguments recorded at this label", args.map((a) => named(a.id, a.name))),
    listed("Nodes put under it at this label", under.map((n) => named(n.id, n.text))),
  ].filter((l): l is string => l !== null);
  return (
    `The public graph has merged another node into this one: ${named(mergedId, merged?.text)}. The mirror ` +
    `brought the merge, and a read of the merged node by its id now gives this node.\n\n` +
    `Work at \`${label}\` was recorded on the merged node, and it is still there. A batch of the mirror ` +
    `moves and deletes nothing this deployment recorded, because whether it holds for this node as it ` +
    `is worded is a judgment, and a merge with a claim's denial reverses every stance. What was ` +
    `recorded there at \`${label}\`:\n` +
    `${lines.join("\n")}\n` +
    (lines.some((l) => l.includes("the first"))
      ? `Each list names at most ${UPKEEP_NAMED_PER_LIST}, to keep this message short.\n`
      : "") +
    `\nWhat of it bears on this node is yours to judge. What you carry over is recorded here, at ` +
    `\`${label}\`: a source with record_claim_instance, an argument, a subclaim, a version of this ` +
    `node's judgment. If you judge that nothing carries over, say so with log_stewardship_decision.`
  );
}

/** What the Steward of a node is told when a node under it, by an edge at this label, was merged or withdrawn. */
async function premiseMovedMessage(
  premiseId: string,
  label: string,
  what: { merged_into: string } | { withdrawn: true }
): Promise<string> {
  const [premise] = await rawQuery<{ text: string }>(`SELECT text FROM claims WHERE id = $1`, [premiseId]);
  if ("merged_into" in what) {
    const [into] = await rawQuery<{ text: string }>(`SELECT text FROM claims WHERE id = $1`, [what.merged_into]);
    return (
      `A node under this one has been merged by the public graph: ${named(premiseId, premise?.text)} is now ` +
      `part of ${named(what.merged_into, into?.text)}. The mirror brought the merge. The edge recorded at ` +
      `\`${label}\` from this node still names the merged node: a batch of the mirror changes nothing this ` +
      `deployment recorded. Whether this node rests on the node it was merged into, and in what way, is ` +
      `yours to judge: a merge with a claim's denial reverses how it bears. add_decomposition_edge records ` +
      `an edge to that node at \`${label}\`, and remove_subclaim_edge removes the one that names the ` +
      `merged node.`
    );
  }
  return (
    `A node under this one has been withdrawn by the public graph: ${named(premiseId, premise?.text)}. It is ` +
    `no longer an active node there. The mirror keeps it here, not active, because this deployment's own ` +
    `work points to it, and the public graph's judgment of it is gone. The edge recorded at \`${label}\` ` +
    `from this node still names it. Whether this node still rests on that proposition, and where it is ` +
    `now stated if anywhere, is yours to judge.`
  );
}

async function tellOfMerge(mergedId: string): Promise<number> {
  const found = await withSystemClearance(REASON, async () => ({
    survivor: await survivorOf(mergedId),
    labels: await labelsWithWorkOn(mergedId),
    parents: await parentsByOwnEdges(mergedId),
  }));
  let opened = 0;
  if (found.survivor) {
    const survivor = found.survivor;
    for (const label of found.labels) {
      const sent = await runAtLabel(label, `what ${label} recorded on merged node ${mergedId}`, async () =>
        tellOnce(survivor, `merged:${mergedId}`, await mergedIntoMessage(mergedId, label))
      );
      if (sent) opened++;
    }
    for (const { parent, label } of found.parents) {
      if (parent === survivor) continue;
      const sent = await runAtLabel(label, `the edge at ${label} from ${parent} to merged node ${mergedId}`, async () =>
        tellOnce(parent, `premise-merged:${mergedId}`, await premiseMovedMessage(mergedId, label, { merged_into: survivor }))
      );
      if (sent) opened++;
    }
  }
  return opened;
}

async function tellOfWithdrawal(withdrawnId: string): Promise<number> {
  const parents = await withSystemClearance(REASON, () => parentsByOwnEdges(withdrawnId));
  let opened = 0;
  for (const { parent, label } of parents) {
    const sent = await runAtLabel(label, `the edge at ${label} from ${parent} to withdrawn node ${withdrawnId}`, async () =>
      tellOnce(parent, `premise-withdrawn:${withdrawnId}`, await premiseMovedMessage(withdrawnId, label, { withdrawn: true }))
    );
    if (sent) opened++;
  }
  return opened;
}

/**
 * Do what follows the batches just applied. Each step is taken for the
 * nodes the batches name and no others, and a step that fails is logged and
 * leaves the rest to run: the scheduler's own sweep finds a version made
 * beside an earlier one in any case.
 */
export async function afterMirrorApplied(applied: readonly ApplyResult[]): Promise<MirrorUpkeepResult> {
  const result: MirrorUpkeepResult = { versions: 0, merges: 0, withdrawals: 0, convergence: 0, fromOutside: 0 };
  const done = applied.filter((a) => a.status === "applied");
  if (done.length === 0) return result;
  const union = <T>(pick: (a: ApplyResult) => T[]) => [...new Set(done.flatMap(pick))];
  const attempt = async (what: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch (err) {
      console.error(`[mirror-upkeep] ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const merged = new Map(done.flatMap((a) => a.nodes.merged.map((m) => [m.claim_id, m.merged_into] as const)));
  const withdrawn = union((a) => a.nodes.withdrawn);
  // A node's public judgment goes with it when it is merged or withdrawn,
  // and no pass can be opened on it; those are told below.
  const judged = union((a) => a.nodes.judged).filter((id) => !merged.has(id) && !withdrawn.includes(id));

  await attempt("opening reassessments for versions made beside a replaced public judgment", async () => {
    result.versions = await openReassessmentsForVersionsMadeBesideEarlier({ claimIds: judged });
  });
  await attempt("opening reassessments where a label left a replaced public judgment standing", async () => {
    result.versions += await openReassessmentsForJudgmentsLeftStanding({ claimIds: judged });
  });
  for (const mergedId of merged.keys()) {
    await attempt(`telling the Stewards concerned that ${mergedId} was merged`, async () => {
      result.merges += await tellOfMerge(mergedId);
    });
  }
  for (const withdrawnId of withdrawn) {
    await attempt(`telling the Stewards concerned that ${withdrawnId} was withdrawn`, async () => {
      result.withdrawals += await tellOfWithdrawal(withdrawnId);
    });
  }
  await attempt("asking the Curator about nodes that arrived", async () => {
    const { scanArrivedPublicNodes } = await import("./curation-service.js");
    result.convergence = await scanArrivedPublicNodes(union((a) => a.nodes.arrived));
  });
  // What the public graph said back through a page published from here, and requests there addressed to a
  // mandate published from here, arrive with the batch: taken in now, not at the scheduler's next look.
  await attempt("taking in what the public graph said back", async () => {
    const { takeInFromOutside } = await import("./outward-follow.js");
    const out = await takeInFromOutside();
    const given = out.given_to_stewards as { delivered?: number } | undefined;
    result.fromOutside = (given?.delivered ?? 0) + (Number(out.asked_of_published_mandates) || 0);
  });
  return result;
}
