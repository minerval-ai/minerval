/**
 * What examination a node has had (#543): `coverage`, derived from the
 * judgment in force, the sources it was recorded against and the readings
 * of them, and served whole on the read of one node and in a short form on
 * every row of a tree.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { rawQuery } from "../../src/db/client.js";
import {
  COVERAGE_UNEXAMINED_NOTE,
  coverage,
  coverageRow,
  summarizeCoverage,
  type CoverageSummary,
} from "../../src/services/coverage-service.js";
import { recordJudgmentInputs } from "../../src/services/judgment-inputs-service.js";
import { recordInstanceReading } from "../../src/services/source-map-service.js";
import { defineQuantity, recordEstimate } from "../../src/services/quantity-service.js";
import { markQuestion, recordQuestionAssessment } from "../../src/services/question-service.js";
import { changeNodeKind } from "../../src/services/reconciliation-service.js";
import { getClaimTree } from "../../src/services/tree-service.js";
import { claimRoutes } from "../../src/routes/claims.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { executeGraphReadTool } from "../../src/llm/tools/graph-read-tools.js";
import type { TreeNode } from "../../src/schemas/claim.js";
import { seedClaim } from "./helpers.js";

const NOT_EXAMINED: CoverageSummary = { examined: false, on: [] };
const PUBLIC: CoverageSummary = { examined: true, on: ["public_evidence"] };
const NOT_SHOWN: CoverageSummary = { examined: true, on: ["public_evidence", "evidence_not_shown"] };
// The same three on a row of a list, which names only what goes beyond public evidence.
const ROW_NOT_EXAMINED = { examined: false };
const ROW_PUBLIC = { examined: true };
const ROW_NOT_SHOWN = { examined: true, on: ["evidence_not_shown"] };

async function seedSource(): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, source_type) VALUES ($1, 'DB-test source', 'paper') RETURNING id`,
    [`https://example.org/coverage/${randomUUID()}`]
  );
  return row!.id;
}

/** Attach a source to the claim and, when `support` is given, record a reading of it. */
async function seedInstance(claimId: string, sourceId: string, support?: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, 'a passage') RETURNING id`,
    [claimId, sourceId]
  );
  if (support) await read(claimId, row!.id, support);
  return row!.id;
}

/** Record a reading through the service the Steward's tool calls, which writes the log too. */
async function read(claimId: string, instanceId: string, support: string): Promise<void> {
  await recordInstanceReading({ claimId, instanceId, support, createdBy: "dbtest" });
}

async function seedEdge(parent: string, child: string, relation = "requires"): Promise<void> {
  await rawQuery(
    `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning)
     VALUES ($1, $2, $3, 'dbtest')`,
    [parent, child, relation]
  );
}

/** Supersede the claim's assessment and write a new one, as the Steward's write does. */
async function assess(claimId: string, opts: { record?: boolean; status?: string } = {}): Promise<string> {
  await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1`, [claimId]);
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace)
     VALUES ($1, $2, 0.7, 'dbtest') RETURNING id`,
    [claimId, opts.status ?? "supported"]
  );
  if (opts.record !== false) await recordJudgmentInputs(rawQuery, "assessment", row!.id, claimId);
  return row!.id;
}

const one = async (id: string) => (await summarizeCoverage([id])).get(id);
/** What a row of a list must carry for a node: the short form of its own read. */
const row = async (id: string) => coverageRow(await one(id));

async function claimsApp() {
  const app = Fastify();
  // The claim routes expect the auth plugin's decorators; these reads need none of them.
  const decorate = app.decorate.bind(app) as (name: string, value: unknown) => void;
  app.decorateRequest("auth", null);
  decorate("authenticate", async () => {});
  decorate("requireAgenticQuota", () => async () => {});
  decorate("requireUser", async () => {});
  await app.register(claimRoutes, { prefix: "/claims" });
  await app.ready();
  return app;
}

const getClaim = async (id: string, include?: string[]) =>
  JSON.parse((await executeGraphReadTool("get_claim", { claim_id: id, ...(include ? { include } : {}) }))!);

/** Every node of a tree by id; a shared node appears once per occurrence, each the same. */
function flatten(node: TreeNode, into = new Map<string, TreeNode>()): Map<string, TreeNode> {
  into.set(node.id, node);
  for (const child of node.children) flatten(child, into);
  return into;
}

describe("a node that has not been examined", () => {
  it("is not examined while it has no judgment, whatever seed, sources and readings it carries", async () => {
    const bare = await seedClaim("coverage never judged");
    expect(await one(bare)).toEqual(NOT_EXAMINED);

    // A seed from the parent's Steward, an attached source and a reading of
    // it are everything short of a judgment.
    const seeded = await seedClaim("coverage seeded");
    await rawQuery(`UPDATE claims SET seed_credence = 0.9, seed_note = 'looks right' WHERE id = $1`, [seeded]);
    await seedInstance(seeded, await seedSource(), "evidence_not_shown");
    expect(await one(seeded)).toEqual(NOT_EXAMINED);

    // An id no node has is not examined either.
    const nobody = randomUUID();
    expect(await one(nobody)).toEqual(NOT_EXAMINED);
  });

  it("says so in words on the read of one node, and only there", async () => {
    const never = await seedClaim("coverage never judged note");
    const want = { ...NOT_EXAMINED, note: COVERAGE_UNEXAMINED_NOTE };
    expect(coverage(await one(never))).toEqual(want);
    expect((await getClaim(never)).coverage).toEqual(want);
    const app = await claimsApp();
    const res = await app.inject({ url: `/claims/${never}?information_depth=cursory` });
    expect(res.statusCode).toBe(200);
    expect(res.json().coverage).toEqual(want);
    expect(res.json().assessment).toBeNull();
  });

  it("is a quantity with no estimate, a question with no assessment, and a node whose kind change retired its judgment", async () => {
    const quantity = await seedClaim("coverage quantity unjudged");
    await defineQuantity({
      claimId: quantity,
      definition: { measures: "Tests run", population: "This suite", unit: { kind: "count", noun: "tests", min: 0 } },
      createdBy: "dbtest",
    });
    const question = await seedClaim("coverage question unjudged");
    await markQuestion(question);
    expect(await one(quantity)).toEqual(NOT_EXAMINED);
    expect(await one(question)).toEqual(NOT_EXAMINED);

    // The Curator corrects a node's kind: the verdict it had as a claim is
    // retired, and no judgment of it is in force until it is judged again.
    const converted = await seedClaim("coverage converted");
    await assess(converted);
    expect(await one(converted)).toEqual(PUBLIC);
    await changeNodeKind({ claimId: converted, to: "question", reasoning: "dbtest: it asks, it does not assert" });
    expect(await one(converted)).toEqual(NOT_EXAMINED);
    expect((await getClaim(converted)).coverage).toEqual({ ...NOT_EXAMINED, note: COVERAGE_UNEXAMINED_NOTE });
  });
});

describe("a node that has been examined", () => {
  it("was examined on public evidence when judged on ordinary sources, or on none", async () => {
    const plain = await seedClaim("coverage judged, no sources");
    await assess(plain);
    expect(await one(plain)).toEqual(PUBLIC);

    const sourced = await seedClaim("coverage judged on sources");
    await seedInstance(sourced, await seedSource(), "supports");
    await seedInstance(sourced, await seedSource(), "asserts_without_evidence");
    await seedInstance(sourced, await seedSource());
    await assess(sourced);
    expect(await one(sourced)).toEqual(PUBLIC);
    // An examined node carries no note: the verdict is beside it.
    expect(coverage(await one(sourced))).toEqual(PUBLIC);
    expect((await getClaim(sourced)).coverage).toEqual(PUBLIC);
  });

  it("is examined when the verdict is unknown: the evidence was looked at and found insufficient", async () => {
    const unknown = await seedClaim("coverage judged unknown");
    await assess(unknown, { status: "unknown" });
    expect(await one(unknown)).toEqual(PUBLIC);
  });

  it("says evidence not shown when a source it was judged against had been read that way", async () => {
    const claim = await seedClaim("coverage evidence not shown");
    await seedInstance(claim, await seedSource(), "supports");
    await seedInstance(claim, await seedSource(), "evidence_not_shown");
    await assess(claim);
    expect(await one(claim)).toEqual(NOT_SHOWN);
    expect((await getClaim(claim)).coverage).toEqual(NOT_SHOWN);
    const app = await claimsApp();
    expect((await app.inject({ url: `/claims/${claim}?information_depth=cursory` })).json().coverage).toEqual(NOT_SHOWN);
  });

  it("goes by the reading as it stood when the judgment was written", async () => {
    // Read as evidence not shown only after the verdict: the verdict in
    // force was not made on that reading, and the next one is.
    const later = await seedClaim("coverage read after the verdict");
    const instance = await seedInstance(later, await seedSource(), "supports");
    await assess(later);
    await read(later, instance, "evidence_not_shown");
    expect(await one(later)).toEqual(PUBLIC);
    await assess(later);
    expect(await one(later)).toEqual(NOT_SHOWN);

    // Read as evidence not shown when judged, and read again since as
    // showing its evidence: the verdict in force still rests on the earlier
    // reading until the node is judged again.
    const shownSince = await seedClaim("coverage shown since the verdict");
    const reread = await seedInstance(shownSince, await seedSource(), "evidence_not_shown");
    await assess(shownSince);
    await read(shownSince, reread, "supports");
    expect(await one(shownSince)).toEqual(NOT_SHOWN);
    await assess(shownSince);
    expect(await one(shownSince)).toEqual(PUBLIC);
  });

  it("counts only sources the judgment was recorded against", async () => {
    // Attached and read after the verdict: not one of its inputs.
    const added = await seedClaim("coverage source added since");
    await seedInstance(added, await seedSource(), "supports");
    await assess(added);
    await seedInstance(added, await seedSource(), "evidence_not_shown");
    expect(await one(added)).toEqual(PUBLIC);

    // Two passages of one source, the one read as evidence not shown
    // detached before the verdict: the verdict was made on the other.
    const detached = await seedClaim("coverage passage detached before");
    const source = await seedSource();
    const gone = await seedInstance(detached, source, "evidence_not_shown");
    await seedInstance(detached, source, "supports");
    await rawQuery(
      `UPDATE claim_instances SET detached_at = now(), detached_reason = 'dbtest', detached_by = 'dbtest' WHERE id = $1`,
      [gone]
    );
    await assess(detached);
    expect(await one(detached)).toEqual(PUBLIC);

    // Detached after the verdict: the verdict was made with it.
    const detachedSince = await seedClaim("coverage passage detached since");
    const kept = await seedInstance(detachedSince, await seedSource(), "evidence_not_shown");
    await assess(detachedSince);
    await rawQuery(
      `UPDATE claim_instances SET detached_at = now() + interval '1 second', detached_reason = 'dbtest', detached_by = 'dbtest' WHERE id = $1`,
      [kept]
    );
    expect(await one(detachedSince)).toEqual(NOT_SHOWN);

    // A judgment whose inputs were not recorded names no sources.
    const unrecorded = await seedClaim("coverage inputs not recorded");
    await seedInstance(unrecorded, await seedSource(), "evidence_not_shown");
    await assess(unrecorded, { record: false });
    expect(await one(unrecorded)).toEqual(PUBLIC);
  });

  it("is read from the Steward's own write of a verdict", async () => {
    const claim = await seedClaim("coverage steward write");
    await seedInstance(claim, await seedSource(), "evidence_not_shown");
    expect(await one(claim)).toEqual(NOT_EXAMINED);
    const out = JSON.parse(
      await executeStewardTool("update_claim_assessment", {
        claim_id: claim,
        status: "supported",
        confidence: 0.6,
        assessment: "Rests on a developer's report of an evaluation it has not released.",
        reasoning_trace: "Weighed the report as testimony.",
      })
    );
    expect(out.success).toBe(true);
    expect(await one(claim)).toEqual(NOT_SHOWN);
  });

  it("covers a quantity's estimate and a question's assessment", async () => {
    const quantity = await seedClaim("coverage quantity");
    await defineQuantity({
      claimId: quantity,
      definition: { measures: "Tests run", population: "This suite", unit: { kind: "count", noun: "tests", min: 0 } },
      createdBy: "dbtest",
    });
    await seedInstance(quantity, await seedSource(), "evidence_not_shown");
    await recordEstimate({ claimId: quantity, estimate: { form: "interval", low: 1, high: 5 }, work: "counted" });
    expect(await one(quantity)).toEqual(NOT_SHOWN);
    // A quantity has no `assessment`; coverage is what says it has been judged.
    const view = await getClaim(quantity);
    expect(view.assessment).toBeNull();
    expect(view.coverage).toEqual(NOT_SHOWN);

    const question = await seedClaim("coverage question");
    await markQuestion(question);
    await recordQuestionAssessment({ claimId: question, standing: "open", reasoningTrace: "t" });
    expect(await one(question)).toEqual(PUBLIC);
    expect((await getClaim(question)).coverage).toEqual(PUBLIC);
  });
});

describe("coverage for many nodes at once, and on the rows of a tree", () => {
  /** A parent over one premise of each case, with a quantity and a question among them. */
  async function seedTree() {
    const parent = await seedClaim("coverage tree parent");
    const never = await seedClaim("coverage tree never");
    const plain = await seedClaim("coverage tree plain");
    const notShown = await seedClaim("coverage tree not shown");
    const quantity = await seedClaim("coverage tree quantity");
    const question = await seedClaim("coverage tree question");
    const deep = await seedClaim("coverage tree grandchild");
    await rawQuery(`UPDATE claims SET seed_credence = 0.8 WHERE id = $1`, [never]);
    await assess(plain);
    await seedInstance(notShown, await seedSource(), "evidence_not_shown");
    await assess(notShown);
    await defineQuantity({
      claimId: quantity,
      definition: { measures: "Tests run", population: "This suite", unit: { kind: "count", noun: "tests", min: 0 } },
      createdBy: "dbtest",
    });
    await recordEstimate({ claimId: quantity, estimate: { form: "interval", low: 1, high: 5 }, work: "counted" });
    await markQuestion(question);
    for (const child of [never, plain, notShown, quantity, question]) await seedEdge(parent, child, "supports");
    await seedEdge(plain, deep);
    await assess(parent);
    return { parent, never, plain, notShown, quantity, question, deep };
  }

  it("says for a set what it says for each node alone", async () => {
    const t = await seedTree();
    const ids = [...Object.values(t), randomUUID()];
    const together = await summarizeCoverage(ids);
    expect(together.size).toBe(ids.length);
    for (const id of ids) expect(together.get(id)).toEqual(await one(id));
    expect(together.get(t.parent)).toEqual(PUBLIC);
    expect(together.get(t.never)).toEqual(NOT_EXAMINED);
    expect(together.get(t.plain)).toEqual(PUBLIC);
    expect(together.get(t.notShown)).toEqual(NOT_SHOWN);
    expect(together.get(t.quantity)).toEqual(PUBLIC);
    expect(together.get(t.question)).toEqual(NOT_EXAMINED);
    expect(together.get(t.deep)).toEqual(NOT_EXAMINED);
    // Ids are matched whatever their case, and each is answered once.
    expect((await summarizeCoverage([t.plain.toUpperCase(), t.plain])).get(t.plain)).toEqual(PUBLIC);
    expect((await summarizeCoverage([])).size).toBe(0);
  });

  it("has a short form for a row: examined, and only what goes beyond public evidence", () => {
    expect(coverageRow(NOT_EXAMINED)).toEqual(ROW_NOT_EXAMINED);
    expect(coverageRow(PUBLIC)).toEqual(ROW_PUBLIC);
    expect(coverageRow(NOT_SHOWN)).toEqual(ROW_NOT_SHOWN);
    // No `on` key at all where there is nothing beyond public evidence.
    expect("on" in coverageRow(PUBLIC)!).toBe(false);
    expect("on" in coverageRow(NOT_EXAMINED)!).toBe(false);
    // A value the vocabulary gains later is listed the same way. The cast
    // stands in for a word that is not in the vocabulary yet.
    const later = { examined: true, on: ["public_evidence", "sealed_evidence"] } as unknown as CoverageSummary;
    expect(coverageRow(later)).toEqual({ examined: true, on: ["sealed_evidence"] });
    expect(coverageRow(undefined)).toBeUndefined();
  });

  it("is on every node of the tree in the short form, saying what the read of that node says", async () => {
    const t = await seedTree();
    const tree = (await getClaimTree(t.parent))!;
    const nodes = flatten(tree);
    expect(nodes.size).toBe(7);
    for (const [id, node] of nodes) {
      expect(node.coverage).toEqual(await row(id));
      expect(node.coverage && "note" in node.coverage).toBe(false);
    }
    // The status field alone cannot say this: a judged quantity and an
    // unjudged question both carry a null status.
    expect(nodes.get(t.quantity)).toMatchObject({ assessment_status: null, coverage: ROW_PUBLIC });
    expect(nodes.get(t.question)).toMatchObject({ assessment_status: null, coverage: ROW_NOT_EXAMINED });
    // A seed does not make a node examined.
    expect(nodes.get(t.never)).toMatchObject({ seed_credence: 0.8, coverage: ROW_NOT_EXAMINED });
    expect(nodes.get(t.notShown)!.coverage).toEqual(ROW_NOT_SHOWN);
    expect(nodes.get(t.plain)!.coverage).toEqual(ROW_PUBLIC);
  });

  it("is on get_decomposition's nodes, on get_claim's subclaims and on the tree of GET /claims/:claim_id", async () => {
    const t = await seedTree();

    const walked = JSON.parse((await executeGraphReadTool("get_decomposition", { claim_id: t.parent }))!);
    const fromTool = flatten(walked.tree as TreeNode);
    expect(fromTool.get(t.never)!.coverage).toEqual(ROW_NOT_EXAMINED);
    expect(fromTool.get(t.notShown)!.coverage).toEqual(ROW_NOT_SHOWN);
    expect(fromTool.get(t.deep)!.coverage).toEqual(ROW_NOT_EXAMINED);
    // The root of the walk is a row too: the short form, not the full object.
    expect(walked.tree.coverage).toEqual(ROW_PUBLIC);

    // The read of one node keeps the full object, beside rows in the short form.
    const view = await getClaim(t.parent, ["subclaims"]);
    expect(view.coverage).toEqual(PUBLIC);
    const rows = new Map<string, { coverage: unknown }>(
      (view.subclaims as Array<{ id: string; coverage: unknown }>).map((r) => [r.id, r])
    );
    expect(rows.size).toBe(5);
    for (const [id, r] of rows) expect(r.coverage).toEqual(await row(id));
    expect(rows.get(t.quantity)!.coverage).toEqual(ROW_PUBLIC);
    expect(rows.get(t.never)!.coverage).toEqual(ROW_NOT_EXAMINED);
    expect(rows.get(t.notShown)!.coverage).toEqual(ROW_NOT_SHOWN);

    const app = await claimsApp();
    const res = await app.inject({ url: `/claims/${t.parent}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.coverage).toEqual(PUBLIC);
    const served = flatten(body.tree as TreeNode);
    for (const [id, node] of served) expect(node.coverage).toEqual(await row(id));
    expect(served.get(t.never)!.coverage).toEqual(ROW_NOT_EXAMINED);
    expect(served.get(t.notShown)!.coverage).toEqual(ROW_NOT_SHOWN);
  });
});
