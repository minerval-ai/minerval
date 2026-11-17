/**
 * Artifacts (constitution §7b, #845): nodes made from other nodes, judged
 * for fidelity rather than truth. Lists first.
 *
 * A list is a claims row of kind 'artifact' with:
 *   - its specification in artifact_specs (what it is for, what qualifies
 *     an entry, what is excluded, how entries are ordered). The
 *     specification is the list's identity: a list with other criteria is
 *     another list.
 *   - its entries as claim_relationships edges with relation_type
 *     'draws_on', the list the parent and each entry the child, the edge's
 *     reasoning saying why the entry qualifies. Propagation already follows
 *     every edge upward, so a list hears when an entry changes, and
 *     judgment_inputs already records every edge under a node, so a list's
 *     judgment knows what it was made against. Nothing reads a 'draws_on'
 *     edge as support: a list carries no evidential weight (§7b).
 *   - its judgment in artifact_assessments: the fidelity, the order its
 *     entries are shown in, and the nodes considered and left out with why.
 *
 * Staleness is not a fidelity the Steward records: it is read, here, from
 * what changed under the judgment since it was made.
 */
import { generateEmbedding } from "./embedding-service.js";
import { sameLabelOnly, writtenAtOwnLabel } from "../db/clearance.js";
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { claims } from "../db/schema.js";
import { loadConfig } from "../config.js";
import { currentLabel, getUsageContext } from "../llm/usage-context.js";
import {
  ARTIFACT_FIDELITIES,
  DRAWS_ON,
  leftOutSchema,
  listSpecSchema,
  type ArtifactFidelity,
  type LeftOut,
  type ListSpecInput,
  type NodeKind,
  type QuantityEstimate,
  type QuantityUnit,
} from "../schemas/kinds.js";
import { getJudgmentInputs, recordJudgmentInputs } from "./judgment-inputs-service.js";
import { markSeveralInForce, recordMadeBeside } from "./judgment-version-service.js";
import { layered, lowerRowSql, oneDefinitionForQuantitySql, oneForKeySql, refuseWhereHeldBelow } from "./layer-service.js";
import { publicGraphJudges, publicJudgmentMessage } from "./mirrored-node-service.js";
import { KindError, lockNodeKind, requireKind } from "./node-kind.js";
import { enqueueClaimPipeline } from "./queue-service.js";

/** One specification for an artifact, for a read of artifact_specs aliased `alias`: the nearest layer's. */
export function oneSpecForArtifactSql(alias: string): string {
  return oneForKeySql("artifact_specs", alias, ["claim_id"]);
}

const refuseWhereALayerBelowHoldsIt = (tx: TxQuery, table: string, key: Record<string, unknown>, what: string) =>
  refuseWhereHeldBelow(tx.query.bind(tx), table, key, what, (message) => new KindError(message));

/** Parse a list's specification, with the refusal written for whoever sent it. */
export function parseListSpec(raw: unknown): ListSpecInput {
  const parsed = listSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new KindError(
      "A list's specification needs purpose and inclusion, each a sentence or more: " +
        parsed.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ")
    );
  }
  return parsed.data;
}

