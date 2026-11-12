/**
 * Reconciliation operations: the data layer for the Curator's re-individuation
 * surgery (constitution §5). Merges combine two claims into one; splits break a
 * conflated claim apart. These mutate nodes, edges, and instances directly — that
 * is the operation.
 *
 * Every operation is recorded in `reconciliation_events` with a payload detailed
 * enough to **reverse** it (§5: every operation is logged, and reversal restores
 * the prior structure without erasing history). `reverseReconciliation`
 * undoes a logged event.
 */
import { getDb, rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { recordStateChange } from "./claim-lifecycle-service.js";
import { claims } from "../db/schema.js";
import { generateEmbedding } from "./embedding-service.js";
import { loadConfig } from "../config.js";
import { insertRelationshipEdge } from "./relationship-service.js";
import {
  quantityDefinitionSchema,
  quantityEstimateSchema,
  type QuantityDefinitionInput,
} from "../schemas/kinds.js";
import {
  linkClaims as insertClaimLink,
  unlinkClaims as deleteClaimLinks,
  type ClaimLinkKind,
  type ClaimLinkRow,
} from "./claim-link-service.js";

/** One argument_subclaims row, as recorded in a reversible payload. */
interface MembershipRef {
  argument_id: string;
  relationship_id: string;
}

interface EdgeRow {
  parent_claim_id: string;
  child_claim_id: string;
  relation_type: string;
  reasoning: string;
  confidence: number;
  created_by: string;
  /**
   * The named arguments the edge was grouped under when it was deleted
   * (argument_subclaims, #437), so a reversal can restore the grouping.
   * Absent on payloads logged before membership moved off the edge.
   */
  argument_ids?: string[];
}

// SQL fragment: flip affirm/deny (instances) or for/against (arguments) when the
// merge is between a claim and its negation/counterpart ($3 = opposed boolean).
// A "poses" (#445) or "mentions" instance takes no side, so the ELSE keeps it
// as is.
const FLIP_INSTANCE_STANCE = `CASE WHEN $3::boolean
  THEN (CASE stance WHEN 'affirms' THEN 'denies' WHEN 'denies' THEN 'affirms' ELSE stance END)
  ELSE stance END`;
const FLIP_ARGUMENT_STANCE = `CASE WHEN $3::boolean
  THEN (CASE stance WHEN 'for' THEN 'against' WHEN 'against' THEN 'for' ELSE stance END)
  ELSE stance END`;

/**
 * Merges across kinds (constitution §2, §7a): a claim that only states a
 * value folds into the quantity, and a question that asks whether X is so,
 * or for a value, folds into the claim X or the quantity. Each pair maps
 * the moved instances' stances into the survivor's vocabulary; every other
 * pair of different kinds is refused, so the Curator changes a node's kind
 * first (changeNodeKind) and merges like with like. A "mentions" instance
 * takes no side and states no value, so it keeps its stance on a claim or a
 * quantity survivor.
 */
const CROSS_KIND_MERGES: Record<string, Record<string, string>> = {
  "claim>quantity": { affirms: "states", denies: "poses", poses: "poses" },
  "question>claim": { asks: "poses", answers: "poses" },
  "question>quantity": { asks: "poses", answers: "poses" },
};

/**
 * The instance stances a node of each kind carries, for a kind change. A
 * question's instances ask or answer it (§7a), so a source that mentions the
 * node becomes one that raises the question, as a posing one does; a claim
 * or a quantity keeps a mention as it is.
 */
const KIND_STANCE_MAP: Record<string, Record<string, string>> = {
  quantity: { affirms: "states", denies: "poses", poses: "poses", asks: "poses", answers: "poses" },
  question: { affirms: "asks", denies: "asks", poses: "asks", states: "asks", mentions: "asks" },
  claim: { states: "affirms", asks: "poses", answers: "poses" },
};

interface StanceRef {
  id: string;
  stance: string;
}

/** Rewrite instance stances through a map; returns the rows it changed, with their prior stance. */
async function remapStances(instanceIds: string[], map: Record<string, string>): Promise<StanceRef[]> {
  if (instanceIds.length === 0) return [];
  const prior = await rawQuery<StanceRef>(
    `SELECT id, stance FROM claim_instances WHERE id = ANY($1::uuid[])`,
    [instanceIds]
  );
  const changed = prior.filter((r) => map[r.stance] && map[r.stance] !== r.stance);
  for (const r of changed) {
    await rawQuery(`UPDATE claim_instances SET stance = $2 WHERE id = $1`, [r.id, map[r.stance]]);
  }
  return changed;
}

async function restoreStances(refs: StanceRef[]): Promise<void> {
  for (const r of refs) {
    await rawQuery(`UPDATE claim_instances SET stance = $2 WHERE id = $1`, [r.id, r.stance]);
  }
}

/**
 * Rows of the kinds' tables that point at the loser, moved onto the survivor
 * in a merge, by id, so the reversal can move exactly these back.
 */
interface KindRefsMoved {
  reading_ids: string[];
  cut_claim_ids: string[];
  loser_cut_moved: boolean;
  answer_relation_ids: string[];
  answer_instance_ids: string[];
  request_target_ids: string[];
  dropped_request_targets: { request_id: string }[];
  keeper_request_ids: string[];
}

async function moveKindRefs(survivorId: string, loserId: string): Promise<KindRefsMoved> {
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  const reading_ids = ids(
    await rawQuery<{ id: string }>(
      `UPDATE quantity_readings SET claim_id = $1 WHERE claim_id = $2 RETURNING id`,
      [survivorId, loserId]
    )
  );
  const cut_claim_ids = (
    await rawQuery<{ claim_id: string }>(
      `UPDATE quantity_cuts SET quantity_id = $1 WHERE quantity_id = $2 AND claim_id != $1 RETURNING claim_id`,
      [survivorId, loserId]
    )
  ).map((r) => r.claim_id);
  // A cut claim merged into another: its cut moves only when the survivor
  // has none of its own.
  const loserCut = await rawQuery<{ claim_id: string }>(
    `UPDATE quantity_cuts SET claim_id = $1
      WHERE claim_id = $2 AND quantity_id != $1
        AND NOT EXISTS (SELECT 1 FROM quantity_cuts WHERE claim_id = $1)
      RETURNING claim_id`,
    [survivorId, loserId]
  );
  const answer_relation_ids = ids(
    await rawQuery<{ id: string }>(
      `UPDATE answer_relations ar SET question_id = $1
        WHERE ar.question_id = $2
          AND NOT EXISTS (SELECT 1 FROM answer_relations o
                           WHERE o.question_id = $1 AND o.claim_a_id = ar.claim_a_id AND o.claim_b_id = ar.claim_b_id)
        RETURNING ar.id`,
      [survivorId, loserId]
    )
  );
  const answer_instance_ids = ids(
    await rawQuery<{ id: string }>(
      `UPDATE claim_instances SET answer_claim_id = $1 WHERE answer_claim_id = $2 RETURNING id`,
      [survivorId, loserId]
    )
  );
  // A request that already bears on the survivor keeps one target.
  const dropped_request_targets = await rawQuery<{ request_id: string }>(
    `DELETE FROM request_targets t
      WHERE t.claim_id = $2
        AND EXISTS (SELECT 1 FROM request_targets o WHERE o.request_id = t.request_id AND o.claim_id = $1)
      RETURNING t.request_id`,
    [survivorId, loserId]
  );
  const request_target_ids = ids(
    await rawQuery<{ id: string }>(
      `UPDATE request_targets SET claim_id = $1 WHERE claim_id = $2 RETURNING id`,
      [survivorId, loserId]
    )
  );
  const keeper_request_ids = ids(
    await rawQuery<{ id: string }>(
      `UPDATE requests SET keeper_claim_id = $1, updated_at = now() WHERE keeper_claim_id = $2 RETURNING id`,
      [survivorId, loserId]
    )
  );
  return {
    reading_ids,
    cut_claim_ids,
    loser_cut_moved: loserCut.length > 0,
    answer_relation_ids,
    answer_instance_ids,
    request_target_ids,
    dropped_request_targets,
    keeper_request_ids,
  };
}

async function restoreKindRefs(loserId: string, survivorId: string, m: Partial<KindRefsMoved>): Promise<void> {
  if (m.reading_ids?.length) {
    await rawQuery(`UPDATE quantity_readings SET claim_id = $1 WHERE id = ANY($2::uuid[])`, [loserId, m.reading_ids]);
  }
  if (m.cut_claim_ids?.length) {
    await rawQuery(`UPDATE quantity_cuts SET quantity_id = $1 WHERE claim_id = ANY($2::uuid[])`, [loserId, m.cut_claim_ids]);
  }
  if (m.loser_cut_moved) {
    await rawQuery(`UPDATE quantity_cuts SET claim_id = $1 WHERE claim_id = $2`, [loserId, survivorId]);
  }
  if (m.answer_relation_ids?.length) {
    await rawQuery(`UPDATE answer_relations SET question_id = $1 WHERE id = ANY($2::uuid[])`, [loserId, m.answer_relation_ids]);
  }
  if (m.answer_instance_ids?.length) {
    await rawQuery(`UPDATE claim_instances SET answer_claim_id = $1 WHERE id = ANY($2::uuid[])`, [loserId, m.answer_instance_ids]);
  }
  if (m.request_target_ids?.length) {
    await rawQuery(`UPDATE request_targets SET claim_id = $1 WHERE id = ANY($2::uuid[])`, [loserId, m.request_target_ids]);
  }
  for (const t of m.dropped_request_targets ?? []) {
    await rawQuery(`INSERT INTO request_targets (request_id, claim_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [t.request_id, loserId]);
  }
  if (m.keeper_request_ids?.length) {
    await rawQuery(`UPDATE requests SET keeper_claim_id = $1 WHERE id = ANY($2::uuid[])`, [loserId, m.keeper_request_ids]);
  }
}

async function logEvent(
  operation: string,
  reasoning: string,
  payload: unknown,
  tx?: TxQuery
): Promise<string | undefined> {
  const sql = `INSERT INTO reconciliation_events (operation, reasoning, payload, created_by)
     VALUES ($1, $2, $3::jsonb, 'curator') RETURNING id`;
  const params = [operation, reasoning, JSON.stringify(payload)];
  const rows = tx ? await tx.query<{ id: string }>(sql, params) : await rawQuery<{ id: string }>(sql, params);
  return rows[0]?.id;
}

/**
 * Capture edges (with their argument memberships) and delete them, in that
 * order: membership rows cascade away with the edge, so they must be read
 * first for the reversal payload.
 */
async function captureAndDeleteEdges(edgeIds: string[]): Promise<EdgeRow[]> {
  if (edgeIds.length === 0) return [];
  const captured = await rawQuery<EdgeRow>(
    `SELECT cr.parent_claim_id, cr.child_claim_id, cr.relation_type,
            cr.reasoning, cr.confidence, cr.created_by,
            COALESCE(
              array_agg(am.argument_id) FILTER (WHERE am.argument_id IS NOT NULL),
              '{}'
            ) AS argument_ids
       FROM claim_relationships cr
       LEFT JOIN argument_subclaims am ON am.relationship_id = cr.id
      WHERE cr.id = ANY($1::uuid[])
      GROUP BY cr.id`,
    [edgeIds]
  );
  await rawQuery(`DELETE FROM claim_relationships WHERE id = ANY($1::uuid[])`, [
    edgeIds,
  ]);
  return captured;
}

/**
 * Restore captured edges and their argument memberships. Idempotent: an edge
 * already present is reused, and a membership is re-added only while its
 * argument still exists on the edge's parent claim (the invariant
 * relationship-service enforces on live writes).
 */
async function reinsertEdges(edges: EdgeRow[]): Promise<void> {
  for (const e of edges) {
    const { id } = await insertRelationshipEdge({
      parentId: e.parent_claim_id,
      childId: e.child_claim_id,
      relationType: e.relation_type,
      reasoning: e.reasoning,
      confidence: e.confidence,
      createdBy: e.created_by,
    });
    const argumentIds = e.argument_ids ?? [];
    if (argumentIds.length === 0) continue;
    await rawQuery(
      `INSERT INTO argument_subclaims (argument_id, relationship_id)
       SELECT a.id, cr.id
         FROM arguments a
         JOIN claim_relationships cr ON cr.id = $2
        WHERE a.id = ANY($1::uuid[])
          AND a.claim_id = cr.parent_claim_id
       ON CONFLICT DO NOTHING`,
      [argumentIds, id]
    );
  }
}

/**
 * Before a duplicate edge of the loser's is deleted in a merge, carry its
 * argument memberships over to the survivor's equivalent edge (same parent,
 * child and relation once the loser is read as the survivor), so a grouping
 * survives the merge instead of cascading away with the duplicate.
 */
async function repointMemberships(
  edgeIds: string[],
  equivalentEdgeJoin: string,
  survivorId: string
): Promise<MembershipRef[]> {
  if (edgeIds.length === 0) return [];
  // RETURNING yields only the rows this statement created, so the reversal
  // can remove exactly the memberships the merge added and nothing older.
  return rawQuery<MembershipRef>(
    `INSERT INTO argument_subclaims (argument_id, relationship_id)
     SELECT am.argument_id, e.id
       FROM argument_subclaims am
       JOIN claim_relationships cr ON cr.id = am.relationship_id
       JOIN claim_relationships e ON ${equivalentEdgeJoin}
      WHERE cr.id = ANY($2::uuid[])
     ON CONFLICT DO NOTHING
     RETURNING argument_id, relationship_id`,
    [survivorId, edgeIds]
  );
}

/**
 * Merge `loserId` into `survivorId`: move the loser's instances, arguments, and
 * edges onto the survivor, then mark the loser a merged alias. On
 * `stanceRelation: "opposed"` (a claim and its negation), moved instance/argument
 * stances are flipped. Logs a reversible `merge` event.
 */
export async function mergeClaims(input: {
  survivorId: string;
  loserId: string;
  stanceRelation: "same" | "opposed";
  reasoning: string;
}): Promise<{ merged: boolean; survivorId: string; loserId: string; eventId?: string }> {
  const { survivorId, loserId, stanceRelation, reasoning } = input;
  if (survivorId === loserId) {
    throw new Error("Cannot merge a claim into itself");
  }
  const opposed = stanceRelation === "opposed";

  // Capture the loser's prior state so a reversal can restore it.
  const [loserRow] = await rawQuery<{ state: string; kind: string }>(
    `SELECT state, kind FROM claims WHERE id = $1`,
    [loserId]
  );
  const loserPrevState = loserRow?.state ?? "active";
  const [survivorRow] = await rawQuery<{ kind: string }>(`SELECT kind FROM claims WHERE id = $1`, [survivorId]);
  const loserKind = loserRow?.kind ?? "claim";
  const survivorKind = survivorRow?.kind ?? "claim";
  const crossKind = loserKind !== survivorKind;
  const stanceMap = crossKind ? CROSS_KIND_MERGES[`${loserKind}>${survivorKind}`] : undefined;
  if (crossKind && !stanceMap) {
    throw new Error(
      `Cannot merge a ${loserKind} into a ${survivorKind}. Change one node's kind first ` +
        `(change_node_kind), or merge a claim that only states a value into the quantity, ` +
        `or a question into the claim or quantity it asks about.`
    );
  }
  if (crossKind && opposed) {
    throw new Error("A merge across kinds has no opposed reading: use stance_relation \"same\".");
  }

  // 1. Instances onto the survivor (flip if opposed).
  const movedInstances = await rawQuery<{ id: string }>(
    `UPDATE claim_instances SET claim_id = $1, stance = ${FLIP_INSTANCE_STANCE}, display_rank = NULL
      WHERE claim_id = $2 RETURNING id`,
    [survivorId, loserId, opposed]
  );

  // 1b. Across kinds, the moved instances take the survivor's stances.
  const remappedStances = stanceMap ? await remapStances(movedInstances.map((r) => r.id), stanceMap) : [];

  // 2. Arguments onto the survivor (flip if opposed). An argument about a
  //    quantity has no for or against (§7): it shows something about the value.
  const movedArguments = await rawQuery<{ id: string; stance: string }>(
    `UPDATE arguments a SET claim_id = $1, stance = ${FLIP_ARGUMENT_STANCE}
      FROM (SELECT id, stance AS prior_stance FROM arguments WHERE claim_id = $2) p
      WHERE a.id = p.id RETURNING a.id, p.prior_stance AS stance`,
    [survivorId, loserId, opposed]
  );
  const neutralizedArguments =
    crossKind && survivorKind === "quantity" ? movedArguments.filter((a) => a.stance !== "neutral") : [];
  if (neutralizedArguments.length > 0) {
    await rawQuery(`UPDATE arguments SET stance = 'neutral' WHERE id = ANY($1::uuid[])`, [
      neutralizedArguments.map((a) => a.id),
    ]);
  }

  // 2a. Argument passages waiting on the loser for its Steward (#541): onto
  //     the survivor, their side flipped for an opposed merge. A quantity
  //     has no sides, so a merge into one clears it. Prior sides are kept
  //     for the undo.
  const movedPassages = await rawQuery<{ id: string; direction: string | null }>(
    `UPDATE argument_instances ai
        SET claim_id = $1,
            direction = CASE
              WHEN $4::boolean THEN NULL
              WHEN $3::boolean THEN (CASE p.direction WHEN 'for' THEN 'against' WHEN 'against' THEN 'for' ELSE p.direction END)
              ELSE p.direction END
       FROM (SELECT id, direction FROM argument_instances WHERE claim_id = $2) p
      WHERE ai.id = p.id
      RETURNING ai.id, p.direction`,
    [survivorId, loserId, opposed, crossKind && survivorKind === "quantity"]
  );

  // 2b. The kinds' rows that point at the loser: a quantity's readings and
  //     cuts, a question's answer relations, the answers sources gave, and
  //     the requests that bear on it.
  const kindRefs = await moveKindRefs(survivorId, loserId);

  // 3. Edges where the loser is the CHILD: drop self/duplicate edges (captured,
  //    with their argument memberships, so they can be restored; a duplicate's
  //    memberships move to the survivor's equivalent edge first), then repoint
  //    the rest — memberships ride along with a repointed edge, whose id is
  //    unchanged.
  const childDupIds = (
    await rawQuery<{ id: string }>(
      `SELECT cr.id FROM claim_relationships cr
        WHERE cr.child_claim_id = $2
          AND (cr.parent_claim_id = $1
               OR EXISTS (SELECT 1 FROM claim_relationships e
                            WHERE e.child_claim_id = $1
                              AND e.parent_claim_id = cr.parent_claim_id
                              AND e.relation_type = cr.relation_type))`,
      [survivorId, loserId]
    )
  ).map((r) => r.id);
  const repointedChildMemberships = await repointMemberships(
    childDupIds,
    `e.child_claim_id = $1 AND e.parent_claim_id = cr.parent_claim_id
                                  AND e.relation_type = cr.relation_type`,
    survivorId
  );
  const deletedChildEdges = await captureAndDeleteEdges(childDupIds);
  const repointedChild = await rawQuery<{ id: string }>(
    `UPDATE claim_relationships SET child_claim_id = $1 WHERE child_claim_id = $2 RETURNING id`,
    [survivorId, loserId]
  );

  // 4. Edges where the loser is the PARENT (same dedupe). The loser's
  //    arguments already sit on the survivor (step 2), so their memberships
  //    land on edges of their own claim.
  const parentDupIds = (
    await rawQuery<{ id: string }>(
      `SELECT cr.id FROM claim_relationships cr
        WHERE cr.parent_claim_id = $2
          AND (cr.child_claim_id = $1
               OR EXISTS (SELECT 1 FROM claim_relationships e
                            WHERE e.parent_claim_id = $1
                              AND e.child_claim_id = cr.child_claim_id
                              AND e.relation_type = cr.relation_type))`,
      [survivorId, loserId]
    )
  ).map((r) => r.id);
  const repointedParentMemberships = await repointMemberships(
    parentDupIds,
    `e.parent_claim_id = $1 AND e.child_claim_id = cr.child_claim_id
                                  AND e.relation_type = cr.relation_type`,
    survivorId
  );
  const deletedParentEdges = await captureAndDeleteEdges(parentDupIds);
  const repointedParent = await rawQuery<{ id: string }>(
    `UPDATE claim_relationships SET parent_claim_id = $1 WHERE parent_claim_id = $2 RETURNING id`,
    [survivorId, loserId]
  );

  // 4b. Lateral links (#436) touching the loser move to the survivor. Captured
  //     whole and re-created on the survivor's side (a link to the survivor
  //     itself, or one the survivor already has, simply drops), so the
  //     reversal can delete exactly what the merge created and put the
  //     originals back.
  const movedLinks = await rawQuery<ClaimLinkRow>(
    `DELETE FROM claim_links
      WHERE claim_a_id = $1 OR claim_b_id = $1
      RETURNING id, claim_a_id, claim_b_id, kind, reasoning, created_by`,
    [loserId]
  );
  const mergedLinkIds: string[] = [];
  for (const link of movedLinks) {
    const other = link.claim_a_id === loserId ? link.claim_b_id : link.claim_a_id;
    if (other === survivorId) continue;
    const { id, created } = await insertClaimLink({
      claimId: survivorId,
      otherClaimId: other,
      kind: link.kind as ClaimLinkKind,
      reasoning: link.reasoning,
      createdBy: link.created_by,
    });
    if (created) mergedLinkIds.push(id);
  }

  // 5. Mark the loser a merged alias of the survivor.
  await rawQuery(
    `UPDATE claims SET merged_into = $1, state = 'merged', updated_at = now() WHERE id = $2`,
    [survivorId, loserId]
  );

  const eventId = await logEvent("merge", reasoning, {
    survivor_id: survivorId,
    loser_id: loserId,
    stance_relation: stanceRelation,
    loser_prev_state: loserPrevState,
    moved_instance_ids: movedInstances.map((r) => r.id),
    moved_argument_ids: movedArguments.map((r) => r.id),
    moved_argument_passages: movedPassages,
    repointed_child_edge_ids: repointedChild.map((r) => r.id),
    repointed_parent_edge_ids: repointedParent.map((r) => r.id),
    deleted_edges: [...deletedChildEdges, ...deletedParentEdges],
    repointed_memberships: [
      ...repointedChildMemberships,
      ...repointedParentMemberships,
    ],
    moved_links: movedLinks,
    merged_link_ids: mergedLinkIds,
    remapped_stances: remappedStances,
    neutralized_arguments: neutralizedArguments,
    kind_refs: kindRefs,
  });
  // The absorbed node's own history shows the merge, naming the survivor (#962).
  await recordStateChange({
    claimId: loserId,
    fromState: loserPrevState,
    toState: "merged",
    actor: "curator",
    reason: reasoning,
    successorIds: [survivorId],
    reconciliationEventId: eventId ?? null,
  });

  return { merged: true, survivorId, loserId, eventId };
}

/**
 * Change a node's kind (constitution §2, §7a): a node created as the wrong
 * kind keeps its identity and moves what can move. The records that belong
 * to the old kind (a proposition's verdict, a quantity's estimate, a
 * question's standing) are retired to history rather than carried over,
 * since none of them means anything for the new kind; instance stances are
 * mapped into the new kind's vocabulary; an argument about a quantity
 * loses its for or against. A quantity needs its definition. Logs a
 * reversible `change_kind` event.
 */
export async function changeNodeKind(input: {
  claimId: string;
  to: "claim" | "quantity" | "question";
  definition?: QuantityDefinitionInput | null;
  reasoning: string;
}): Promise<{ changed: boolean; from: string; eventId?: string }> {
  const { claimId, to, reasoning } = input;
  const [row] = await rawQuery<{ kind: string; state: string }>(
    `SELECT kind, state FROM claims WHERE id = $1`,
    [claimId]
  );
  if (!row) throw new Error(`Node ${claimId} not found`);
  if (row.state !== "active") throw new Error(`Node ${claimId} is ${row.state}, not active`);
  const from = row.kind;
  if (from === to) return { changed: false, from };
  const definition = to === "quantity" ? quantityDefinitionSchema.parse(input.definition ?? undefined) : null;

  const retire = async (table: string): Promise<string[]> =>
    (
      await rawQuery<{ id: string }>(
        `UPDATE ${table} SET is_current = false WHERE claim_id = $1 AND is_current = true RETURNING id`,
        [claimId]
      )
    ).map((r) => r.id);
  const retired = {
    assessments: await retire("assessments"),
    quantity_estimates: await retire("quantity_estimates"),
    question_assessments: await retire("question_assessments"),
  };

  const instanceIds = (
    await rawQuery<{ id: string }>(`SELECT id FROM claim_instances WHERE claim_id = $1`, [claimId])
  ).map((r) => r.id);
  const remappedStances = await remapStances(instanceIds, KIND_STANCE_MAP[to] ?? {});
  const neutralizedArguments =
    to === "quantity"
      ? await rawQuery<StanceRef>(
          `UPDATE arguments a SET stance = 'neutral'
             FROM (SELECT id, stance AS prior FROM arguments WHERE claim_id = $1 AND stance != 'neutral') p
            WHERE a.id = p.id RETURNING a.id, p.prior AS stance`,
          [claimId]
        )
      : [];

  const [priorDefinition] = await rawQuery<Record<string, unknown>>(
    `SELECT measures, population, conditions, unit, created_by FROM quantity_definitions WHERE claim_id = $1`,
    [claimId]
  );
  if (definition) {
    await rawQuery(
      `INSERT INTO quantity_definitions (claim_id, measures, population, conditions, unit, created_by)
       VALUES ($1, $2, $3, $4, $5, 'curator')
       ON CONFLICT (claim_id) DO UPDATE
         SET measures = EXCLUDED.measures, population = EXCLUDED.population,
             conditions = EXCLUDED.conditions, unit = EXCLUDED.unit, updated_at = now()`,
      [
        claimId,
        definition.measures,
        definition.population ?? null,
        definition.conditions ?? null,
        JSON.stringify(definition.unit),
      ]
    );
  }
  await rawQuery(`UPDATE claims SET kind = $2, updated_at = now() WHERE id = $1`, [claimId, to]);

  const eventId = await logEvent("change_kind", reasoning, {
    claim_id: claimId,
    from,
    to,
    retired,
    remapped_stances: remappedStances,
    neutralized_arguments: neutralizedArguments,
    prior_definition: priorDefinition ?? null,
  });
  return { changed: true, from, eventId };
}

/**
 * Create a new node (embedded): a claim, a quantity with its definition, or
 * a question (§2, §7a), so a split can mint what each part actually is
 * (#764). Logs a reversible `create_claim` event.
 */
export async function createClaim(input: {
  text: string;
  claimType?: string;
  kind?: "claim" | "quantity" | "question";
  /** Required for a quantity: what its value is a value of (§3). */
  definition?: QuantityDefinitionInput | null;
  createdBy?: string;
}): Promise<{ id: string; eventId?: string }> {
  const kind = input.kind ?? "claim";
  // Validated before anything is written: a quantity without a definition
  // is not a quantity (§3).
  const definition = kind === "quantity" ? quantityDefinitionSchema.parse(input.definition ?? undefined) : null;
  const db = getDb();
  let embedding: number[] | undefined;
  try {
    embedding = await generateEmbedding(input.text);
  } catch {
    // Continue without embedding
  }
  const [claim] = await db
    .insert(claims)
    .values({
      text: input.text,
      kind,
      claimType: input.claimType ?? "empirical_derived",
      embedding: embedding ?? undefined,
      pipelineEpoch: loadConfig().pipelineEpoch,
      createdBy: input.createdBy ?? "curator",
    })
    .returning({ id: claims.id });
  if (definition) {
    await rawQuery(
      `INSERT INTO quantity_definitions (claim_id, measures, population, conditions, unit, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        claim!.id,
        definition.measures,
        definition.population ?? null,
        definition.conditions ?? null,
        JSON.stringify(definition.unit),
        input.createdBy ?? "curator",
      ]
    );
  }
  const eventId = await logEvent("create_claim", "split: new claim", {
    claim_id: claim!.id,
    kind,
  });
  return { id: claim!.id, eventId };
}

/**
 * Complete or correct a quantity's definition (Part VIII: the Curator
 * "completes ... a quantity whose definition leaves its value open"; #764).
 * Logs a reversible `set_definition` event holding the prior definition,
 * so the completion can be undone like any other surgery. A definition
 * that different considerations would bear on is a different quantity:
 * that is a split (createClaim with kind quantity), not this.
 */
export async function setQuantityDefinition(input: {
  claimId: string;
  definition: QuantityDefinitionInput;
  reasoning: string;
}): Promise<{ eventId?: string }> {
  const definition = quantityDefinitionSchema.parse(input.definition);
  const [row] = await rawQuery<{ kind: string; state: string }>(
    `SELECT kind, state FROM claims WHERE id = $1`,
    [input.claimId]
  );
  if (!row) throw new Error(`Node ${input.claimId} not found`);
  if (row.state !== "active") throw new Error(`Node ${input.claimId} is ${row.state}, not active`);
  if (row.kind !== "quantity") {
    throw new Error(
      `Node ${input.claimId} is a ${row.kind}, not a quantity. Change its kind first ` +
        `(change_node_kind takes the definition).`
    );
  }
  const [prior] = await rawQuery<Record<string, unknown>>(
    `SELECT measures, population, conditions, unit, created_by FROM quantity_definitions WHERE claim_id = $1`,
    [input.claimId]
  );
  await rawQuery(
    `INSERT INTO quantity_definitions (claim_id, measures, population, conditions, unit, created_by)
     VALUES ($1, $2, $3, $4, $5, 'curator')
     ON CONFLICT (claim_id) DO UPDATE
       SET measures = EXCLUDED.measures, population = EXCLUDED.population,
           conditions = EXCLUDED.conditions, unit = EXCLUDED.unit, updated_at = now()`,
    [
      input.claimId,
      definition.measures,
      definition.population ?? null,
      definition.conditions ?? null,
      JSON.stringify(definition.unit),
    ]
  );
  const eventId = await logEvent("set_definition", input.reasoning, {
    claim_id: input.claimId,
    prior_definition: prior ?? null,
  });
  return { eventId };
}

/**
 * Correct a node's proposition type (claims.claim_type) and its domain
 * tags (claims.domains), which point every run on it to its domain skills
 * (#640). Either may be omitted. Logs a reversible `reclassify` event
 * holding the prior values. The values are validated by the caller (the
 * closed lists live with the tools).
 */
export async function reclassifyClaim(input: {
  claimId: string;
  claimType?: string;
  domains?: string[];
  reasoning: string;
}): Promise<{ changed: boolean; eventId?: string }> {
  const [row] = await rawQuery<{
    state: string;
    claim_type: string;
    domains: string[] | null;
    domains_source: string | null;
  }>(`SELECT state, claim_type, domains, domains_source FROM claims WHERE id = $1`, [input.claimId]);
  if (!row) throw new Error(`Node ${input.claimId} not found`);
  if (row.state !== "active") throw new Error(`Node ${input.claimId} is ${row.state}, not active`);
  const sameType = input.claimType === undefined || input.claimType === row.claim_type;
  const sameDomains =
    input.domains === undefined ||
    JSON.stringify([...input.domains].sort()) === JSON.stringify([...(row.domains ?? [])].sort());
  if (sameType && sameDomains) return { changed: false };
  await rawQuery(
    `UPDATE claims
        SET claim_type = COALESCE($2, claim_type),
            domains = COALESCE($3::text[], domains),
            domains_source = CASE WHEN $3::text[] IS NULL THEN domains_source ELSE 'curator' END,
            updated_at = now()
      WHERE id = $1`,
    [input.claimId, input.claimType ?? null, input.domains ?? null]
  );
  const eventId = await logEvent("reclassify", input.reasoning, {
    claim_id: input.claimId,
    prior_claim_type: row.claim_type,
    prior_domains: row.domains ?? [],
    prior_domains_source: row.domains_source,
  });
  return { changed: true, eventId };
}

/** One logged reconciliation operation, as the Curator reads it. */
export interface ReconciliationEventRow {
  id: string;
  operation: string;
  reasoning: string;
  /** The nodes the operation touched. */
  node_ids: string[];
  reversed: boolean;
  created_at: string;
}

/** The payload keys that name a node, across every operation. */
const NODE_KEYS = [
  "survivor_id",
  "loser_id",
  "claim_id",
  "other_claim_id",
  "parent_id",
  "child_id",
  "from_claim_id",
  "to_claim_id",
  "survivor_argument_id",
  "absorbed_argument_id",
  "argument_id",
] as const;

function eventNodeIds(payload: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const key of NODE_KEYS) {
    const v = payload[key];
    if (typeof v === "string" && v) ids.add(v);
  }
  for (const e of (payload.deleted_edges as EdgeRow[] | undefined) ?? []) {
    ids.add(e.parent_claim_id);
    ids.add(e.child_claim_id);
  }
  for (const l of [
    ...((payload.deleted_links as ClaimLinkRow[] | undefined) ?? []),
    ...((payload.moved_links as ClaimLinkRow[] | undefined) ?? []),
  ]) {
    ids.add(l.claim_a_id);
    ids.add(l.claim_b_id);
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Merging and splitting arguments (§5, §7, #541)
// ---------------------------------------------------------------------------

interface ArgumentRow {
  id: string;
  claim_id: string;
  name: string | null;
  stance: string;
  content: string;
  description: string | null;
  retired_at: Date | null;
  retired_reason: string | null;
  merged_into: string | null;
}

async function argumentRow(id: string): Promise<ArgumentRow | null> {
  const [row] = await rawQuery<ArgumentRow>(
    `SELECT id, claim_id, name, stance, content, description, retired_at, retired_reason, merged_into
       FROM arguments WHERE id = $1`,
    [id]
  );
  return row ?? null;
}

/**
 * Merge two arguments recognized as one: the same conclusion reached
 * through the same inference (§7). The survivor keeps whichever written
 * form states the inference better (`writtenFormFrom`), never the older
 * one by default; the absorbed argument's instances and premise groupings
 * move to the survivor, and the absorbed row stays as an alias, retired
 * with the reason, its evaluations as history. Logged for undo.
 */
export async function mergeArguments(input: {
  survivorId: string;
  absorbedId: string;
  writtenFormFrom: "survivor" | "absorbed";
  reasoning: string;
}): Promise<{ eventId?: string; claimId: string; movedInstances: number; movedPremises: number }> {
  const { survivorId, absorbedId, reasoning } = input;
  if (survivorId === absorbedId) throw new Error("Cannot merge an argument into itself.");
  const survivor = await argumentRow(survivorId);
  const absorbed = await argumentRow(absorbedId);
  if (!survivor) throw new Error(`Argument not found: ${survivorId}`);
  if (!absorbed) throw new Error(`Argument not found: ${absorbedId}`);
  if (survivor.merged_into || absorbed.merged_into) {
    throw new Error("One of these arguments is already merged into another; merge into the one it names.");
  }
  // The conclusion is part of an argument's identity (§7): arguments on
  // different nodes, or on opposite sides of one, are different arguments.
  if (survivor.claim_id !== absorbed.claim_id) {
    throw new Error(
      "Arguments on different nodes reach different conclusions, so they are different arguments (§7). " +
        "If the nodes are one claim, merge the claims first."
    );
  }
  if (survivor.stance !== absorbed.stance) {
    throw new Error(
      `One argument is ${survivor.stance} and the other ${absorbed.stance}: they reach opposite conclusions, so they are different arguments (§7).`
    );
  }
  if (survivor.retired_at && !absorbed.retired_at) {
    throw new Error(
      "The survivor is retired and the absorbed argument is live. Make the live one the survivor " +
        "(take the written form you judge better with written_form_from), so the merge does not take an argument off the claim."
    );
  }

  return withTransaction(async (tx) => {
    // Instances follow the argument.
    const movedInstances = await tx.query<{ id: string }>(
      `UPDATE argument_instances SET argument_id = $1 WHERE argument_id = $2 RETURNING id`,
      [survivorId, absorbedId]
    );
    // Premise groupings: the absorbed argument's edges join the survivor's
    // where they are not already grouped there; the absorbed rows go, kept
    // in the payload for the undo.
    const absorbedMemberships = await tx.query<{ relationship_id: string; created_at: Date }>(
      `DELETE FROM argument_subclaims WHERE argument_id = $1 RETURNING relationship_id, created_at`,
      [absorbedId]
    );
    const addedMemberships = await tx.query<{ relationship_id: string }>(
      `INSERT INTO argument_subclaims (argument_id, relationship_id)
       SELECT $1, rid FROM unnest($2::uuid[]) AS rid
        WHERE NOT EXISTS (SELECT 1 FROM argument_subclaims WHERE argument_id = $1 AND relationship_id = rid)
       RETURNING relationship_id`,
      [survivorId, absorbedMemberships.map((m) => m.relationship_id)]
    );
    const replacedWrittenForm = input.writtenFormFrom === "absorbed";
    if (replacedWrittenForm) {
      await tx.query(`UPDATE arguments SET content = $2, description = $3 WHERE id = $1`, [
        survivorId,
        absorbed.content,
        absorbed.description,
      ]);
    }
    await tx.query(
      `UPDATE arguments
          SET merged_into = $2,
              retired_at = COALESCE(retired_at, now()),
              retired_reason = $3
        WHERE id = $1`,
      [absorbedId, survivorId, `Merged into argument ${survivorId}: ${reasoning}`]
    );
    const [event] = await tx.query<{ id: string }>(
      `INSERT INTO reconciliation_events (operation, reasoning, payload, created_by)
       VALUES ('merge_arguments', $1, $2::jsonb, 'curator') RETURNING id`,
      [
        reasoning,
        JSON.stringify({
          claim_id: survivor.claim_id,
          survivor_argument_id: survivorId,
          absorbed_argument_id: absorbedId,
          moved_instance_ids: movedInstances.map((r) => r.id),
          absorbed_relationship_ids: absorbedMemberships.map((m) => m.relationship_id),
          added_relationship_ids: addedMemberships.map((m) => m.relationship_id),
          replaced_written_form: replacedWrittenForm
            ? { content: survivor.content, description: survivor.description }
            : null,
          absorbed_prev_retired: absorbed.retired_at
            ? { at: new Date(absorbed.retired_at).toISOString(), reason: absorbed.retired_reason }
            : null,
        }),
      ]
    );
    return {
      eventId: event?.id,
      claimId: survivor.claim_id,
      movedInstances: movedInstances.length,
      movedPremises: addedMemberships.length,
    };
  });
}

/**
 * Split an argument recognized as several lines of reasoning (§5, §7).
 * Each part becomes a new argument on the same node with the same stance,
 * taking the premise groupings (edge ids) and instances named for it; the
 * original keeps the rest. The original's current evaluation rated an
 * inference it no longer makes, so it stops being current, and every part
 * awaits its Steward's written form and evaluation. Logged for undo, which
 * retires the parts rather than deleting them.
 */
export async function splitArgument(input: {
  argumentId: string;
  parts: Array<{ name: string; writtenForm: string; relationshipIds: string[]; instanceIds: string[] }>;
  reasoning: string;
}): Promise<{ eventId?: string; claimId: string; partIds: string[] }> {
  const original = await argumentRow(input.argumentId);
  if (!original) throw new Error(`Argument not found: ${input.argumentId}`);
  if (original.merged_into) throw new Error("That argument is merged into another; split the one it names.");
  if (original.retired_at) throw new Error("That argument is retired; a split is for an argument on the claim.");
  if (input.parts.length === 0) throw new Error("Name at least one part to split off.");

  const grouped = new Set(
    (
      await rawQuery<{ relationship_id: string }>(
        `SELECT relationship_id FROM argument_subclaims WHERE argument_id = $1`,
        [original.id]
      )
    ).map((r) => r.relationship_id)
  );
  const instances = new Set(
    (await rawQuery<{ id: string }>(`SELECT id FROM argument_instances WHERE argument_id = $1`, [original.id])).map(
      (r) => r.id
    )
  );
  const seenEdges = new Set<string>();
  const seenInstances = new Set<string>();
  for (const part of input.parts) {
    if (!part.name.trim() || !part.writtenForm.trim()) throw new Error("Each part needs a name and a written form.");
    for (const r of part.relationshipIds) {
      if (!grouped.has(r)) throw new Error(`Edge ${r} is not grouped under argument ${original.id}.`);
      if (seenEdges.has(r)) throw new Error(`Edge ${r} is named for two parts; name it once.`);
      seenEdges.add(r);
    }
    for (const i of part.instanceIds) {
      if (!instances.has(i)) throw new Error(`Instance ${i} is not an instance of argument ${original.id}.`);
      if (seenInstances.has(i)) throw new Error(`Instance ${i} is named for two parts; name it once.`);
      seenInstances.add(i);
    }
  }

  return withTransaction(async (tx) => {
    const partIds: string[] = [];
    const moves: Array<{ part_id: string; relationship_ids: string[]; instance_ids: string[] }> = [];
    for (const part of input.parts) {
      const [row] = await tx.query<{ id: string }>(
        `INSERT INTO arguments (claim_id, stance, name, content, created_by)
         VALUES ($1, $2, $3, $4, 'curator') RETURNING id`,
        [original.claim_id, original.stance, part.name.trim(), part.writtenForm.trim()]
      );
      const partId = row!.id;
      partIds.push(partId);
      if (part.relationshipIds.length > 0) {
        await tx.query(
          `UPDATE argument_subclaims SET argument_id = $1
            WHERE argument_id = $2 AND relationship_id = ANY($3::uuid[])`,
          [partId, original.id, part.relationshipIds]
        );
      }
      if (part.instanceIds.length > 0) {
        await tx.query(`UPDATE argument_instances SET argument_id = $1 WHERE id = ANY($2::uuid[])`, [
          partId,
          part.instanceIds,
        ]);
      }
      moves.push({ part_id: partId, relationship_ids: part.relationshipIds, instance_ids: part.instanceIds });
    }
    const retiredEvaluations = await tx.query<{ id: string }>(
      `UPDATE argument_evaluations SET is_current = false
        WHERE argument_id = $1 AND is_current = true RETURNING id`,
      [original.id]
    );
    const [event] = await tx.query<{ id: string }>(
      `INSERT INTO reconciliation_events (operation, reasoning, payload, created_by)
       VALUES ('split_argument', $1, $2::jsonb, 'curator') RETURNING id`,
      [
        input.reasoning,
        JSON.stringify({
          claim_id: original.claim_id,
          argument_id: original.id,
          moves,
          retired_evaluation_ids: retiredEvaluations.map((r) => r.id),
        }),
      ]
    );
    return { eventId: event?.id, claimId: original.claim_id, partIds };
  });
}

/** How many events list_reconciliation_events returns at most, newest first. */
export const RECONCILIATION_EVENTS_LIMIT = 30;

/**
 * The logged operations that touched a node, newest first: what the Curator
 * reads to find the event a wrong merge, kind change or split step left,
 * and to reverse it (#761).
 */
export async function listReconciliationEvents(
  claimId: string,
  limit = RECONCILIATION_EVENTS_LIMIT
): Promise<ReconciliationEventRow[]> {
  const rows = await rawQuery<{
    id: string;
    operation: string;
    reasoning: string;
    payload: Record<string, unknown>;
    reversed: boolean;
    created_at: Date;
  }>(
    `SELECT id, operation, reasoning, payload, reversed, created_at
       FROM reconciliation_events
      WHERE payload::text LIKE '%' || $1 || '%'
      ORDER BY created_at DESC
      LIMIT $2`,
    [claimId, Math.min(RECONCILIATION_EVENTS_LIMIT, Math.max(1, limit))]
  );
  return rows.map((r) => ({
    id: r.id,
    operation: r.operation,
    reasoning: r.reasoning,
    node_ids: eventNodeIds(r.payload ?? {}),
    reversed: r.reversed,
    created_at: new Date(r.created_at).toISOString(),
  }));
}

/** Add a relationship edge between two existing claims. Logs an `add_edge` event. */
export async function addRelationshipEdge(input: {
  parentId: string;
  childId: string;
  relationType: string;
  reasoning: string;
  confidence?: number;
  createdBy?: string;
}): Promise<{ added: boolean; eventId?: string }> {
  if (input.parentId === input.childId) return { added: false };
  // Only a true duplicate reads as not-added; a missing claim or any other
  // failure propagates rather than masquerading as "already existed".
  const { created } = await insertRelationshipEdge({
    parentId: input.parentId,
    childId: input.childId,
    relationType: input.relationType,
    reasoning: input.reasoning,
    confidence: input.confidence ?? 1.0,
    createdBy: input.createdBy ?? "curator",
  });
  if (!created) return { added: false };
  const eventId = await logEvent("add_edge", input.reasoning, {
    parent_id: input.parentId,
    child_id: input.childId,
    relation_type: input.relationType.toLowerCase(),
  });
  return { added: true, eventId };
}

/** Remove a relationship edge. Captures the deleted rows; logs a `remove_edge` event. */
export async function removeRelationshipEdge(input: {
  parentId: string;
  childId: string;
  relationType?: string;
}): Promise<{ removed: number; eventId?: string }> {
  const ids = (
    await rawQuery<{ id: string }>(
      `SELECT id FROM claim_relationships
        WHERE parent_claim_id = $1 AND child_claim_id = $2
        ${input.relationType ? "AND relation_type = $3" : ""}`,
      input.relationType
        ? [input.parentId, input.childId, input.relationType.toLowerCase()]
        : [input.parentId, input.childId]
    )
  ).map((r) => r.id);
  const deleted = await captureAndDeleteEdges(ids);
  const eventId =
    deleted.length > 0
      ? await logEvent("remove_edge", "split: edge removed", { deleted_edges: deleted })
      : undefined;
  return { removed: deleted.length, eventId };
}

/**
 * Record a lateral link (#436) between two claims. Logs a reversible
 * `link_claims` event when the link is new; a duplicate is reported, not
 * re-logged.
 */
export async function linkClaims(input: {
  claimId: string;
  otherClaimId: string;
  kind: ClaimLinkKind;
  reasoning: string;
  createdBy?: string;
}): Promise<{ linked: boolean; linkId: string; eventId?: string }> {
  const { id, created } = await insertClaimLink({
    ...input,
    createdBy: input.createdBy ?? "curator",
  });
  if (!created) return { linked: false, linkId: id };
  const eventId = await logEvent("link_claims", input.reasoning, {
    link_id: id,
    claim_id: input.claimId,
    other_claim_id: input.otherClaimId,
    kind: input.kind,
  });
  return { linked: true, linkId: id, eventId };
}

/** Remove lateral link(s) between two claims. Logs a reversible `unlink_claims` event. */
export async function unlinkClaims(input: {
  claimId: string;
  otherClaimId: string;
  kind?: ClaimLinkKind;
  reasoning?: string;
}): Promise<{ removed: number; eventId?: string }> {
  const deleted = await deleteClaimLinks(input);
  const eventId =
    deleted.length > 0
      ? await logEvent("unlink_claims", input.reasoning ?? "link removed", {
          deleted_links: deleted,
        })
      : undefined;
  return { removed: deleted.length, eventId };
}

/** Restore captured lateral links; idempotent against a link already present. */
async function reinsertLinks(links: ClaimLinkRow[]): Promise<void> {
  for (const link of links) {
    await insertClaimLink({
      claimId: link.claim_a_id,
      otherClaimId: link.claim_b_id,
      kind: link.kind as ClaimLinkKind,
      reasoning: link.reasoning,
      createdBy: link.created_by,
    });
  }
}

/** What a reassigned instance carried before, as logged for the reversal. */
interface InstancePrior {
  claim_id: string;
  stance: string;
  stated_estimate: unknown;
  argument_id: string | null;
  answer_claim_id: string | null;
  display_rank: number | null;
}

export interface ReassignInstanceResult {
  reassigned: boolean;
  /** Why nothing was written, when `reassigned` is false. */
  reason?: string;
  mode?: "move" | "copy";
  /** The instance now on the target: the moved row, or the new copy. */
  instanceId?: string;
  /** The stance it carries there. */
  stance?: string;
  eventId?: string;
}

/**
 * Put a source's passage on another node (§4, §5): move the instance there,
 * or, with `copy`, leave it where it is and record a second instance of the
 * same passage on the target. One operation for every kind of target:
 *
 *  - The stance is read into the target kind's vocabulary (KIND_STANCE_MAP),
 *    as a kind change does.
 *  - A claim target takes `stanceRelation`: "opposed" when the target is
 *    worded as the denial of what the instance was recorded against, which
 *    flips affirms and denies and leaves poses and mentions alone.
 *  - A quantity target takes `stated`, the figure the passage gives for
 *    that quantity, since a figure recorded against another node says
 *    nothing about this one. Several figures from one source are allowed.
 *  - A question target may take `answerClaimId`, the answer in its answer
 *    set that the passage gives.
 *
 * A move clears what pointed into the old node (its argument, its answer,
 * its place in the page order). A copy starts unread: the readings and
 * provenance edges recorded on the original are judgments about the passage
 * against the original's node, and stay with it. A copy onto a claim that
 * already holds an instance from the same source and speaker is refused, as
 * record_claim_instance refuses one. Logs a reversible `reassign_instance`
 * event.
 */
export async function reassignInstance(input: {
  instanceId: string;
  toClaimId: string;
  copy?: boolean;
  reasoning?: string;
  stanceRelation?: "same" | "opposed";
  stated?: unknown;
  answerClaimId?: string | null;
}): Promise<ReassignInstanceResult> {
  const copy = input.copy === true;
  const mode = copy ? "copy" : "move";
  const refuse = (reason: string): ReassignInstanceResult => ({ reassigned: false, reason });

  return withTransaction(async (tx) => {
    // The prior state is captured first, under a lock, so the operation is
    // reversible against exactly what it found.
    const [before] = await tx.query<
      InstancePrior & {
        source_id: string;
        verbatim_text: string;
        context: string | null;
        summary_context: string | null;
        speaker: string | null;
        publication: string | null;
        source_date: string | null;
        link: string | null;
        segment_id: string | null;
      }
    >(
      `SELECT claim_id, stance, stated_estimate, argument_id, answer_claim_id, display_rank,
              source_id, verbatim_text, context, summary_context, speaker, publication,
              source_date, link, segment_id
         FROM claim_instances WHERE id = $1 FOR UPDATE`,
      [input.instanceId]
    );
    if (!before) return refuse(`instance ${input.instanceId} not found`);
    if (!copy && before.claim_id === input.toClaimId) {
      return refuse("the instance is already on that node; nothing to move");
    }

    const [target] = await tx.query<{ kind: string; state: string }>(
      `SELECT kind, state FROM claims WHERE id = $1`,
      [input.toClaimId]
    );
    if (!target) return refuse(`node ${input.toClaimId} not found`);
    if (target.state !== "active") {
      return refuse(`node ${input.toClaimId} is ${target.state}, not active`);
    }

    const opposed = input.stanceRelation === "opposed";
    if (opposed && target.kind !== "claim") {
      return refuse(
        `stance_relation "opposed" applies to a claim, which a source affirms or denies; ` +
          `${input.toClaimId} is a ${target.kind}`
      );
    }
    const statedGiven = input.stated !== undefined && input.stated !== null;
    if (target.kind === "quantity" && !statedGiven) {
      return refuse(
        `${input.toClaimId} is a quantity: give stated, the figure this passage states for it ` +
          `(form "none" with the reason when the passage gives no figure)`
      );
    }
    if (target.kind !== "quantity" && statedGiven) {
      return refuse(`stated is a figure for a quantity; ${input.toClaimId} is a ${target.kind}`);
    }
    let stated: unknown = null;
    if (statedGiven) {
      const parsed = quantityEstimateSchema.safeParse(input.stated);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "stated"}: ${i.message}`);
        return refuse(`stated is not a figure: ${issues.join("; ")}`);
      }
      stated = parsed.data;
    }
    const answerClaimId = input.answerClaimId || null;
    if (answerClaimId) {
      if (target.kind !== "question") {
        return refuse(`answer_claim_id names an answer to a question; ${input.toClaimId} is a ${target.kind}`);
      }
      const [inSet] = await tx.query<{ id: string }>(
        `SELECT id FROM claim_relationships
          WHERE parent_claim_id = $1 AND child_claim_id = $2 AND relation_type = 'answers'`,
        [input.toClaimId, answerClaimId]
      );
      if (!inSet) {
        return refuse(`node ${answerClaimId} is not in the answer set of question ${input.toClaimId}`);
      }
    }

    // The stance on the target: the target kind's vocabulary first, then
    // what the caller said about this passage and this node.
    let stance = KIND_STANCE_MAP[target.kind]?.[before.stance] ?? before.stance;
    if (target.kind === "quantity") stance = "states";
    else if (answerClaimId) stance = "answers";
    else if (opposed) stance = stance === "affirms" ? "denies" : stance === "denies" ? "affirms" : stance;

    // One instance per (claim, source, speaker), as record_claim_instance
    // keeps it: an unattributed row on either side matches any voice. A
    // detached one counts, since a copy would silently overturn the judgment
    // that detached it. A quantity holds each figure a source gives, and a
    // question each asking and answering, so neither is deduplicated.
    if (copy && target.kind === "claim") {
      const [existing] = await tx.query<{ id: string; stance: string; detached_at: Date | null }>(
        `SELECT id, stance, detached_at FROM claim_instances
          WHERE claim_id = $1 AND source_id = $2
            AND ($3::text IS NULL OR speaker IS NULL OR lower(speaker) = lower($3::text))
          ORDER BY COALESCE(lower(speaker) = lower($3::text), false) DESC,
                   (detached_at IS NULL) DESC, created_at
          LIMIT 1`,
        [input.toClaimId, before.source_id, before.speaker]
      );
      if (existing) {
        return refuse(
          `claim ${input.toClaimId} already has an instance from this source` +
            `${before.speaker ? ` and speaker (${before.speaker})` : ""}: ${existing.id} ` +
            `(stance: ${existing.stance}${existing.detached_at ? ", detached by its Steward" : ""}); ` +
            `nothing was copied`
        );
      }
    }

    const statedJson = stated === null ? null : JSON.stringify(stated);
    let instanceId = input.instanceId;
    if (copy) {
      const [row] = await tx.query<{ id: string }>(
        `INSERT INTO claim_instances
           (claim_id, source_id, verbatim_text, context, summary_context, stance, stated_estimate,
            answer_claim_id, speaker, publication, source_date, link, segment_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, 'curator')
         RETURNING id`,
        [
          input.toClaimId,
          before.source_id,
          before.verbatim_text,
          before.context,
          before.summary_context,
          stance,
          statedJson,
          answerClaimId,
          before.speaker,
          before.publication,
          before.source_date,
          before.link,
          before.segment_id,
        ]
      );
      instanceId = row!.id;
    } else {
      // The argument, the answer and the rank each point into the old node,
      // so none of them travels; a figure is restated or dropped.
      await tx.query(
        `UPDATE claim_instances
            SET claim_id = $1, stance = $3, stated_estimate = $4::jsonb,
                argument_id = NULL, answer_claim_id = $5, display_rank = NULL
          WHERE id = $2`,
        [input.toClaimId, input.instanceId, stance, statedJson, answerClaimId]
      );
    }

    const prior: InstancePrior = {
      claim_id: before.claim_id,
      stance: before.stance,
      stated_estimate: before.stated_estimate ?? null,
      argument_id: before.argument_id,
      answer_claim_id: before.answer_claim_id,
      display_rank: before.display_rank,
    };
    const eventId = await logEvent(
      "reassign_instance",
      input.reasoning?.trim() || (copy ? "split: instance copied" : "split: instance moved"),
      {
        mode,
        instance_id: instanceId,
        copied_from_instance_id: copy ? input.instanceId : null,
        from_claim_id: before.claim_id,
        to_claim_id: input.toClaimId,
        stance_relation: opposed ? "opposed" : "same",
        stance,
        prior,
      },
      tx
    );
    return { reassigned: true, mode, instanceId, stance, eventId };
  });
}

