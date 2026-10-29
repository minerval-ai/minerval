/**
 * Node kinds (constitution §2, §7a, §10) against real Postgres: the kind
 * column and its check, converting a fresh claim into a quantity or a
 * question and refusing once it holds a verdict, the current-estimate and
 * current-assessment partial indexes, the shapes the reads serve, the kind
 * fields on the tree, and the claim detail route.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim, pgCode } from "./helpers.js";
import {
  addReading,
  defineQuantity,
  getQuantityDetail,
  getThresholdOf,
  recordCut,
  recordEstimate,
  setArgumentShows,
  setStatedEstimate,
} from "../../src/services/quantity-service.js";
import {
  addAnswer,
  addSubquestion,
  getQuestionDetail,
  markQuestion,
  recordQuestionAssessment,
  setAnswerRelation,
  setQuestionInstance,
} from "../../src/services/question-service.js";
import { KindError } from "../../src/services/node-kind.js";
import { getClaimDependents, getClaimTree } from "../../src/services/tree-service.js";
import { claimRoutes } from "../../src/routes/claims.js";

const CHECK_VIOLATION = "23514";

const DEATHS = {
  measures: "Deaths attributable to the 1918 influenza pandemic",
  population: "World population, 1918 to 1920",
  unit: { kind: "count" as const, noun: "deaths", min: 0 },
};

async function seedSource(label = "source"): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, source_type) VALUES ($1, $2, 'paper') RETURNING id`,
    [`https://example.org/${label}/${randomUUID()}`, `DB-test ${label}`]
  );
  return row!.id;
}

async function seedInstance(claimId: string, sourceId: string, text = "a passage"): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, $3) RETURNING id`,
    [claimId, sourceId, text]
  );
  return row!.id;
}

async function seedEdge(parent: string, child: string, relation = "requires"): Promise<void> {
  await rawQuery(
    `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning)
     VALUES ($1, $2, $3, 'dbtest')`,
    [parent, child, relation]
  );
}

async function seedAssessment(claimId: string, status = "supported", credence: number | null = 0.8) {
  await rawQuery(
    `INSERT INTO assessments (claim_id, status, confidence, claim_credence, reasoning_trace)
     VALUES ($1, $2, 0.7, $3, 'dbtest')`,
    [claimId, status, credence]
  );
}

async function seedQuantity(label = "quantity"): Promise<string> {
  const id = await seedClaim(label);
  await defineQuantity({ claimId: id, definition: DEATHS, createdBy: "dbtest" });
  return id;
}

async function kindOf(id: string): Promise<string> {
  const [row] = await rawQuery<{ kind: string }>(`SELECT kind FROM claims WHERE id = $1`, [id]);
  return row!.kind;
}

describe("claims.kind", () => {
  it("defaults to claim and rejects an unknown kind", async () => {
    const id = await seedClaim();
    expect(await kindOf(id)).toBe("claim");
    const err = await rawQuery(`UPDATE claims SET kind = 'opinion' WHERE id = $1`, [id]).catch((e) => e);
    expect(pgCode(err)).toBe(CHECK_VIOLATION);
  });
});

describe("quantities", () => {
  it("defines a fresh claim as a quantity, and refuses one that holds a verdict", async () => {
    const q = await seedQuantity();
    expect(await kindOf(q)).toBe("quantity");
    // Redefining updates in place.
    await defineQuantity({
      claimId: q,
      definition: { ...DEATHS, conditions: "Excess deaths over the 1915 to 1917 baseline" },
      createdBy: "dbtest",
    });
    const detail = await getQuantityDetail(q);
    expect(detail.definition).toEqual({
      measures: DEATHS.measures,
      population: DEATHS.population,
      conditions: "Excess deaths over the 1915 to 1917 baseline",
      unit: DEATHS.unit,
    });

    const judged = await seedClaim("judged");
    await seedAssessment(judged);
    await expect(
      defineQuantity({ claimId: judged, definition: DEATHS, createdBy: "dbtest" })
    ).rejects.toBeInstanceOf(KindError);
    expect(await kindOf(judged)).toBe("claim");
  });

  it("validates definitions and estimates before writing", async () => {
    const id = await seedClaim();
    await expect(
      defineQuantity({
        claimId: id,
        definition: { measures: "x", unit: { kind: "currency" } },
        createdBy: "dbtest",
      })
    ).rejects.toThrow(/currency/);
    expect(await kindOf(id)).toBe("claim");

    const q = await seedQuantity();
    await expect(
      recordEstimate({ claimId: q, estimate: { form: "interval", low: 5, high: 2 }, work: "w" })
    ).rejects.toThrow(/low/);
    await expect(
      recordEstimate({
        claimId: q,
        estimate: { form: "distribution", quantiles: [{ p: 0.5, v: 1 }, { p: 0.1, v: 2 }] },
        work: "w",
      })
    ).rejects.toThrow(/increasing/);
    await expect(recordEstimate({ claimId: q, estimate: { form: "none" }, work: "w" })).rejects.toThrow(
      /says why/
    );
    // An estimate on a claim is the wrong kind.
    await expect(
      recordEstimate({ claimId: await seedClaim(), estimate: { form: "point", central: 1 }, work: "w" })
    ).rejects.toBeInstanceOf(KindError);
  });

  it("keeps one current estimate, the latest", async () => {
    const q = await seedQuantity();
    await recordEstimate({
      claimId: q,
      estimate: { form: "interval", low: 17e6, high: 100e6, level: 0.9 },
      work: "first pass",
    });
    await recordEstimate({
      claimId: q,
      estimate: {
        form: "distribution",
        quantiles: [
          { p: 0.05, v: 17e6 },
          { p: 0.5, v: 40e6 },
          { p: 0.95, v: 100e6 },
        ],
      },
      summary: "Most reconstructions fall between 17 and 100 million.",
      work: "second pass",
      model: "dbtest-model",
    });
    const rows = await rawQuery<{ is_current: boolean; work: string }>(
      `SELECT is_current, work FROM quantity_estimates WHERE claim_id = $1 ORDER BY assessed_at, work`,
      [q]
    );
    expect(rows.filter((r) => r.is_current).map((r) => r.work)).toEqual(["second pass"]);
    // The partial index refuses a second current row written around the service.
    const err = await rawQuery(
      `INSERT INTO quantity_estimates (claim_id, estimate, work) VALUES ($1, '{"form":"point","central":1}', 'x')`,
      [q]
    ).catch((e) => e);
    expect(pgCode(err)).toBe("23505");

    const detail = await getQuantityDetail(q);
    expect(detail.estimate?.form).toBe("distribution");
    expect(detail.assessed).toMatchObject({ work: "second pass", model: "dbtest-model" });
  });

  it("records stated estimates, argument values, readings and cuts, and serves them", async () => {
    const q = await seedQuantity();
    const [arg] = await rawQuery<{ id: string }>(
      `INSERT INTO arguments (claim_id, name, stance, content, created_by)
       VALUES ($1, 'Extrapolation', 'neutral', 'From registered deaths', 'dbtest') RETURNING id`,
      [q]
    );
    await setArgumentShows({
      argumentId: arg!.id,
      shows: { text: "between 17 and 50 million", range: { side: "between", low: 17e6, high: 50e6 } },
    });
    await expect(
      setArgumentShows({ argumentId: arg!.id, shows: { text: "x", range: { side: "below", low: 3 } } })
    ).rejects.toThrow(/below/);

    const src = await seedSource("paper");
    const inst = await seedInstance(q, src, "");
    await setStatedEstimate({
      instanceId: inst,
      stated: { form: "point", central: 50e6 },
      argumentId: arg!.id,
    });
    await addReading({
      claimId: q,
      sourceId: src,
      measured: "Registered influenza deaths in 14 countries",
      figure: "2.6 million",
      bearing: "A floor for those countries only",
      createdBy: "dbtest",
    });
    const cut = await seedClaim("cut");
    await seedAssessment(cut, "supported", 0.9);
    await recordCut({ claimId: cut, quantityId: q, direction: "above", value: 20e6, createdBy: "dbtest" });
    await expect(
      recordCut({ claimId: await seedClaim(), quantityId: await seedClaim(), direction: "above", value: 1, createdBy: "dbtest" })
    ).rejects.toBeInstanceOf(KindError);

    const detail = await getQuantityDetail(q);
    expect(detail.estimates).toEqual([
      expect.objectContaining({
        id: inst,
        argument_id: arg!.id,
        stated: { form: "point", central: 50e6 },
        // A figure read from a table has no sentence.
        verbatim_text: null,
        source_type: "paper",
      }),
    ]);
    expect(detail.readings).toEqual([
      expect.objectContaining({ figure: "2.6 million", claim: null }),
    ]);
    expect(detail.cuts).toEqual([
      expect.objectContaining({ id: cut, direction: "above", value: 20e6, status: "supported", credence: 0.9 }),
    ]);
    expect(await getThresholdOf(cut)).toMatchObject({
      quantity_id: q,
      direction: "above",
      value: 20e6,
      definition: { measures: DEATHS.measures },
    });

    // The tree carries the kind fields where they apply, and only there.
    const parent = await seedClaim("parent");
    await seedEdge(parent, q);
    await seedEdge(parent, cut);
    await recordEstimate({ claimId: q, estimate: { form: "point", central: 40e6 }, work: "w" });
    const tree = await getClaimTree(parent);
    const qNode = tree!.children.find((c) => c.id === q)!;
    expect(qNode).toMatchObject({ node_kind: "quantity", estimate: { form: "point", central: 40e6 }, unit: DEATHS.unit });
    const cutNode = tree!.children.find((c) => c.id === cut)!;
    expect(cutNode).not.toHaveProperty("node_kind");
    expect(cutNode).not.toHaveProperty("estimate");

    const qTree = await getClaimTree(q);
    expect(qTree).toMatchObject({ node_kind: "quantity" });
  });
});

describe("questions", () => {
  async function seedQuestion(): Promise<{ question: string; a: string; b: string }> {
    const question = await seedClaim("question");
    await markQuestion(question);
    const a = await seedClaim("answer a");
    const b = await seedQuantity("answer b");
    await addAnswer({ questionId: question, answerId: a, basis: "quality", reasoning: "r", createdBy: "dbtest" });
    await addAnswer({ questionId: question, answerId: b, basis: "both", reasoning: "r", createdBy: "dbtest" });
    return { question, a, b };
  }

  it("holds answers, subquestions, presuppositions and answer relations", async () => {
    const { question, a, b } = await seedQuestion();
    const sub = await seedClaim("sub");
    await markQuestion(sub);
    await addSubquestion({ questionId: question, subquestionId: sub, reasoning: "r", createdBy: "dbtest" });
    const presupposition = await seedClaim("presupposition");
    await seedEdge(question, presupposition, "assumes");
    const dependent = await seedClaim("dependent");
    await seedEdge(dependent, question, "requires");

    // Stored in canonical order whichever way it is written, and one row per pair.
    await setAnswerRelation({ questionId: question, answerA: b, answerB: a, relation: "compatible", createdBy: "dbtest" });
    await setAnswerRelation({ questionId: question, answerA: a, answerB: b, relation: "excludes", createdBy: "dbtest" });
    const rel = await rawQuery<{ relation: string }>(`SELECT relation FROM answer_relations WHERE question_id = $1`, [question]);
    expect(rel).toEqual([{ relation: "excludes" }]);

    await expect(
      setAnswerRelation({ questionId: question, answerA: a, answerB: presupposition, relation: "excludes", createdBy: "dbtest" })
    ).rejects.toThrow(/not an answer/);
    await expect(
      addAnswer({ questionId: question, answerId: sub, basis: "quality", reasoning: "r", createdBy: "dbtest" })
    ).rejects.toThrow(/subquestion/);
    await expect(
      addAnswer({ questionId: a, answerId: b, basis: "quality", reasoning: "r", createdBy: "dbtest" })
    ).rejects.toBeInstanceOf(KindError);
    // answer_basis belongs on 'answers' edges only.
    const err = await rawQuery(
      `UPDATE claim_relationships SET answer_basis = 'quality' WHERE parent_claim_id = $1 AND child_claim_id = $2`,
      [question, presupposition]
    ).catch((e) => e);
    expect(pgCode(err)).toBe(CHECK_VIOLATION);

    const detail = await getQuestionDetail(question);
    expect(detail.standing).toBeNull();
    expect(detail.answers.map((x) => [x.id, x.kind, x.basis])).toEqual([
      [a, "claim", "quality"],
      [b, "quantity", "both"],
    ]);
    expect(detail.answers[1]!.unit).toEqual(DEATHS.unit);
    expect(detail.subquestions.map((x) => x.id)).toEqual([sub]);
    expect(detail.presuppositions.map((x) => x.id)).toEqual([presupposition]);
    expect(detail.depended_on_by.map((x) => x.id)).toEqual([dependent]);
    expect(detail.relations).toEqual([{ ...orderedPair(a, b), relation: "excludes" }]);

    // A question depends on its answers: the question shows among an answer's dependents.
    const deps = await getClaimDependents(a);
    expect(deps).toEqual([expect.objectContaining({ id: question, node_kind: "question", relation_type: "answers" })]);
  });

  it("keeps a standing consistent with the answers it favors", async () => {
    const { question, a, b } = await seedQuestion();
    await expect(
      recordQuestionAssessment({ claimId: question, standing: "answered", favoredClaimIds: [a, b], reasoningTrace: "t" })
    ).rejects.toThrow(/exactly one/);
    await expect(
      recordQuestionAssessment({ claimId: question, standing: "open", favoredClaimIds: [a], reasoningTrace: "t" })
    ).rejects.toThrow(/favors no answer/);
    await expect(
      recordQuestionAssessment({ claimId: question, standing: "leaning", favoredClaimIds: [question], reasoningTrace: "t" })
    ).rejects.toThrow(/not an answer/);

    await recordQuestionAssessment({ claimId: question, standing: "open", reasoningTrace: "first" });
    await recordQuestionAssessment({
      claimId: question,
      standing: "leaning",
      favoredClaimIds: [b],
      summary: "Leans toward the larger figures.",
      reasoningTrace: "second",
      incomplete: "No answer yet covers the undercount argument.",
    });
    const detail = await getQuestionDetail(question);
    expect(detail.standing).toBe("leaning");
    expect(detail.assessment).toMatchObject({ reasoning_trace: "second", favored_ids: [b] });
    expect(detail.incomplete).toMatch(/undercount/);
    expect(detail.answers.find((x) => x.id === b)!.favored).toBe(true);
    expect(detail.answers.find((x) => x.id === a)!.favored).toBe(false);

    const err = await rawQuery(
      `UPDATE question_assessments SET standing = 'settled' WHERE claim_id = $1 AND is_current`,
      [question]
    ).catch((e) => e);
    expect(pgCode(err)).toBe(CHECK_VIOLATION);

    const tree = await getClaimTree(question);
    expect(tree).toMatchObject({ node_kind: "question", standing: "leaning" });
  });

  it("records where a source asks the question and where it answers it", async () => {
    const { question, a } = await seedQuestion();
    const src = await seedSource();
    const asks = await seedInstance(question, src, "How many died?");
    const answers = await seedInstance(question, src, "At least fifty million died.");
    await setQuestionInstance({ instanceId: asks, role: "asks" });
    await setQuestionInstance({ instanceId: answers, role: "answers", answerClaimId: a });
    await expect(
      setQuestionInstance({ instanceId: asks, role: "answers", answerClaimId: question })
    ).rejects.toThrow(/not an answer/);
    const detail = await getQuestionDetail(question);
    expect(detail.instances.map((i) => [i.id, i.role, i.answer_id])).toEqual([
      [asks, "asks", null],
      [answers, "answers", a],
    ]);
  });
});

function orderedPair(x: string, y: string): { a: string; b: string } {
  return x < y ? { a: x, b: y } : { a: y, b: x };
}

describe("GET /claims/:id for the kinds", () => {
  it("serves the kind, the quantity or question, and threshold_of", async () => {
    const app = Fastify();
    // The write routes' hooks; the GET under test uses none of them.
    app.decorateRequest("auth", null);
    app.decorate("authenticate", async () => {});
    app.decorate("requireAgenticQuota", () => async () => {});
    app.decorate("requireUser", async () => {});
    await app.register(claimRoutes, { prefix: "/claims" });
    await app.ready();
    try {
      const q = await seedQuantity();
      await recordEstimate({ claimId: q, estimate: { form: "point", central: 4e7 }, work: "w" });
      const res = await app.inject({ method: "GET", url: `/claims/${q}?information_depth=cursory` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.claim.kind).toBe("quantity");
      expect(body.assessment).toBeNull();
      expect(body.quantity).toMatchObject({
        definition: { measures: DEATHS.measures, unit: DEATHS.unit },
        estimate: { form: "point", central: 4e7 },
        assessed: { work: "w" },
        estimates: [],
        readings: [],
        cuts: [],
      });
      expect(body.question).toBeNull();
      expect(body.requests).toEqual([]);

      const cut = await seedClaim("cut");
      await recordCut({ claimId: cut, quantityId: q, direction: "below", value: 1e8, createdBy: "dbtest" });
      const cutBody = (await app.inject({ method: "GET", url: `/claims/${cut}?information_depth=cursory` })).json();
      expect(cutBody.claim.kind).toBe("claim");
      expect(cutBody.threshold_of).toMatchObject({ quantity_id: q, direction: "below", value: 1e8 });
    } finally {
      await app.close();
    }
  });
});
