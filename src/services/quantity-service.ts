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
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import {
  quantityDefinitionSchema,
  quantityEstimateSchema,
  valueShownSchema,
  type QuantityDefinitionInput,
  type QuantityEstimate,
  type QuantityUnit,
  type ValueShown,
} from "../schemas/kinds.js";
import { convertKind, KindError, requireKind } from "./node-kind.js";

/** Set a quantity's definition, making a fresh claim a quantity if it is not one yet. */
export async function defineQuantity(input: {
  claimId: string;
  definition: QuantityDefinitionInput;
  createdBy: string;
}): Promise<void> {
  const def = quantityDefinitionSchema.parse(input.definition);
  await withTransaction(async (tx) => {
    await convertKind(tx, input.claimId, "quantity");
    await tx.query(
      `INSERT INTO quantity_definitions (claim_id, measures, population, conditions, unit, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (claim_id) DO UPDATE
         SET measures = EXCLUDED.measures, population = EXCLUDED.population,
             conditions = EXCLUDED.conditions, unit = EXCLUDED.unit, updated_at = now()`,
      [
        input.claimId,
        def.measures,
        def.population ?? null,
        def.conditions ?? null,
        JSON.stringify(def.unit),
        input.createdBy,
      ]
    );
  });
}

/** Record the graph's estimate of a quantity, retiring the previous one to history. */
export async function recordEstimate(input: {
  claimId: string;
  estimate: QuantityEstimate;
  summary?: string | null;
  work: string;
  model?: string | null;
  fundedByJobId?: string | null;
  trigger?: string | null;
  triggerContext?: string | null;
}): Promise<{ id: string }> {
  const estimate = quantityEstimateSchema.parse(input.estimate);
  if (!input.work.trim()) throw new KindError("An estimate records its work");
  return withTransaction(async (tx) => {
    await requireKind(tx, input.claimId, "quantity");
    const [def] = await tx.query(`SELECT 1 FROM quantity_definitions WHERE claim_id = $1`, [input.claimId]);
    if (!def) throw new KindError(`Quantity ${input.claimId} has no definition yet; define it first`);
    await tx.query(
      `UPDATE quantity_estimates SET is_current = false WHERE claim_id = $1 AND is_current = true`,
      [input.claimId]
    );
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO quantity_estimates
         (claim_id, estimate, summary, work, model, funded_by_job_id, trigger, trigger_context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        input.claimId,
        JSON.stringify(estimate),
        input.summary ?? null,
        input.work,
        input.model ?? null,
        input.fundedByJobId ?? null,
        input.trigger ?? null,
        input.triggerContext ?? null,
      ]
    );
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
      `INSERT INTO quantity_readings (claim_id, source_id, measured, figure, bearing, bearing_claim_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        input.claimId,
        input.sourceId,
        input.measured,
        input.figure,
        input.bearing,
        input.bearingClaimId ?? null,
        input.createdBy,
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
    await tx.query(
      `INSERT INTO quantity_cuts (claim_id, quantity_id, direction, value, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (claim_id) DO UPDATE
         SET quantity_id = EXCLUDED.quantity_id, direction = EXCLUDED.direction, value = EXCLUDED.value`,
      [input.claimId, input.quantityId, input.direction, input.value, input.createdBy]
    );
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
}

export interface QuantityDetailView {
  definition: QuantityDefinitionView | null;
  estimate: QuantityEstimate | null;
  assessed: QuantityAssessedView | null;
  estimates: EstimateInstanceView[];
  readings: QuantityReadingView[];
  cuts: QuantityCutView[];
}

export async function getQuantityDefinition(claimId: string): Promise<QuantityDefinitionView | null> {
  const [row] = await rawQuery<QuantityDefinitionView>(
    `SELECT measures, population, conditions, unit FROM quantity_definitions WHERE claim_id = $1`,
    [claimId]
  );
  return row ?? null;
}

export async function getCurrentEstimate(
  claimId: string
): Promise<{ estimate: QuantityEstimate; assessed: QuantityAssessedView } | null> {
  const [row] = await rawQuery<{ estimate: QuantityEstimate } & QuantityAssessedView>(
    `SELECT estimate, summary, work, model, assessed_at
       FROM quantity_estimates WHERE claim_id = $1 AND is_current = true`,
    [claimId]
  );
  if (!row) return null;
  const { estimate, ...assessed } = row;
  return { estimate, assessed };
}

export async function getQuantityDetail(claimId: string): Promise<QuantityDetailView> {
  const [definition, current, estimates, readings, cuts] = await Promise.all([
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
         LEFT JOIN assessments a ON a.claim_id = bc.id AND a.is_current = true
        WHERE r.claim_id = $1
        ORDER BY r.created_at, r.id`,
      [claimId]
    ),
    rawQuery<QuantityCutView>(
      `SELECT c.id, c.text, qc.direction, qc.value, a.status, a.claim_credence AS credence
         FROM quantity_cuts qc
         JOIN claims c ON c.id = qc.claim_id AND c.state = 'active'
         LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
        WHERE qc.quantity_id = $1
        ORDER BY qc.value, c.id`,
      [claimId]
    ),
  ]);
  return {
    definition,
    estimate: current?.estimate ?? null,
    assessed: current?.assessed ?? null,
    estimates,
    readings: readings.map(({ bc_id, bc_text, bc_status, ...r }) => ({
      ...r,
      claim: bc_id ? { id: bc_id, text: bc_text!, status: bc_status } : null,
    })),
    cuts,
  };
}

export interface ThresholdOfView {
  quantity_id: string;
  quantity_text: string;
  definition: QuantityDefinitionView | null;
  estimate: QuantityEstimate | null;
  direction: "above" | "below";
  value: number;
}

/** For a claim that cuts a quantity: the quantity, and where. */
export async function getThresholdOf(claimId: string): Promise<ThresholdOfView | null> {
  const [row] = await rawQuery<{ quantity_id: string; quantity_text: string; direction: "above" | "below"; value: number }>(
    `SELECT qc.quantity_id, q.text AS quantity_text, qc.direction, qc.value
       FROM quantity_cuts qc JOIN claims q ON q.id = qc.quantity_id
      WHERE qc.claim_id = $1`,
    [claimId]
  );
  if (!row) return null;
  const [definition, current] = await Promise.all([
    getQuantityDefinition(row.quantity_id),
    getCurrentEstimate(row.quantity_id),
  ]);
  return { ...row, definition, estimate: current?.estimate ?? null };
}
