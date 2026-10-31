/**
 * The kinds' agents against real Postgres (constitution §2, §7a, §21, Part
 * VIII): the Curator's kind change and cross-kind merges with their
 * reversals, request keeping, the Consistency Checker's figure and answer
 * candidates, the tools as an agent calls them, and a mandate funding a
 * request the Researcher takes up.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.RESEARCHER_ENABLED = "true";
});

import { rawQuery } from "../../src/db/client.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";
import {
  changeNodeKind,
  mergeClaims,
  reverseReconciliation,
} from "../../src/services/reconciliation-service.js";
import {
  addReading,
  defineQuantity,
  recordCut,
  recordEstimate,
} from "../../src/services/quantity-service.js";
import {
  addAnswer,
  markQuestion,
  recordQuestionAssessment,
} from "../../src/services/question-service.js";
import {
  fileRequest,
  getRequest,
  notifyRequestKeeper,
  reviseRequest,
  setRequestTargets,
} from "../../src/services/request-service.js";
import { figureAndAnswerChecks } from "../../src/services/consistency-service.js";
import { executeKindTool } from "../../src/llm/tools/kind-tools.js";
import { createResearchTools } from "../../src/llm/tools/research-tools.js";

const DEF = { measures: "Deaths in the 1918 pandemic", unit: { kind: "count" as const, noun: "deaths", min: 0 } };

async function seedSource(): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title) VALUES ($1, 'DB-test source') RETURNING id`,
    [`https://example.org/${randomUUID()}`]
  );
  return row!.id;
}

async function seedInstance(claimId: string, sourceId: string, stance = "affirms"): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, stance) VALUES ($1, $2, 'a passage', $3) RETURNING id`,
    [claimId, sourceId, stance]
  );
  return row!.id;
}

async function seedAssessment(claimId: string, status: string, credence: number | null = null): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO assessments (claim_id, status, confidence, claim_credence, reasoning_trace)
     VALUES ($1, $2, 0.7, $3, 'dbtest') RETURNING id`,
    [claimId, status, credence]
  );
  return row!.id;
}

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const [row] = await rawQuery<T>(sql, params);
  return row!;
}

describe("changeNodeKind", () => {
  it("makes a judged claim a quantity, retiring its verdict and mapping its instances, and reverses", async () => {
    const id = await seedClaim("figure");
    const assessmentId = await seedAssessment(id, "supported", 0.7);
    const inst = await seedInstance(id, await seedSource(), "affirms");
    const [arg] = await rawQuery<{ id: string }>(
      `INSERT INTO arguments (claim_id, stance, content, created_by) VALUES ($1, 'for', 'x', 'dbtest') RETURNING id`,
      [id]
    );
    await expect(changeNodeKind({ claimId: id, to: "quantity", reasoning: "r" })).rejects.toThrow();
    const { changed, eventId } = await changeNodeKind({ claimId: id, to: "quantity", definition: DEF, reasoning: "names a value" });
    expect(changed).toBe(true);

    expect(await one<{ kind: string }>(`SELECT kind FROM claims WHERE id = $1`, [id])).toEqual({ kind: "quantity" });
    expect(await one<{ is_current: boolean }>(`SELECT is_current FROM assessments WHERE id = $1`, [assessmentId])).toEqual({ is_current: false });
    expect(await one<{ stance: string }>(`SELECT stance FROM claim_instances WHERE id = $1`, [inst])).toEqual({ stance: "states" });
    expect(await one<{ stance: string }>(`SELECT stance FROM arguments WHERE id = $1`, [arg!.id])).toEqual({ stance: "neutral" });
    expect(await one<{ measures: string }>(`SELECT measures FROM quantity_definitions WHERE claim_id = $1`, [id])).toEqual({
      measures: DEF.measures,
    });

    expect(await reverseReconciliation(eventId!)).toEqual({ reversed: true });
    expect(await one<{ kind: string }>(`SELECT kind FROM claims WHERE id = $1`, [id])).toEqual({ kind: "claim" });
    expect(await one<{ is_current: boolean }>(`SELECT is_current FROM assessments WHERE id = $1`, [assessmentId])).toEqual({ is_current: true });
    expect(await one<{ stance: string }>(`SELECT stance FROM claim_instances WHERE id = $1`, [inst])).toEqual({ stance: "affirms" });
    expect(await one<{ stance: string }>(`SELECT stance FROM arguments WHERE id = $1`, [arg!.id])).toEqual({ stance: "for" });
    expect(await rawQuery(`SELECT 1 FROM quantity_definitions WHERE claim_id = $1`, [id])).toEqual([]);
  });
});

describe("mergeClaims across kinds", () => {
  it("folds a claim that states a value into its quantity, and reverses", async () => {
    const quantity = await seedClaim("quantity");
    await defineQuantity({ claimId: quantity, definition: DEF, createdBy: "dbtest" });
    const loser = await seedClaim("figure claim");
    const inst = await seedInstance(loser, await seedSource(), "affirms");
    const { eventId } = await mergeClaims({ survivorId: quantity, loserId: loser, stanceRelation: "same", reasoning: "a figure" });
    expect(await one(`SELECT claim_id, stance FROM claim_instances WHERE id = $1`, [inst])).toEqual({
      claim_id: quantity,
      stance: "states",
    });
    await reverseReconciliation(eventId!);
    expect(await one(`SELECT claim_id, stance FROM claim_instances WHERE id = $1`, [inst])).toEqual({
      claim_id: loser,
      stance: "affirms",
    });
  });

  it("refuses a quantity into a claim, and an opposed merge across kinds", async () => {
    const quantity = await seedClaim("quantity");
    await defineQuantity({ claimId: quantity, definition: DEF, createdBy: "dbtest" });
    const claim = await seedClaim("claim");
    await expect(mergeClaims({ survivorId: claim, loserId: quantity, stanceRelation: "same", reasoning: "r" })).rejects.toThrow(
      /Cannot merge a quantity into a claim/
    );
    await expect(mergeClaims({ survivorId: quantity, loserId: claim, stanceRelation: "opposed", reasoning: "r" })).rejects.toThrow(
      /opposed/
    );
  });

  it("moves a quantity's readings and cuts and the requests on the loser, and moves them back", async () => {
    const survivor = await seedClaim("survivor");
    const loser = await seedClaim("loser");
    for (const q of [survivor, loser]) await defineQuantity({ claimId: q, definition: DEF, createdBy: "dbtest" });
    const { id: reading } = await addReading({
      claimId: loser,
      sourceId: await seedSource(),
      measured: "m",
      figure: "f",
      bearing: "b",
      createdBy: "dbtest",
    });
    const cut = await seedClaim("cut");
    await recordCut({ claimId: cut, quantityId: loser, direction: "above", value: 5, createdBy: "dbtest" });
    const { id: requestId } = await fileRequest({
      ask: "a",
      why: "w",
      satisfiedBy: "s",
      claimIds: [loser],
      filer: { kind: "admin", agent: "claim_steward" },
    });

    const { eventId } = await mergeClaims({ survivorId: survivor, loserId: loser, stanceRelation: "same", reasoning: "dup" });
    expect(await one(`SELECT claim_id FROM quantity_readings WHERE id = $1`, [reading])).toEqual({ claim_id: survivor });
    expect(await one(`SELECT quantity_id FROM quantity_cuts WHERE claim_id = $1`, [cut])).toEqual({ quantity_id: survivor });
    expect(await getRequest(requestId)).toMatchObject({ bears_on: [{ id: survivor }], keeper: { kind: "steward" } });
    expect(await one(`SELECT keeper_claim_id FROM requests WHERE id = $1`, [requestId])).toEqual({ keeper_claim_id: survivor });

    await reverseReconciliation(eventId!);
    expect(await one(`SELECT claim_id FROM quantity_readings WHERE id = $1`, [reading])).toEqual({ claim_id: loser });
    expect(await one(`SELECT quantity_id FROM quantity_cuts WHERE claim_id = $1`, [cut])).toEqual({ quantity_id: loser });
    expect(await one(`SELECT keeper_claim_id FROM requests WHERE id = $1`, [requestId])).toEqual({ keeper_claim_id: loser });
    expect((await getRequest(requestId))!.bears_on.map((n) => n.id)).toEqual([loser]);
  });
});

describe("keeping requests", () => {
  it("revises, retargets to a new keeper, and notifies a Steward keeper", async () => {
    const a = await seedClaim("a");
    const b = await seedClaim("b");
    const { id } = await fileRequest({ ask: "a", why: "w", satisfiedBy: "s", claimIds: [a, b], filer: { kind: "admin", agent: "curator" } });
    expect((await getRequest(id))!.keeper.kind).toBe("curator");

    await reviseRequest({ requestId: id, ask: "A sharper ask", addressedTo: "An archive" });
    expect(await getRequest(id)).toMatchObject({ ask: "A sharper ask", addressed_to: "An archive", state: "addressed" });
    await expect(reviseRequest({ requestId: id, why: "" })).rejects.toThrow(/keeps its why/);

    expect(await setRequestTargets({ requestId: id, claimIds: [b] })).toEqual({ keeper: "steward", keeperClaimId: b });
    await rawQuery(`UPDATE claims SET steward_state = 'done', steward_trigger = NULL WHERE id = $1`, [b]);
    expect(await notifyRequestKeeper(id, "work came back")).toBe(true);
    expect(await one(`SELECT steward_state, steward_trigger FROM claims WHERE id = $1`, [b])).toEqual({
      steward_state: "pending",
      steward_trigger: "request_returned",
    });
  });
});

describe("figure and answer checks", () => {
  it("lists a cut whose credence the estimate does not bear out, and a question that favors a doubtful answer", async () => {
    const quantity = await seedClaim("quantity");
    await defineQuantity({ claimId: quantity, definition: DEF, createdBy: "dbtest" });
    await recordEstimate({
      claimId: quantity,
      estimate: { form: "distribution", quantiles: [{ p: 0.05, v: 10 }, { p: 0.5, v: 30 }, { p: 0.95, v: 100 }] },
      work: "w",
    });
    const cut = await seedClaim("cut");
    await seedAssessment(cut, "supported", 0.9);
    await recordCut({ claimId: cut, quantityId: quantity, direction: "above", value: 50, createdBy: "dbtest" });
    const agreeing = await seedClaim("agreeing cut");
    await seedAssessment(agreeing, "supported", 0.95);
    await recordCut({ claimId: agreeing, quantityId: quantity, direction: "above", value: 10, createdBy: "dbtest" });

    const question = await seedClaim("question");
    await markQuestion(question);
    const answer = await seedClaim("answer");
    await seedAssessment(answer, "doubtful");
    await addAnswer({ questionId: question, answerId: answer, basis: "prominence", reasoning: "r", createdBy: "dbtest" });
    await recordQuestionAssessment({ claimId: question, standing: "leaning", favoredClaimIds: [answer], reasoningTrace: "t" });

    const checks = await figureAndAnswerChecks({ claimIds: [cut, agreeing, quantity, question] });
    expect(checks.cuts.map((c) => c.claim_id)).toEqual([cut]);
    expect(checks.cuts[0]).toMatchObject({ direction: "above", value: 50, credence: 0.9, implied_bound: null });
    expect(checks.cuts[0]!.implied).toBeCloseTo(0.5 * (1 - (50 - 30) / 70) + 0, 1);
    expect(checks.answers).toEqual([
      expect.objectContaining({ question_id: question, answer_id: answer, favored: true, answer_status: "doubtful" }),
    ]);
  });
});

describe("the kinds' tools", () => {
  it("records a figure and an estimate on a quantity, and refuses a claim tool's write on it", async () => {
    const quantity = await seedClaim("quantity");
    await defineQuantity({ claimId: quantity, definition: DEF, createdBy: "dbtest" });
    const ctx = { role: "claim_steward" as const, claimId: quantity, model: "dbtest-model" };
    const figure = JSON.parse(
      (await executeKindTool(
        "record_estimate",
        { quantity_id: quantity, url: `https://example.org/${randomUUID()}`, stated: { form: "point", central: 5e7 } },
        ctx
      ))!
    );
    expect(figure.success).toBe(true);
    expect(await one(`SELECT stance, verbatim_text, stated_estimate FROM claim_instances WHERE id = $1`, [figure.instance_id])).toEqual({
      stance: "states",
      verbatim_text: "",
      stated_estimate: { form: "point", central: 5e7 },
    });

    const bad = JSON.parse(
      (await executeKindTool("update_quantity_estimate", { claim_id: quantity, estimate: { form: "interval", low: 3 }, assessment: "a", work: "w" }, ctx))!
    );
    expect(bad.success).toBe(false);
    expect(bad.message).toMatch(/low and high/);
    const good = JSON.parse(
      (await executeKindTool(
        "update_quantity_estimate",
        { claim_id: quantity, estimate: { form: "interval", low: 1.7e7, high: 1e8, level: 0.9 }, assessment: "a", work: "w" },
        ctx
      ))!
    );
    expect(good.success).toBe(true);
    expect(await one(`SELECT model FROM quantity_estimates WHERE id = $1`, [good.estimate_id])).toEqual({ model: "dbtest-model" });

    expect(await executeKindTool("not_a_kind_tool", {}, ctx)).toBeNull();
  });

  it("mints a new quantity answer for a question, and keeps requests to their keepers", async () => {
    const question = await seedClaim("question");
    await markQuestion(question);
    const qctx = { role: "question_steward" as const, claimId: question };
    const added = JSON.parse(
      (await executeKindTool(
        "add_answer",
        { question_id: question, new_text: "Deaths in the pandemic", new_kind: "quantity", new_definition: DEF, basis: "quality", reasoning: "r" },
        qctx
      ))!
    );
    expect(added.success).toBe(true);
    expect(await one(`SELECT kind FROM claims WHERE id = $1`, [added.answer_id])).toEqual({ kind: "quantity" });

    const filed = JSON.parse(
      (await executeKindTool("file_request", { ask: "a", why: "w", satisfied_by: "s", claim_ids: [question] }, qctx))!
    );
    expect(filed.success).toBe(true);
    expect((await getRequest(filed.request_id))!.filed_by).toEqual({ kind: "admin", label: "Question Steward" });

    const other = await seedClaim("other");
    const notMine = JSON.parse(
      (await executeKindTool("close_request", { request_id: filed.request_id, state: "met", note: "n" }, { role: "claim_steward", claimId: other }))!
    );
    expect(notMine.success).toBe(false);
    const closed = JSON.parse(
      (await executeKindTool("close_request", { request_id: filed.request_id, state: "moot", note: "duplicate" }, qctx))!
    );
    expect(closed.success).toBe(true);

    const kindChange = JSON.parse((await executeKindTool("change_node_kind", { claim_id: other, to: "question", reasoning: "r" }, qctx))!);
    expect(kindChange.success).toBe(false);
  });
});

describe("fund_request", () => {
  it("puts the mandate's money on the request's ledger row, clipped to what the row lacks", async () => {
    // An active platform mandate left by another file would price and fund
    // the scoping pass the moment the request is filed (as it should);
    // this test is about the Grantmaker's own placement, so none is active.
    await rawQuery(
      `UPDATE grants SET status = 'completed'
        WHERE is_platform = true OR policy IN ('general', 'governance')`
    );
    resetAllocationPolicyCache();
    const claim = await seedClaim("kept");
    const { id: requestId } = await fileRequest({
      ask: "Recover the regional estimates.",
      why: "The global figure turns on them.",
      satisfiedBy: "Estimates with stated methods.",
      claimIds: [claim],
      filer: { kind: "admin", agent: "claim_steward" },
    });
    const funder = await seedUser("funder");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 10_000_000 });
    const tools = createResearchTools({ requestedBy: "grantmaker", grantId });
    expect(tools.definitions.map((t) => t.name)).toContain("fund_request");
    const out = JSON.parse((await tools.execute("fund_request", { request_id: requestId, budget_usd: 1 }))!);
    // No budget yet: the money goes to the scoping pass (0.5 owl prior),
    // which it covers; the Researcher takes it up on the executor's pass.
    expect(out).toMatchObject({ success: true, covered: true });
    expect(out.funded).toContain("scoping pass");
    expect(
      await one(
        `SELECT amount_micro_usd::bigint AS amount FROM action_allocations
          WHERE exclusion_group = $1 AND grant_id = $2 AND released_at IS NULL`,
        [`request:${requestId}`, grantId]
      )
    ).toEqual({ amount: "500000" });
    // Nothing ran inline: the request has no work recorded yet.
    expect((await getRequest(requestId))!.work).toEqual([]);

    const steward = createResearchTools({ requestedBy: "claim_steward", claimId: claim });
    expect(steward.definitions.map((t) => t.name)).not.toContain("fund_request");
  });
});
