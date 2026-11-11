/**
 * What a judgment was made against, and what has changed since (#566): the
 * record written with each kind of judgment, and each kind of change read
 * back from it.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { rawQuery } from "../../src/db/client.js";
import { getJudgmentInputs, recordJudgmentInputs } from "../../src/services/judgment-inputs-service.js";
import { defineQuantity, recordEstimate } from "../../src/services/quantity-service.js";
import { markQuestion, recordQuestionAssessment } from "../../src/services/question-service.js";
import { claimRoutes } from "../../src/routes/claims.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { seedClaim } from "./helpers.js";

async function seedSource(): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, source_type) VALUES ($1, 'DB-test source', 'paper') RETURNING id`,
    [`https://example.org/judgment-inputs/${randomUUID()}`]
  );
  return row!.id;
}

async function seedInstance(claimId: string, sourceId: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, 'a passage') RETURNING id`,
    [claimId, sourceId]
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

/** Supersede the claim's assessment and write a new one, as the Steward's write does; returns its id. */
async function assess(claimId: string, opts: { record?: boolean } = {}): Promise<string> {
  await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1`, [claimId]);
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace)
     VALUES ($1, 'supported', 0.7, 'dbtest') RETURNING id`,
    [claimId]
  );
  if (opts.record !== false) await recordJudgmentInputs(rawQuery, "assessment", row!.id, claimId);
  return row!.id;
}

/** A parent with two judged premises, one unjudged, and one source; assessed with its inputs recorded. */
async function seedCase() {
  const parent = await seedClaim("inputs parent");
  const [a, b, unjudged] = await Promise.all([
    seedClaim("inputs premise a"),
    seedClaim("inputs premise b"),
    seedClaim("inputs premise unjudged"),
  ]);
  await seedEdge(parent, a);
  await seedEdge(parent, b, "supports");
  await seedEdge(parent, unjudged);
  const aJudgment = await assess(a);
  const bJudgment = await assess(b);
  const source = await seedSource();
  const instance = await seedInstance(parent, source);
  const judgment = await assess(parent);
  return { parent, a, b, unjudged, aJudgment, bJudgment, source, instance, judgment };
}

const view = async (id: string) => (await getJudgmentInputs(id))!;