/** The words a list's identity is matched on: its title and its specification. */
export function specText(title: string, spec: ListSpecInput): string {
  return [
    title,
    `For: ${spec.purpose}`,
    `Includes: ${spec.inclusion}`,
    spec.exclusion ? `Excludes: ${spec.exclusion}` : "",
    spec.entry_kinds?.length ? `Entries: ${spec.entry_kinds.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A list the graph already holds whose specification reads close to a proposed one. */
export interface SimilarList {
  id: string;
  text: string;
  inclusion: string;
  similarity: number;
}

/**
 * The identity gate for a list (§7b): the lists whose specifications read
 * closest to this one. Two lists with different criteria are two lists, so
 * a near one is shown to whoever proposes, never merged on its own: whether
 * the criteria are the same is a judgment, and the caller makes it.
 */
export async function similarLists(embedding: number[], limit = 5): Promise<SimilarList[]> {
  const rows = await rawQuery<SimilarList>(
    `SELECT c.id, c.text, s.inclusion, (1 - (c.embedding <=> $1::vector))::float8 AS similarity
       FROM claims c
       JOIN artifact_specs s ON s.claim_id = c.id${oneSpecForArtifactSql("s")}
      WHERE c.kind = 'artifact' AND c.state = 'active' AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> $1::vector
      LIMIT $2`,
    [JSON.stringify(embedding), limit]
  );
  return rows;
}

/** How close a proposed list's specification must read to an existing one before the proposal is held for a look. */
export const SAME_LIST_SIMILARITY = 0.93;

/**
 * Propose a list: mint the node and its specification and hand it to its
 * Steward. Where a list whose specification reads very close already
 * exists, nothing is minted unless `confirmNew` says the criteria differ;
 * the near lists come back either way.
 */
export async function proposeList(input: {
  title: string;
  spec: ListSpecInput;
  createdBy: string;
  importance?: number;
  confirmNew?: boolean;
}): Promise<{ id: string | null; similar: SimilarList[] }> {
  const title = input.title.trim();
  if (!title) throw new KindError("A list needs a title: what it lists, in a line.");
  const spec = parseListSpec(input.spec);
  let embedding: number[] | undefined;
  try {
    embedding = await generateEmbedding(specText(title, spec));
  } catch {
    // Continue without an embedding, as a new subclaim does; the gate then has nothing to compare.
  }
  const similar = embedding ? await similarLists(embedding) : [];
  if (!input.confirmNew && similar.some((s) => s.similarity >= SAME_LIST_SIMILARITY)) {
    return { id: null, similar };
  }
  const { stewardEnqueueMinImportance, pipelineEpoch } = loadConfig();
  const importance = input.importance === undefined ? undefined : Math.min(1, Math.max(0, input.importance));
  const gated = stewardEnqueueMinImportance > 0 && (importance ?? 0.5) < stewardEnqueueMinImportance;
  const id = await withTransaction(async (tx) => {
    const [created] = await tx.db
      .insert(claims)
      .values({
        text: title,
        kind: "artifact",
        embedding: embedding ?? undefined,
        ...(importance !== undefined ? { importance } : {}),
        ...(gated ? { stewardState: "deferred" } : {}),
        pipelineEpoch,
        createdBy: input.createdBy,
        sensitivityLabel: currentLabel(),
      })
      .returning({ id: claims.id });
    await writeSpec(tx, created!.id, spec, input.createdBy);
    return created!.id;
  });
  if (!gated) await enqueueClaimPipeline({ claimId: id, jobId: "steward" });
  return { id, similar: similar.filter((s) => s.id !== id) };
}

async function writeSpec(tx: TxQuery, claimId: string, spec: ListSpecInput, createdBy: string): Promise<void> {
  writtenAtOwnLabel(
    await tx.query<{ claim_id: string }>(
      `INSERT INTO artifact_specs
         (claim_id, subtype, purpose, inclusion, exclusion, ordering, entry_kinds, created_by, sensitivity_label)
       VALUES ($1, 'list', $2, $3, $4, $5, $6::text[], $7, $8)
       ON CONFLICT (claim_id, sensitivity_label, origin) DO UPDATE
         SET purpose = EXCLUDED.purpose, inclusion = EXCLUDED.inclusion, exclusion = EXCLUDED.exclusion,
             ordering = EXCLUDED.ordering, entry_kinds = EXCLUDED.entry_kinds, updated_at = now()
       ${sameLabelOnly("artifact_specs")}
       RETURNING claim_id`,
      [
        claimId,
        spec.purpose,
        spec.inclusion,
        spec.exclusion ?? null,
        spec.ordering ?? null,
        spec.entry_kinds ?? [],
        createdBy,
        currentLabel(),
      ]
    ),
    "this list's specification"
  );
}

/**
 * Restate a list's specification under the same identity: clearer words for
 * the same criteria. A change to what qualifies makes another list (§7b),
 * which the Steward says in its reasoning and the Curator splits.
 */
export async function restateListSpec(input: { claimId: string; spec: ListSpecInput; createdBy: string }): Promise<void> {
  const spec = parseListSpec(input.spec);
  await withTransaction(async (tx) => {
    await requireKind(tx, input.claimId, "artifact");
    await refuseWhereALayerBelowHoldsIt(tx, "artifact_specs", { claim_id: input.claimId }, "this list's specification");
    await writeSpec(tx, input.claimId, spec, input.createdBy);
  });
}

async function specOf(tx: TxQuery, claimId: string): Promise<{ entry_kinds: string[] } | null> {
  const [row] = await tx.query<{ entry_kinds: string[] }>(
    `SELECT entry_kinds FROM artifact_specs s WHERE claim_id = $1${oneSpecForArtifactSql("s")}`,
    [claimId]
  );
  return row ?? null;
}

/**
 * Put a node on a list, or change why it is there. The note says, against
 * the criteria, why the entry qualifies; it is shown beside the entry.
 */
export async function addListEntry(input: {
  artifactId: string;
  nodeId: string;
  note: string;
  createdBy: string;
}): Promise<{ id: string }> {
  if (!input.note.trim()) throw new KindError("Say why the entry meets the list's criteria.");
  if (input.artifactId === input.nodeId) throw new KindError("A list is not an entry of itself.");
  return withTransaction(async (tx) => {
    await requireKind(tx, input.artifactId, "artifact");
    const kind = await lockNodeKind(tx, input.nodeId);
    if (kind === "artifact") throw new KindError("A list draws on claims, quantities and questions, not on other lists.");
    const spec = await specOf(tx, input.artifactId);
    if (spec && spec.entry_kinds.length > 0 && !spec.entry_kinds.includes(kind)) {
      throw new KindError(`This list's entries are ${spec.entry_kinds.join(" or ")}; node ${input.nodeId} is a ${kind}.`);
    }
    await refuseWhereALayerBelowHoldsIt(
      tx,
      "claim_relationships",
      { parent_claim_id: input.artifactId, child_claim_id: input.nodeId, relation_type: DRAWS_ON },
      "this entry of the list"
    );
    const [row] = writtenAtOwnLabel(
      await tx.query<{ id: string }>(
        `INSERT INTO claim_relationships
           (parent_claim_id, child_claim_id, relation_type, reasoning, created_by, sensitivity_label)
         VALUES ($1, $2, '${DRAWS_ON}', $3, $4, $5)
         ON CONFLICT (parent_claim_id, child_claim_id, relation_type, sensitivity_label, origin) DO UPDATE
           SET reasoning = EXCLUDED.reasoning
         ${sameLabelOnly("claim_relationships")}
         RETURNING id`,
        [input.artifactId, input.nodeId, input.note.trim(), input.createdBy, currentLabel()]
      ),
      "this entry of the list"
    );
    return { id: row!.id };
  });
}

