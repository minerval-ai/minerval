/**
 * What a Steward is told, at the start of a pass, about what the public
 * graph has changed since this run's label last judged the node, on a
 * deployment that mirrors it (docs/mirror.md, "Beside a deployment's own
 * rows").
 *
 * It is the part of "what has changed since the judgment"
 * (steward-changes-note.ts) that the judgment's own record of its inputs
 * cannot show. That record compares edges, sources and judgments as they
 * were with what is there now. A wording, an argument, a merge and a
 * withdrawal are overwritten in place by the mirror, so the applier writes
 * what it replaced (mirror_node_changes), and this reads it: for the node
 * itself where it is mirrored, and for the mirrored nodes under it.
 *
 * Like the note it joins, it states what moved and nothing about what that
 * means. A node's judgment is of the node as worded (constitution §3), so
 * a version recorded before a rewording was made of other words; whether
 * the difference matters is the Steward's to judge.
 *
 * Empty on a deployment that does not mirror, for a node this label has
 * not judged (a first pass reads the node as it stands), and where nothing
 * of the kind has changed.
 */
import { rawQuery } from "../../db/client.js";
import type { NodeKind } from "../../schemas/kinds.js";
import { holdsMirror } from "../../services/mirrored-node-service.js";
import { currentLabel } from "../usage-context.js";

/** How many items each list names, as in the note this one joins. */
export const MIRROR_CHANGES_NAMED_PER_LIST = 5;

const TEXT_MAX_CHARS = 300;
const cut = (text: unknown) => {
  const s = typeof text === "string" ? text : "";
  return s.length > TEXT_MAX_CHARS ? `${s.slice(0, TEXT_MAX_CHARS)}...` : s;
};

export interface MirrorChange {
  claim_id: string;
  /** True for the node the pass is on, false for a node under it. */
  own: boolean;
  change: string;
  detail: Record<string, unknown>;
  /** When the public graph cut the batch that carried the change. */
  cut_at: string;
  /** The node's wording now, for a node under the one the pass is on. */
  text: string | null;
}

function list(heading: string, lines: string[]): string[] {
  if (lines.length === 0) return [];
  const shown = lines.slice(0, MIRROR_CHANGES_NAMED_PER_LIST);
  const count = lines.length > shown.length ? `${lines.length}, the first ${shown.length} listed` : `${lines.length}`;
  return [`${heading} (${count}):`, ...shown.map((l) => `- ${l}`)];
}

/** The note itself, from the changes read. `since` is when this label's version was recorded. */
export function mirrorChangesNote(label: string, since: string, changes: readonly MirrorChange[]): string {
  if (changes.length === 0) return "";
  const day = (c: MirrorChange) => c.cut_at.slice(0, 10);
  const own = changes.filter((c) => c.own);
  const under = changes.filter((c) => !c.own);
  const of = (kind: string, from: readonly MirrorChange[]) => from.filter((c) => c.change === kind);
  const argument = (c: MirrorChange) =>
    `${String(c.detail.argument_id)} "${cut(c.detail.name)}"` +
    ({ argument_added: " was added", argument_rewritten: " was rewritten", argument_retired: " was retired", argument_removed: " was removed" }[
      c.change
    ] ?? "") +
    (c.change === "argument_retired" && c.detail.reason ? ` (${cut(c.detail.reason)})` : "") +
    `, ${day(c)}`;
  const node = (c: MirrorChange) => `${c.claim_id}${c.text ? ` "${cut(c.text)}"` : ""}`;
  const lines = [
    `What the public graph has changed, as the mirror brought it, since the version at \`${label}\` was ` +
      `recorded on ${since.slice(0, 10)}:`,
    ...list(
      "This node was reworded",
      of("reworded", own).map((c) => `${day(c)}. It read: "${cut(c.detail.was)}" It now reads: "${cut(c.detail.now)}"`)
    ),
    ...list(
      "Arguments on this node",
      own.filter((c) => c.change.startsWith("argument_")).map(argument)
    ),
    ...list(
      "Nodes under it reworded",
      of("reworded", under).map((c) => `${node(c)}, ${day(c)}. It read: "${cut(c.detail.was)}"`)
    ),
    ...list(
      "Nodes under it merged into another node",
      of("merged", under).map((c) => `${node(c)}, into ${String(c.detail.merged_into)}, ${day(c)}`)
    ),
    ...list(
      "Nodes under it withdrawn by the public graph",
      of("withdrawn", under).map((c) => `${node(c)}, ${day(c)}`)
    ),
  ];
  if (lines.length === 1) return "";
  lines.push(
    `The version at \`${label}\` was made of the node, and of the nodes under it, as they were worded ` +
      `then. Each list names at most ${MIRROR_CHANGES_NAMED_PER_LIST}, to keep this note short; ` +
      `get_claim gives each node as it now stands.`
  );
  return lines.join("\n");
}

const VERSIONS: Record<string, string> = {
  claim: "assessments_versions",
  quantity: "quantity_estimates_versions",
  question: "question_assessments_versions",
};

/** Read the record and write the note for one node. A failed read says nothing and never costs the pass. */
export async function loadMirrorChangesNote(claimId: string, kind: NodeKind): Promise<string> {
  if (!holdsMirror()) return "";
  try {
    const label = currentLabel();
    const [own] = await rawQuery<{ assessed_at: Date }>(
      `SELECT assessed_at FROM ${VERSIONS[kind] ?? VERSIONS.claim} WHERE claim_id = $1 AND sensitivity_label = $2`,
      [claimId, label]
    );
    if (!own) return "";
    const since = new Date(own.assessed_at).toISOString();
    const changes = await rawQuery<MirrorChange>(
      `SELECT ch.claim_id, (ch.claim_id = $1) AS own, ch.change, ch.detail,
              to_char(ch.cut_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS cut_at, c.text
         FROM mirror_node_changes ch
         LEFT JOIN claims c ON c.id = ch.claim_id
        WHERE ch.applied_at > $2
          AND (ch.claim_id = $1
               OR ch.claim_id IN (SELECT r.child_claim_id FROM claim_relationships r WHERE r.parent_claim_id = $1))
        ORDER BY ch.applied_at, ch.id`,
      [claimId, since]
    );
    return mirrorChangesNote(label, since, changes);
  } catch (err) {
    console.warn(
      `[steward] what the public graph changed could not be read for ${claimId}:`,
      err instanceof Error ? err.message : err
    );
    return "";
  }
}
