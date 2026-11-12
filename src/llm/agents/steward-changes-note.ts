/**
 * What a Steward is told, at the start of a pass on a node it has already
 * judged, about what has changed under that judgment since (#566).
 *
 * The record exists (services/judgment-inputs-service.ts), but a Steward
 * that had to ask for it would mostly not ask, and would reassess without
 * knowing which of its premises had been judged again or which source had
 * been retracted. So the pass opens with it. It is a statement of fact and
 * nothing more: which premises and sources moved, not what that means or
 * what to do about it, which is the Steward's judgment. A premise judged
 * again to the same verdict is listed like any other, and the note says so.
 *
 * Each list names a few items and gives the full count; the note states the
 * cap, why it is there and the read that has the rest, so nothing is cut
 * without the Steward being told.
 */
import { rawQuery } from "../../db/client.js";
import { getJudgmentInputs, type JudgmentInputsView } from "../../services/judgment-inputs-service.js";
import type { NodeKind } from "../../schemas/kinds.js";
import { nodeVersions, type NodeVersion } from "../../services/judgment-version-service.js";
import { currentLabel } from "../usage-context.js";

/**
 * How many items each list names. A handful is enough to see what kind of
 * change it is; a node with dozens of moved premises is read in full with
 * get_claim, and the note says that.
 */
export const CHANGES_NAMED_PER_LIST = 5;

/** A claim's text or a source's title is cut here in the note, with a visible mark. */
const NAME_MAX_CHARS = 160;

/** The words to show beside an id: node texts and source titles, by id. */
export interface ChangeNames {
  nodes: ReadonlyMap<string, string>;
  sources: ReadonlyMap<string, string>;
}

function named(id: string, name: string | undefined): string {
  if (!name) return id;
  const text = name.length > NAME_MAX_CHARS ? `${name.slice(0, NAME_MAX_CHARS)}...` : name;
  return `${id} "${text}"`;
}

/** One list: its heading with the full count, and at most the cap of its lines. */
function list(heading: string, lines: string[]): string[] {
  if (lines.length === 0) return [];
  const shown = lines.slice(0, CHANGES_NAMED_PER_LIST);
  const count =
    lines.length > shown.length ? `${lines.length}, the first ${shown.length} listed` : `${lines.length}`;
  return [`${heading} (${count}):`, ...shown.map((l) => `- ${l}`)];
}

/** The ids the note will name, so their texts can be read in one query each. */
export function namedInChangesNote(view: JudgmentInputsView): { nodeIds: string[]; sourceIds: string[] } {
  const cap = <T>(xs: T[]) => xs.slice(0, CHANGES_NAMED_PER_LIST);
  return {
    nodeIds: [
      ...cap(view.premises.filter((p) => p.state === "rejudged")),
      ...cap(view.premises_added),
      ...cap(view.premises.filter((p) => p.state === "removed")),
    ].map((p) => p.node_id),
    sourceIds: [
      ...cap(view.sources.added),
      ...cap(view.sources.removed),
      ...cap(view.sources.events_since).map((e) => e.source_id),
    ],
  };
}

/**
 * The note itself. Empty when the node has no judgment in force: there is
 * nothing for anything to have changed under.
 */
export function changesSinceJudgedNote(
  kind: NodeKind,
  view: JudgmentInputsView | null,
  names: ChangeNames
): string {
  if (!view?.judgment) return "";
  const noun = kind === "claim" ? "claim" : kind;
  const on = view.judgment.assessed_at.slice(0, 10);
  if (!view.recorded) {
    return (
      `The current assessment (${on}) was recorded before the graph kept a record of what an ` +
      `assessment was made against, so there is no record of what has changed under it since.`
    );
  }
  if (!view.changed) {
    return (
      `Since the current assessment was recorded on ${on}, nothing it was made against in the ` +
      `graph has changed: the nodes under this ${noun} have the judgments they had then, none ` +
      `has been added or removed, its sources are the same, and no correction, retraction or ` +
      `other notice has been recorded on them.`
    );
  }

  // A question's children are answers, subquestions and presuppositions.
  const under = kind === "question" ? "Nodes under it" : "Subclaims";
  const premise = (p: { node_id: string; relation: string }, aside = "") =>
    `${named(p.node_id, names.nodes.get(p.node_id))} (${p.relation}${aside})`;
  const source = (id: string) => named(id, names.sources.get(id));

  const rejudged = view.premises.filter((p) => p.state === "rejudged");
  const lines = [
    `What has changed in the graph under the current assessment since it was recorded on ${on}:`,
    ...list(
      `${under} judged again`,
      rejudged.map((p) =>
        premise(
          p,
          p.judged_against === null
            ? ", had no judgment then"
            : p.in_force_now === null
              ? ", has no judgment now"
              : ""
        )
      )
    ),
    ...list(`${under} added`, view.premises_added.map((p) => premise(p))),
    ...list(
      `${under} removed`,
      view.premises.filter((p) => p.state === "removed").map((p) => premise(p))
    ),
    ...list("Sources added", view.sources.added.map(source)),
    ...list("Sources removed", view.sources.removed.map(source)),
    ...list(
      "Notices recorded on its sources",
      view.sources.events_since.map(
        (e) => `${e.kind.replace(/_/g, " ")}, ${e.detected_at.slice(0, 10)}: ${source(e.source_id)}`
      )
    ),
    ...(rejudged.length > 0
      ? [
          `"Judged again" means the node has a newer judgment than the one this assessment was ` +
            `made against, whether or not its verdict moved.`,
        ]
      : []),
    `Each list names at most ${CHANGES_NAMED_PER_LIST}, to keep this note short; get_claim with ` +
      `include ["judgment_inputs"] gives all of them by id.`,
  ];
  return lines.join("\n");
}

