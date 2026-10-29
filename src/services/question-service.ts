/**
 * Questions (constitution §7a, §10). A question's candidate answers are
 * claims or quantities joined to it by 'answers' edges, its subquestions by
 * 'part_of' edges, and its presuppositions by the ordinary 'assumes' and
 * 'requires' edges. How two answers bear on each other is recorded pair by
 * pair in answer_relations, and how well answered the question is lives in
 * question_assessments as a standing.
 */
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import {
  ANSWER_BASES,
  ANSWER_RELATIONS,
  QUESTION_STANDINGS,
  type AnswerBasis,
  type AnswerRelationKind,
  type NodeKind,
  type QuantityEstimate,
  type QuantityUnit,
  type QuestionStanding,
} from "../schemas/kinds.js";
import { convertKind, KindError, lockNodeKind, requireKind } from "./node-kind.js";
import { orderPair } from "./claim-link-service.js";

/** Make a fresh claim a question. */
export async function markQuestion(claimId: string): Promise<void> {
  await withTransaction((tx) => convertKind(tx, claimId, "question"));
}

function requireQuestion(tx: TxQuery, claimId: string): Promise<void> {
  return requireKind(tx, claimId, "question");
}

async function answerIds(tx: TxQuery, questionId: string): Promise<Set<string>> {
  const rows = await tx.query<{ child_claim_id: string }>(
    `SELECT child_claim_id FROM claim_relationships
      WHERE parent_claim_id = $1 AND relation_type = 'answers'`,
    [questionId]
  );
  return new Set(rows.map((r) => r.child_claim_id));
}

/** Add a candidate answer to a question, or change why it is in the set. */
export async function addAnswer(input: {
  questionId: string;
  answerId: string;
  basis: AnswerBasis;
  reasoning: string;
  createdBy: string;
}): Promise<{ id: string }> {
  if (!(ANSWER_BASES as readonly string[]).includes(input.basis)) {
    throw new KindError(`Unknown answer basis "${input.basis}"`);
  }
  return withTransaction(async (tx) => {
    await requireQuestion(tx, input.questionId);
    const kind = await lockNodeKind(tx, input.answerId);
    if (kind === "question") throw new KindError("A question answers no question; add it as a subquestion");
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO claim_relationships
         (parent_claim_id, child_claim_id, relation_type, answer_basis, reasoning, created_by)
       VALUES ($1, $2, 'answers', $3, $4, $5)
       ON CONFLICT (parent_claim_id, child_claim_id, relation_type) DO UPDATE
         SET answer_basis = EXCLUDED.answer_basis, reasoning = EXCLUDED.reasoning
       RETURNING id`,
      [input.questionId, input.answerId, input.basis, input.reasoning, input.createdBy]
    );
    return { id: row!.id };
  });
}

/** Add a subquestion: a question whose answer is part of this one's. */
export async function addSubquestion(input: {
  questionId: string;
  subquestionId: string;
  reasoning: string;
  createdBy: string;
}): Promise<{ id: string }> {
  return withTransaction(async (tx) => {
    await requireQuestion(tx, input.questionId);
    await requireQuestion(tx, input.subquestionId);
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO claim_relationships
         (parent_claim_id, child_claim_id, relation_type, reasoning, created_by)
       VALUES ($1, $2, 'part_of', $3, $4)
       ON CONFLICT (parent_claim_id, child_claim_id, relation_type) DO UPDATE
         SET reasoning = EXCLUDED.reasoning
       RETURNING id`,
      [input.questionId, input.subquestionId, input.reasoning, input.createdBy]
    );
    return { id: row!.id };
  });
}

