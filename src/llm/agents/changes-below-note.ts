/**
 * What a Steward is told, at the start of a pass, about what the layer
 * below has changed on the node since this run's label last judged it
 * (docs/architecture.md, "Word from the layer below"; docs/mirror.md,
 * "Beside a deployment's own rows").
 *
 * The layer below a label is everything at the labels it reads, down to
 * the public graph, which a deployment holds through its mirror. A
 * judgment at a label is made of nodes that belong to those layers, and
 * their Stewards go on changing them.
 *
 * This is the part of "what has changed since the judgment"
 * (steward-changes-note.ts) that the judgment's own record of its inputs
 * cannot show. That record compares edges, sources and judgments as they
 * were with what is there now. A wording, an argument, a kind, a merge and
 * a withdrawal are overwritten in place, so what was replaced is written
 * as it happens (node_changes: by the mirror's applier for a node the
 * public graph holds, by the database for a node of the deployment's own),
 * and this reads it: for the node itself where it belongs to a layer
 * below, and for such nodes under it. One note, whichever layer changed:
 * a section for the public graph and one for each label below.
 *
 * Like the note it joins, it states what moved and nothing about what that
 * means. A node's judgment is of the node as worded (constitution §3), so
 * a version recorded before a rewording was made of other words; whether
 * the difference matters is the Steward's to judge. Nothing is opened when
 * the layer below changes a node in one of these ways: the note is read on
 * the next pass at this label, as a mirrored change always was.
 *
 * Empty where there is no layer below (one label and no mirror), for a
 * node this label has neither judged nor left standing (a first pass reads
 * the node as it stands), and where nothing of the kind has changed.
 */
import { rawQuery } from "../../db/client.js";
import type { NodeKind } from "../../schemas/kinds.js";
import { layered } from "../../services/layer-service.js";
import { nodeVersions } from "../../services/judgment-version-service.js";
import { currentLabel } from "../usage-context.js";

/** How many items each list names, as in the note this one joins. */
export const CHANGES_BELOW_NAMED_PER_LIST = 5;

const TEXT_MAX_CHARS = 300;
const cut = (text: unknown) => {
  const s = typeof text === "string" ? text : "";
  return s.length > TEXT_MAX_CHARS ? `${s.slice(0, TEXT_MAX_CHARS)}...` : s;
};

export interface ChangeBelow {
  claim_id: string;
  /** The layer that made the change: null for the public graph, as the mirror brought it, else the label it was made at. */
  at: string | null;
  /** True for the node the pass is on, false for a node under it. */
  own: boolean;
  change: string;
  detail: Record<string, unknown>;
  /** When the public graph cut the batch that carried the change, or when the change was made here. */
  cut_at: string;
  /** The node's wording now, for a node under the one the pass is on. */
  text: string | null;
}

function list(heading: string, lines: string[]): string[] {
  if (lines.length === 0) return [];
  const shown = lines.slice(0, CHANGES_BELOW_NAMED_PER_LIST);
  const count = lines.length > shown.length ? `${lines.length}, the first ${shown.length} listed` : `${lines.length}`;
  return [`${heading} (${count}):`, ...shown.map((l) => `- ${l}`)];
}

/**
 * The note itself, from the changes read. `since` is when this label's
 * version was recorded, or when it left the judgment it reads standing
 * (`leftStanding`).
 */
export function changesBelowNote(
  label: string,
  since: string,
  changes: readonly ChangeBelow[],
  opts: { leftStanding?: boolean } = {}
): string {
  if (changes.length === 0) return "";
  const sinceWhat = opts.leftStanding
    ? `since a run at \`${label}\` examined this node and left the judgment it read standing on ${since.slice(0, 10)}`
    : `since the version at \`${label}\` was recorded on ${since.slice(0, 10)}`;
  // The public graph first, then each label below, by name.
  const layers = [...new Set(changes.map((c) => c.at))].sort((a, b) => (a === null ? -1 : b === null ? 1 : a < b ? -1 : 1));
  const lines = layers.flatMap((at) =>
    layerLines(
      at === null
        ? `What the public graph has changed, as the mirror brought it, ${sinceWhat}:`
        : `What work at \`${at}\` has changed, ${sinceWhat}:`,
      at === null ? " by the public graph" : "",
      changes.filter((c) => c.at === at)
    )
  );
  if (lines.length === 0) return "";
  lines.push(
    (opts.leftStanding
      ? `The run at \`${label}\` examined the node, and the nodes under it, as they were worded then. `
      : `The version at \`${label}\` was made of the node, and of the nodes under it, as they were worded ` + `then. `) +
      `Each list names at most ${CHANGES_BELOW_NAMED_PER_LIST}, to keep this note short; ` +
      `get_claim gives each node as it now stands.`
  );
  return lines.join("\n");
}

