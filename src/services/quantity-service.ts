/**
 * Quantities (constitution §2, §3, §10): nodes whose subject is a value. A
 * quantity has a definition (what it measures, in which population, under
 * which conditions, in what unit), an estimate the graph keeps current, the
 * estimates sources state (instances with stance 'states'), readings of
 * instruments taken to indicate it, and, rarely, claims of their own about
 * which side of a figure it lies (cuts).
 *
 * Writers validate through src/schemas/kinds.ts and refuse a write on the
 * wrong kind of node with a KindError (node-kind.ts).
 */
import { sameLabelOnly, writtenAtOwnLabel } from "../db/clearance.js";
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { currentLabel, getUsageContext } from "../llm/usage-context.js";
import {
  quantityDefinitionSchema,
  quantityEstimateSchema,
  valueShownSchema,
  type QuantityDefinitionInput,
  type QuantityEstimate,
  type QuantityUnit,
  type ValueShown,
} from "../schemas/kinds.js";
import { recordJudgmentInputs } from "./judgment-inputs-service.js";
import { markSeveralInForce, recordMadeBeside } from "./judgment-version-service.js";
import { overlaid } from "./overlay-service.js";
import { byLayer, oneCutForClaimSql, oneDefinitionForQuantitySql, refuseWhereHeldBelow } from "./layer-service.js";
import { mirroredNode, mirroredRowMessage, publicGraphJudges, publicJudgmentMessage } from "./mirrored-node-service.js";
import { convertKind, KindError, requireKind } from "./node-kind.js";

/** Set a quantity's definition, making a fresh claim a quantity if it is not one yet. */
export async function defineQuantity(input: {
  claimId: string;
  definition: QuantityDefinitionInput;
  createdBy: string;
}): Promise<void> {
  const def = quantityDefinitionSchema.parse(input.definition);
  // A mirrored node's kind and definition are the public graph's, and a
  // definition of this deployment's own beside it would be a second
  // definition of one quantity (mirrored-node-service.ts).
  if (await mirroredNode(input.claimId)) throw new KindError(mirroredRowMessage("the quantity's definition"));
  await withTransaction(async (tx) => {
    await convertKind(tx, input.claimId, "quantity");
    // A definition a label this work reads already holds is the
    // quantity's definition (layer-service.ts): not this work's to revise,
    // and one of its own beside it would define the quantity twice.
    await refuseWhereHeldBelow(tx.query.bind(tx), "quantity_definitions", { claim_id: input.claimId }, "this quantity's definition");
    // A first definition takes this run's label; a revision of one keeps
    // the label the definition has (src/labels.ts).
    writtenAtOwnLabel(
      await tx.query(
      `INSERT INTO quantity_definitions (claim_id, measures, population, conditions, unit, created_by, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (claim_id, sensitivity_label, origin) DO UPDATE
         SET measures = EXCLUDED.measures, population = EXCLUDED.population,
             conditions = EXCLUDED.conditions, unit = EXCLUDED.unit, updated_at = now()
       ${sameLabelOnly("quantity_definitions")}
       RETURNING 1 AS written`,
      [
        input.claimId,
        def.measures,
        def.population ?? null,
        def.conditions ?? null,
        JSON.stringify(def.unit),
        input.createdBy,
        currentLabel(),
      ]
    ),
      "this quantity's definition"
    );
  });
}