/** Record whether two of a question's answers exclude each other or can both hold. */
export async function setAnswerRelation(input: {
  questionId: string;
  answerA: string;
  answerB: string;
  relation: AnswerRelationKind;
  reasoning?: string | null;
  createdBy: string;
}): Promise<{ id: string }> {
  if (!(ANSWER_RELATIONS as readonly string[]).includes(input.relation)) {
    throw new KindError(`Unknown answer relation "${input.relation}"`);
  }
  if (input.answerA === input.answerB) throw new KindError("An answer stands in no relation to itself");
  const [a, b] = orderPair(input.answerA, input.answerB);
  return withTransaction(async (tx) => {
    await requireQuestion(tx, input.questionId);
    const answers = await answerIds(tx, input.questionId);
    for (const id of [a, b]) {
      if (!answers.has(id)) throw new KindError(`Node ${id} is not an answer to ${input.questionId}`);
    }
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO answer_relations (question_id, claim_a_id, claim_b_id, relation, reasoning, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (question_id, claim_a_id, claim_b_id) DO UPDATE
         SET relation = EXCLUDED.relation, reasoning = EXCLUDED.reasoning
       RETURNING id`,
      [input.questionId, a, b, input.relation, input.reasoning ?? null, input.createdBy]
    );
    return { id: row!.id };
  });
}

/**
 * Record how well answered a question is, retiring the previous assessment
 * to history. An answered question favors exactly one answer, a leaning one
 * at least one; an open, ill-posed or unknown question favors none.
 */
export async function recordQuestionAssessment(input: {
  claimId: string;
  standing: QuestionStanding;
  favoredClaimIds?: string[];
  summary?: string | null;
  reasoningTrace: string;
  incomplete?: string | null;
  model?: string | null;
  fundedByJobId?: string | null;
  trigger?: string | null;
  triggerContext?: string | null;
}): Promise<{ id: string }> {
  if (!(QUESTION_STANDINGS as readonly string[]).includes(input.standing)) {
    throw new KindError(`Unknown standing "${input.standing}"`);
  }
  if (!input.reasoningTrace.trim()) throw new KindError("An assessment records its reasoning");
  const favored = [...new Set(input.favoredClaimIds ?? [])];
  if (input.standing === "answered" && favored.length !== 1) {
    throw new KindError("An answered question favors exactly one answer");
  }
  if (input.standing === "leaning" && favored.length === 0) {
    throw new KindError("A leaning question favors at least one answer");
  }
  if (!["answered", "leaning"].includes(input.standing) && favored.length > 0) {
    throw new KindError(`A question that is ${input.standing} favors no answer`);
  }
  return withTransaction(async (tx) => {
    await requireQuestion(tx, input.claimId);
    const answers = await answerIds(tx, input.claimId);
    for (const id of favored) {
      if (!answers.has(id)) throw new KindError(`Node ${id} is not an answer to ${input.claimId}`);
    }
    await tx.query(
      `UPDATE question_assessments SET is_current = false WHERE claim_id = $1 AND is_current = true`,
      [input.claimId]
    );
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO question_assessments
         (claim_id, standing, favored_claim_ids, summary, reasoning_trace, incomplete,
          model, funded_by_job_id, trigger, trigger_context)
       VALUES ($1, $2, $3::uuid[], $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        input.claimId,
        input.standing,
        favored,
        input.summary ?? null,
        input.reasoningTrace,
        input.incomplete ?? null,
        input.model ?? null,
        input.fundedByJobId ?? null,
        input.trigger ?? null,
        input.triggerContext ?? null,
      ]
    );
    return { id: row!.id };
  });
}

/** Record whether a source asks the question or answers it, and which answer its answer matches. */
export async function setQuestionInstance(input: {
  instanceId: string;
  role: "asks" | "answers";
  answerClaimId?: string | null;
}): Promise<void> {
  if (input.role === "asks" && input.answerClaimId) {
    throw new KindError("A source that asks the question matches no answer");
  }
  await withTransaction(async (tx) => {
    const [inst] = await tx.query<{ claim_id: string }>(
      `SELECT claim_id FROM claim_instances WHERE id = $1 FOR UPDATE`,
      [input.instanceId]
    );
    if (!inst) throw new KindError(`Instance ${input.instanceId} not found`);
    await requireQuestion(tx, inst.claim_id);
    if (input.answerClaimId && !(await answerIds(tx, inst.claim_id)).has(input.answerClaimId)) {
      throw new KindError(`Node ${input.answerClaimId} is not an answer to ${inst.claim_id}`);
    }
    await tx.query(
      `UPDATE claim_instances SET stance = $2, answer_claim_id = $3 WHERE id = $1`,
      [input.instanceId, input.role, input.answerClaimId ?? null]
    );
  });
}

// ---------------------------------------------------------------------------
// Reads, in the shapes the API serves (web/lib/types.ts QuestionDetail).
// ---------------------------------------------------------------------------

export interface QuestionNodeRefView {
  id: string;
  text: string;
  kind: NodeKind;
  status: string | null;
  standing: QuestionStanding | null;
}

export interface QuestionAnswerView {
  id: string;
  text: string;
  kind: NodeKind;
  status: string | null;
  credence: number | null;
  estimate: QuantityEstimate | null;
  unit: QuantityUnit | null;
  favored: boolean;
  basis: AnswerBasis | null;
}

export interface QuestionAssessmentView {
  standing: QuestionStanding;
  summary: string | null;
  reasoning_trace: string;
  model: string | null;
  assessed_at: Date;
  favored_ids: string[];
}

export interface QuestionInstanceView {
  id: string;
  role: "asks" | "answers";
  verbatim_text: string | null;
  source_title: string;
  source_url: string | null;
  source_type: string | null;
  answer_id: string | null;
}

export interface QuestionDetailView {
  standing: QuestionStanding | null;
  assessment: QuestionAssessmentView | null;
  incomplete: string | null;
  presuppositions: QuestionNodeRefView[];
  subquestions: QuestionNodeRefView[];
  answers: QuestionAnswerView[];
  relations: { a: string; b: string; relation: AnswerRelationKind }[];
  depended_on_by: QuestionNodeRefView[];
  instances: QuestionInstanceView[];
}

// A node's standing as a reference: a proposition's status, a question's standing.
const NODE_REF_COLUMNS = `c.id, c.text, c.kind, a.status, qa.standing`;
const NODE_REF_JOINS = `
  LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
  LEFT JOIN question_assessments qa ON qa.claim_id = c.id AND qa.is_current = true`;

export async function getCurrentStanding(claimId: string): Promise<QuestionStanding | null> {
  const [row] = await rawQuery<{ standing: QuestionStanding }>(
    `SELECT standing FROM question_assessments WHERE claim_id = $1 AND is_current = true`,
    [claimId]
  );
  return row?.standing ?? null;
}

export async function getQuestionDetail(claimId: string): Promise<QuestionDetailView> {
  const [current, children, relations, dependedOnBy, instances] = await Promise.all([
    rawQuery<QuestionAssessmentView & { incomplete: string | null }>(
      `SELECT standing, summary, reasoning_trace, model, assessed_at,
              favored_claim_ids::text[] AS favored_ids, incomplete
         FROM question_assessments WHERE claim_id = $1 AND is_current = true`,
      [claimId]
    ),
    rawQuery<
      QuestionNodeRefView & {
        relation_type: string;
        answer_basis: AnswerBasis | null;
        credence: number | null;
        estimate: QuantityEstimate | null;
        unit: QuantityUnit | null;
      }
    >(
      `SELECT ${NODE_REF_COLUMNS}, r.relation_type, r.answer_basis,
              a.claim_credence AS credence, qe.estimate, qd.unit
         FROM claim_relationships r
         JOIN claims c ON c.id = r.child_claim_id AND c.state = 'active'
         ${NODE_REF_JOINS}
         LEFT JOIN quantity_estimates qe ON qe.claim_id = c.id AND qe.is_current = true
         LEFT JOIN quantity_definitions qd ON qd.claim_id = c.id
        WHERE r.parent_claim_id = $1
          AND r.relation_type IN ('answers', 'part_of', 'assumes', 'requires')
        ORDER BY r.created_at, r.id`,
      [claimId]
    ),
    rawQuery<{ a: string; b: string; relation: AnswerRelationKind }>(
      `SELECT claim_a_id AS a, claim_b_id AS b, relation
         FROM answer_relations WHERE question_id = $1 ORDER BY created_at, id`,
      [claimId]
    ),
    rawQuery<QuestionNodeRefView>(
      `SELECT DISTINCT ON (c.id) ${NODE_REF_COLUMNS}
         FROM claim_relationships r
         JOIN claims c ON c.id = r.parent_claim_id AND c.state = 'active'
         ${NODE_REF_JOINS}
        WHERE r.child_claim_id = $1 AND r.relation_type IN ('requires', 'assumes', 'supports', 'contradicts', 'specifies')
        ORDER BY c.id`,
      [claimId]
    ),
    rawQuery<QuestionInstanceView>(
      `SELECT ci.id, ci.stance AS role, NULLIF(ci.verbatim_text, '') AS verbatim_text,
              s.title AS source_title, s.url AS source_url, s.source_type,
              ci.answer_claim_id AS answer_id
         FROM claim_instances ci JOIN sources s ON s.id = ci.source_id
        WHERE ci.claim_id = $1 AND ci.stance IN ('asks', 'answers') AND ci.detached_at IS NULL
        ORDER BY ci.display_rank NULLS LAST, ci.source_date NULLS LAST, ci.created_at`,
      [claimId]
    ),
  ]);
  const cur = current[0] ?? null;
  const favored = new Set(cur?.favored_ids ?? []);
  const ref = (r: QuestionNodeRefView): QuestionNodeRefView => ({
    id: r.id,
    text: r.text,
    kind: r.kind,
    status: r.status,
    standing: r.standing,
  });
  const answers = children.filter((r) => r.relation_type === "answers");
  const answerSet = new Set(answers.map((r) => r.id));
  return {
    standing: cur?.standing ?? null,
    assessment: cur
      ? {
          standing: cur.standing,
          summary: cur.summary,
          reasoning_trace: cur.reasoning_trace,
          model: cur.model,
          assessed_at: cur.assessed_at,
          // An answer removed since the assessment no longer counts as favored.
          favored_ids: cur.favored_ids.filter((id) => answerSet.has(id)),
        }
      : null,
    incomplete: cur?.incomplete ?? null,
    presuppositions: children
      .filter((r) => r.relation_type === "assumes" || r.relation_type === "requires")
      .map(ref),
    subquestions: children.filter((r) => r.relation_type === "part_of").map(ref),
    answers: answers.map((r) => ({
      id: r.id,
      text: r.text,
      kind: r.kind,
      status: r.status,
      credence: r.credence,
      estimate: r.estimate,
      unit: r.unit,
      favored: favored.has(r.id),
      basis: r.answer_basis,
    })),
    relations: relations.filter((r) => answerSet.has(r.a) && answerSet.has(r.b)),
    depended_on_by: dependedOnBy.map(ref),
    instances,
  };
}