/** Take a node off a list. Whoever does says why, in the judgment's left_out or the decision log. */
export async function removeListEntry(input: { artifactId: string; nodeId: string }): Promise<boolean> {
  return withTransaction(async (tx) => {
    await requireKind(tx, input.artifactId, "artifact");
    await refuseWhereALayerBelowHoldsIt(
      tx,
      "claim_relationships",
      { parent_claim_id: input.artifactId, child_claim_id: input.nodeId, relation_type: DRAWS_ON },
      "this entry of the list"
    );
    const rows = await tx.query<{ id: string }>(
      `DELETE FROM claim_relationships
        WHERE parent_claim_id = $1 AND child_claim_id = $2 AND relation_type = '${DRAWS_ON}'
          AND sensitivity_label = $3 AND origin = 'local'
        RETURNING id`,
      [input.artifactId, input.nodeId, currentLabel()]
    );
    return rows.length > 0;
  });
}

async function entryIds(tx: TxQuery, artifactId: string): Promise<Set<string>> {
  const rows = await tx.query<{ child_claim_id: string }>(
    `SELECT child_claim_id FROM claim_relationships WHERE parent_claim_id = $1 AND relation_type = '${DRAWS_ON}'`,
    [artifactId]
  );
  return new Set(rows.map((r) => r.child_claim_id));
}

/**
 * Record a list's judgment: its fidelity to what it draws on under its
 * specification, the order its entries are shown in, and what was
 * considered and left out (§7b).
 */