/** Record the graph's estimate of a quantity, retiring the previous one to history. */
export async function recordEstimate(input: {
  claimId: string;
  estimate: QuantityEstimate;
  summary?: string | null;
  work: string;
  /** The Steward's exit judgment, 0..1 (#755); null when not stated. */
  marginalYield?: number | null;
  model?: string | null;
  fundedByJobId?: string | null;
  trigger?: string | null;
  triggerContext?: string | null;
}): Promise<{ id: string }> {
  const estimate = quantityEstimateSchema.parse(input.estimate);
  if (!input.work.trim()) throw new KindError("An estimate records its work");
  // A mirrored quantity's estimate at its own label is the public graph's
  // (mirrored-node-service.ts).
  if (await publicGraphJudges(input.claimId)) throw new KindError(publicJudgmentMessage("An estimate of it"));
  return withTransaction(async (tx) => {
    await requireKind(tx, input.claimId, "quantity");
    const [def] = await tx.query(`SELECT 1 FROM quantity_definitions WHERE claim_id = $1`, [input.claimId]);
    if (!def) throw new KindError(`Quantity ${input.claimId} has no definition yet; define it first`);
    // This label's current estimate is retired, and no other label's
    // (db/schema.ts, "a version at each label").
    await tx.query(
      `UPDATE quantity_estimates SET is_current = false
        WHERE claim_id = $1 AND is_current = true AND sensitivity_label = $2`,
      [input.claimId, currentLabel()]
    );
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO quantity_estimates
         (claim_id, estimate, summary, work, model, funded_by_job_id, trigger, trigger_context,
          marginal_yield, run_id, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        input.claimId,
        JSON.stringify(estimate),
        input.summary ?? null,
        input.work,
        input.model ?? null,
        input.fundedByJobId ?? null,
        input.trigger ?? null,
        input.triggerContext ?? null,
        input.marginalYield ?? null,
        // The run that wrote it, and the label it writes at (src/labels.ts),
        // both stamped from the usage context.
        getUsageContext().runId ?? null,
        currentLabel(),
      ]
    );
    // What the estimate was made against, in the same transaction (#566).
    await recordJudgmentInputs(tx.query, "quantity_estimate", row!.id, input.claimId);
    await recordMadeBeside(tx.query, "quantity_estimates", "quantity_estimate", row!.id, input.claimId);
    return { id: row!.id };
  });
}

/** Record a source's statement of a quantity's value on its instance, and the argument that rests on it. */
export async function setStatedEstimate(input: {
  instanceId: string;
  stated: QuantityEstimate;
  argumentId?: string | null;
}): Promise<void> {
  const stated = quantityEstimateSchema.parse(input.stated);
  await withTransaction(async (tx) => {
    const [inst] = await tx.query<{ claim_id: string }>(
      `SELECT claim_id FROM claim_instances WHERE id = $1 FOR UPDATE`,
      [input.instanceId]
    );
    if (!inst) throw new KindError(`Instance ${input.instanceId} not found`);
    await requireKind(tx, inst.claim_id, "quantity");
    if (input.argumentId) await requireArgumentOf(tx, input.argumentId, inst.claim_id);
    await tx.query(
      `UPDATE claim_instances SET stance = 'states', stated_estimate = $2, argument_id = $3 WHERE id = $1`,
      [input.instanceId, JSON.stringify(stated), input.argumentId ?? null]
    );
  });
}

async function requireArgumentOf(tx: TxQuery, argumentId: string, claimId: string): Promise<void> {
  const [arg] = await tx.query<{ claim_id: string }>(`SELECT claim_id FROM arguments WHERE id = $1`, [argumentId]);
  if (!arg || arg.claim_id !== claimId) {
    throw new KindError(`Argument ${argumentId} is not an argument about ${claimId}`);
  }
}

/** Record what an argument about a quantity shows about its value (§7). */
export async function setArgumentShows(input: { argumentId: string; shows: ValueShown | null }): Promise<void> {
  const shows = input.shows === null ? null : valueShownSchema.parse(input.shows);
  await withTransaction(async (tx) => {
    const [arg] = await tx.query<{ claim_id: string }>(
      `SELECT claim_id FROM arguments WHERE id = $1 FOR UPDATE`,
      [input.argumentId]
    );
    if (!arg) throw new KindError(`Argument ${input.argumentId} not found`);
    await requireKind(tx, arg.claim_id, "quantity");
    await tx.query(`UPDATE arguments SET shows = $2 WHERE id = $1`, [
      input.argumentId,
      shows === null ? null : JSON.stringify(shows),
    ]);
  });
}

/** Record a reading of an instrument taken to indicate the quantity (§3). */
export async function addReading(input: {
  claimId: string;
  sourceId: string;
  measured: string;
  figure: string;
  bearing: string;
  bearingClaimId?: string | null;
  createdBy: string;
}): Promise<{ id: string }> {
  for (const [field, v] of [["measured", input.measured], ["figure", input.figure], ["bearing", input.bearing]] as const) {
    if (!v.trim()) throw new KindError(`A reading states its ${field}`);
  }
  return withTransaction(async (tx) => {
    await requireKind(tx, input.claimId, "quantity");
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO quantity_readings
         (claim_id, source_id, measured, figure, bearing, bearing_claim_id, created_by, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        input.claimId,
        input.sourceId,
        input.measured,
        input.figure,
        input.bearing,
        input.bearingClaimId ?? null,
        input.createdBy,
        currentLabel(),
      ]
    );
    return { id: row!.id };
  });
}

