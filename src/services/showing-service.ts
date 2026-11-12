/**
 * Showing a node's page below its label (docs/showing-a-page.md).
 *
 * Often the best evidence for something is more sensitive than the thing
 * itself. A deployment that holds material at more than one label can show
 * what an agent concluded from evidence without showing the evidence: a
 * page written at one label is shown to readers who may not read that
 * label, at another label inside the deployment or outside it, with what
 * was removed marked in its place and in a form those readers can check.
 * It is one act at every boundary, and this file is that act up to the
 * gate: asking, following a standing showing as the graph changes,
 * recording the page, the Redactor's removals, the fingerprint, and
 * Audit's check. The gate and what arrives on the other side are in
 * release-gate-service.ts.
 *
 * What is shown is the ordinary page. Nothing is run to produce it and no
 * table holds a special form of it: the page is read from the rows the
 * Steward's ordinary work wrote at the page's label (the version of the
 * judgment, the arguments and their evaluations, the readings of sources,
 * the subclaims, the requests), and divided into parts by its own
 * structure (page-parts.ts).
 *
 * A showing covers the rows at the page's label and no others. Rows the
 * page's label merely reads belong to those labels' own pages: where the
 * destination reads them too it has them already, and where it does not,
 * showing them is a showing across that other boundary, under its policy.
 *
 * The two sides of a boundary may share no label, so each has rows of its
 * own (db/schema.ts). The page's side is written by work at the page's
 * label. The destination's side holds only what the process says in fixed
 * words (stages, kinds, hashes, dates, who acted) until a part is
 * released, and is written here as the tables' owner.
 */
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery, withTransaction } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";
import { currentLabel, runAtLabel } from "../llm/usage-context.js";
import { oneLabelOnly } from "./judgment-version-service.js";
import {
  VERDICT_DESCRIPTOR,
  newSalt,
  pageRoot,
  partCommitment,
  type LeafRecord,
  type Mark,
} from "./page-fingerprint.js";
import {
  RemovalError,
  applyRemovals,
  countByCategory,
  descriptorOf,
  locate,
  overlaps,
  paragraphsOf,
  type PartKind,
} from "./page-parts.js";
import { getPromptSet } from "./prompt-set.js";
import {
  destinationLabel,
  ensureBoundaryPolicy,
  policyById,
  type Boundary,
  type PolicyView,
} from "./redaction-policy.js";

const REASON_BOTH_SIDES =
  "Showing a page below its label keeps rows on both sides of a boundary, the page's label and the destination's, and the two may share no label.";

/** Run `fn` as the tables' owner, for the rows a showing keeps on each side of its boundary. */
export function bothSides<T>(fn: () => Promise<T>): Promise<T> {
  return withSystemClearance(REASON_BOTH_SIDES, fn);
}

// ---- the fixed words ---------------------------------------------------------

export const SHOWING_FORMS = ["once", "standing"] as const;
export type ShowingForm = (typeof SHOWING_FORMS)[number];
export const SHOWING_SCOPES = ["node", "under"] as const;
export type ShowingScope = (typeof SHOWING_SCOPES)[number];

/** Why a standing showing was ended. The person ending it picks one; nobody checks it. */
export const END_REASONS = {
  no_longer_needed: "it is no longer needed",
  replaced: "another showing replaces it",
  asked_in_error: "it was asked for in error",
  no_reason_given: "no reason given",
} as const;
export type EndReason = keyof typeof END_REASONS;

/** Why a node stopped being covered by a showing. Read from the record, never chosen. */
export const LEFT_REASONS = {
  link_removed: "the link that placed it under the shown node was removed",
  node_not_active: "the node was merged into another or retired",
  showing_ended: "the showing ended",
} as const;
export type LeftReason = keyof typeof LEFT_REASONS;

/** Where a page stands, as both sides record it. */
export const PAGE_STAGES = ["to_redact", "to_check", "at_gate", "cannot_cross", "overtaken"] as const;
export type PageStage = (typeof PAGE_STAGES)[number];

/**
 * Audit's answer to whether what remains still supports the verdict, in
 * the only words it is recorded and shown in, so that the answer cannot
 * itself give anything away.
 */
export const FIDELITY_ANSWERS = {
  supports: "The reasoning shown supports the verdict.",
  supports_in_part: "The reasoning shown supports the verdict in part.",
  does_not_show_why: "The reasoning shown does not show why the verdict was reached.",
} as const;
export type FidelityAnswer = keyof typeof FIDELITY_ANSWERS;

export class ShowingError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

/** The person acting, as a route resolved them. */
export interface Actor {
  id: string;
  /** The permissions they hold, as the record shows them: "direct", "release for <party>". */
  holding: string[];
}

interface NodeRow {
  id: string;
  kind: string;
  text: string;
  state: string;
  label: string;
  origin: string;
}

const JUDGMENT_TABLES: Record<string, { table: string; kind: "assessment" | "quantity_estimate" | "question_assessment" }> = {
  claim: { table: "assessments", kind: "assessment" },
  quantity: { table: "quantity_estimates", kind: "quantity_estimate" },
  question: { table: "question_assessments", kind: "question_assessment" },
};
const judgmentOf = (nodeKind: string) => JUDGMENT_TABLES[nodeKind] ?? JUDGMENT_TABLES.claim!;

interface ShowingRow {
  id: string;
  node_id: string;
  to_label: string | null;
  to_outside: boolean;
  boundary_id: string;
  form: ShowingForm;
  scope: ShowingScope;
  asked_at: Date;
  ended_at: Date | null;
  page_label: string;
}

const SHOWING_COLUMNS = `id, node_id, to_label, to_outside, boundary_id, form, scope, asked_at, ended_at, sensitivity_label AS page_label`;

const boundaryOf = (s: Pick<ShowingRow, "page_label" | "to_label">): Boundary => ({ from: s.page_label, to: s.to_label });
const destinationOf = (s: Pick<ShowingRow, "page_label" | "to_label">): string => destinationLabel(boundaryOf(s));

/** The party that is the organization itself, or null where the deployment has not said. */
export async function ownOrganizationParty(): Promise<{ id: string; name: string } | null> {
  const [row] = await rawQuery<{ id: string; name: string }>(`SELECT id, name FROM parties WHERE is_own_organization`);
  return row ?? null;
}

// ---- asking -----------------------------------------------------------------

/**
 * Ask for a node's page at `pageLabel` to be shown at `toLabel`, or outside
 * the deployment when `toLabel` is null. The caller has checked that the
 * person holds `direct` and reads `pageLabel`.
 */
