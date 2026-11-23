/**
 * Safety cases (constitution §7b, #1211): the second artifact kind with a
 * suggested structure, after lists (artifact-service.ts).
 *
 * A safety case argues one conclusion about one system in one deployment,
 * to a stated standard. It is a claims row of kind 'artifact' with:
 *   - its specification in artifact_specs (subtype 'safety_case'): the
 *     system and the deployment, the claim it argues for, the standard that
 *     conclusion has to meet and whose it is, the framework it follows, and
 *     what it does not cover. The specification is the case's identity: a
 *     later model or another deployment is another case.
 *   - its structure in case_elements, as its Steward writes it: claims,
 *     argument steps with their building block, side claims, evidence, and
 *     defeaters with where each stands. Every element but a step points at
 *     the graph node it presents. Nothing here is computed over the graph:
 *     which nodes the case draws on, how it uses each, and where each doubt
 *     stands are the Steward's judgments.
 *   - a 'draws_on' edge to each node an element points at, kept here beside
 *     the elements, so propagation reaches the case when one changes and
 *     judgment_inputs records what a judgment was made against.
 *   - its judgment in artifact_assessments, in two parts: how far the case
 *     can be relied on as a piece of work (the fidelity every artifact has),
 *     and whether it establishes its conclusion to its standard (the
 *     verdict). The burden is on the case. The verdict is a statement about
 *     the case and changes nothing in the assessment of any node it draws
 *     on, the conclusion's included.
 *
 * The graph has no defeaters. A defeater is the case's name for the part an
 * ordinary claim plays in its structure; the claim keeps the graph's own
 * assessment, and the assessment is not the standing.
 *
 * case-form.ts checks form; this file holds the invariants of storage.
 */
import { generateEmbedding } from "./embedding-service.js";
import { sameLabelOnly, writtenAtOwnLabel } from "../db/clearance.js";
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { claims } from "../db/schema.js";
import { loadConfig } from "../config.js";
import { currentLabel, getUsageContext } from "../llm/usage-context.js";
import {
  ARTIFACT_FIDELITIES,
  CASE_BLOCKS,
  CASE_ELEMENT_TYPES,
  CASE_VERDICTS,
  DEFEATER_STANDINGS,
  DRAWS_ON,
  caseSpecSchema,
  type ArtifactFidelity,
  type ArtifactSubtype,
  type CaseBlock,
  type CaseElementType,
  type CaseSpecInput,
  type CaseVerdict,
  type DefeaterStanding,
  type NodeKind,
} from "../schemas/kinds.js";
import { oneSpecForArtifactSql, SAME_LIST_SIMILARITY } from "./artifact-service.js";
import {
  CASE_EXPORT_FORMAT,
  checkCaseForm,
  countsAgainst,
  misplacement,
  type CaseExport,
  type CaseExportElement,
  type CaseNodeRef,
  type CountsAgainst,
  type FormFailure,
} from "./case-form.js";
import { getJudgmentInputs, recordJudgmentInputs } from "./judgment-inputs-service.js";
import { markSeveralInForce, recordMadeBeside } from "./judgment-version-service.js";
import { publicGraphJudges, publicJudgmentMessage } from "./mirrored-node-service.js";
import { KindError, requireKind } from "./node-kind.js";
import { enqueueClaimPipeline } from "./queue-service.js";

/** Which artifact a node is: its specification's subtype, or null for a node that is no artifact or has no specification. */
export async function artifactSubtypeOf(claimId: string): Promise<ArtifactSubtype | null> {
  const [row] = await rawQuery<{ subtype: ArtifactSubtype }>(
    `SELECT subtype FROM artifact_specs s WHERE claim_id = $1${oneSpecForArtifactSql("s")}`,
    [claimId]
  );
  return row?.subtype ?? null;
}

/** Parse a case's specification, with the refusal written for whoever sent it. */
export function parseCaseSpec(raw: unknown): CaseSpecInput {
  const parsed = caseSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new KindError(
      "A safety case's specification names the system, the deployment, the claim it argues for (conclusion_claim_id), " +
        "the standard and whose standard it is (standard_of), and the framework: " +
        parsed.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ")
    );
  }
  return parsed.data;
}