/** Record that a claim says which side of a figure a quantity lies. */
export async function recordCut(input: {
  claimId: string;
  quantityId: string;
  direction: "above" | "below";
  value: number;
  createdBy: string;
}): Promise<void> {
  if (!Number.isFinite(input.value)) throw new KindError("A cut's value is a finite number");
  await withTransaction(async (tx) => {
    await requireKind(tx, input.claimId, "claim");
    await requireKind(tx, input.quantityId, "quantity");
    // A cut a layer below already holds for the claim (the public graph,
    // or a label this work reads) stays that layer's, untouched. Where
    // this work judges that the claim cuts elsewhere, the cut it records
    // is its own label's row under the same key: its label's divergence,
    // which its readers and its sweeps go by and which a read shows beside
    // the one below (layer-service.ts, byLayer).
    const written = await tx.query<{ claim_id: string }>(
      `INSERT INTO quantity_cuts (claim_id, quantity_id, direction, value, created_by, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (claim_id, sensitivity_label, origin) DO UPDATE
         SET quantity_id = EXCLUDED.quantity_id, direction = EXCLUDED.direction, value = EXCLUDED.value
       ${sameLabelOnly("quantity_cuts")}
       RETURNING claim_id`,
      [input.claimId, input.quantityId, input.direction, input.value, input.createdBy, currentLabel()]
    );
    // A cut recorded at another label is that label's: work at this one is
    // told that nothing was written, with the reason.
    writtenAtOwnLabel(written, "this claim's cut of the quantity");
  });
}

// ---------------------------------------------------------------------------
// Reads, in the shapes the API serves (web/lib/types.ts QuantityDetail).
// ---------------------------------------------------------------------------

export interface QuantityDefinitionView {
  measures: string;
  population: string | null;
  conditions: string | null;
  unit: QuantityUnit;
}

export interface QuantityAssessedView {
  /** The estimate row's own id: what a finding cites as a quantity_estimate ref. */
  id: string;
  summary: string | null;
  work: string;
  model: string | null;
  assessed_at: Date;
}

export interface EstimateInstanceView {
  id: string;
  argument_id: string | null;
  source_title: string;
  source_url: string | null;
  source_type: string | null;
  source_date: string | null;
  stated: QuantityEstimate;
  verbatim_text: string | null;
}

export interface QuantityReadingView {
  id: string;
  source_title: string;
  source_url: string | null;
  measured: string;
  figure: string;
  bearing: string;
  claim: { id: string; text: string; status: string | null } | null;
}

export interface QuantityCutView {
  id: string;
  text: string;
  direction: "above" | "below";
  value: number;
  status: string | null;
  credence: number | null;
  /** On a graph with more than one layer: the label the cut is recorded at. */
  label?: string;
}

export interface QuantityDetailView {
  definition: QuantityDefinitionView | null;
  estimate: QuantityEstimate | null;
  assessed: QuantityAssessedView | null;
  estimates: EstimateInstanceView[];
  readings: QuantityReadingView[];
  cuts: QuantityCutView[];
  /**
   * Figures ingestion linked to the quantity whose value nobody has recorded
   * yet (stance 'states', no stated_estimate): the instances show them, and
   * the Steward's record_estimate with instance_id records each one.
   */
  figures_not_yet_recorded: number;
}

export async function getQuantityDefinition(claimId: string): Promise<QuantityDefinitionView | null> {
  const [row] = await rawQuery<QuantityDefinitionView>(
    `SELECT measures, population, conditions, unit FROM quantity_definitions qd WHERE claim_id = $1${oneDefinitionForQuantitySql("qd")}`,
    [claimId]
  );
  return row ?? null;
}

export async function getCurrentEstimate(
  claimId: string
): Promise<{ estimate: QuantityEstimate; assessed: QuantityAssessedView } | null> {
  const [row] = await rawQuery<{ estimate: QuantityEstimate } & QuantityAssessedView>(
    `SELECT id, estimate, summary, work, model, assessed_at
       FROM quantity_estimates_in_force WHERE claim_id = $1`,
    [claimId]
  );
  if (!row) return null;
  const { estimate, ...assessed } = row;
  return { estimate, assessed };
}

