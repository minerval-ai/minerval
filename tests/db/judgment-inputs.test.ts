/**
 * What a judgment was made against, and what has changed since (#566): the
 * record written with each kind of judgment, and each kind of change read
 * back from it.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { rawQuery } from "../../src/db/client.js";
import {
  countJudgmentChanges,
  getJudgmentInputs,
  recordJudgmentInputs,
  sinceAssessed,
  sinceAssessedRow,
  summarizeJudgmentChanges,
} from "../../src/services/judgment-inputs-service.js";
import { defineQuantity, recordEstimate } from "../../src/services/quantity-service.js";
import { markQuestion, recordQuestionAssessment } from "../../src/services/question-service.js";
import { claimRoutes } from "../../src/routes/claims.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { executeGraphReadTool } from "../../src/llm/tools/graph-read-tools.js";
import { executeManagementTool } from "../../src/llm/agents/grantmaker.js";
import { loadChangesSinceJudgedNote } from "../../src/llm/agents/steward-changes-note.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

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

/**
 * The summary of many nodes is the same fact as the detailed read of each
 * (#566): every case the detailed read distinguishes, read both ways.
 */
describe("the summary of what changed, for many nodes at once", () => {
  /** What the summary must say for a node, worked out from its detailed read. */
  async function expected(id: string) {
    const v = await getJudgmentInputs(id);
    if (!v || !v.judgment) {
      return {
        judged: false, recorded: false, changed: null,
        premises_rejudged: 0, premises_added: 0, premises_removed: 0,
        sources_added: 0, sources_removed: 0, source_events: 0,
      };
    }
    return { judged: true, recorded: v.recorded, changed: v.changed, ...countJudgmentChanges(v) };
  }

  it("agrees with the detailed read on every kind of change, and on none", async () => {
    // Nothing changed.
    const fresh = await seedCase();

    // Premises judged again: one that had a judgment, one judged for the first time.
    const rejudged = await seedCase();
    await assess(rejudged.a);
    await assess(rejudged.unjudged);

    // A premise added and a premise removed.
    const edges = await seedCase();
    await seedEdge(edges.parent, await seedClaim("summary premise added"), "contradicts");
    await rawQuery(`DELETE FROM claim_relationships WHERE parent_claim_id = $1 AND child_claim_id = $2`, [
      edges.parent,
      edges.b,
    ]);

    // A source attached, the recorded one detached, and two events on it:
    // one before the judgment, which does not count, and one after.
    const sources = await seedCase();
    await seedInstance(sources.parent, await seedSource());
    await rawQuery(`UPDATE claim_instances SET detached_at = now() WHERE id = $1`, [sources.instance]);
    await rawQuery(
      `INSERT INTO source_events (source_id, kind, detected_at, detected_by, notice_url)
       VALUES ($1, 'correction', now() - interval '1 day', 'dbtest', 'before'),
              ($1, 'retraction', now() + interval '1 second', 'dbtest', 'after')`,
      [sources.source]
    );

    // Everything at once, on a node that shares a premise with another case:
    // a change under one parent must not leak into another's counts.
    const all = await seedCase();
    await seedEdge(all.parent, rejudged.a);
    await assess(all.b);
    await rawQuery(`DELETE FROM claim_relationships WHERE parent_claim_id = $1 AND child_claim_id = $2`, [
      all.parent,
      all.a,
    ]);
    const second = await seedSource();
    await seedInstance(all.parent, second);
    await seedInstance(all.parent, second);
    await rawQuery(
      `INSERT INTO source_events (source_id, kind, detected_at, detected_by)
       VALUES ($1, 'expression_of_concern', now() + interval '1 second', 'dbtest')`,
      [all.source]
    );

    // A judgment that settles earlier changes, a judgment with no record, a
    // node never judged, and an id no node has.
    const settled = await seedCase();
    await assess(settled.a);
    await assess(settled.parent);
    const unrecorded = await seedClaim("summary unrecorded");
    await seedEdge(unrecorded, await seedClaim("summary unrecorded child"));
    await assess(unrecorded, { record: false });
    const never = await seedClaim("summary never judged");
    const nowhere = randomUUID();

    // A quantity and a question, whose judgments live in their own tables.
    const quantity = await seedClaim("summary quantity");
    await defineQuantity({
      claimId: quantity,
      definition: { measures: "Tests run", population: "This suite", unit: { kind: "count", noun: "tests", min: 0 } },
      createdBy: "dbtest",
    });
    const part = await seedClaim("summary quantity premise");
    await seedEdge(quantity, part);
    await recordEstimate({ claimId: quantity, estimate: { form: "interval", low: 1, high: 5 }, work: "counted" });
    const question = await seedClaim("summary question");
    await markQuestion(question);
    await seedEdge(question, quantity, "part_of");
    await recordQuestionAssessment({ claimId: question, standing: "open", reasoningTrace: "t" });
    // The question's premise is estimated again; then the estimate's own premise is judged again.
    await recordEstimate({ claimId: quantity, estimate: { form: "interval", low: 2, high: 4 }, work: "recounted" });
    await assess(part);

    const ids = [
      fresh.parent, rejudged.parent, edges.parent, sources.parent, all.parent, settled.parent,
      unrecorded, never, nowhere, quantity, question,
      // Leaves, each with a judgment and nothing under it.
      fresh.a, rejudged.a,
    ];
    const summary = await summarizeJudgmentChanges([...ids, fresh.parent]);
    expect([...summary.keys()].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(summary.get(id), id).toEqual(await expected(id));

    // The cases are the ones intended, so the agreement above is not vacuous.
    const counts = (id: string) => {
      const { judged: _j, recorded: _r, changed: _c, ...rest } = summary.get(id)!;
      return rest;
    };
    const none = {
      premises_rejudged: 0, premises_added: 0, premises_removed: 0,
      sources_added: 0, sources_removed: 0, source_events: 0,
    };
    expect(summary.get(fresh.parent)).toEqual({ judged: true, recorded: true, changed: false, ...none });
    expect(counts(rejudged.parent)).toEqual({ ...none, premises_rejudged: 2 });
    expect(counts(edges.parent)).toEqual({ ...none, premises_added: 1, premises_removed: 1 });
    expect(counts(sources.parent)).toEqual({ ...none, sources_added: 1, sources_removed: 1, source_events: 1 });
    expect(counts(all.parent)).toEqual({
      premises_rejudged: 1, premises_added: 1, premises_removed: 1,
      sources_added: 1, sources_removed: 0, source_events: 1,
    });
    expect(summary.get(all.parent)!.changed).toBe(true);
    expect(summary.get(settled.parent)).toEqual({ judged: true, recorded: true, changed: false, ...none });
    expect(summary.get(unrecorded)).toEqual({ judged: true, recorded: false, changed: null, ...none });
    expect(summary.get(never)).toEqual({ judged: false, recorded: false, changed: null, ...none });
    expect(summary.get(nowhere)).toEqual({ judged: false, recorded: false, changed: null, ...none });
    expect(counts(quantity)).toEqual({ ...none, premises_rejudged: 1 });
    expect(counts(question)).toEqual({ ...none, premises_rejudged: 1 });

    expect(await summarizeJudgmentChanges([])).toEqual(new Map());
  });

  it("is served as since_assessed: counts when recorded, a plain statement when not, nothing when never judged", async () => {
    const c = await seedCase();
    await assess(c.a);
    const unrecorded = await seedClaim("since unrecorded");
    await assess(unrecorded, { record: false });
    const never = await seedClaim("since never judged");
    const summary = await summarizeJudgmentChanges([c.parent, unrecorded, never]);

    expect(sinceAssessed(summary.get(c.parent))).toEqual({
      recorded: true, changed: true,
      premises_rejudged: 1, premises_added: 0, premises_removed: 0,
      sources_added: 0, sources_removed: 0, source_events: 0,
    });
    // No counts beside "not recorded": zeros there would read as "nothing changed".
    const said = sinceAssessed(summary.get(unrecorded))!;
    expect(said).toEqual({ recorded: false, changed: null, note: expect.stringContaining("unknown, not unchanged") });
    expect(sinceAssessed(summary.get(never))).toBeNull();
    expect(sinceAssessed(undefined)).toBeNull();
  });

  it("is served on a list row in as few keys as the fact takes", async () => {
    const c = await seedCase();
    await assess(c.a);
    await seedInstance(c.parent, await seedSource());
    const fresh = await seedCase();
    const unrecorded = await seedClaim("row unrecorded");
    await assess(unrecorded, { record: false });
    const never = await seedClaim("row never judged");
    const summary = await summarizeJudgmentChanges([c.parent, fresh.parent, unrecorded, never]);

    // Changed: only the counts above zero.
    expect(sinceAssessedRow(summary.get(c.parent))).toEqual({ changed: true, premises_rejudged: 1, sources_added: 1 });
    expect(sinceAssessedRow(summary.get(fresh.parent))).toEqual({ changed: false });
    // Unknown is said as unknown, never as `changed: false`.
    expect(sinceAssessedRow(summary.get(unrecorded))).toEqual({ recorded: false });
    // No judgment: nothing, so the row carries no key.
    expect(sinceAssessedRow(summary.get(never))).toBeUndefined();
    expect(sinceAssessedRow(undefined)).toBeUndefined();
  });
});

/** The claim routes on a bare app: these reads need none of the auth plugin's checks. */
async function claimsApp() {
  const app = Fastify();
  const decorate = app.decorate.bind(app) as (name: string, value: unknown) => void;
  app.decorateRequest("auth", null);
  decorate("authenticate", async () => {});
  decorate("requireAgenticQuota", () => async () => {});
  decorate("requireUser", async () => {});
  await app.register(claimRoutes, { prefix: "/claims" });
  await app.ready();
  return app;
}

/**
 * The same fact where each reader already looks (#566): the claim read, the
 * Grantmaker's list of candidates, and the Steward's task.
 */
describe("what changed since the judgment, where readers already look", () => {
  const none = {
    premises_rejudged: 0, premises_added: 0, premises_removed: 0,
    sources_added: 0, sources_removed: 0, source_events: 0,
  };

  it("is on GET /claims/:claim_id and get_claim beside the judgment, for each kind", async () => {
    const c = await seedCase();
    await assess(c.a);
    const later = await seedSource();
    await seedInstance(c.parent, later);
    const app = await claimsApp();
    const expected = { recorded: true, changed: true, ...none, premises_rejudged: 1, sources_added: 1 };

    const rest = (await app.inject({ url: `/claims/${c.parent}?information_depth=cursory` })).json();
    expect(rest.since_assessed).toEqual(expected);
    // An id in another letter case reads the same node and the same summary.
    const upper = (await app.inject({ url: `/claims/${c.parent.toUpperCase()}?information_depth=cursory` })).json();
    expect(upper.since_assessed).toEqual(expected);

    const view = JSON.parse((await executeGraphReadTool("get_claim", { claim_id: c.parent }))!);
    expect(view.since_assessed).toEqual(expected);
    expect(view.judgment_inputs).toBeUndefined();
    const full = JSON.parse(
      (await executeGraphReadTool("get_claim", { claim_id: c.parent, include: ["judgment_inputs"] }))!
    );
    expect(full.judgment_inputs).toEqual(JSON.parse(JSON.stringify(await getJudgmentInputs(c.parent))));

    // Nothing changed: said as such, with every count at zero.
    const fresh = await seedCase();
    expect((await app.inject({ url: `/claims/${fresh.parent}?information_depth=cursory` })).json().since_assessed).toEqual({
      recorded: true, changed: false, ...none,
    });

    // A judgment that predates the record: said in words, never as unchanged.
    const old = await seedClaim("read unrecorded");
    await assess(old, { record: false });
    const oldRest = (await app.inject({ url: `/claims/${old}?information_depth=cursory` })).json();
    expect(oldRest.since_assessed).toEqual({
      recorded: false, changed: null, note: expect.stringContaining("unknown, not unchanged"),
    });
    expect(JSON.parse((await executeGraphReadTool("get_claim", { claim_id: old }))!).since_assessed).toEqual(
      oldRest.since_assessed
    );

    // A node never judged has no such field.
    const never = await seedClaim("read never judged");
    expect("since_assessed" in (await app.inject({ url: `/claims/${never}?information_depth=cursory` })).json()).toBe(false);
    expect("since_assessed" in JSON.parse((await executeGraphReadTool("get_claim", { claim_id: never }))!)).toBe(false);

    // A quantity's estimate and a question's assessment are judgments too.
    const quantity = await seedClaim("read quantity");
    await defineQuantity({
      claimId: quantity,
      definition: { measures: "Tests run", population: "This suite", unit: { kind: "count", noun: "tests", min: 0 } },
      createdBy: "dbtest",
    });
    await recordEstimate({ claimId: quantity, estimate: { form: "interval", low: 1, high: 5 }, work: "counted" });
    await seedEdge(quantity, await seedClaim("read quantity premise added"));
    const question = await seedClaim("read question");
    await markQuestion(question);
    await seedEdge(question, quantity, "part_of");
    await recordQuestionAssessment({ claimId: question, standing: "open", reasoningTrace: "t" });
    await recordEstimate({ claimId: quantity, estimate: { form: "interval", low: 2, high: 4 }, work: "recounted" });
    await seedEdge(quantity, await seedClaim("read quantity premise added later"));
    for (const [id, counts] of [
      [quantity, { premises_added: 1 }],
      [question, { premises_rejudged: 1 }],
    ] as const) {
      const want = { recorded: true, changed: true, ...none, ...counts };
      expect((await app.inject({ url: `/claims/${id}?information_depth=cursory` })).json().since_assessed).toEqual(want);
      expect(JSON.parse((await executeGraphReadTool("get_claim", { claim_id: id }))!).since_assessed).toEqual(want);
    }
  });

  it("is on each row of the Grantmaker's list of a source's nodes", async () => {
    const c = await seedCase();
    await assess(c.b);
    const unjudged = await seedClaim("list never judged");
    await seedInstance(unjudged, c.source);
    const steady = await seedClaim("list judged, nothing moved");
    await seedInstance(steady, c.source);
    await assess(steady);
    const old = await seedClaim("list judged before the record");
    await seedInstance(old, c.source);
    await assess(old, { record: false });
    const { grantId } = await seedGrantWithJob({ funderId: await seedUser("changes-funder"), budgetMicroUsd: 10 * OWL });
    const [job] = await rawQuery<{ id: string }>(
      `INSERT INTO jobs (type, status, input, completed_at) VALUES ('url_extraction', 'completed', '{}', now()) RETURNING id`
    );
    await rawQuery(
      `INSERT INTO grant_sources (grant_id, source_id, url, job_id) VALUES ($1, $2, 'https://example.org/changes', $3)`,
      [grantId, c.source, job!.id]
    );

    const out = JSON.parse((await executeManagementTool(grantId, "claims_from_source", { source_id: c.source }))!);
    const byId = new Map<string, { since_assessed?: unknown }>(
      out.claims.map((r: { claim_id: string; since_assessed?: unknown }) => [r.claim_id, r])
    );
    // The short form of a list row: only what is not the default.
    expect(byId.get(c.parent)!.since_assessed).toEqual({ changed: true, premises_rejudged: 1 });
    expect(byId.get(steady)!.since_assessed).toEqual({ changed: false });
    expect(byId.get(old)!.since_assessed).toEqual({ recorded: false });
    expect("since_assessed" in byId.get(unjudged)!).toBe(false);
  });

  it("opens the Steward's pass, by claim id and text", async () => {
    const c = await seedCase();
    await assess(c.a);
    await rawQuery(
      `INSERT INTO source_events (source_id, kind, detected_at, detected_by)
       VALUES ($1, 'retraction', now() + interval '1 second', 'dbtest')`,
      [c.source]
    );
    const note = await loadChangesSinceJudgedNote(c.parent, "claim");
    expect(note).toContain("What has changed in the graph under the current assessment since it was recorded on ");
    expect(note).toContain("Subclaims judged again (1):");
    expect(note).toMatch(new RegExp(`- ${c.a} "[^"]*inputs premise a[^"]*" \\(requires\\)`));
    expect(note).toContain("Notices recorded on its sources (1):");
    expect(note).toMatch(new RegExp(`- retraction, \\d{4}-\\d{2}-\\d{2}: ${c.source} "DB-test source"`));
    expect(note).not.toContain(c.b);

    const fresh = await seedCase();
    expect(await loadChangesSinceJudgedNote(fresh.parent, "claim")).toMatch(
      /^Since the current assessment was recorded on \d{4}-\d{2}-\d{2}, nothing it was made against in the graph has changed/
    );
    const old = await seedClaim("note unrecorded");
    await assess(old, { record: false });
    expect(await loadChangesSinceJudgedNote(old, "claim")).toContain("there is no record of what has changed under it since");
    expect(await loadChangesSinceJudgedNote(await seedClaim("note never judged"), "claim")).toBe("");
  });
});