/**
 * Reverse a logged reconciliation event, restoring the prior state as faithfully
 * as the recorded payload allows. Idempotent: a `reversed` event is a no-op.
 *
 * Refused while a later, unreversed operation touched any of the same nodes:
 * each payload records the state it found, so undoing an older operation
 * under a newer one would restore a state the newer one no longer matches.
 * Reverse newest first. With `reasoning` (the Curator's tool), the reversal
 * is itself logged, as a `reverse` event naming the one it undid (#761).
 */
export async function reverseReconciliation(
  eventId: string,
  opts: { reasoning?: string } = {}
): Promise<{ reversed: boolean; reason?: string; blockedBy?: string[] }> {
  const [event] = await rawQuery<{
    operation: string;
    payload: Record<string, unknown>;
    reversed: boolean;
  }>(`SELECT operation, payload, reversed FROM reconciliation_events WHERE id = $1`, [eventId]);

  if (!event) return { reversed: false, reason: "event not found" };
  if (event.reversed) return { reversed: false, reason: "already reversed" };
  if (event.operation === "reverse") {
    return { reversed: false, reason: "a reversal cannot itself be reversed; redo the operation instead" };
  }

  const p = event.payload;
  // A copied instance leaves the node it was copied from as it was, so a
  // copy neither waits on later operations there nor holds up earlier ones:
  // one passage copied to each node of a split is undone one copy at a time.
  const isCopy = (payload: Record<string, unknown>) => payload.mode === "copy";
  const nodes = eventNodeIds(p ?? {}).filter(
    (n) => !(isCopy(p ?? {}) && n === p.from_claim_id && n !== p.to_claim_id)
  );
  if (nodes.length > 0) {
    // "Later" is decided in SQL against the event's own stored timestamp,
    // never a value round-tripped through JavaScript: a JS Date keeps
    // milliseconds and Postgres microseconds, so a timestamp passed back
    // in would read the event as later than itself. The event itself is
    // excluded by id as well. Each operation logs its event in its own
    // statement, so two events never share a timestamp in practice.
    const later = await rawQuery<{ id: string }>(
      `SELECT e.id FROM reconciliation_events e
        WHERE e.id <> $1
          AND e.created_at > (SELECT created_at FROM reconciliation_events WHERE id = $1)
          AND e.reversed = false AND e.operation <> 'reverse'
          AND e.payload::text LIKE ANY($2::text[])
          AND NOT (e.operation = 'reassign_instance' AND e.payload->>'mode' = 'copy'
                   AND NOT (e.payload->>'to_claim_id' = ANY($3::text[])))
        ORDER BY e.created_at DESC`,
      [eventId, nodes.map((n) => `%${n}%`), nodes]
    );
    if (later.length > 0) {
      return {
        reversed: false,
        reason:
          "later operations touched the same nodes; reverse them first, newest first",
        blockedBy: later.map((r) => r.id),
      };
    }
  }

  switch (event.operation) {
    case "merge": {
      const survivorId = p.survivor_id as string;
      const loserId = p.loser_id as string;
      const opposed = p.stance_relation === "opposed";
      const movedInstances = (p.moved_instance_ids as string[]) ?? [];
      const movedArguments = (p.moved_argument_ids as string[]) ?? [];
      const repointedChild = (p.repointed_child_edge_ids as string[]) ?? [];
      const repointedParent = (p.repointed_parent_edge_ids as string[]) ?? [];
      const deletedEdges = (p.deleted_edges as EdgeRow[]) ?? [];
      const repointedMemberships = (p.repointed_memberships as MembershipRef[]) ?? [];
      const movedLinks = (p.moved_links as ClaimLinkRow[]) ?? [];
      const mergedLinkIds = (p.merged_link_ids as string[]) ?? [];

      // Move instances/arguments back (un-flipping stance for an opposed merge).
      // Param order matches FLIP_*_STANCE, which references $3::boolean.
      if (movedInstances.length) {
        await rawQuery(
          `UPDATE claim_instances SET claim_id = $1, stance = ${FLIP_INSTANCE_STANCE}
            WHERE id = ANY($2::uuid[]) AND claim_id = $4`,
          [loserId, movedInstances, opposed, survivorId]
        );
      }
      if (movedArguments.length) {
        await rawQuery(
          `UPDATE arguments SET claim_id = $1, stance = ${FLIP_ARGUMENT_STANCE}
            WHERE id = ANY($2::uuid[]) AND claim_id = $4`,
          [loserId, movedArguments, opposed, survivorId]
        );
      }
      // Argument passages still waiting on the survivor go back with their
      // prior side; any its Steward placed since stay where they were put.
      for (const ap of (p.moved_argument_passages as Array<{ id: string; direction: string | null }>) ?? []) {
        await rawQuery(
          `UPDATE argument_instances SET claim_id = $2, direction = $3 WHERE id = $1 AND claim_id = $4`,
          [ap.id, loserId, ap.direction, survivorId]
        );
      }
      // A merge across kinds: the stances it rewrote, and its kinds' rows.
      await restoreStances((p.remapped_stances as StanceRef[]) ?? []);
      for (const a of (p.neutralized_arguments as StanceRef[]) ?? []) {
        await rawQuery(`UPDATE arguments SET stance = $2 WHERE id = $1`, [a.id, a.stance]);
      }
      await restoreKindRefs(loserId, survivorId, (p.kind_refs as Partial<KindRefsMoved>) ?? {});
      // Repoint the survivor-side edges back to the loser.
      if (repointedChild.length) {
        await rawQuery(
          `UPDATE claim_relationships SET child_claim_id = $1 WHERE id = ANY($2::uuid[])`,
          [loserId, repointedChild]
        );
      }
      if (repointedParent.length) {
        await rawQuery(
          `UPDATE claim_relationships SET parent_claim_id = $1 WHERE id = ANY($2::uuid[])`,
          [loserId, repointedParent]
        );
      }
      // Drop the memberships the merge carried onto the survivor's edges (and
      // only those), then restore the deleted duplicates with their own.
      if (repointedMemberships.length) {
        await rawQuery(
          `DELETE FROM argument_subclaims
            WHERE (argument_id, relationship_id) IN
                  (SELECT unnest($1::uuid[]), unnest($2::uuid[]))`,
          [
            repointedMemberships.map((m) => m.argument_id),
            repointedMemberships.map((m) => m.relationship_id),
          ]
        );
      }
      await reinsertEdges(deletedEdges);
      // Lateral links: drop what the merge created, restore the originals.
      if (mergedLinkIds.length) {
        await rawQuery(`DELETE FROM claim_links WHERE id = ANY($1::uuid[])`, [
          mergedLinkIds,
        ]);
      }
      await reinsertLinks(movedLinks);
      // Un-merge the loser.
      await rawQuery(
        `UPDATE claims SET merged_into = NULL, state = $2, updated_at = now() WHERE id = $1`,
        [loserId, (p.loser_prev_state as string) ?? "active"]
      );
      await recordStateChange({
        claimId: loserId,
        fromState: "merged",
        toState: (p.loser_prev_state as string) ?? "active",
        actor: "curator",
        reason: opts.reasoning ?? "The merge was reversed.",
        reconciliationEventId: eventId,
      });
      break;
    }

    case "change_kind": {
      const claimId = p.claim_id as string;
      const retired = (p.retired as Record<string, string[]>) ?? {};
      // The new kind's records are retired; the old kind's come back.
      for (const table of ["assessments", "quantity_estimates", "question_assessments"]) {
        await rawQuery(`UPDATE ${table} SET is_current = false WHERE claim_id = $1 AND is_current = true`, [claimId]);
        const ids = retired[table] ?? [];
        if (ids.length) {
          await rawQuery(`UPDATE ${table} SET is_current = true WHERE id = ANY($1::uuid[])`, [ids]);
        }
      }
      await restoreStances((p.remapped_stances as StanceRef[]) ?? []);
      for (const a of (p.neutralized_arguments as StanceRef[]) ?? []) {
        await rawQuery(`UPDATE arguments SET stance = $2 WHERE id = $1`, [a.id, a.stance]);
      }
      const prior = p.prior_definition as Record<string, unknown> | null;
      if (prior) {
        await rawQuery(
          `UPDATE quantity_definitions SET measures = $2, population = $3, conditions = $4, unit = $5, updated_at = now()
            WHERE claim_id = $1`,
          [claimId, prior.measures, prior.population ?? null, prior.conditions ?? null, JSON.stringify(prior.unit)]
        );
      } else if (p.to === "quantity") {
        await rawQuery(`DELETE FROM quantity_definitions WHERE claim_id = $1`, [claimId]);
      }
      await rawQuery(`UPDATE claims SET kind = $2, updated_at = now() WHERE id = $1`, [claimId, p.from as string]);
      break;
    }

    case "create_claim": {
      // A split-off claim: deprecate it (excluded from search) rather than hard
      // delete, since downstream rows may reference it.
      const [before] = await rawQuery<{ state: string }>(`SELECT state FROM claims WHERE id = $1`, [
        p.claim_id as string,
      ]);
      await rawQuery(
        `UPDATE claims SET state = 'deprecated', updated_at = now() WHERE id = $1`,
        [p.claim_id as string]
      );
      if (before && before.state !== "deprecated") {
        await recordStateChange({
          claimId: p.claim_id as string,
          fromState: before.state,
          toState: "deprecated",
          actor: "curator",
          reason: opts.reasoning ?? "The Curator's creation of this node was reversed.",
          reconciliationEventId: eventId,
        });
      }
      break;
    }

    case "set_definition": {
      const claimId = p.claim_id as string;
      const prior = p.prior_definition as Record<string, unknown> | null;
      if (prior) {
        await rawQuery(
          `UPDATE quantity_definitions SET measures = $2, population = $3, conditions = $4, unit = $5, updated_at = now()
            WHERE claim_id = $1`,
          [claimId, prior.measures, prior.population ?? null, prior.conditions ?? null, JSON.stringify(prior.unit)]
        );
      } else {
        await rawQuery(`DELETE FROM quantity_definitions WHERE claim_id = $1`, [claimId]);
      }
      break;
    }

    case "reclassify": {
      await rawQuery(
        `UPDATE claims SET claim_type = $2, domains = $3::text[], domains_source = $4, updated_at = now()
          WHERE id = $1`,
        [
          p.claim_id as string,
          p.prior_claim_type as string,
          (p.prior_domains as string[]) ?? [],
          (p.prior_domains_source as string | null) ?? null,
        ]
      );
      break;
    }

    case "add_edge": {
      await rawQuery(
        `DELETE FROM claim_relationships
          WHERE parent_claim_id = $1 AND child_claim_id = $2 AND relation_type = $3`,
        [p.parent_id as string, p.child_id as string, p.relation_type as string]
      );
      break;
    }

    case "remove_edge": {
      await reinsertEdges((p.deleted_edges as EdgeRow[]) ?? []);
      break;
    }

    case "link_claims": {
      await rawQuery(`DELETE FROM claim_links WHERE id = $1`, [p.link_id as string]);
      break;
    }

    case "unlink_claims": {
      await reinsertLinks((p.deleted_links as ClaimLinkRow[]) ?? []);
      break;
    }

    case "reassign_instance": {
      const instanceId = p.instance_id as string;
      const prior = p.prior as InstancePrior | undefined;
      if (p.mode === "copy") {
        // The copy is detached, never deleted: readings and provenance
        // edges recorded since may reference it, and the record of what
        // happened is permanent (§5).
        await rawQuery(
          `UPDATE claim_instances
              SET detached_at = now(), detached_reason = $2, detached_by = 'curator', display_rank = NULL
            WHERE id = $1 AND detached_at IS NULL`,
          [instanceId, `The copy that created it was undone (reconciliation event ${eventId}).`]
        );
      } else if (prior) {
        // The argument and the answer come back only while they still exist.
        await rawQuery(
          `UPDATE claim_instances
              SET claim_id = $2, stance = $3, stated_estimate = $4::jsonb,
                  argument_id = (SELECT id FROM arguments WHERE id = $5),
                  answer_claim_id = (SELECT id FROM claims WHERE id = $6),
                  display_rank = $7
            WHERE id = $1`,
          [
            instanceId,
            prior.claim_id,
            prior.stance,
            prior.stated_estimate == null ? null : JSON.stringify(prior.stated_estimate),
            prior.argument_id,
            prior.answer_claim_id,
            prior.display_rank,
          ]
        );
      } else {
        // An event logged before the payload recorded the prior state: the
        // move changed the owner alone.
        await rawQuery(`UPDATE claim_instances SET claim_id = $1 WHERE id = $2`, [
          p.from_claim_id as string,
          instanceId,
        ]);
      }
      break;
    }

    case "merge_arguments": {
      const survivorId = p.survivor_argument_id as string;
      const absorbedId = p.absorbed_argument_id as string;
      await rawQuery(`UPDATE argument_instances SET argument_id = $1 WHERE id = ANY($2::uuid[]) AND argument_id = $3`, [
        absorbedId,
        (p.moved_instance_ids as string[]) ?? [],
        survivorId,
      ]);
      const added = (p.added_relationship_ids as string[]) ?? [];
      if (added.length) {
        await rawQuery(
          `DELETE FROM argument_subclaims WHERE argument_id = $1 AND relationship_id = ANY($2::uuid[])`,
          [survivorId, added]
        );
      }
      const absorbedEdges = (p.absorbed_relationship_ids as string[]) ?? [];
      if (absorbedEdges.length) {
        // Edges deleted since the merge are gone; only the ones that remain
        // are grouped again.
        await rawQuery(
          `INSERT INTO argument_subclaims (argument_id, relationship_id)
           SELECT $1, cr.id FROM claim_relationships cr WHERE cr.id = ANY($2::uuid[])
           ON CONFLICT DO NOTHING`,
          [absorbedId, absorbedEdges]
        );
      }
      const prior = p.replaced_written_form as { content: string; description: string | null } | null;
      if (prior) {
        await rawQuery(`UPDATE arguments SET content = $2, description = $3 WHERE id = $1`, [
          survivorId,
          prior.content,
          prior.description,
        ]);
      }
      const prevRetired = p.absorbed_prev_retired as { at: string; reason: string | null } | null;
      await rawQuery(
        `UPDATE arguments SET merged_into = NULL, retired_at = $2, retired_reason = $3 WHERE id = $1`,
        [absorbedId, prevRetired?.at ?? null, prevRetired?.reason ?? null]
      );
      break;
    }

    case "split_argument": {
      const originalId = p.argument_id as string;
      for (const move of (p.moves as Array<{ part_id: string; relationship_ids: string[]; instance_ids: string[] }>) ?? []) {
        if (move.relationship_ids.length) {
          await rawQuery(
            `UPDATE argument_subclaims SET argument_id = $1
              WHERE argument_id = $2 AND relationship_id = ANY($3::uuid[])`,
            [originalId, move.part_id, move.relationship_ids]
          );
        }
        if (move.instance_ids.length) {
          await rawQuery(
            `UPDATE argument_instances SET argument_id = $1 WHERE id = ANY($2::uuid[]) AND argument_id = $3`,
            [originalId, move.instance_ids, move.part_id]
          );
        }
        // The parts are retired, not deleted: the record of what happened,
        // mistakes included, is permanent (§5).
        await rawQuery(
          `UPDATE arguments SET retired_at = now(), retired_reason = 'The split that created it was undone.'
            WHERE id = $1 AND retired_at IS NULL`,
          [move.part_id]
        );
        await rawQuery(`DELETE FROM argument_subclaims WHERE argument_id = $1`, [move.part_id]);
      }
      // The original's evaluation comes back only if none was recorded since.
      const retiredEvaluations = (p.retired_evaluation_ids as string[]) ?? [];
      if (retiredEvaluations.length) {
        await rawQuery(
          `UPDATE argument_evaluations SET is_current = true
            WHERE id = ANY($1::uuid[])
              AND NOT EXISTS (SELECT 1 FROM argument_evaluations WHERE argument_id = $2 AND is_current = true)`,
          [retiredEvaluations, originalId]
        );
      }
      break;
    }

    default:
      return { reversed: false, reason: `unknown operation: ${event.operation}` };
  }

  await rawQuery(`UPDATE reconciliation_events SET reversed = true WHERE id = $1`, [eventId]);
  if (opts.reasoning !== undefined) {
    await logEvent("reverse", opts.reasoning, { reversed_event_id: eventId, operation: event.operation });
  }
  return { reversed: true };
}