/** The words a case's identity is matched on: its title and its specification. */
export function caseSpecText(title: string, spec: CaseSpecInput, conclusion: string): string {
  return [
    title,
    `System: ${spec.system}`,
    `Deployment: ${spec.deployment}`,
    `Argues that: ${conclusion}`,
    `To the standard: ${spec.standard} (${spec.standard_of})`,
    spec.not_covered ? `Does not cover: ${spec.not_covered}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A case the graph already holds whose specification reads close to a proposed one. */
export interface SimilarCase {
  id: string;
  text: string;
  system: string;
  deployment: string;
  similarity: number;
}

/** The identity gate for a case (§7b): the cases whose specifications read closest. Shown to whoever proposes, never merged on its own. */
export async function similarCases(embedding: number[], limit = 5): Promise<SimilarCase[]> {
  return rawQuery<SimilarCase>(
    `SELECT c.id, c.text, s.system, s.deployment, (1 - (c.embedding <=> $1::vector))::float8 AS similarity
       FROM claims c
       JOIN artifact_specs s ON s.claim_id = c.id AND s.subtype = 'safety_case'${oneSpecForArtifactSql("s")}
      WHERE c.kind = 'artifact' AND c.state = 'active' AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> $1::vector
      LIMIT $2`,
    [JSON.stringify(embedding), limit]
  );
}

async function conclusionOf(claimId: string): Promise<{ id: string; text: string }> {
  const [row] = await rawQuery<{ id: string; text: string; kind: NodeKind; state: string }>(
    `SELECT id, text, kind, state FROM claims WHERE id = $1`,
    [claimId]
  );
  if (!row || row.state !== "active") {
    throw new KindError(
      `No active claim ${claimId}. A case argues for a claim the graph holds: propose the conclusion as a claim first, then name it here.`
    );
  }
  if (row.kind !== "claim") {
    throw new KindError(`Node ${claimId} is a ${row.kind}. A case's conclusion is a claim: a proposition the case can establish or fail to.`);
  }
  return row;
}

/**
 * Propose a safety case: mint the node, its specification and its top
 * claim, and hand it to its Steward. Where a case whose specification
 * reads very close already exists, nothing is minted unless `confirmNew`
 * says it is another case; the near ones come back either way.
 */
export async function proposeCase(input: {
  title: string;
  spec: CaseSpecInput;
  createdBy: string;
  importance?: number;
  confirmNew?: boolean;
}): Promise<{ id: string | null; similar: SimilarCase[] }> {
  const title = input.title.trim();
  if (!title) throw new KindError("A safety case needs a title: what it argues, of what, in a line.");
  const spec = parseCaseSpec(input.spec);
  const conclusion = await conclusionOf(spec.conclusion_claim_id);
  let embedding: number[] | undefined;
  try {
    embedding = await generateEmbedding(caseSpecText(title, spec, conclusion.text));
  } catch {
    // Continue without an embedding, as a new list does; the gate then has nothing to compare.
  }
  const similar = embedding ? await similarCases(embedding) : [];
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
    // The top claim: the conclusion, as the graph holds it.
    await tx.query(
      `INSERT INTO case_elements (case_id, element_type, node_id, statement, created_by, sensitivity_label)
       VALUES ($1, 'claim', $2, $3, $4, $5)`,
      [created!.id, conclusion.id, "The conclusion the case argues for.", input.createdBy, currentLabel()]
    );
    await syncDrawsOn(tx, created!.id, input.createdBy);
    return created!.id;
  });
  if (!gated) await enqueueClaimPipeline({ claimId: id, jobId: "steward" });
  return { id, similar: similar.filter((s) => s.id !== id) };
}

async function writeSpec(tx: TxQuery, claimId: string, spec: CaseSpecInput, createdBy: string): Promise<void> {
  writtenAtOwnLabel(
    await tx.query<{ claim_id: string }>(
      `INSERT INTO artifact_specs
         (claim_id, subtype, system, deployment, conclusion_claim_id, standard, standard_of, framework, not_covered,
          created_by, sensitivity_label)
       VALUES ($1, 'safety_case', $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (claim_id, sensitivity_label, origin) DO UPDATE
         SET system = EXCLUDED.system, deployment = EXCLUDED.deployment, standard = EXCLUDED.standard,
             standard_of = EXCLUDED.standard_of, not_covered = EXCLUDED.not_covered, updated_at = now()
       ${sameLabelOnly("artifact_specs")}
       RETURNING claim_id`,
      [
        claimId,
        spec.system,
        spec.deployment,
        spec.conclusion_claim_id,
        spec.standard,
        spec.standard_of,
        spec.framework,
        spec.not_covered ?? null,
        createdBy,
        currentLabel(),
      ]
    ),
    "this case's specification"
  );
}