/**
 * Read the record and write the note for one node. A failed read says
 * nothing, which the Steward cannot mistake for "nothing changed"; it never
 * costs the pass.
 */
export async function loadChangesSinceJudgedNote(claimId: string, kind: NodeKind): Promise<string> {
  try {
    const view = await getJudgmentInputs(claimId);
    if (!view?.judgment) return loadVersionsNote(claimId, kind);
    const { nodeIds, sourceIds } = namedInChangesNote(view);
    const [nodes, sources] = await Promise.all([
      nodeIds.length > 0
        ? rawQuery<{ id: string; name: string | null }>(
            `SELECT id, text AS name FROM claims WHERE id = ANY($1::uuid[])`,
            [nodeIds]
          )
        : [],
      sourceIds.length > 0
        ? rawQuery<{ id: string; name: string | null }>(
            `SELECT id, COALESCE(NULLIF(title, ''), url) AS name FROM sources WHERE id = ANY($1::uuid[])`,
            [sourceIds]
          )
        : [],
    ]);
    const byId = (rows: Array<{ id: string; name: string | null }>) =>
      new Map(rows.flatMap((r) => (r.name ? [[r.id, r.name] as const] : [])));
    const note = changesSinceJudgedNote(kind, view, { nodes: byId(nodes), sources: byId(sources) });
    const versions = await loadVersionsNote(claimId, kind);
    return versions ? `${note}\n\n${versions}` : note;
  } catch (err) {
    console.warn(
      `[steward] changes since the judgment could not be read for ${claimId}:`,
      err instanceof Error ? err.message : err
    );
    return "";
  }
}

/**
 * What a Steward is told about the versions of its node's judgment, on a
 * deployment where a node can carry one at each label
 * (services/judgment-version-service.ts): which labels have one, which is
 * its own, and whether its own was made beside one that has since been
 * replaced. A statement of the record, like the note above. Empty on the
 * public graph, and for a node that carries this run's label and no version
 * at any other.
 */
export function versionsNote(
  runLabel: string,
  node: { label: string; versions: ReadonlyArray<Pick<NodeVersion, "label" | "in_force" | "made_beside" | "versions_since"> & { assessed_at?: unknown }> }
): string {
  const others = node.versions.filter((v) => v.label !== runLabel);
  if (node.label === runLabel && others.length === 0) return "";
  const own = node.versions.find((v) => v.label === runLabel);
  const tick = (l: string) => `\`${l}\``;
  const on = (v: { assessed_at?: unknown }) => (typeof v.assessed_at === "string" ? `, recorded ${v.assessed_at.slice(0, 10)}` : "");
  const lines: string[] = [
    `This node carries the label ${tick(node.label)}, and this run works at ${tick(runLabel)}. The versions of its ` +
      `judgment that this run reads:`,
  ];
  if (own) {
    const replaced = own.made_beside.filter((b) => b.replaced).map((b) => tick(b.label));
    const since = own.versions_since.map(tick);
    const moved = [
      ...(replaced.length > 0 ? [`the version${replaced.length === 1 ? "" : "s"} at ${replaced.join(", ")} that it was made beside ${replaced.length === 1 ? "has" : "have"} since been replaced`] : []),
      ...(since.length > 0 ? [`${since.join(", ")} ${since.length === 1 ? "has" : "have"} gained a version since`] : []),
    ];
    lines.push(
      `- ${tick(own.label)}, this run's own${on(own)}.` +
        (moved.length > 0 ? ` It was made against an earlier state of what it reads: ${moved.join("; ")}.` : "")
    );
  } else {
    lines.push(`- ${tick(runLabel)}, this run's own: none recorded.`);
  }
  for (const v of others) {
    lines.push(`- ${tick(v.label)}${on(v)}${!own && v.in_force ? ". It is the version in force for this run" : ""}.`);
  }
  lines.push(`get_claim returns each of them in full under \`versions\`.`);
  return lines.join("\n");
}

async function loadVersionsNote(claimId: string, kind: NodeKind): Promise<string> {
  try {
    const node = await nodeVersions(claimId, kind);
    return node ? versionsNote(currentLabel(), node) : "";
  } catch (err) {
    console.warn(
      `[steward] the versions of ${claimId} could not be read:`,
      err instanceof Error ? err.message : err
    );
    return "";
  }
}
