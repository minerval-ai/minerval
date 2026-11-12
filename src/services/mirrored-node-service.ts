/**
 * The public graph's nodes, in a deployment that mirrors it (docs/mirror.md,
 * "Beside a deployment's own rows").
 *
 * A mirrored row is the public graph's. The database refuses any change to
 * one from anything but the mirror's applier (mirror_row_guard), and on a
 * deployment with more than one label it also refuses a change to a row at
 * another label than the work's own (minerval_own_label_guard). This module
 * is the application's side of both for mirrored nodes: what is asked
 * before a write, the one thing an agent is told whichever guard would have
 * fired, and what a person is told who asks for work that is not done here.
 *
 * Three rules, each with its reason:
 *
 *  - Nothing here changes a mirrored row. The next batch would overwrite
 *    the change, and until then readers would take it for the public
 *    graph's own.
 *  - The public judgment of a mirrored node is the mirrored row. Nothing
 *    local records a judgment at the node's own label, and no work on the
 *    node at that label is opened, funded or run: a second public
 *    assessment beside the public graph's would be this deployment's, on
 *    the same public evidence, shown as the public graph's. A fresh public
 *    assessment is funded on the public graph.
 *  - What a run adds to a mirrored node is a row of its own, at its own
 *    label: an argument, an edge, a source, and at a label other than the
 *    node's a version of the judgment where material at that label bears.
 *
 * Nothing here is asked on a deployment that does not mirror (holdsMirror):
 * no query is made and no statement changes, so the public graph runs what
 * it always ran.
 */
import { rawQuery } from "../db/client.js";
import { currentLabel } from "../llm/usage-context.js";
import { mirrorRoles } from "./mirror-roles.js";

/** The SQLSTATE the guard on mirrored rows raises (the mirror's migration). */
export const MIRRORED_ROW_REFUSED = "MIR01";

let appliedHere = false;

/**
 * Whether this deployment keeps a mirror of the public graph: it is
 * configured with a feed, or this process has itself applied a batch (a
 * script, a test). Nothing is asked of the database.
 */
export function holdsMirror(): boolean {
  return appliedHere || mirrorRoles().applier;
}

/** Called by the applier when a batch is in, so the process that applied it knows it holds a mirror. */
export function noteMirrorApplied(): void {
  appliedHere = true;
  asOfRead = null;
}

/** Test seam: forget that this process applied a batch. */
export function resetMirrorHeldForTests(): void {
  appliedHere = false;
  asOfRead = null;
}

/** How long the time the mirror stands at is kept before it is read again. */
const AS_OF_TTL_MS = 30_000;
let asOfRead: { at: number; value: string | null } | null = null;

/**
 * When the public graph cut the newest batch applied here: what this
 * deployment reads of the public graph is as of then. Null where no mirror
 * is held or no batch has been applied. Read from the applier's own
 * bookkeeping, which carries no label, and kept for half a minute.
 */
export async function publicGraphAsOf(): Promise<string | null> {
  if (!holdsMirror()) return null;
  if (asOfRead && Date.now() - asOfRead.at < AS_OF_TTL_MS) return asOfRead.value;
  const [head] = await rawQuery<{ cut_at: string }>(
    `SELECT to_char(cut_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cut_at
       FROM mirror_applied_batches ORDER BY sequence DESC LIMIT 1`
  );
  asOfRead = { at: Date.now(), value: head?.cut_at ?? null };
  return asOfRead.value;
}

/** SQL condition: the claims row aliased `alias` is not mirrored. Empty where no mirror is held. */
export function notMirroredSql(alias?: string): string {
  return holdsMirror() ? ` AND ${alias ? `${alias}.` : ""}origin <> 'mirror'` : "";
}

const PLAIN_LABEL_RE = /^[a-z][a-z0-9_-]{0,62}$/;

/**
 * SQL condition: work at the label of the work in progress on the claims
 * row aliased `alias` is this deployment's to do, which it is not on a
 * mirrored node at the node's own label. Empty where no mirror is held.
 * The label is written as a literal: it is a row in `labels`, whose names
 * are plain words.
 */