async function requireCase(tx: TxQuery, caseId: string): Promise<{ conclusion_claim_id: string; framework: string }> {
  await requireKind(tx, caseId, "artifact");
  const [spec] = await tx.query<{ subtype: string; conclusion_claim_id: string; framework: string }>(
    `SELECT subtype, conclusion_claim_id, framework FROM artifact_specs s WHERE claim_id = $1${oneSpecForArtifactSql("s")}`,
    [caseId]
  );
  if (!spec || spec.subtype !== "safety_case") throw new KindError(`Node ${caseId} is not a safety case.`);
  return spec;
}

/**
 * Restate a case's specification under the same identity: clearer words
 * for the same system, deployment and standard. The conclusion and the
 * framework are not restated: a case for another conclusion is another
 * case (§7b), which the Steward says and the Curator splits.
 */
export async function restateCaseSpec(input: {
  claimId: string;
  spec: Omit<CaseSpecInput, "conclusion_claim_id" | "framework">;
  createdBy: string;
}): Promise<void> {
  await withTransaction(async (tx) => {
    const current = await requireCase(tx, input.claimId);
    const spec = parseCaseSpec({
      ...input.spec,
      conclusion_claim_id: current.conclusion_claim_id,
      framework: current.framework,
    });
    const [own] = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM artifact_specs WHERE claim_id = $1 AND sensitivity_label = $2 AND origin = 'local'`,
      [input.claimId, currentLabel()]
    );
    if ((own?.n ?? 0) === 0) {
      throw new KindError(
        "This case's specification was written at another label than this work's, and work at one label does not " +
          "change what another wrote. Say what should change to the case's Steward at that label."
      );
    }
    await writeSpec(tx, input.claimId, spec, input.createdBy);
  });
}

// ---------------------------------------------------------------------------
// The structure
// ---------------------------------------------------------------------------

interface ElementRow {
  id: string;
  case_id: string;
  element_type: CaseElementType;
  parent_id: string | null;
  node_id: string | null;
  label: string;
  origin: string;
}

async function elementOf(tx: TxQuery, caseId: string, elementId: string): Promise<ElementRow> {
  const [row] = await tx.query<ElementRow>(
    `SELECT id, case_id, element_type, parent_id, node_id, sensitivity_label AS label, origin
       FROM case_elements WHERE id::text = $1 AND case_id = $2`,
    [elementId, caseId]
  );
  if (!row) throw new KindError(`This case holds no element ${elementId}.`);
  return row;
}

/** A row this work may change: one it wrote, at its own label. A label does not edit what it reads (§29). */
function requireOwn(row: ElementRow): void {
  if (row.label === currentLabel() && row.origin === "local") return;
  throw new KindError(
    `Element ${row.id} was written at another label than this work's, or by the public graph. Work at one label does ` +
      `not change what another wrote: add an element of your own, a defeater of this one where you doubt it.`
  );
}

/**
 * Keep the case's 'draws_on' edges beside its elements: one for each node
 * an element points at, none for a node no element points at. Only this
 * work's own edges are written or removed.
 */
async function syncDrawsOn(tx: TxQuery, caseId: string, createdBy: string): Promise<void> {
  const label = currentLabel();
  // sameLabelOnly: the key holds the label, so an edge this conflicts with is this label's own.
  await tx.query(
    `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning, created_by, sensitivity_label)
     SELECT $1, e.node_id, '${DRAWS_ON}', (array_agg(e.statement ORDER BY e.created_at, e.id))[1], $2, $3
       FROM case_elements e
      WHERE e.case_id = $1 AND e.node_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM claim_relationships r
                         WHERE r.parent_claim_id = $1 AND r.child_claim_id = e.node_id AND r.relation_type = '${DRAWS_ON}')
      GROUP BY e.node_id
     ON CONFLICT (parent_claim_id, child_claim_id, relation_type, sensitivity_label, origin) DO UPDATE
       SET reasoning = EXCLUDED.reasoning
     ${sameLabelOnly("claim_relationships")}`,
    [caseId, createdBy, label]
  );
  await tx.query(
    `DELETE FROM claim_relationships r
      WHERE r.parent_claim_id = $1 AND r.relation_type = '${DRAWS_ON}' AND r.sensitivity_label = $2 AND r.origin = 'local'
        AND NOT EXISTS (SELECT 1 FROM case_elements e WHERE e.case_id = $1 AND e.node_id = r.child_claim_id)`,
    [caseId, label]
  );
}

export interface CaseElementInput {
  caseId: string;
  /** Given to revise an element; omitted to add one. */
  elementId?: string | null;
  type: CaseElementType;
  /** The element it hangs under. Not changed by a revision. */
  parentId?: string | null;
  /** The graph node it presents: required of every element but a step. */
  nodeId?: string | null;
  /** A step: the argument it reads, where the graph holds one. */
  argumentId?: string | null;
  /** A step: its building block. */
  block?: CaseBlock | null;
  /** A step: the inference in words. Any other element: what the case needs of the node. */
  statement: string;
  departure?: string | null;
  raisedInPublished?: boolean | null;
  position?: number | null;
  createdBy: string;
}

/**
 * Add an element to a case's structure, or revise one. What is refused
 * here is what would not be a structure at all (a step with no block, an
 * element under something it cannot hang under, a node that is not there).
 * Whether the structure is well formed under its framework is reported by
 * the form check and refuses nothing.
 */
export async function writeCaseElement(input: CaseElementInput): Promise<{ id: string }> {
  if (!(CASE_ELEMENT_TYPES as readonly string[]).includes(input.type)) {
    throw new KindError(`Unknown element "${input.type}"; one of ${CASE_ELEMENT_TYPES.join(", ")}.`);
  }
  const statement = input.statement.trim();
  if (!statement) {
    throw new KindError(
      input.type === "step"
        ? "A step states its inference in words."
        : "Say what the case needs of this node: the part it plays here, in a sentence."
    );
  }
  const isStep = input.type === "step";
  if (isStep && !(CASE_BLOCKS as readonly string[]).includes(input.block ?? "")) {
    throw new KindError(`A step is one of the framework's building blocks: ${CASE_BLOCKS.join(", ")}.`);
  }
  if (isStep && input.nodeId) throw new KindError("A step presents no node; name the argument it reads in argument_id, where the graph holds one.");
  if (!isStep && !input.nodeId) {
    throw new KindError(
      `A ${input.type.replace(/_/g, " ")} presents a node the graph holds. Where the graph lacks it, propose it first (match_claim), ` +
        `worded to stand on its own, then name it here.`
    );
  }
  if (!isStep && (input.block || input.argumentId)) throw new KindError("Only a step has a building block or reads an argument.");
  return withTransaction(async (tx) => {
    await requireCase(tx, input.caseId);
    if (input.nodeId) {
      if (input.nodeId === input.caseId) throw new KindError("A case is not an element of itself.");
      const [node] = await tx.query<{ kind: NodeKind; state: string }>(`SELECT kind, state FROM claims WHERE id::text = $1`, [input.nodeId]);
      if (!node || node.state !== "active") throw new KindError(`No active node ${input.nodeId}.`);
      if (node.kind !== "claim" && node.kind !== "quantity") {
        throw new KindError(`Node ${input.nodeId} is a ${node.kind}. A case's elements present claims, and quantities where a claim is about a value.`);
      }
    }
    if (input.argumentId) {
      const [arg] = await tx.query(`SELECT 1 FROM arguments WHERE id::text = $1 AND retired_at IS NULL`, [input.argumentId]);
      if (!arg) throw new KindError(`No argument ${input.argumentId} stands in the graph.`);
    }
    const label = currentLabel();
    let id: string;
    if (input.elementId) {
      const row = await elementOf(tx, input.caseId, input.elementId);
      requireOwn(row);
      if (row.element_type !== input.type) {
        throw new KindError(`Element ${row.id} is a ${row.element_type.replace(/_/g, " ")}; an element keeps its kind. Remove it and add the other.`);
      }
      if (row.parent_id === null && input.nodeId !== row.node_id) {
        throw new KindError("The top claim is the case's conclusion, which is its identity. A case for another conclusion is another case.");
      }
      await tx.query(
        `UPDATE case_elements
            SET node_id = $2, argument_id = $3, block = $4, statement = $5, departure = $6, raised_in_published = $7,
                position = COALESCE($8, position), updated_at = now()
          WHERE id = $1`,
        [row.id, input.nodeId ?? null, input.argumentId ?? null, input.block ?? null, statement, input.departure?.trim() || null,
         input.raisedInPublished ?? null, input.position ?? null]
      );
      id = row.id;
    } else {
      if (!input.parentId) throw new KindError("Say what the element hangs under (parent_id). Only the case's top claim hangs under nothing, and the case has it.");
      const parent = await elementOf(tx, input.caseId, input.parentId);
      const wrong = misplacement(input.type, parent.element_type);
      if (wrong) throw new KindError(wrong);
      const [created] = await tx.query<{ id: string }>(
        `INSERT INTO case_elements
           (case_id, element_type, parent_id, node_id, argument_id, block, statement, standing, departure, raised_in_published,
            position, created_by, sensitivity_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 COALESCE($11, (SELECT COALESCE(max(position), 0) + 1 FROM case_elements WHERE parent_id = $3)), $12, $13)
         RETURNING id`,
        [input.caseId, input.type, parent.id, input.nodeId ?? null, input.argumentId ?? null, input.block ?? null, statement,
         input.type === "defeater" ? "open" : null, input.departure?.trim() || null, input.raisedInPublished ?? null,
         input.position ?? null, input.createdBy, label]
      );
      id = created!.id;
    }
    await syncDrawsOn(tx, input.caseId, input.createdBy);
    return { id };
  });
}

/** Take an element out of the structure, with everything that hangs under it. The top claim stays. */
export async function removeCaseElement(input: { caseId: string; elementId: string; createdBy: string }): Promise<{ removed: number }> {
  return withTransaction(async (tx) => {
    await requireCase(tx, input.caseId);
    const row = await elementOf(tx, input.caseId, input.elementId);
    requireOwn(row);
    if (row.parent_id === null) throw new KindError("The top claim is the case's conclusion and stays.");
    const under = await tx.query<{ id: string; label: string; origin: string }>(
      `WITH RECURSIVE sub AS (
         SELECT id, sensitivity_label, origin FROM case_elements WHERE id = $1
         UNION ALL
         SELECT e.id, e.sensitivity_label, e.origin FROM case_elements e JOIN sub ON e.parent_id = sub.id)
       SELECT id, sensitivity_label AS label, origin FROM sub`,
      [row.id]
    );
    if (under.some((u) => u.label !== currentLabel() || u.origin !== "local")) {
      throw new KindError("Something under this element was written at another label, and removing this would remove it. It stays.");
    }
    await tx.query(`DELETE FROM case_elements WHERE id = $1`, [row.id]);
    await syncDrawsOn(tx, input.caseId, input.createdBy);
    return { removed: under.length };
  });
}

/**
 * Record where a defeater stands in the case. The standing is the
 * Steward's judgment with the claim's own assessment in front of it, and
 * the assessment is not the standing: a doubt the graph finds inconclusive
 * is still open against a case that carries the burden.
 */
export async function setDefeaterStanding(input: {
  caseId: string;
  elementId: string;
  standing: DefeaterStanding;
  reason: string;
  /** For a sustained defeater the case proceeds past: who accepted it as a residual doubt, and why. */
  acceptedBy?: string | null;
  acceptance?: string | null;
}): Promise<void> {
  if (!(DEFEATER_STANDINGS as readonly string[]).includes(input.standing)) {
    throw new KindError(`Unknown standing "${input.standing}"; one of ${DEFEATER_STANDINGS.join(", ")}.`);
  }
  if (!input.reason.trim()) throw new KindError("Say why the defeater stands as it does.");
  const acceptedBy = input.acceptedBy?.trim() || null;
  const acceptance = input.acceptance?.trim() || null;
  if (acceptedBy && input.standing !== "sustained") {
    throw new KindError("Only a sustained defeater is accepted as a residual doubt: an answered one needs no acceptance, and an open one is not yet settled.");
  }
  if (acceptedBy && !acceptance) throw new KindError("A residual doubt records why it was accepted, and where the party that accepted it said so.");
  if (!acceptedBy && acceptance) throw new KindError("Say who accepted the doubt (accepted_by).");
  await withTransaction(async (tx) => {
    await requireCase(tx, input.caseId);
    const row = await elementOf(tx, input.caseId, input.elementId);
    requireOwn(row);
    if (row.element_type !== "defeater") throw new KindError(`Element ${row.id} is a ${row.element_type.replace(/_/g, " ")}, not a defeater.`);
    if (input.standing === "answered") {
      const [answer] = await tx.query(`SELECT 1 FROM case_elements WHERE parent_id = $1 AND element_type = 'claim' LIMIT 1`, [row.id]);
      if (!answer) {
        throw new KindError(
          "A defeater is answered by a subcase: add under it the claim that answers it, with the step and evidence that argue for that claim, then record it as answered."
        );
      }
    }
    await tx.query(
      `UPDATE case_elements SET standing = $2, standing_reason = $3, accepted_by = $4, acceptance = $5, updated_at = now() WHERE id = $1`,
      [row.id, input.standing, input.reason.trim(), acceptedBy, acceptance]
    );
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface CaseSpecView {
  subtype: "safety_case";
  system: string;
  deployment: string;
  conclusion_claim_id: string;
  standard: string;
  standard_of: string;
  framework: string;
  not_covered: string | null;
}

export async function getCaseSpec(claimId: string): Promise<CaseSpecView | null> {
  const [row] = await rawQuery<CaseSpecView>(
    `SELECT subtype, system, deployment, conclusion_claim_id, standard, standard_of, framework, not_covered
       FROM artifact_specs s WHERE claim_id = $1 AND subtype = 'safety_case'${oneSpecForArtifactSql("s")}`,
    [claimId]
  );
  return row ?? null;
}

export interface CaseElementView extends CaseExportElement {
  position: number;
  /** The node's verdict moved after the case was last judged, or the node joined the case since. */
  changed_since: boolean;
  label?: string;
}

export interface CaseAssessmentView {
  id: string;
  fidelity: ArtifactFidelity;
  verdict: CaseVerdict | null;
  verdict_basis: string | null;
  would_change: string | null;
  summary: string | null;
  reasoning_trace: string;
  gaps: string | null;
  confidence: number | null;
  model: string | null;
  run_id: string | null;
  assessed_at: string;
}

export interface CaseDetailView {
  spec: CaseSpecView | null;
  /** The conclusion as the graph holds it, with the graph's own assessment of it: not the case's verdict. */
  conclusion: CaseNodeRef | null;
  fidelity: ArtifactFidelity | null;
  /** Whether the case establishes its conclusion to its standard. Null until it is judged. */
  verdict: CaseVerdict | null;
  assessment: CaseAssessmentView | null;
  elements: CaseElementView[];
  /** The form under the case's framework, as it stands now. */
  form: { framework: string; well_formed: boolean; failures: FormFailure[] };
  /** What counts against the case under its own burden, as far as its structure shows it. */
  counts_against: CountsAgainst[];
  /** Sustained defeaters accepted as residual doubts, by element. */
  residual_doubts: string[];
  /** What the structure holds that the developer's published case never raised, by element. Empty where none is being read in. */
  not_raised_in_published: string[];
  stale: boolean | null;
  changed_nodes: number;
}

interface ElementReadRow {
  id: string;
  type: CaseElementType;
  parent: string | null;
  block: string | null;
  statement: string;
  argument_id: string | null;
  standing: string | null;
  standing_reason: string | null;
  accepted_by: string | null;
  acceptance: string | null;
  departure: string | null;
  raised_in_published: boolean | null;
  position: number;
  label: string;
  node_id: string | null;
  node_kind: NodeKind | null;
  node_text: string | null;
  status: string | null;
  credence: number | null;
  estimate: unknown;
}

async function readElements(caseId: string): Promise<ElementReadRow[]> {
  return rawQuery<ElementReadRow>(
    `SELECT e.id, e.element_type AS type, e.parent_id AS parent, e.block, e.statement, e.argument_id,
            e.standing, e.standing_reason, e.accepted_by, e.acceptance, e.departure, e.raised_in_published,
            e.position, e.sensitivity_label AS label,
            c.id AS node_id, c.kind AS node_kind, c.text AS node_text,
            a.status, a.claim_credence AS credence, qe.estimate
       FROM case_elements e
       LEFT JOIN claims c ON c.id = e.node_id
       LEFT JOIN assessments_in_force a ON a.claim_id = c.id
       LEFT JOIN quantity_estimates_in_force qe ON qe.claim_id = c.id
      WHERE e.case_id = $1
      ORDER BY e.position, e.created_at, e.id`,
    [caseId]
  );
}

const pageUrl = (id: string) => `${loadConfig().publicWebBaseUrl.replace(/\/$/, "")}/claims/${id}`;

function nodeRef(r: Pick<ElementReadRow, "node_id" | "node_kind" | "node_text" | "status" | "credence" | "estimate">): CaseNodeRef | null {
  if (!r.node_id || !r.node_kind) return null;
  const judged = r.status !== null || r.estimate !== null;
  return {
    id: r.node_id,
    kind: r.node_kind,
    text: r.node_text ?? "",
    page_url: pageUrl(r.node_id),
    judgment: !judged ? null : r.node_kind === "quantity" ? { estimate: r.estimate } : { status: r.status, credence: r.credence },
  };
}

function toExportElement(r: ElementReadRow): CaseExportElement {
  const base: CaseExportElement = {
    id: r.id,
    type: r.type,
    parent: r.parent,
    statement: r.statement,
    departure: r.departure,
    raised_in_published: r.raised_in_published,
  };
  if (r.type === "step") return { ...base, block: r.block, argument_id: r.argument_id };
  const withNode = { ...base, node: nodeRef(r) };
  if (r.type !== "defeater") return withNode;
  return { ...withNode, standing: r.standing, standing_reason: r.standing_reason, accepted_by: r.accepted_by, acceptance: r.acceptance };
}

interface CurrentRow extends Omit<CaseAssessmentView, "assessed_at"> {
  assessed_at: Date | string;
}

async function currentAssessment(caseId: string): Promise<CurrentRow | null> {
  const [row] = await rawQuery<CurrentRow>(
    `SELECT id, fidelity, verdict, verdict_basis, would_change, summary, reasoning_trace, gaps, confidence, model, run_id, assessed_at
       FROM artifact_assessments_in_force WHERE claim_id = $1`,
    [caseId]
  );
  return row ?? null;
}

export async function getCaseDetail(claimId: string): Promise<CaseDetailView> {
  const [spec, cur, rows, inputs] = await Promise.all([
    getCaseSpec(claimId),
    currentAssessment(claimId),
    readElements(claimId),
    getJudgmentInputs(claimId),
  ]);
  // What moved under the judgment, node by node (judgment-inputs-service.ts), as a list reads it.
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
  const elements: CaseElementView[] = rows.map((r) => ({
    ...toExportElement(r),
    position: r.position,
    changed_since: r.node_id !== null && moved.has(r.node_id),
    label: r.label,
  }));
  const framework = spec?.framework ?? "none";
  const failures = checkCaseForm(elements, framework);
  const top = rows.find((r) => r.parent === null && r.type === "claim");
  const changed = moved.size + removed;
  const readingPublished = elements.some((e) => e.raised_in_published === true);
  const detail: CaseDetailView = {
    spec,
    conclusion: top ? nodeRef(top) : null,
    fidelity: cur?.fidelity ?? null,
    verdict: cur?.verdict ?? null,
    assessment: cur ? { ...cur, run_id: cur.run_id ?? null, assessed_at: new Date(cur.assessed_at).toISOString() } : null,
    elements,
    form: { framework, well_formed: failures.length === 0, failures },
    counts_against: countsAgainst(elements, failures),
    residual_doubts: elements.filter((e) => e.type === "defeater" && e.standing === "sustained" && e.accepted_by).map((e) => e.id),
    not_raised_in_published: readingPublished ? elements.filter((e) => e.raised_in_published === false).map((e) => e.id) : [],
    stale: cur && inputs?.recorded ? changed > 0 : null,
    changed_nodes: changed,
  };
  await markSeveralInForce(
    elements.filter((e) => e.node).map((e) => e.node!),
    (n) => n.id
  );
  return detail;
}

// ---------------------------------------------------------------------------
// The judgment
// ---------------------------------------------------------------------------

/**
 * Record a case's judgment, in its two parts (§7b). The fidelity says how
 * far the case can be relied on as a piece of work. The verdict says
 * whether it establishes its conclusion to its standard, and here the
 * burden is on the case.
 *
 * What is refused is a record that contradicts itself: a case recorded as
 * establishing its conclusion while its own structure holds a defeater it
 * has not settled, a sustained one nobody has accepted, or a failure of
 * form it has not said is a departure. Which standing a defeater has, and
 * whether a departure is warranted, are the Steward's to decide first.
 */
export async function recordCaseAssessment(input: {
  claimId: string;
  fidelity: ArtifactFidelity;
  verdict: CaseVerdict;
  verdictBasis: string;
  wouldChange?: string | null;
  summary?: string | null;
  reasoningTrace: string;
  gaps?: string | null;
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
  if (!(CASE_VERDICTS as readonly string[]).includes(input.verdict)) {
    throw new KindError(`Unknown verdict "${input.verdict}"; one of ${CASE_VERDICTS.join(", ")}.`);
  }
  if (!input.reasoningTrace.trim()) throw new KindError("An assessment records its reasoning");
  if (!input.verdictBasis.trim()) throw new KindError("Say what the verdict rests on: the residual doubts among it.");
  if (input.fidelity === "incomplete" && !input.gaps?.trim()) {
    throw new KindError("An incomplete case says what it is missing, in gaps.");
  }
  if (await publicGraphJudges(input.claimId)) throw new KindError(publicJudgmentMessage("An assessment of it"));
  return withTransaction(async (tx) => {
    const spec = await requireCase(tx, input.claimId);
    if (input.verdict === "established") {
      const elements = (await readElements(input.claimId)).map(toExportElement);
      const against = countsAgainst(elements, checkCaseForm(elements, spec.framework));
      if (against.length > 0) {
        throw new KindError(
          `The case cannot be recorded as establishing its conclusion while its own structure holds what counts against it: ` +
            against.map((a) => `${a.message}${a.element ? ` (element ${a.element})` : ""}`).join(" ") +
            ` Settle each first (answer or sustain a defeater, record who accepted a residual doubt, complete the step or say ` +
            `where the case departs from its framework), or record not_established with what would change it.`
        );
      }
    }
    await tx.query(
      `UPDATE artifact_assessments SET is_current = false
        WHERE claim_id = $1 AND is_current = true AND sensitivity_label = $2`,
      [input.claimId, currentLabel()]
    );
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO artifact_assessments
         (claim_id, fidelity, verdict, verdict_basis, would_change, summary, reasoning_trace, gaps, confidence, marginal_yield,
          model, funded_by_job_id, trigger, trigger_context, run_id, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
      [
        input.claimId,
        input.fidelity,
        input.verdict,
        input.verdictBasis.trim(),
        input.wouldChange?.trim() || null,
        input.summary ?? null,
        input.reasoningTrace,
        input.gaps ?? null,
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
// Export
// ---------------------------------------------------------------------------

/**
 * The case in its framework's form (docs/safety-cases.md, "Export"): every
 * claim, step with its block, side claim, evidence item and defeater with
 * its standing, each carrying the graph node it points at and that node's
 * judgment at the time of export. It is read with the caller's clearance,
 * as the case's page is: a row the caller does not read is not in it.
 * Null for a node that is not a safety case the caller reads.
 */
export async function exportCase(claimId: string): Promise<CaseExport | null> {
  const [node] = await rawQuery<{ id: string; text: string; kind: string; state: string }>(
    `SELECT id, text, kind, state FROM claims WHERE id::text = $1`,
    [claimId]
  );
  if (!node || node.kind !== "artifact") return null;
  const detail = await getCaseDetail(node.id);
  if (!detail.spec || !detail.conclusion) return null;
  const a = detail.assessment;
  return {
    format: CASE_EXPORT_FORMAT,
    exported_at: new Date().toISOString(),
    case: {
      id: node.id,
      title: node.text,
      page_url: pageUrl(node.id),
      system: detail.spec.system,
      deployment: detail.spec.deployment,
      standard: detail.spec.standard,
      standard_of: detail.spec.standard_of,
      framework: detail.spec.framework,
      not_covered: detail.spec.not_covered,
      conclusion: detail.conclusion,
    },
    judgment: a
      ? {
          fidelity: a.fidelity,
          verdict: a.verdict,
          verdict_basis: a.verdict_basis,
          would_change: a.would_change,
          summary: a.summary,
          gaps: a.gaps,
          assessed_at: a.assessed_at,
        }
      : null,
    elements: detail.elements.map(({ position: _p, changed_since: _c, label: _l, ...e }) => e),
    form: detail.form,
  };
}

/**
 * An artifact's record as a read of its node serves it: `list` for a list,
 * `safety_case` for a safety case, one of them and never both. An artifact
 * whose specification this reader does not read has neither.
 */
export async function getArtifactDetail(
  claimId: string
): Promise<{ list: import("./artifact-service.js").ListDetailView | null; safety_case: CaseDetailView | null }> {
  const subtype = await artifactSubtypeOf(claimId);
  if (subtype === "safety_case") return { list: null, safety_case: await getCaseDetail(claimId) };
  const { getListDetail } = await import("./artifact-service.js");
  return { list: await getListDetail(claimId), safety_case: null };
}