export async function recordListAssessment(input: {
  claimId: string;
  fidelity: ArtifactFidelity;
  summary?: string | null;
  reasoningTrace: string;
  gaps?: string | null;
  entryOrder?: string[];
  leftOut?: LeftOut;
  confidence?: number | null;
  marginalYield?: number | null;
  model?: string | null;
  fundedByJobId?: string | null;
  trigger?: string | null;
  triggerContext?: string | null;
}): Promise<{ id: string }> {
  if (!(ARTIFACT_FIDELITIES as readonly string[]).includes(input.fidelity)) {
    throw new KindError(`Unknown fidelity "${input.fidelity}"; one of ${ARTIFACT_FIDELITIES.join(", ")}.`);
  }
  if (!input.reasoningTrace.trim()) throw new KindError("An assessment records its reasoning");
  if (input.fidelity === "incomplete" && !input.gaps?.trim()) {
    throw new KindError("An incomplete list says what it is missing, in gaps.");
  }
  const leftOut = leftOutSchema.safeParse(input.leftOut ?? []);
  if (!leftOut.success) throw new KindError("left_out is a list of { node_id, reason }, each with a reason.");
  const order = [...new Set(input.entryOrder ?? [])];
  if (await publicGraphJudges(input.claimId)) throw new KindError(publicJudgmentMessage("An assessment of it"));
  return withTransaction(async (tx) => {
    await requireKind(tx, input.claimId, "artifact");
    const entries = await entryIds(tx, input.claimId);
    const stray = order.filter((id) => !entries.has(id));
    if (stray.length > 0) {
      throw new KindError(`entry_order names nodes that are not entries of this list: ${stray.join(", ")}. Add them first, or leave them out.`);
    }
    const both = leftOut.data.filter((l) => entries.has(l.node_id)).map((l) => l.node_id);
    if (both.length > 0) {
      throw new KindError(`A node is either on the list or left out of it, not both: ${both.join(", ")}.`);
    }
    await tx.query(
      `UPDATE artifact_assessments SET is_current = false
        WHERE claim_id = $1 AND is_current = true AND sensitivity_label = $2`,
      [input.claimId, currentLabel()]
    );
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO artifact_assessments
         (claim_id, fidelity, summary, reasoning_trace, gaps, entry_order, left_out, confidence, marginal_yield,
          model, funded_by_job_id, trigger, trigger_context, run_id, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [
        input.claimId,
        input.fidelity,
        input.summary ?? null,
        input.reasoningTrace,
        input.gaps ?? null,
        order,
        JSON.stringify(leftOut.data),
        input.confidence ?? null,
        input.marginalYield ?? null,
        input.model ?? null,
        input.fundedByJobId ?? null,
        input.trigger ?? null,
        input.triggerContext ?? null,
        getUsageContext().runId ?? null,
        currentLabel(),
      ]
    );
    await recordJudgmentInputs(tx.query, "artifact_assessment", row!.id, input.claimId);
    await recordMadeBeside(tx.query, "artifact_assessments", "artifact_assessment", row!.id, input.claimId);
    return { id: row!.id };
  });
}

// ---------------------------------------------------------------------------
// Reads, in the shape the API serves (web/lib/types.ts ListDetail).
// ---------------------------------------------------------------------------

export interface ListSpecView {
  subtype: "list";
  purpose: string;
  inclusion: string;
  exclusion: string | null;
  ordering: string | null;
  entry_kinds: string[];
}

export interface ListEntryView {
  id: string;
  text: string;
  kind: NodeKind;
  /** Why it qualifies, in the Steward's words. */
  note: string;
  status: string | null;
  credence: number | null;
  standing: string | null;
  estimate: QuantityEstimate | null;
  unit: QuantityUnit | null;
  /** Its verdict moved after the list was last judged, or it joined the list since: the list has not looked at it as it is. */
  changed_since: boolean;
  judgments_in_force?: number;
  label?: string;
}

export interface ListLeftOutView {
  id: string;
  text: string | null;
  kind: NodeKind | null;
  reason: string;
}

export interface ListAssessmentView {
  id: string;
  fidelity: ArtifactFidelity;
  summary: string | null;
  reasoning_trace: string;
  gaps: string | null;
  confidence: number | null;
  model: string | null;
  run_id: string | null;
  assessed_at: string;
}

export interface ListDetailView {
  spec: ListSpecView | null;
  fidelity: ArtifactFidelity | null;
  assessment: ListAssessmentView | null;
  entries: ListEntryView[];
  left_out: ListLeftOutView[];
  /**
   * Whether what the list draws on has moved since it was judged: an entry
   * whose verdict changed, one added or taken off. Null when it has not been
   * judged, or its judgment has no record to compare.
   */
  stale: boolean | null;
  /** How many entries moved, joined or left since the judgment. */
  changed_entries: number;
}

export async function getListSpec(claimId: string): Promise<ListSpecView | null> {
  const [row] = await rawQuery<ListSpecView>(
    `SELECT subtype, purpose, inclusion, exclusion, ordering, entry_kinds
       FROM artifact_specs s WHERE claim_id = $1${oneSpecForArtifactSql("s")}`,
    [claimId]
  );
  return row ?? null;
}