export function ownWorkSql(alias: string): string {
  if (!holdsMirror()) return "";
  const label = currentLabel();
  if (!PLAIN_LABEL_RE.test(label)) throw new Error(`"${label}" is not a label's name`);
  return ` AND NOT (${alias}.origin = 'mirror' AND ${alias}.sensitivity_label = '${label}')`;
}

/**
 * The node is the public graph's: its label where it is mirrored, else
 * null. A node that does not exist is not mirrored.
 */
export async function mirroredNode(claimId: string): Promise<{ label: string } | null> {
  if (!holdsMirror()) return null;
  const [row] = await rawQuery<{ origin: string; label: string }>(
    `SELECT origin, sensitivity_label AS label FROM claims WHERE id = $1`,
    [claimId]
  );
  return row?.origin === "mirror" ? { label: row.label } : null;
}

/**
 * The node is the public graph's, and the work in progress is at the
 * node's own label: the label at which its judgment and its Steward's work
 * are the public graph's and not this deployment's.
 */
export async function publicGraphJudges(claimId: string): Promise<boolean> {
  const node = await mirroredNode(claimId);
  return node !== null && node.label === currentLabel();
}

/** The same for an argument, by the node it is on. */
export async function publicGraphEvaluates(argumentId: string): Promise<boolean> {
  if (!holdsMirror()) return false;
  const [row] = await rawQuery<{ origin: string; label: string }>(
    `SELECT origin, sensitivity_label AS label FROM arguments WHERE id = $1`,
    [argumentId]
  );
  return row?.origin === "mirror" && row.label === currentLabel();
}

/** What a read of a mirrored node says of it: that it is the public graph's, and as of when. */
export interface MirroredFacts {
  /** When the public graph cut the newest batch applied here: the node is shown as of then. */
  public_graph_as_of: string | null;
  /** The node's page on the public graph, where its feed says where its pages are. */
  public_page_url: string | null;
  /**
   * Set when the public graph no longer holds the node as an active one,
   * with when the batch that said so was cut: it is kept here because this
   * deployment's own work points to it.
   */
  withdrawn_as_of?: string;
  /** Set when the public graph merged the node into another, with when and into which. */
  merged_as_of?: string;
  merged_into?: string;
}

/**
 * What a read of the node adds where the node is mirrored: null for a node
 * of this deployment's own, and on a deployment that does not mirror, where
 * nothing is asked.
 */
export async function mirroredFacts(claimId: string): Promise<MirroredFacts | null> {
  if (!holdsMirror()) return null;
  const [node] = await rawQuery<{ origin: string; state: string; merged_into: string | null }>(
    `SELECT origin, state, merged_into FROM claims WHERE id = $1`,
    [claimId]
  );
  if (node?.origin !== "mirror") return null;
  const facts: MirroredFacts = {
    public_graph_as_of: await publicGraphAsOf(),
    public_page_url: await publicGraphPageUrl(claimId),
  };
  if (node.state !== "active") {
    const [change] = await rawQuery<{ change: string; cut_at: string }>(
      `SELECT change, to_char(cut_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cut_at
         FROM mirror_node_changes
        WHERE claim_id = $1 AND change IN ('merged', 'withdrawn')
        ORDER BY applied_at DESC, id DESC LIMIT 1`,
      [claimId]
    );
    if (node.state === "merged" && node.merged_into) {
      facts.merged_into = node.merged_into;
      if (change?.change === "merged") facts.merged_as_of = change.cut_at;
    } else if (change?.change === "withdrawn") {
      facts.withdrawn_as_of = change.cut_at;
    }
  }
  return facts;
}

/**
 * What a read of a source adds on a deployment that mirrors: for a mirrored
 * source, that it is the public graph's and as of when; for a source of the
 * deployment's own whose address the public graph also holds, the public
 * graph's row for it, so that the two are read as one document recorded
 * twice. Null otherwise, and where no mirror is held.
 */
export async function sourceMirrorFacts(
  sourceId: string
): Promise<{ mirrored: { public_graph_as_of: string | null } } | { public_graph_source_id: string } | null> {
  if (!holdsMirror()) return null;
  const [row] = await rawQuery<{ origin: string; twin: string | null }>(
    `SELECT s.origin,
            (SELECT m.id FROM sources m WHERE m.url = s.url AND m.origin = 'mirror' AND m.id <> s.id LIMIT 1) AS twin
       FROM sources s WHERE s.id = $1`,
    [sourceId]
  );
  if (!row) return null;
  if (row.origin === "mirror") return { mirrored: { public_graph_as_of: await publicGraphAsOf() } };
  return row.twin ? { public_graph_source_id: row.twin } : null;
}