/** One layer's section: its heading and its lists, or nothing where no list has a line. */
function layerLines(heading: string, withdrawnBy: string, changes: readonly ChangeBelow[]): string[] {
  const day = (c: ChangeBelow) => c.cut_at.slice(0, 10);
  const own = changes.filter((c) => c.own);
  const under = changes.filter((c) => !c.own);
  const of = (kind: string, from: readonly ChangeBelow[]) => from.filter((c) => c.change === kind);
  const argument = (c: ChangeBelow) =>
    `${String(c.detail.argument_id)} "${cut(c.detail.name)}"` +
    ({ argument_added: " was added", argument_rewritten: " was rewritten", argument_retired: " was retired", argument_removed: " was removed" }[
      c.change
    ] ?? "") +
    (c.change === "argument_retired" && c.detail.reason ? ` (${cut(c.detail.reason)})` : "") +
    `, ${day(c)}`;
  const node = (c: ChangeBelow) => `${c.claim_id}${c.text ? ` "${cut(c.text)}"` : ""}`;
  const kind = (c: ChangeBelow) => `It was a ${String(c.detail.was)} and is now a ${String(c.detail.now)}`;
  const lines = [
    ...list(
      "This node was reworded",
      of("reworded", own).map((c) => `${day(c)}. It read: "${cut(c.detail.was)}" It now reads: "${cut(c.detail.now)}"`)
    ),
    ...list(
      "This node's kind was corrected",
      of("kind_corrected", own).map((c) => `${day(c)}. ${kind(c)}.`)
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
      "Nodes under it whose kind was corrected",
      of("kind_corrected", under).map((c) => `${node(c)}, ${day(c)}. ${kind(c)}.`)
    ),
    ...list(
      "Nodes under it merged into another node",
      of("merged", under).map((c) => `${node(c)}, into ${String(c.detail.merged_into)}, ${day(c)}`)
    ),
    ...list(
      `Nodes under it withdrawn${withdrawnBy}`,
      of("withdrawn", under).map((c) => `${node(c)}, ${day(c)}`)
    ),
  ];
  return lines.length === 0 ? [] : [heading, ...lines];
}

/**
 * Read the record and write the note for one node. A failed read says
 * nothing and never costs the pass.
 *
 * What is read is what a layer below changed: a row the mirror's applier
 * wrote (it carries a batch), and a row at a label other than this run's.
 * A change made at this run's own label on a node of its own is this
 * Steward's own work and is not told back to it. The database returns only
 * rows at labels this run reads, and the query asks for the layers below
 * itself as well (services/layer-service.ts), so that the answer does not
 * depend on who asks.
 */
export async function loadChangesBelowNote(claimId: string, kind: NodeKind): Promise<string> {
  // One layer (one label and no mirror): there is nothing below to have changed.
  if (!layered()) return "";
  try {
    const label = currentLabel();
    const node = await nodeVersions(claimId, kind);
    const own = node?.versions.find((v) => v.label === label);
    const left = own ? undefined : node?.left_standing?.find((e) => e.label === label);
    const at = own?.assessed_at ?? left?.examined_at;
    if (!at) return "";
    const since = new Date(at as string | Date).toISOString();
    const changes = await rawQuery<ChangeBelow>(
      `SELECT ch.claim_id, (ch.claim_id = $1) AS own, ch.change, ch.detail,
              CASE WHEN ch.sequence IS NULL THEN ch.sensitivity_label END AS at,
              to_char(COALESCE(ch.cut_at, ch.applied_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS cut_at, c.text
         FROM node_changes ch
         LEFT JOIN claims c ON c.id = ch.claim_id
        WHERE ch.applied_at > $2
          AND (ch.sequence IS NOT NULL OR minerval_layer_below(ch.sensitivity_label, 'local', $3, 'local'))
          AND (ch.claim_id = $1
               OR ch.claim_id IN (SELECT r.child_claim_id FROM claim_relationships r WHERE r.parent_claim_id = $1))
        ORDER BY ch.applied_at, ch.id`,
      [claimId, since, label]
    );
    return changesBelowNote(label, since, changes, { leftStanding: !own });
  } catch (err) {
    console.warn(
      `[steward] what the layer below changed could not be read for ${claimId}:`,
      err instanceof Error ? err.message : err
    );
    return "";
  }
}