describe("what a judgment was made against", () => {
  it("records each premise with its judgment in force, and each attached source", async () => {
    const c = await seedCase();
    const v = await view(c.parent);
    expect(v.judgment).toMatchObject({ kind: "assessment", id: c.judgment });
    expect(v.recorded).toBe(true);
    expect(v.changed).toBe(false);
    const byNode = new Map(v.premises.map((p) => [p.node_id, p]));
    expect(byNode.get(c.a)).toEqual({
      node_id: c.a, relation: "requires", judged_against: c.aJudgment, in_force_now: c.aJudgment, state: "unchanged",
    });
    expect(byNode.get(c.b)).toMatchObject({ relation: "supports", judged_against: c.bJudgment, state: "unchanged" });
    // A premise with no judgment is recorded as such, and is unchanged while it has none.
    expect(byNode.get(c.unjudged)).toMatchObject({ judged_against: null, in_force_now: null, state: "unchanged" });
    expect(v.premises_added).toEqual([]);
    expect(v.sources).toEqual({ recorded: 1, added: [], removed: [], events_since: [] });

    const [flag] = await rawQuery<{ inputs_recorded: boolean }>(
      `SELECT inputs_recorded FROM assessments_in_force WHERE claim_id = $1`,
      [c.parent]
    );
    expect(flag!.inputs_recorded).toBe(true);
  });

  it("shows a premise judged again, including one judged for the first time", async () => {
    const c = await seedCase();
    const again = await assess(c.a);
    const first = await assess(c.unjudged);
    const v = await view(c.parent);
    expect(v.changed).toBe(true);
    const byNode = new Map(v.premises.map((p) => [p.node_id, p]));
    expect(byNode.get(c.a)).toMatchObject({ judged_against: c.aJudgment, in_force_now: again, state: "rejudged" });
    expect(byNode.get(c.unjudged)).toMatchObject({ judged_against: null, in_force_now: first, state: "rejudged" });
    expect(byNode.get(c.b)!.state).toBe("unchanged");
  });

  it("shows a premise added and a premise removed", async () => {
    const c = await seedCase();
    const added = await seedClaim("inputs premise added");
    const addedJudgment = await assess(added);
    await seedEdge(c.parent, added, "contradicts");
    await rawQuery(`DELETE FROM claim_relationships WHERE parent_claim_id = $1 AND child_claim_id = $2`, [c.parent, c.b]);
    const v = await view(c.parent);
    expect(v.changed).toBe(true);
    expect(v.premises_added).toEqual([{ node_id: added, relation: "contradicts", in_force_now: addedJudgment }]);
    expect(v.premises.find((p) => p.node_id === c.b)).toMatchObject({ state: "removed", in_force_now: null });
  });

  it("shows a source attached, a source detached, and an event on a source since", async () => {
    const c = await seedCase();
    const later = await seedSource();
    await seedInstance(c.parent, later);
    let v = await view(c.parent);
    expect(v.sources).toMatchObject({ recorded: 1, added: [later], removed: [] });
    expect(v.changed).toBe(true);

    await rawQuery(`UPDATE claim_instances SET detached_at = now() WHERE id = $1`, [c.instance]);
    await rawQuery(
      `INSERT INTO source_events (source_id, kind, detected_at, detected_by)
       VALUES ($1, 'retraction', now() + interval '1 second', 'dbtest')`,
      [c.source]
    );
    v = await view(c.parent);
    expect(v.sources.removed).toEqual([c.source]);
    expect(v.sources.events_since).toEqual([
      expect.objectContaining({ source_id: c.source, kind: "retraction" }),
    ]);
  });

  it("is settled again by a fresh judgment, which records the state it was made against", async () => {
    const c = await seedCase();
    await assess(c.a);
    expect((await view(c.parent)).changed).toBe(true);
    const fresh = await assess(c.parent);
    const v = await view(c.parent);
    expect(v.judgment!.id).toBe(fresh);
    expect(v.changed).toBe(false);
  });

  it("says nothing about a judgment written before inputs were recorded, or a node never judged", async () => {
    const old = await seedClaim("inputs unrecorded");
    const child = await seedClaim("inputs unrecorded child");
    await seedEdge(old, child);
    const judgment = await assess(old, { record: false });
    expect(await view(old)).toMatchObject({
      judgment: { id: judgment }, recorded: false, changed: null, premises: [], premises_added: [],
    });

    const never = await seedClaim("inputs never judged");
    expect(await view(never)).toMatchObject({ judgment: null, recorded: false, changed: null });
    expect(await getJudgmentInputs(randomUUID())).toBeNull();
  });

  it("is recorded by the Steward's own write of a verdict", async () => {
    const claim = await seedClaim("inputs steward write");
    const premise = await seedClaim("inputs steward premise");
    const premiseJudgment = await assess(premise);
    await seedEdge(claim, premise);
    const source = await seedSource();
    await seedInstance(claim, source);

    const out = JSON.parse(
      await executeStewardTool("update_claim_assessment", {
        claim_id: claim,
        status: "supported",
        confidence: 0.75,
        assessment: "Judged on the premise and the source.",
        reasoning_trace: "Weighed both.",
      })
    );
    expect(out.success).toBe(true);
    expect(await view(claim)).toMatchObject({
      judgment: { kind: "assessment" },
      recorded: true,
      changed: false,
      premises: [{ node_id: premise, judged_against: premiseJudgment, state: "unchanged" }],
      sources: { recorded: 1 },
    });
  });

  it("is recorded by a quantity's estimate and a question's assessment, in their own write", async () => {
    const quantity = await seedClaim("inputs quantity");
    await defineQuantity({
      claimId: quantity,
      definition: { measures: "Tests run", population: "This suite", unit: { kind: "count", noun: "tests", min: 0 } },
      createdBy: "dbtest",
    });
    const part = await seedClaim("inputs quantity premise");
    const partJudgment = await assess(part);
    await seedEdge(quantity, part);
    const estimate = await recordEstimate({
      claimId: quantity,
      estimate: { form: "interval", low: 1, high: 5 },
      work: "counted",
    });
    expect(await view(quantity)).toMatchObject({
      judgment: { kind: "quantity_estimate", id: estimate.id },
      recorded: true,
      changed: false,
      premises: [{ node_id: part, judged_against: partJudgment, state: "unchanged" }],
    });

    const question = await seedClaim("inputs question");
    await markQuestion(question);
    // A question rests on a quantity here: its premise's judgment is an estimate.
    await seedEdge(question, quantity, "part_of");
    const standing = await recordQuestionAssessment({ claimId: question, standing: "open", reasoningTrace: "t" });
    expect(await view(question)).toMatchObject({
      judgment: { kind: "question_assessment", id: standing.id },
      recorded: true,
      premises: [{ node_id: quantity, relation: "part_of", judged_against: estimate.id, state: "unchanged" }],
    });
  });

  it("is served on GET /claims/:claim_id/judgment-inputs", async () => {
    const c = await seedCase();
    await assess(c.b);
    const app = Fastify();
    // The claim routes expect the auth plugin's decorators; this read needs none of them.
    const decorate = app.decorate.bind(app) as (name: string, value: unknown) => void;
    app.decorateRequest("auth", null);
    decorate("authenticate", async () => {});
    decorate("requireAgenticQuota", () => async () => {});
    decorate("requireUser", async () => {});
    await app.register(claimRoutes, { prefix: "/claims" });
    await app.ready();
    const res = await app.inject({ url: `/claims/${c.parent}/judgment-inputs` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(JSON.parse(JSON.stringify(await getJudgmentInputs(c.parent))));
    expect(res.json().changed).toBe(true);
    expect((await app.inject({ url: `/claims/${randomUUID()}/judgment-inputs` })).statusCode).toBe(404);
  });
});