export async function getQuantityDetail(claimId: string): Promise<QuantityDetailView> {
  const [definition, current, estimates, readings, cuts, unrecorded] = await Promise.all([
    getQuantityDefinition(claimId),
    getCurrentEstimate(claimId),
    rawQuery<EstimateInstanceView>(
      `SELECT ci.id, ci.argument_id, s.title AS source_title,
              s.url AS source_url, s.source_type, COALESCE(ci.source_date, s.published_date) AS source_date,
              ci.stated_estimate AS stated, NULLIF(ci.verbatim_text, '') AS verbatim_text
         FROM claim_instances ci
         JOIN sources s ON s.id = ci.source_id
        WHERE ci.claim_id = $1 AND ci.stance = 'states' AND ci.stated_estimate IS NOT NULL
          AND ci.detached_at IS NULL
        ORDER BY ci.display_rank NULLS LAST, ci.source_date NULLS LAST, ci.created_at`,
      [claimId]
    ),
    rawQuery<Omit<QuantityReadingView, "claim"> & { bc_id: string | null; bc_text: string | null; bc_status: string | null }>(
      `SELECT r.id, s.title AS source_title, s.url AS source_url,
              r.measured, r.figure, r.bearing,
              bc.id AS bc_id, bc.text AS bc_text, a.status AS bc_status
         FROM quantity_readings r
         JOIN sources s ON s.id = r.source_id
         LEFT JOIN claims bc ON bc.id = r.bearing_claim_id
         LEFT JOIN assessments_in_force a ON a.claim_id = bc.id
        WHERE r.claim_id = $1
        ORDER BY r.created_at, r.id`,
      [claimId]
    ),
    rawQuery<QuantityCutView>(
      `SELECT c.id, c.text, qc.direction, qc.value, a.status, a.claim_credence AS credence${overlaid() ? ", qc.sensitivity_label AS label" : ""}
         FROM quantity_cuts qc
         JOIN claims c ON c.id = qc.claim_id AND c.state = 'active'
         LEFT JOIN assessments_in_force a ON a.claim_id = c.id
        WHERE qc.quantity_id = $1${oneCutForClaimSql("qc")}
        ORDER BY qc.value, c.id`,
      [claimId]
    ),
    rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM claim_instances
        WHERE claim_id = $1 AND stance = 'states' AND stated_estimate IS NULL AND detached_at IS NULL`,
      [claimId]
    ),
  ]);
  const readingViews = readings.map(({ bc_id, bc_text, bc_status, ...r }) => ({
    ...r,
    claim: bc_id ? { id: bc_id, text: bc_text!, status: bc_status } : null,
  }));
  // The claims this quantity's page gives a status for: where more than one
  // judgment of one is in force for the asker, it says so.
  await markSeveralInForce(readingViews.flatMap((r) => (r.claim ? [r.claim] : [])), (c) => c.id);
  await markSeveralInForce(cuts, (c) => c.id);
  return {
    definition,
    estimate: current?.estimate ?? null,
    assessed: current?.assessed ?? null,
    estimates,
    readings: readingViews,
    cuts,
    figures_not_yet_recorded: Number(unrecorded[0]?.n ?? 0),
  };
}

export interface ThresholdOfView {
  quantity_id: string;
  quantity_text: string;
  definition: QuantityDefinitionView | null;
  estimate: QuantityEstimate | null;
  direction: "above" | "below";
  value: number;
  /** On a graph with more than one layer: the label this cut is recorded at. */
  label?: string;
  /** Where a label below the one above also holds a cut for the claim: each, nearest first. The one above is its divergence from these. */
  below?: { label: string; quantity_id: string; direction: "above" | "below"; value: number }[];
}

/** For a claim that cuts a quantity: the quantity, and where. */
export async function getThresholdOf(claimId: string): Promise<ThresholdOfView | null> {
  // Every layer's cut for the claim, nearest first: the first is the one
  // the reader goes by, and the rest are what the layers below hold.
  const layers = await byLayer<{ quantity_id: string; quantity_text: string; direction: "above" | "below"; value: number }>(
    rawQuery,
    "quantity_cuts",
    { claim_id: claimId },
    `held.quantity_id, (SELECT q.text FROM claims q WHERE q.id = held.quantity_id) AS quantity_text, held.direction, held.value`
  );
  const [first, ...below] = layers;
  if (!first) return null;
  const { label, ...row } = first;
  const [definition, current] = await Promise.all([
    getQuantityDefinition(row.quantity_id),
    getCurrentEstimate(row.quantity_id),
  ]);
  return {
    ...row,
    definition,
    estimate: current?.estimate ?? null,
    ...(overlaid() ? { label } : {}),
    ...(below.length > 0
      ? { below: below.map((b) => ({ label: b.label, quantity_id: b.quantity_id, direction: b.direction, value: b.value })) }
      : {}),
  };
}