/** What a read's schema says of `mirrored`, where a deployment serves it. */
export const MIRRORED_DESCRIPTION =
  "present when the node belongs to the public graph and is read here through the mirror, a copy that follows " +
  "it. `public_graph_as_of` is when the public graph cut the newest batch this deployment has applied: the " +
  "node, what is recorded on it there and its public assessment are shown as of then, not as of now. " +
  "`public_page_url` is the node's page on the public graph, where its feed says where its pages are. " +
  "`withdrawn_as_of` is set when the public graph no longer holds the node as an active one, and " +
  "`merged_as_of` with `merged_into` when it merged the node into another; either way the node is kept here " +
  "because this deployment's own work points to it. Nothing in this deployment changes a mirrored node. " +
  "What the deployment concludes from its own material is recorded beside the public assessment, as a " +
  "version at another label";

/** The schema of `mirrored`, for a route that serves a node. */
export const MIRRORED_SCHEMA = {
  type: "object",
  description: MIRRORED_DESCRIPTION,
  properties: {
    public_graph_as_of: { type: "string", nullable: true },
    public_page_url: { type: "string", nullable: true },
    withdrawn_as_of: { type: "string" },
    merged_as_of: { type: "string" },
    merged_into: { type: "string" },
  },
} as const;

/** Where the public graph's own page for a node is, when its feed has said where its pages are. */
export async function publicGraphPageUrl(claimId: string): Promise<string | null> {
  const [head] = await rawQuery<{ base: string | null }>(
    `SELECT publisher_web_base_url AS base FROM mirror_applied_batches ORDER BY sequence DESC LIMIT 1`
  );
  return head?.base ? `${head.base.replace(/\/+$/, "")}/claims/${claimId}` : null;
}

/**
 * What an agent is told when a tool would change something the public
 * graph holds, whichever guard would have refused it. `what` names the
 * thing, lower case ("the node's wording and type"); left out, "this".
 * It states what is refused, why, and the two things the run can do
 * instead. Whether either is worth doing is the agent's judgment.
 */
export function mirroredRowMessage(what?: string): string {
  const label = currentLabel();
  return (
    `Not changed. ${what ? `What this would change (${what})` : "What this would change"} belongs to the ` +
    `public graph and is read here through the mirror, a copy that follows it. Nothing in this deployment ` +
    `changes a mirrored row: the next batch from the public graph would overwrite the change, and until ` +
    `then readers would take it for the public graph's own. What this run has to add is recorded as a row ` +
    `of its own at \`${label}\`, beside what is there: an argument, a subclaim, a source. If the public ` +
    `graph has this wrong, record that as a request (file_request). The request stays in this deployment, ` +
    `and raising it on the public graph is for the people who direct this deployment, since doing so shows ` +
    `what it is working on.`
  );
}

/**
 * The database's own refusal of a write to a mirrored row, as the agent is
 * told it; null for any other error. A tool that did not ask first is
 * answered with the same words as one that did.
 */
export function mirroredRefusalForAgent(err: unknown): string | null {
  return isMirroredRowRefusal(err) ? mirroredRowMessage() : null;
}

/**
 * Whether an error is the guard's refusal. A query builder wraps the
 * database's error in one of its own, with the original as its cause.
 */
function isMirroredRowRefusal(err: unknown): boolean {
  for (let e = err as { code?: string; cause?: unknown } | null, depth = 0; e && depth < 4; e = e.cause as typeof e, depth++) {
    if (e.code === MIRRORED_ROW_REFUSED) return true;
  }
  return false;
}

/** The same refusal, as a person whose request made the write is told it; null for any other error. */
export function mirroredRefusalForPerson(err: unknown): string | null {
  if (!isMirroredRowRefusal(err)) return null;
  return (
    "This was not changed: it belongs to the public graph and is read here through the mirror, a copy that " +
    "follows it. Nothing in this deployment changes a mirrored row, because the next batch from the public " +
    "graph would overwrite the change. A change to it is proposed on the public graph, as any contributor " +
    "proposes one."
  );
}