export async function askShowing(input: {
  nodeId: string;
  pageLabel: string;
  toLabel: string | null;
  form: ShowingForm;
  scope: ShowingScope;
  actor: Actor;
}): Promise<{ showing_id: string; boundary_id: string; policy: { id: string; version: number; hash: string }; pages_opened: number }> {
  if (oneLabelOnly()) {
    throw new ShowingError(
      "ONE_LABEL",
      "This graph holds everything at one label, which every reader reads, so it has no page that some of its readers cannot already read."
    );
  }
  const { pageLabel, toLabel } = input;
  return bothSides(async () => {
    const labels = new Set((await rawQuery<{ name: string }>(`SELECT name FROM labels`)).map((r) => r.name));
    if (!labels.has(pageLabel)) throw new ShowingError("UNKNOWN_LABEL", `This deployment defines no label "${pageLabel}".`);
    if (toLabel !== null) {
      if (!labels.has(toLabel)) throw new ShowingError("UNKNOWN_LABEL", `This deployment defines no label "${toLabel}".`);
      const [reach] = await rawQuery<{ reads: string[] }>(`SELECT minerval_labels_readable_from(ARRAY[$1::text]) AS reads`, [toLabel]);
      if (toLabel === pageLabel || reach!.reads.includes(pageLabel)) {
        throw new ShowingError(
          "ALREADY_READ",
          `Readers at "${toLabel}" already read what is written at "${pageLabel}", so the page is in front of them whole and there is nothing to show.`
        );
      }
    }
    const [node] = await rawQuery<NodeRow & { readable: boolean }>(
      `SELECT c.id, c.kind, c.text, c.state, c.sensitivity_label AS label, c.origin,
              c.sensitivity_label = ANY (minerval_labels_readable_from(ARRAY[$2::text])) AS readable
         FROM claims c WHERE c.id = $1`,
      [input.nodeId, pageLabel]
    );
    if (!node || !node.readable || node.state !== "active") {
      throw new ShowingError("NODE_NOT_FOUND", `No active node with that id is read at "${pageLabel}".`);
    }
    if (!(await ownOrganizationParty())) {
      throw new ShowingError(
        "NO_OWN_ORGANIZATION",
        "This deployment has not said which party is the organization itself. A part of a page that rests on no " +
          "outside party's material is the organization's to release, so an administrator adds that party first."
      );
    }
    const spec = judgmentOf(node.kind);
    const [version] = await rawQuery<{ id: string }>(
      `SELECT id FROM ${spec.table}_versions WHERE claim_id = $1 AND sensitivity_label = $2`,
      [node.id, pageLabel]
    );
    if (input.form === "once" && version && (await passRunning(node, pageLabel))) {
      throw new ShowingError(
        "PASS_RUNNING",
        `A pass on this node at "${pageLabel}" is running now, and a page shown once is the page as it stands when it is asked for. ` +
          `Ask again when the pass has finished, so that the page is the finished one.`
      );
    }
    if (input.form === "once" && !version) {
      throw new ShowingError(
        "NOTHING_TO_SHOW",
        `This node has no assessment at "${pageLabel}" yet, so there is no page to show once. A standing showing ` +
          `covers it from now and follows it from its first assessment.`
      );
    }
    const boundary: Boundary = { from: pageLabel, to: toLabel };
    const policy = await ensureBoundaryPolicy(boundary);
    const destination = destinationLabel(boundary);
    let showingId: string;
    try {
      showingId = await withTransaction(async (tx) => {
        const [row] = await tx.query<{ id: string; asked_at: Date }>(
          `INSERT INTO showings (node_id, to_label, to_outside, boundary_id, form, scope, asked_by, asked_holding, sensitivity_label)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, asked_at`,
          [node.id, toLabel, toLabel === null, policy.boundary_id, input.form, input.scope, input.actor.id, input.actor.holding, pageLabel]
        );
        await tx.query(
          `INSERT INTO shown_showings (id, node_id, to_outside, boundary_id, form, scope, asked_by, asked_holding, asked_at, sensitivity_label)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [row!.id, node.id, toLabel === null, policy.boundary_id, input.form, input.scope, input.actor.id, input.actor.holding, row!.asked_at, destination]
        );
        await tx.query(
          `INSERT INTO showing_acts (showing_id, act, actor_id, holding, at, sensitivity_label) VALUES ($1, 'asked', $2, $3, $4, $5)`,
          [row!.id, input.actor.id, input.actor.holding, row!.asked_at, destination]
        );
        return row!.id;
      });
    } catch (err) {
      const e = err as { constraint?: string; cause?: { constraint?: string } } | null;
      if ((e?.constraint ?? e?.cause?.constraint) === "uq_showings_live") {
        throw new ShowingError("ALREADY_STANDING", "A standing showing of this node across this boundary, with this scope, already stands.");
      }
      throw err;
    }
    const pagesOpened = await followShowing(showingId, { first: true });
    return {
      showing_id: showingId,
      boundary_id: policy.boundary_id,
      policy: { id: policy.id, version: policy.version, hash: policy.hash },
      pages_opened: pagesOpened,
    };
  });
}

/**
 * End a standing showing. Later versions no longer follow. What was shown
 * stays shown, and the showing and its history stay on the record.
 */
export async function endShowing(input: { showingId: string; reason: EndReason; actor: Actor }): Promise<void> {
  if (!(input.reason in END_REASONS)) {
    throw new ShowingError("BAD_REASON", `The reason is one of: ${Object.keys(END_REASONS).join(", ")}.`);
  }
  await bothSides(async () => {
    const [showing] = await rawQuery<ShowingRow>(`SELECT ${SHOWING_COLUMNS} FROM showings WHERE id = $1`, [input.showingId]);
    if (!showing) throw new ShowingError("SHOWING_NOT_FOUND", "No showing has that id.");
    if (showing.ended_at) throw new ShowingError("ALREADY_ENDED", "This showing has already ended.");
    if (showing.form === "once") {
      throw new ShowingError("NOT_STANDING", "A page shown once undertakes nothing about later versions, so there is nothing to end.");
    }
    const destination = destinationOf(showing);
    await withTransaction(async (tx) => {
      const [at] = await tx.query<{ now: Date }>(
        `UPDATE showings SET ended_at = now(), ended_by = $2, ended_holding = $3, end_reason = $4 WHERE id = $1 RETURNING ended_at AS now`,
        [showing.id, input.actor.id, input.actor.holding, input.reason]
      );
      await tx.query(
        `UPDATE shown_showings SET ended_at = $2, ended_by = $3, ended_holding = $4, end_reason = $5 WHERE id = $1`,
        [showing.id, at!.now, input.actor.id, input.actor.holding, input.reason]
      );
      await tx.query(
        `UPDATE shown_nodes SET left_at = $2, left_reason = 'showing_ended' WHERE showing_id = $1 AND left_at IS NULL`,
        [showing.id, at!.now]
      );
      await tx.query(
        `INSERT INTO showing_acts (showing_id, act, actor_id, holding, reason, at, sensitivity_label) VALUES ($1, 'ended', $2, $3, $4, $5, $6)`,
        [showing.id, input.actor.id, input.actor.holding, input.reason, at!.now, destination]
      );
    });
  });
}

// ---- following a showing as the graph changes --------------------------------

/**
 * A halting guard on how many nodes one walk under a shown node visits. It
 * decides nothing about any page: a walk that reaches it stops, and the
 * nodes it did not reach are found by a later walk from a narrower showing.
 */
const WALK_LIMIT = 5000;

/** The nodes a showing covers now: the node asked for, and under scope `under` everything beneath it that the page's label reads. */
async function nodesCovered(showing: ShowingRow): Promise<Map<string, string | null>> {
  const placed = new Map<string, string | null>([[showing.node_id, null]]);
  if (showing.scope !== "under") return placed;
  let frontier = [showing.node_id];
  while (frontier.length > 0 && placed.size < WALK_LIMIT) {
    const edges = await rawQuery<{ parent: string; child: string }>(
      `SELECT r.parent_claim_id AS parent, r.child_claim_id AS child
         FROM claim_relationships r
         JOIN claims c ON c.id = r.child_claim_id AND c.state = 'active'
        WHERE r.parent_claim_id = ANY($1::uuid[])
          AND r.sensitivity_label = ANY (minerval_labels_readable_from(ARRAY[$2::text]))
          AND c.sensitivity_label = ANY (minerval_labels_readable_from(ARRAY[$2::text]))
        ORDER BY r.created_at, r.id`,
      [frontier, showing.page_label]
    );
    frontier = [];
    for (const e of edges) {
      // A node that sits under several things is shown once, in the first place it is reached here.
      if (placed.has(e.child)) continue;
      placed.set(e.child, e.parent);
      frontier.push(e.child);
    }
  }
  return placed;
}

/**
 * Bring one showing up to the graph as it stands: nodes that came under it
 * or left it, and a page for each version at the page's label that has
 * none. A page shown once is followed once, when it is asked for. Returns
 * how many pages it opened. Called inside bothSides.
 */
async function followShowing(showingId: string, opts: { first?: boolean } = {}): Promise<number> {
  const [showing] = await rawQuery<ShowingRow>(`SELECT ${SHOWING_COLUMNS} FROM showings WHERE id = $1`, [showingId]);
  if (!showing || showing.ended_at) return 0;
  if (showing.form === "once" && !opts.first) return 0;
  const destination = destinationOf(showing);
  const placed = await nodesCovered(showing);
  const known = await rawQuery<{ id: string; node_id: string }>(
    `SELECT id, node_id FROM shown_nodes WHERE showing_id = $1 AND left_at IS NULL`,
    [showing.id]
  );
  const knownIds = new Set(known.map((k) => k.node_id));
  for (const [nodeId, parent] of placed) {
    if (knownIds.has(nodeId)) continue;
    await rawQuery(
      `INSERT INTO shown_nodes (showing_id, node_id, place_parent_id, sensitivity_label) VALUES ($1, $2, $3, $4)`,
      [showing.id, nodeId, parent, destination]
    );
  }
  for (const k of known) {
    if (placed.has(k.node_id)) continue;
    const [node] = await rawQuery<{ state: string }>(`SELECT state FROM claims WHERE id = $1`, [k.node_id]);
    const reason: LeftReason = node?.state === "active" ? "link_removed" : "node_not_active";
    await rawQuery(`UPDATE shown_nodes SET left_at = now(), left_reason = $2 WHERE id = $1`, [k.id, reason]);
  }

  let opened = 0;
  const nodes = await rawQuery<NodeRow>(
    `SELECT id, kind, text, state, sensitivity_label AS label, origin FROM claims WHERE id = ANY($1::uuid[])`,
    [[...placed.keys()]]
  );
  for (const node of nodes) {
    const spec = judgmentOf(node.kind);
    const [first] = await rawQuery<{ at: Date | null }>(
      `SELECT min(assessed_at) AS at FROM ${spec.table} WHERE claim_id = $1 AND sensitivity_label = $2`,
      [node.id, showing.page_label]
    );
    if (first?.at) {
      await rawQuery(
        `UPDATE shown_nodes SET first_assessed_at = $3 WHERE showing_id = $1 AND node_id = $2 AND first_assessed_at IS NULL`,
        [showing.id, node.id, first.at]
      );
    }
    const [version] = await rawQuery<{ id: string; assessed_at: Date }>(
      `SELECT id, assessed_at FROM ${spec.table}_versions WHERE claim_id = $1 AND sensitivity_label = $2`,
      [node.id, showing.page_label]
    );
    if (!version) continue;
    // A page is recorded from a finished version. While a pass on the node
    // at the page's label is running, the Steward may have written its
    // assessment and still be writing the arguments and readings that go
    // with it, so the page waits for the next look after the pass has ended.
    if (await passRunning(node, showing.page_label)) continue;
    const [has] = await rawQuery(
      `SELECT 1 FROM showing_pages WHERE showing_id = $1 AND node_id = $2 AND judgment_id = $3`,
      [showing.id, node.id, version.id]
    );
    if (has) continue;
    await openPage(showing, node, spec.kind, version, destination);
    opened++;
  }
  return opened;
}

/**
 * Whether a Steward's pass on the node at `label` is running now. Work at
 * the node's own label keeps its state on the node, and work at another
 * label in that label's slot (services/steward-lease.ts).
 */
async function passRunning(node: NodeRow, label: string): Promise<boolean> {
  const [row] = await rawQuery<{ running: boolean }>(
    node.label === label
      ? `SELECT steward_state = 'running' AS running FROM claims WHERE id = $1`
      : `SELECT steward_state = 'running' AS running FROM steward_slots WHERE claim_id = $1 AND sensitivity_label = $2`,
    node.label === label ? [node.id] : [node.id, label]
  );
  return row?.running === true;
}

/**
 * Bring every standing showing up to the graph as it stands. The
 * scheduler's work: it finds, at every label, the versions and the changes
 * of structure that a standing showing has not yet taken in.
 */
export async function followShowings(): Promise<number> {
  if (oneLabelOnly()) return 0;
  return bothSides(async () => {
    const live = await rawQuery<{ id: string }>(
      `SELECT id FROM showings WHERE ended_at IS NULL AND form = 'standing' ORDER BY asked_at`
    );
    let opened = 0;
    for (const s of live) {
      try {
        opened += await followShowing(s.id);
      } catch (err) {
        // One showing's failure must not stop the others being followed.
        console.error(`[showing] could not follow showing ${s.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return opened;
  });
}

// ---- recording the page -------------------------------------------------------

interface RecordedPart {
  kind: PartKind;
  descriptor: string;
  refId: string | null;
  original: string;
  /** The sources the part rests on, for working out whose release it takes. */
  sources: string[];
}

interface RecordedPage {
  header: Record<string, unknown>;
  parts: RecordedPart[];
  /** The sources the whole version rests on. */
  sources: string[];
}

const RATINGS: Record<string, string> = {
  certain: "certain if the premises hold",
  likely: "likely if the premises hold",
  slight: "slight even if the premises hold",
  none: "no support even if the premises hold",
};
const ratingWords = (verdict: string, decisive: boolean): string =>
  `${RATINGS[verdict] ?? verdict.replace(/_/g, " ")}${decisive ? "; decisive" : ""}`;

/**
 * Every source the given nodes' judgments rest on, as far as the record
 * says: each node's judgment in force for a reader of the current label,
 * the sources recorded against it, and the same for every premise recorded
 * against it, to the end. A judgment whose inputs were not recorded is
 * taken to rest on what is attached to its node now. Run at the page's
 * label, so it walks only what that label reads.
 */
async function sourcesUnder(nodeIds: readonly string[], memo: Map<string, string[]>): Promise<string[]> {
  const key = [...nodeIds].sort().join(",");
  const cached = memo.get(key);
  if (cached) return cached;
  const seen = new Set<string>();
  const sources = new Set<string>();
  let frontier = [...new Set(nodeIds)];
  while (frontier.length > 0 && seen.size < WALK_LIMIT) {
    for (const id of frontier) seen.add(id);
    const judged = await rawQuery<{ claim_id: string; id: string; kind: string; inputs_recorded: boolean }>(
      `SELECT claim_id, id, 'assessment' AS kind, inputs_recorded FROM assessments_in_force WHERE claim_id = ANY($1::uuid[])
       UNION ALL
       SELECT claim_id, id, 'quantity_estimate', inputs_recorded FROM quantity_estimates_in_force WHERE claim_id = ANY($1::uuid[])
       UNION ALL
       SELECT claim_id, id, 'question_assessment', inputs_recorded FROM question_assessments_in_force WHERE claim_id = ANY($1::uuid[])`,
      [frontier]
    );
    const recorded = judged.filter((j) => j.inputs_recorded);
    const unrecorded = frontier.filter((id) => !recorded.some((j) => j.claim_id === id));
    const next = new Set<string>();
    if (recorded.length > 0) {
      const inputs = await rawQuery<{ input_kind: string; node_id: string | null; source_id: string | null }>(
        `SELECT input_kind, node_id, source_id FROM judgment_inputs
          WHERE judgment_id = ANY($1::uuid[]) AND input_kind IN ('premise', 'source')`,
        [recorded.map((j) => j.id)]
      );
      for (const i of inputs) {
        if (i.source_id) sources.add(i.source_id);
        if (i.node_id) next.add(i.node_id);
      }
    }
    if (unrecorded.length > 0) {
      const attached = await rawQuery<{ source_id: string }>(
        `SELECT DISTINCT source_id FROM claim_instances WHERE claim_id = ANY($1::uuid[]) AND detached_at IS NULL`,
        [unrecorded]
      );
      for (const a of attached) sources.add(a.source_id);
      const children = await rawQuery<{ child: string }>(
        `SELECT child_claim_id AS child FROM claim_relationships WHERE parent_claim_id = ANY($1::uuid[])`,
        [unrecorded]
      );
      for (const c of children) next.add(c.child);
    }
    frontier = [...next].filter((id) => !seen.has(id));
  }
  const out = [...sources];
  memo.set(key, out);
  return out;
}

/**
 * Read the page of `node` at the current label, which is the page's label,
 * as the rows there stand, and divide it into its parts. Only rows written
 * at this label are parts of this page.
 */
async function readPage(node: NodeRow, judgmentKind: string, judgmentId: string): Promise<RecordedPage> {
  const label = currentLabel();
  const memo = new Map<string, string[]>();
  const parts: RecordedPart[] = [];
  const spec = judgmentOf(node.kind);
  const [version] = await rawQuery<Record<string, unknown>>(`SELECT * FROM ${spec.table} WHERE id = $1`, [judgmentId]);
  if (!version) throw new ShowingError("VERSION_GONE", "The version this page was opened for is no longer there.");

  const instances = await rawQuery<{
    id: string; source_id: string; verbatim_text: string; context: string | null; stance: string;
    stated_probability: number | null; stated_estimate: unknown; support: string | null; note: string | null;
    statement: string | null; reasons: string | null; stake: string | null; view_stance: string | null;
  }>(
    `SELECT i.id, i.source_id, i.verbatim_text, i.context, i.stance, i.stated_probability, i.stated_estimate,
            r.support, r.note, v.statement, v.reasons, v.stake, v.stance AS view_stance
       FROM claim_instances i
       LEFT JOIN claim_instance_readings r ON r.instance_id = i.id AND r.sensitivity_label = $2
       LEFT JOIN stated_views v ON v.instance_id = i.id AND v.sensitivity_label = $2
      WHERE i.claim_id = $1 AND i.sensitivity_label = $2 AND i.detached_at IS NULL
      ORDER BY i.display_rank NULLS LAST, i.created_at, i.id`,
    [node.id, label]
  );
  const versionSources = [...new Set([...(await sourcesUnder([node.id], memo)), ...instances.map((i) => i.source_id)])];
  const whole = (kind: PartKind, original: string, refId: string | null = null, sources = versionSources, stance?: string | null) =>
    parts.push({ kind, descriptor: descriptorOf(kind, stance), refId, original, sources });

  if (node.label === label) whole("wording", node.text);
  for (const p of paragraphsOf(version.summary as string | null)) whole("summary", p);
  for (const p of paragraphsOf((version.reasoning_trace ?? version.work) as string | null)) whole("reasoning", p);
  for (const p of paragraphsOf(version.incomplete as string | null)) whole("gap", p);

  const requests = await rawQuery<{ id: string; ask: string; why: string; satisfied_by: string; state: string; addressed_to: string | null; created_at: Date }>(
    `SELECT q.id, q.ask, q.why, q.satisfied_by, q.state, q.addressed_to, q.created_at
       FROM requests q
      WHERE q.sensitivity_label = $2 AND q.state NOT IN ('withdrawn', 'moot')
        AND (q.keeper_claim_id = $1 OR EXISTS (SELECT 1 FROM request_targets t WHERE t.request_id = q.id AND t.claim_id = $1))
      ORDER BY q.created_at, q.id`,
    [node.id, label]
  );
  for (const q of requests) {
    whole("gap", `Request (${q.state.replace(/_/g, " ")})\n\nAsks for: ${q.ask}\n\nWhy: ${q.why}\n\nWhat would satisfy it: ${q.satisfied_by}`, q.id);
  }

  const args = await rawQuery<{
    id: string; name: string | null; stance: string; content: string; label: string;
    verdict: string | null; decisive: boolean | null; evaluation: string | null;
  }>(
    `SELECT a.id, a.name, a.stance, a.content, a.sensitivity_label AS label, e.verdict, e.decisive, e.content AS evaluation
       FROM arguments a
       LEFT JOIN argument_evaluations_versions e ON e.argument_id = a.id AND e.sensitivity_label = $2
      WHERE a.claim_id = $1 AND a.retired_at IS NULL AND a.merged_into IS NULL
        AND (a.sensitivity_label = $2 OR e.id IS NOT NULL)
      ORDER BY a.created_at, a.id`,
    [node.id, label]
  );
  for (const a of args) {
    const passages = await rawQuery<{ source_id: string }>(
      `SELECT DISTINCT source_id FROM argument_instances WHERE argument_id = $1 AND dismissed_at IS NULL`,
      [a.id]
    );
    const premises = await rawQuery<{ child: string }>(
      `SELECT r.child_claim_id AS child FROM argument_subclaims s JOIN claim_relationships r ON r.id = s.relationship_id WHERE s.argument_id = $1`,
      [a.id]
    );
    const sources = [...new Set([...passages.map((p) => p.source_id), ...(await sourcesUnder(premises.map((p) => p.child), memo))])];
    const evaluation = a.evaluation !== null ? `Evaluation: ${ratingWords(a.verdict!, a.decisive === true)}\n\n${a.evaluation}` : null;
    if (a.label === label) {
      const head = `Argument (${a.stance})${a.name ? `: ${a.name}` : ""}`;
      whole("argument", [head, a.content, ...(evaluation ? [evaluation] : [])].join("\n\n"), null, sources, a.stance);
    } else if (evaluation) {
      // The argument is another label's row. Only this label's evaluation of it is part of this page.
      whole("argument", `Evaluation of an argument recorded at another label\n\n${evaluation}`, a.id, sources, a.stance);
    }
  }

  const sourceFacts = await rawQuery<{ id: string; source_type: string; content_hash: string | null; party: string | null; own: boolean | null }>(
    `SELECT s.id, s.source_type, s.content_hash, p.name AS party, p.is_own_organization AS own
       FROM sources s LEFT JOIN parties p ON p.id = s.party_id
      WHERE s.id = ANY($1::uuid[]) ORDER BY s.retrieved_at, s.id`,
    [[...new Set(instances.map((i) => i.source_id))]]
  );
  const interests = await rawQuery<{ source_id: string; party: string; stake: string }>(
    `SELECT source_id, party, stake FROM source_interests
      WHERE source_id = ANY($1::uuid[]) AND (claim_id IS NULL OR claim_id = $2) ORDER BY created_at, id`,
    [sourceFacts.map((s) => s.id), node.id]
  );

  for (const i of instances) {
    if (i.statement !== null) {
      const text = [`Stated view (${i.view_stance ?? i.stance})`, i.statement, ...(i.reasons ? [`Reasons: ${i.reasons}`] : []), ...(i.stake ? [`Stake: ${i.stake}`] : [])];
      whole("stated_view", text.join("\n\n"), null, [i.source_id]);
      continue;
    }
    const text = [
      `Reading of a source (${i.stance})`,
      `Passage: ${i.verbatim_text}`,
      ...(i.context ? [`Context: ${i.context}`] : []),
      ...(i.stated_probability !== null ? [`Stated probability: ${i.stated_probability}`] : []),
      ...(i.stated_estimate ? [`Stated estimate: ${JSON.stringify(i.stated_estimate)}`] : []),
      ...(i.support || i.note ? [`How it was read: ${[i.support, i.note].filter(Boolean).join(". ")}`] : []),
    ];
    whole("reading", text.join("\n\n"), null, [i.source_id]);
  }

  // Who supplied each source, by name, and what interest is recorded for it,
  // in words: a part of its own for each source, so that a name or a stake
  // that cannot be shown is held where a reader can see it is held. That an
  // outside party supplied the source, and that an interest is recorded, are
  // always shown (below).
  sourceFacts.forEach((s, n) => {
    const stakes = interests.filter((i) => i.source_id === s.id);
    if (s.party === null && stakes.length === 0) return;
    const text = [
      `Supplier of source ${n + 1}: ${s.party ?? "not on record"}`,
      ...stakes.map((i) => `Recorded interest: ${i.party}. ${i.stake}`),
    ];
    whole("supplier", text.join("\n\n"), null, [s.id]);
  });

  const edges = await rawQuery<{ id: string; child: string; relation_type: string; reasoning: string; child_text: string; child_label: string }>(
    `SELECT r.id, r.child_claim_id AS child, r.relation_type, r.reasoning, c.text AS child_text, c.sensitivity_label AS child_label
       FROM claim_relationships r JOIN claims c ON c.id = r.child_claim_id
      WHERE r.parent_claim_id = $1 AND r.sensitivity_label = $2
      ORDER BY r.created_at, r.id`,
    [node.id, label]
  );
  for (const e of edges) {
    const own = e.child_label === label;
    const head = `Subclaim (${e.relation_type.replace(/_/g, " ")})${own ? `: ${e.child_text}` : ""}`;
    whole("subclaim", `${head}\n\n${e.reasoning}`, own ? null : e.child, await sourcesUnder([e.child], memo));
  }

  // What is always shown when the page is shown.
  const { summarizeCoverage } = await import("./coverage-service.js");
  const coverage = (await summarizeCoverage([node.id])).get(node.id);
  const verdict =
    judgmentKind === "assessment"
      ? { status: version.status, confidence: version.confidence, credence: version.claim_credence ?? null }
      : judgmentKind === "quantity_estimate"
        ? { estimate: version.estimate }
        : { standing: version.standing, confidence: version.confidence ?? null, favored_answers: version.favored_claim_ids ?? [] };
  const header = {
    format: "minerval-shown-page/1",
    node_kind: node.kind,
    verdict,
    judged_at: new Date(version.assessed_at as string | Date).toISOString(),
    coverage: { examined: coverage?.examined ?? true, on: coverage?.on ?? [] },
    sources: sourceFacts.map((s, n) => ({
      source: n + 1,
      kind: s.source_type,
      fingerprint: s.content_hash,
      supplied_by: s.own === null ? "not_recorded" : s.own ? "the_organization_itself" : "an_outside_party",
      interest_recorded: interests.some((i) => i.source_id === s.id),
    })),
    gaps: {
      requests: requests.map((q) => ({ state: q.state, addressed_to_someone: q.addressed_to !== null, filed: q.created_at.toISOString().slice(0, 10) })),
      names_what_remains_open: paragraphsOf(version.incomplete as string | null).length > 0,
    },
    made: { assessed_by_model: (version.model as string | null) ?? null },
  };
  return { header, parts, sources: versionSources };
}

/**
 * Whose release a set of sources takes, at one boundary: the party of each
 * source the destination does not already read. A source with no party on
 * record is the organization's. A source that is itself a page shown from
 * another label takes the releases that page took. Run at the page's label.
 */
async function partiesFor(sourceIds: readonly string[], showing: ShowingRow, ownOrganization: string): Promise<string[]> {
  if (sourceIds.length === 0) return [ownOrganization];
  const rows = await rawQuery<{ id: string; url: string | null; party_id: string | null; origin: string; source_type: string; already_read: boolean }>(
    `SELECT s.id, s.url, s.party_id, s.origin, s.source_type,
            CASE WHEN $3::boolean THEN s.origin = 'mirror'
                 ELSE s.sensitivity_label = ANY (minerval_labels_readable_from(ARRAY[$2::text])) END AS already_read
       FROM sources s WHERE s.id = ANY($1::uuid[])`,
    [[...sourceIds], showing.to_label ?? PUBLIC_LABEL, showing.to_outside]
  );
  const parties = new Set<string>();
  for (const s of rows) {
    if (s.already_read) continue;
    if (s.source_type === "shown_page") {
      // A shown page's source is addressed by its page (release-gate-service.ts, arrive), whichever arrival it was.
      const shownPageId = /^minerval:shown-page\/([0-9a-f-]{36})\//.exec(s.url ?? "")?.[1] ?? null;
      const needed = await rawQuery<{ party: string }>(
        `SELECT DISTINCT unnest(needs) AS party FROM shown_pages WHERE id = $1
         UNION
         SELECT DISTINCT unnest(sp.needs) FROM shown_parts sp WHERE sp.page_id = $1 AND sp.released_at IS NOT NULL`,
        [shownPageId]
      );
      for (const n of needed) parties.add(n.party);
      if (needed.length === 0) parties.add(ownOrganization);
      continue;
    }
    parties.add(s.party_id ?? ownOrganization);
  }
  return parties.size > 0 ? [...parties].sort() : [ownOrganization];
}

/** The ledger group of a page's redaction. */
export const REDACT_GROUP = (pageId: string) => `redact:${pageId}`;

/**
 * Open the page for one version: record it as it stands, divided into its
 * parts, on the page's side; say on the destination side that a version
 * exists and is waiting; and open the redaction on the ledger, which runs
 * when it is paid for. An earlier version of the node that was still
 * waiting to be redacted is not redacted: this one replaced it.
 */
async function openPage(
  showing: ShowingRow,
  node: NodeRow,
  judgmentKind: string,
  version: { id: string; assessed_at: Date },
  destination: string
): Promise<string> {
  const ownOrganization = (await ownOrganizationParty())!.id;
  const policy = (await ensureBoundaryPolicy(boundaryOf(showing)))!;
  const page = await runAtLabel(showing.page_label, `the page of node ${node.id} under showing ${showing.id}`, async () => {
    const recorded = await readPage(node, judgmentKind, version.id);
    const needs = await partiesFor(recorded.sources, showing, ownOrganization);
    const partNeeds: string[][] = [];
    for (const p of recorded.parts) partNeeds.push(await partiesFor(p.sources, showing, ownOrganization));
    return { recorded, needs, partNeeds };
  });

  const overtaken = await rawQuery<{ id: string }>(
    `UPDATE showing_pages SET stage = 'overtaken'
      WHERE showing_id = $1 AND node_id = $2 AND stage = 'to_redact' RETURNING id`,
    [showing.id, node.id]
  );
  for (const o of overtaken) {
    await rawQuery(`UPDATE shown_pages SET stage = 'overtaken' WHERE id = $1`, [o.id]);
    await rawQuery(
      `UPDATE actions SET status = 'cancelled', updated_at = now() WHERE exclusion_group = $1 AND status = 'open'`,
      [REDACT_GROUP(o.id)]
    );
  }

  const pageId = await withTransaction(async (tx) => {
    const [row] = await tx.query<{ id: string; opened_at: Date }>(
      `INSERT INTO showing_pages
         (showing_id, node_id, judgment_kind, judgment_id, judged_at, policy_id, header, header_salt, rests_on, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[], $10) RETURNING id, opened_at`,
      [showing.id, node.id, judgmentKind, version.id, version.assessed_at, policy.id, JSON.stringify(page.recorded.header), newSalt(), page.needs, showing.page_label]
    );
    let position = 1;
    for (const [i, part] of page.recorded.parts.entries()) {
      await tx.query(
        `INSERT INTO showing_parts (page_id, position, kind, descriptor, ref_id, original, salt, rests_on, sensitivity_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9)`,
        [row!.id, position++, part.kind, part.descriptor, part.refId, part.original, newSalt(), page.partNeeds[i], showing.page_label]
      );
    }
    await tx.query(
      `INSERT INTO shown_pages (id, showing_id, node_id, judged_at, opened_at, stage, needs, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, 'to_redact', $6::uuid[], $7)`,
      [row!.id, showing.id, node.id, version.assessed_at, row!.opened_at, page.needs, destination]
    );
    return row!.id;
  });
  await runAtLabel(showing.page_label, `the redaction of page ${pageId}`, () => ensureRedactAction(pageId, node.id));
  return pageId;
}

/**
 * Open, or open again, the ledger row for a page's redaction, at the
 * current label, which is the page's. It runs when someone pays for it: a
 * mandate that values it, or the person who asked.
 */
export async function ensureRedactAction(pageId: string, nodeId: string): Promise<string> {
  const { estimateLedgerKindCostMicroUsd } = await import("./cost-estimate-service.js");
  const cost = await estimateLedgerKindCostMicroUsd("redact");
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO actions (kind, exclusion_group, variant, claim_id, target_ref, label, cost_est_micro_usd, sensitivity_label)
     VALUES ('redact', $1, 'standard', $2, $3, 'Redact a page that is to be shown to readers who do not read its label', $4, $5)
     ON CONFLICT (exclusion_group, variant) DO UPDATE
       SET status = CASE WHEN actions.status IN ('done', 'superseded', 'cancelled') THEN 'open' ELSE actions.status END,
           updated_at = now()
     RETURNING id`,
    [REDACT_GROUP(pageId), nodeId, pageId, Math.max(1, Math.round(cost)), currentLabel()]
  );
  await rawQuery(`UPDATE showing_pages SET redact_action_id = $2 WHERE id = $1`, [pageId, row!.id]);
  return row!.id;
}

// ---- the Redactor's work ------------------------------------------------------

interface PageRow {
  id: string;
  showing_id: string;
  node_id: string;
  judgment_kind: string;
  judgment_id: string;
  judged_at: Date;
  stage: PageStage;
  round: number;
  policy_id: string;
  header: string;
  header_salt: string;
  root: string | null;
  rests_on: string[];
  least_sure: unknown;
  cannot_cross_category: string | null;
  cannot_cross_note: string | null;
  audit_answer: FidelityAnswer | null;
  audit_reasons: string | null;
  redact_action_id: string | null;
  checked_at: Date | null;
  page_label: string;
}

const PAGE_COLUMNS = `id, showing_id, node_id, judgment_kind, judgment_id, judged_at, stage, round, policy_id, header, header_salt, root,
  rests_on, least_sure, cannot_cross_category, cannot_cross_note, audit_answer, audit_reasons, redact_action_id, checked_at,
  sensitivity_label AS page_label`;

interface PartRow {
  id: string;
  position: number;
  kind: PartKind;
  descriptor: string;
  ref_id: string | null;
  original: string;
  salt: string;
  rests_on: string[];
  redacted: string | null;
  marks: Mark[] | null;
  commitment: string | null;
}

interface RemovalRow {
  id: string;
  part_id: string;
  start_offset: number;
  end_offset: number;
  category: string;
  note: string;
  made_in_round: number;
}

async function pageAtOwnLabel(pageId: string): Promise<PageRow> {
  const [page] = await rawQuery<PageRow>(`SELECT ${PAGE_COLUMNS} FROM showing_pages WHERE id = $1`, [pageId]);
  if (!page) throw new ShowingError("PAGE_NOT_FOUND", "No page under a showing has that id at a label this work reads.");
  return page;
}

const partsOf = (pageId: string) =>
  rawQuery<PartRow>(
    `SELECT id, position, kind, descriptor, ref_id, original, salt, rests_on, redacted, marks, commitment
       FROM showing_parts WHERE page_id = $1 ORDER BY position`,
    [pageId]
  );

const removalsOf = (pageId: string) =>
  rawQuery<RemovalRow>(
    `SELECT r.id, r.part_id, r.start_offset, r.end_offset, r.category, r.note, r.made_in_round
       FROM showing_removals r JOIN showing_parts p ON p.id = r.part_id
      WHERE p.page_id = $1 AND r.taken_back_at IS NULL
      ORDER BY p.position, r.start_offset`,
    [pageId]
  );

/** How far into a stored source's text one read of it goes. The source is read in slices from `offset`. */
export const SOURCE_SLICE_CHARS = 20_000;

/**
 * The page a Redactor works on, as recorded: what is always shown, each
 * part as written with the removals made so far, the sources the page drew
 * on, and what Audit said if it returned the work. Read at the page's label.
 */
export async function pageToRedact(pageId: string): Promise<Record<string, unknown>> {
  const page = await pageAtOwnLabel(pageId);
  const parts = await partsOf(pageId);
  const removals = await removalsOf(pageId);
  const sources = await rawQuery<{ id: string; title: string; source_type: string; label: string; party: string | null; chars: number | null }>(
    `SELECT DISTINCT s.id, s.title, s.source_type, s.sensitivity_label AS label, p.name AS party, length(s.raw_content) AS chars
       FROM claim_instances i JOIN sources s ON s.id = i.source_id LEFT JOIN parties p ON p.id = s.party_id
      WHERE i.claim_id = $1 AND i.detached_at IS NULL ORDER BY s.title, s.id`,
    [page.node_id]
  );
  return {
    page_id: page.id,
    stage: page.stage,
    round: page.round,
    always_shown: JSON.parse(page.header),
    parts: parts.map((p) => ({
      part: p.position,
      kind: p.kind,
      text: p.original,
      removals: removals
        .filter((r) => r.part_id === p.id)
        .map((r) => ({ removal_id: r.id, passage: p.original.slice(r.start_offset, r.end_offset), category: r.category, note: r.note })),
    })),
    sources: sources.map((s) => ({
      source_id: s.id,
      title: s.title,
      kind: s.source_type,
      label: s.label,
      supplied_by: s.party,
      stored_text_chars: s.chars ?? 0,
    })),
    ...(page.audit_reasons && page.stage === "to_redact" ? { returned_by_audit: page.audit_reasons } : {}),
  };
}

/** One slice of a source the page drew on, for judging what a passage gives away. */
export async function sourceBehindPage(pageId: string, sourceId: string, offset = 0): Promise<Record<string, unknown>> {
  const page = await pageAtOwnLabel(pageId);
  const [source] = await rawQuery<{ id: string; title: string; text: string | null; chars: number | null }>(
    `SELECT s.id, s.title, substr(s.raw_content, $3::int + 1, $4::int) AS text, length(s.raw_content) AS chars
       FROM sources s
      WHERE s.id = $2 AND EXISTS (SELECT 1 FROM claim_instances i WHERE i.source_id = s.id AND i.claim_id = $1)`,
    [page.node_id, sourceId, Math.max(0, Math.floor(offset)), SOURCE_SLICE_CHARS]
  );
  if (!source) throw new ShowingError("SOURCE_NOT_FOUND", "That is not one of the sources this page drew on.");
  return {
    source_id: source.id,
    title: source.title,
    offset: Math.max(0, Math.floor(offset)),
    text: source.text ?? "",
    total_chars: source.chars ?? 0,
    ...(source.text === null ? { note: "No text of this source is stored." } : {}),
  };
}

function mustBeRedacting(page: PageRow): void {
  if (page.stage !== "to_redact") {
    throw new ShowingError(
      "NOT_BEING_REDACTED",
      page.stage === "overtaken"
        ? "A later version of this node replaced this page before it was redacted, so there is nothing to redact here."
        : "This page's redaction is finished. Its parts are fingerprinted as they were left, and nothing in them changes now."
    );
  }
}

/** Remove one passage from one part and leave its category's mark there. */
export async function redactPassage(input: {
  pageId: string;
  part: number;
  passage: string;
  occurrence?: number;
  category: string;
  note: string;
}): Promise<{ removal_id: string; part_now_reads: string }> {
  const page = await pageAtOwnLabel(input.pageId);
  mustBeRedacting(page);
  const policy = await policyById(page.policy_id);
  if (!policy) throw new ShowingError("POLICY_NOT_FOUND", "This page's policy could not be read.");
  const category = policy.categories.find((c) => c.name === input.category.trim());
  if (!category) {
    throw new ShowingError(
      "NO_SUCH_CATEGORY",
      `"${input.category}" is not a category of this boundary's policy. Its categories are: ${policy.categories.map((c) => `"${c.name}"`).join(", ")}. ` +
        `A passage no category covers stays.`
    );
  }
  if (!input.note?.trim()) throw new ShowingError("NOTE_NEEDED", "Say in the note why the category covers this passage. Audit and the people who decide what is released read it.");
  const [part] = (await partsOf(input.pageId)).filter((p) => p.position === input.part);
  if (!part) throw new ShowingError("NO_SUCH_PART", `This page has no part ${input.part}.`);
  const existing = (await removalsOf(input.pageId)).filter((r) => r.part_id === part.id);
  let span: { start: number; end: number };
  try {
    span = locate(part.original, input.passage, input.occurrence);
  } catch (err) {
    if (err instanceof RemovalError) throw new ShowingError("PASSAGE_NOT_FOUND", err.message);
    throw err;
  }
  const asRemovals = existing.map((r) => ({ start: r.start_offset, end: r.end_offset, category: r.category }));
  if (overlaps(asRemovals, span)) {
    throw new ShowingError("OVERLAPS", "That passage overlaps a removal already made in this part. Take that removal back with restore first if this one should replace it.");
  }
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO showing_removals (part_id, start_offset, end_offset, category, note, policy_id, made_in_round, sensitivity_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [part.id, span.start, span.end, category.name, input.note.trim(), policy.id, page.round, page.page_label]
  );
  return {
    removal_id: row!.id,
    part_now_reads: applyRemovals(part.original, [...asRemovals, { ...span, category: category.name }]).text,
  };
}

/** Take back a removal: the passage is in the part again, as written. */
export async function restorePassage(input: { pageId: string; removalId: string }): Promise<{ part_now_reads: string }> {
  const page = await pageAtOwnLabel(input.pageId);
  mustBeRedacting(page);
  const [taken] = await rawQuery<{ part_id: string }>(
    `UPDATE showing_removals r SET taken_back_at = now()
      WHERE r.id = $2 AND r.taken_back_at IS NULL
        AND EXISTS (SELECT 1 FROM showing_parts p WHERE p.id = r.part_id AND p.page_id = $1)
      RETURNING r.part_id`,
    [input.pageId, input.removalId]
  );
  if (!taken) throw new ShowingError("NO_SUCH_REMOVAL", "No removal on this page has that id, or it was already taken back.");
  const [part] = (await partsOf(input.pageId)).filter((p) => p.id === taken.part_id);
  const left = (await removalsOf(input.pageId)).filter((r) => r.part_id === taken.part_id);
  return { part_now_reads: applyRemovals(part!.original, left.map((r) => ({ start: r.start_offset, end: r.end_offset, category: r.category }))).text };
}

async function setStageOnBothSides(page: PageRow, stage: PageStage, extra: { act?: string; auditAnswer?: FidelityAnswer } = {}): Promise<void> {
  await bothSides(async () => {
    const [showing] = await rawQuery<ShowingRow>(`SELECT ${SHOWING_COLUMNS} FROM showings WHERE id = $1`, [page.showing_id]);
    const destination = destinationOf(showing!);
    await rawQuery(`UPDATE shown_pages SET stage = $2, audit_answer = COALESCE($3, audit_answer) WHERE id = $1`, [
      page.id,
      stage,
      extra.auditAnswer ?? null,
    ]);
    if (extra.act) {
      await rawQuery(
        `INSERT INTO showing_acts (showing_id, page_id, act, sensitivity_label) VALUES ($1, $2, $3, $4)`,
        [page.showing_id, page.id, extra.act, destination]
      );
    }
  });
}

/**
 * The Redactor's finding that the page cannot be shown under this policy:
 * something that is always shown could not be shown without giving away
 * what a category protects. The destination sees the page as held, in
 * fixed words. The category and the note stay at the page's label.
 */
export async function pageCannotCross(input: { pageId: string; category: string; note: string }): Promise<void> {
  const page = await pageAtOwnLabel(input.pageId);
  mustBeRedacting(page);
  const policy = await policyById(page.policy_id);
  if (!policy?.categories.some((c) => c.name === input.category.trim())) {
    throw new ShowingError(
      "NO_SUCH_CATEGORY",
      `"${input.category}" is not a category of this boundary's policy. Its categories are: ${(policy?.categories ?? []).map((c) => `"${c.name}"`).join(", ")}.`
    );
  }
  if (!input.note?.trim()) throw new ShowingError("NOTE_NEEDED", "Say in the note which of the things that are always shown the category covers here, and why.");
  await rawQuery(
    `UPDATE showing_pages SET stage = 'cannot_cross', cannot_cross_category = $2, cannot_cross_note = $3, redacted_at = now() WHERE id = $1`,
    [page.id, input.category.trim(), input.note.trim()]
  );
  await setStageOnBothSides(page, "cannot_cross", { act: "cannot_cross" });
}

/**
 * The Redactor is done. Each part as it left it is hashed with its salt,
 * the root is computed, and the root with the shape of the page (each
 * part's place, kind and hash) is recorded on the destination side at
 * once, before anyone decides what is released. Audit's check of the
 * redaction is then asked for, at the page's label.
 */
export async function finishRedaction(input: {
  pageId: string;
  leastSure: Array<{ removal_id?: string; part?: number; why: string }>;
  model?: string | null;
  runId?: string | null;
}): Promise<{ root: string; parts: number; removals: Record<string, number> }> {
  const page = await pageAtOwnLabel(input.pageId);
  mustBeRedacting(page);
  const policy = await policyById(page.policy_id);
  const parts = await partsOf(page.id);
  const removals = await removalsOf(page.id);
  const counts = countByCategory(removals.map((r) => r.category));
  const header = JSON.stringify({
    ...JSON.parse(page.header),
    made: {
      ...(JSON.parse(page.header).made as Record<string, unknown>),
      prompt_set: getPromptSet().hash,
      policy: { version: policy?.version ?? null, hash: policy?.hash ?? null },
      redacted_by_model: input.model ?? null,
      // Additions a deployment makes to a role's prompt are not built yet, so there are none to name.
      role_additions: [],
    },
    removals: counts,
    parts: parts.length,
  });
  const leaves: LeafRecord[] = [{ position: 0, descriptor: VERDICT_DESCRIPTOR, commitment: partCommitment(page.header_salt, header, []) }];
  const finished: Array<PartRow & { text: string; marksNow: Mark[]; commitmentNow: string }> = [];
  for (const part of parts) {
    const { text, marks } = applyRemovals(
      part.original,
      removals.filter((r) => r.part_id === part.id).map((r) => ({ start: r.start_offset, end: r.end_offset, category: r.category }))
    );
    const commitment = partCommitment(part.salt, text, marks);
    finished.push({ ...part, text, marksNow: marks, commitmentNow: commitment });
    leaves.push({ position: part.position, descriptor: part.descriptor, commitment });
  }
  const root = pageRoot(leaves);
  await withTransaction(async (tx) => {
    for (const part of finished) {
      await tx.query(`UPDATE showing_parts SET redacted = $2, marks = $3::jsonb, commitment = $4 WHERE id = $1`, [
        part.id,
        part.text,
        JSON.stringify(part.marksNow),
        part.commitmentNow,
      ]);
    }
    await tx.query(
      `UPDATE showing_pages
          SET stage = 'to_check', header = $2, root = $3, least_sure = $4::jsonb, redactor_model = $5, redactor_run_id = $6,
              redacted_at = now(), audit_answer = NULL
        WHERE id = $1`,
      [page.id, header, root, JSON.stringify(input.leastSure ?? []), input.model ?? null, input.runId ?? null]
    );
  });
  // The step that follows the Redactor's run: the root and the shape go to
  // the destination side now. Nothing of the text goes with them.
  await bothSides(async () => {
    const [showing] = await rawQuery<ShowingRow>(`SELECT ${SHOWING_COLUMNS} FROM showings WHERE id = $1`, [page.showing_id]);
    const destination = destinationOf(showing!);
    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE shown_pages
            SET stage = 'to_check', round = $2, root = $3, header_commitment = $4,
                roots = roots || jsonb_build_object('round', $2::int, 'root', $3::text, 'recorded_at', now())
          WHERE id = $1`,
        [page.id, page.round, root, leaves[0]!.commitment]
      );
      // A redaction done again after the check returned it replaces the earlier round's shape. Nothing was released from it.
      await tx.query(`DELETE FROM shown_parts WHERE page_id = $1`, [page.id]);
      for (const part of finished) {
        await tx.query(
          `INSERT INTO shown_parts (id, page_id, position, kind, descriptor, commitment, needs, sensitivity_label)
           VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8)`,
          [part.id, page.id, part.position, part.kind, part.descriptor, part.commitmentNow, part.rests_on, destination]
        );
      }
    });
  });
  const { requestAudit } = await import("./queue-service.js");
  const auditRunId = await requestAudit({
    auditType: "redaction_fidelity",
    context: `Check the redaction of page ${page.id} (round ${page.round}) before it goes to the people who decide what is released. get_redaction_to_check reads it.`,
    triggeredBy: "redaction_finished",
    dedupeKey: `redaction:${page.id}:${page.round}`,
    claimId: page.node_id,
  });
  if (auditRunId) await rawQuery(`UPDATE showing_pages SET audit_run_id = $2 WHERE id = $1`, [page.id, auditRunId]);
  return { root, parts: parts.length, removals: counts };
}

// ---- Audit's check ------------------------------------------------------------

/** What Audit reads to check a redaction: the page as written, as redacted, each removal with its note, and the policy. */
export async function redactionToCheck(pageId: string): Promise<Record<string, unknown>> {
  const page = await pageAtOwnLabel(pageId);
  const parts = await partsOf(pageId);
  const removals = await removalsOf(pageId);
  const policy = await policyById(page.policy_id);
  return {
    page_id: page.id,
    stage: page.stage,
    round: page.round,
    always_shown: JSON.parse(page.header),
    least_sure: page.least_sure ?? [],
    parts: parts.map((p) => ({
      part: p.position,
      kind: p.kind,
      as_written: p.original,
      as_redacted: p.redacted ?? p.original,
      removals: removals
        .filter((r) => r.part_id === p.id)
        .map((r) => ({ removal_id: r.id, passage: p.original.slice(r.start_offset, r.end_offset), category: r.category, note: r.note })),
    })),
    policy: policy ? { version: policy.version, text: policy.body } : null,
    fixed_answers: FIDELITY_ANSWERS,
  };
}

/**
 * Audit's outcome. A pass sends the page to the gate with one of the three
 * fixed answers, which is all the destination side is told. A return sends
 * it back to the Redactor with reasons, which stay at the page's label, and
 * the redaction is opened again on the ledger.
 */
export async function recordFidelityOutcome(input: {
  pageId: string;
  outcome: "pass" | "return";
  answer?: string;
  reasons: string;
}): Promise<{ stage: PageStage }> {
  const page = await pageAtOwnLabel(input.pageId);
  if (page.stage !== "to_check") {
    throw new ShowingError("NOT_WAITING_FOR_CHECK", "This page is not waiting for its redaction to be checked.");
  }
  if (!input.reasons?.trim()) throw new ShowingError("REASONS_NEEDED", "Give your reasons. They stay at the label of the page.");
  if (input.outcome === "pass") {
    if (!input.answer || !(input.answer in FIDELITY_ANSWERS)) {
      throw new ShowingError(
        "ANSWER_NEEDED",
        `A pass gives one of the three answers that are shown with the page: ${Object.entries(FIDELITY_ANSWERS).map(([k, v]) => `${k} ("${v}")`).join("; ")}.`
      );
    }
    const answer = input.answer as FidelityAnswer;
    await rawQuery(
      `UPDATE showing_pages SET stage = 'at_gate', audit_answer = $2, audit_reasons = $3, checked_at = now() WHERE id = $1`,
      [page.id, answer, input.reasons.trim()]
    );
    await setStageOnBothSides(page, "at_gate", { auditAnswer: answer });
    const { pageReachedGate } = await import("./release-gate-service.js");
    await pageReachedGate(page.id);
    return { stage: "at_gate" };
  }
  await rawQuery(
    `UPDATE showing_pages SET stage = 'to_redact', round = round + 1, audit_answer = NULL, audit_reasons = $2, checked_at = now() WHERE id = $1`,
    [page.id, input.reasons.trim()]
  );
  await setStageOnBothSides(page, "to_redact", { act: "returned_by_check" });
  await ensureRedactAction(page.id, page.node_id);
  return { stage: "to_redact" };
}

/** A page with what a caller on the page's side needs to act on it. Read at the caller's own clearance. */
export async function showingPage(pageId: string): Promise<PageRow | null> {
  const [page] = await rawQuery<PageRow>(`SELECT ${PAGE_COLUMNS} FROM showing_pages WHERE id = $1`, [pageId]);
  return page ?? null;
}

export { partsOf as showingPartsOf, removalsOf as showingRemovalsOf, SHOWING_COLUMNS, destinationOf, boundaryOf };
export type { PageRow, PartRow, RemovalRow, ShowingRow, PolicyView };