export async function getListDetail(claimId: string): Promise<ListDetailView> {
  const [spec, current, entries, inputs] = await Promise.all([
    getListSpec(claimId),
    rawQuery<ListAssessmentView & { entry_order: string[]; left_out: LeftOut }>(
      `SELECT id, fidelity, summary, reasoning_trace, gaps, confidence, model, run_id, assessed_at,
              entry_order::text[] AS entry_order, left_out
         FROM artifact_assessments_in_force WHERE claim_id = $1`,
      [claimId]
    ),
    rawQuery<Omit<ListEntryView, "changed_since"> & { added_at: Date }>(
      // An entry held at two layers is listed once, by the lowest layer's row (layer-service.ts).
      `SELECT c.id, c.text, c.kind, r.reasoning AS note, r.created_at AS added_at,
              a.status, a.claim_credence AS credence, qa.standing, qe.estimate, qd.unit${
                layered() ? ", r.sensitivity_label AS label" : ""
              }
         FROM claim_relationships r
         JOIN claims c ON c.id = r.child_claim_id AND c.state = 'active'
         LEFT JOIN assessments_in_force a ON a.claim_id = c.id
         LEFT JOIN question_assessments_in_force qa ON qa.claim_id = c.id
         LEFT JOIN quantity_estimates_in_force qe ON qe.claim_id = c.id
         LEFT JOIN quantity_definitions qd ON qd.claim_id = c.id${oneDefinitionForQuantitySql("qd")}
        WHERE r.parent_claim_id = $1 AND r.relation_type = '${DRAWS_ON}'${
          layered() ? ` AND ${lowerRowSql("claim_relationships", "r", ["parent_claim_id", "child_claim_id", "relation_type"])} IS NULL` : ""
        }
        ORDER BY r.created_at, r.id`,
      [claimId]
    ),
    getJudgmentInputs(claimId),
  ]);
  const cur = current[0] ?? null;
  // What moved under the judgment, entry by entry (judgment-inputs-service.ts).
  const moved = new Set<string>();
  let removed = 0;
  if (cur && inputs?.recorded) {
    for (const p of inputs.premises) {
      if (p.relation !== DRAWS_ON) continue;
      if (p.state === "removed") removed += 1;
      else if (p.moved) moved.add(p.node_id);
    }
    for (const p of inputs.premises_added) if (p.relation === DRAWS_ON) moved.add(p.node_id);
  }
  const rank = new Map((cur?.entry_order ?? []).map((id, i) => [id, i]));
  const shown: ListEntryView[] = entries
    .map(({ added_at: _added, ...e }) => ({ ...e, changed_since: moved.has(e.id) }))
    // The Steward's order first; an entry it has not placed (added since) after, in the order it joined.
    .sort((x, y) => (rank.get(x.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(y.id) ?? Number.MAX_SAFE_INTEGER));
  const leftOutRaw = cur?.left_out ?? [];
  const leftOutNodes = leftOutRaw.length
    ? await rawQuery<{ id: string; text: string; kind: NodeKind }>(
        `SELECT id, text, kind FROM claims WHERE id = ANY($1::uuid[])`,
        [leftOutRaw.map((l) => l.node_id)]
      )
    : [];
  const byId = new Map(leftOutNodes.map((n) => [n.id, n]));
  const changed = moved.size + removed;
  const detail: ListDetailView = {
    spec,
    fidelity: cur?.fidelity ?? null,
    assessment: cur
      ? {
          id: cur.id,
          fidelity: cur.fidelity,
          summary: cur.summary,
          reasoning_trace: cur.reasoning_trace,
          gaps: cur.gaps,
          confidence: cur.confidence,
          model: cur.model,
          run_id: cur.run_id ?? null,
          assessed_at: new Date(cur.assessed_at).toISOString(),
        }
      : null,
    entries: shown,
    left_out: leftOutRaw.map((l) => ({
      id: l.node_id,
      text: byId.get(l.node_id)?.text ?? null,
      kind: byId.get(l.node_id)?.kind ?? null,
      reason: l.reason,
    })),
    stale: cur && inputs?.recorded ? changed > 0 : null,
    changed_entries: changed,
  };
  await markSeveralInForce(detail.entries, (n) => n.id);
  return detail;
}