/**
 * What an agent is told when it would record a judgment of a mirrored node
 * at the node's own label. `what` is the judgment, capitalized ("An
 * assessment of it").
 */
export function publicJudgmentMessage(what: string): string {
  const label = currentLabel();
  return (
    `Not recorded. This node belongs to the public graph and is read here through the mirror. ${what} ` +
    `at \`${label}\` is the public graph's own, which arrives with the mirror, and nothing in this ` +
    `deployment records one in its place: it would be shown to readers as the public graph's judgment ` +
    `without being it. If the public graph's judgment is wrong on evidence the public graph could see, ` +
    `record that as a request (file_request). A run at a label that reads \`${label}\` records its own ` +
    `version beside it where material at its label bears on the node.`
  );
}

/**
 * Work on a mirrored node at the node's own label is not done here. The
 * message is for the person who asked: a member ordering or funding an
 * assessment, or a caller with a key.
 */
export class PublicGraphNodeError extends Error {
  readonly statusCode = 409;
  readonly code = "PUBLIC_GRAPH_NODE";
  constructor(message: string) {
    super(message);
    this.name = "PublicGraphNodeError";
  }
}

/**
 * What an agent is told when it would open or pay for a pass on a mirrored
 * node at the node's own label (a commission, a note that asks for a pass).
 */
export function publicWorkMessageForAgent(): string {
  const label = currentLabel();
  return (
    `Not done. This node belongs to the public graph and is read here through the mirror. Its assessment ` +
    `at \`${label}\` is the public graph's own, so no pass on it at \`${label}\` is opened, paid for or run in ` +
    `this deployment, and nothing was charged. If its public assessment looks wrong or out of date, record ` +
    `that as a request (file_request): asking the public graph for a fresh one shows what this deployment ` +
    `is working on, so it is for the people who direct it to decide.`
  );
}

/** What a person is told. `pageUrl` is the node's page on the public graph, where known. */
export function publicWorkNotDoneHereMessage(label: string, pageUrl: string | null): string {
  return (
    `This node belongs to the public graph and is read here through the mirror, so its assessment at ` +
    `"${label}" is the public graph's own and no work is done on it here at "${label}". A fresh public ` +
    `assessment is ordered or funded on the public graph${pageUrl ? ` (${pageUrl})` : ""}, which shows the ` +
    `public graph that someone asked. To have the node assessed on this deployment's own material, name a ` +
    `label that reads "${label}" in "label": that work records a version of its own beside the public ` +
    `one, and stays here.`
  );
}

/**
 * Refuse work on a mirrored node at the node's own label: throws
 * PublicGraphNodeError where the work in progress is that, and returns
 * otherwise. Called where a person starts work (an order, funding, a
 * decomposition).
 */
export async function refusePublicWorkOnMirroredNode(claimId: string): Promise<void> {
  if (!(await publicGraphJudges(claimId))) return;
  throw new PublicGraphNodeError(publicWorkNotDoneHereMessage(currentLabel(), await publicGraphPageUrl(claimId)));
}

/**
 * The end of a read of `sources` by address that wants one row. A document
 * this deployment recorded and the public graph's row for the same address
 * are two rows (db/schema.ts, the origin column). The one taken is the
 * deployment's own where it is at the label of the work in progress (what
 * that label wrote: its fetched text, its readings), else the public
 * graph's (the public facts), else a row of the deployment's own at another
 * label the work reads. Empty on a deployment that does not mirror, where
 * an address has one row and the statement is what it always was. `alias`
 * is the table's alias in the statement, where it has one.
 */
export function oneSourceForAddressSql(alias?: string): string {
  if (!holdsMirror()) return "";
  const c = (name: string) => (alias ? `${alias}.${name}` : name);
  return (
    ` ORDER BY (${c("origin")} = 'local' AND ${c("sensitivity_label")} = minerval_write_label()) DESC, ` +
    `(${c("origin")} = 'mirror') DESC, ${c("retrieved_at")}, ${c("id")} LIMIT 1`
  );
}
