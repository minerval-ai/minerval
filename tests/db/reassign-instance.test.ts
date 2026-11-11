/**
 * The Curator's reassign_instance against real Postgres (#828, #815): one
 * operation that puts a passage on the node it is about, by moving the
 * instance or copying it, for a claim, a quantity or a question, with what
 * the passage says about that node; each logged with the state it found
 * and reversible (a move restored whole, a copy detached, never deleted).
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { defineQuantity } from "../../src/services/quantity-service.js";
import { addAnswer, markQuestion } from "../../src/services/question-service.js";
import { reassignInstance, reverseReconciliation } from "../../src/services/reconciliation-service.js";

interface InstanceRow {
  id: string;
  claim_id: string;
  source_id: string;
  verbatim_text: string;
  context: string | null;
  stance: string;
  stated_estimate: unknown;
  argument_id: string | null;
  answer_claim_id: string | null;
  display_rank: number | null;
  speaker: string | null;
  publication: string | null;
  source_date: string | null;
  segment_id: string | null;
  created_by: string;
  detached_at: Date | null;
  detached_reason: string | null;
  detached_by: string | null;
}

async function instance(id: string): Promise<InstanceRow> {
  const [row] = await rawQuery<InstanceRow>(`SELECT * FROM claim_instances WHERE id = $1`, [id]);
  return row!;
}

async function seedSource(): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, source_type) VALUES ($1, 'DB-test source', 'journal_article') RETURNING id`,
    [`https://example.org/reassign/${randomUUID()}`]
  );
  return row!.id;
}

async function seedInstance(
  claimId: string,
  sourceId: string,
  fields: Partial<{ stance: string; speaker: string; stated: unknown; rank: number; argumentId: string; answerId: string }> = {}
): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claim_instances
       (claim_id, source_id, verbatim_text, context, stance, speaker, publication, source_date,
        stated_estimate, display_rank, argument_id, answer_claim_id)
     VALUES ($1, $2, 'Games ran 31, 42, 55 and 61 minutes.', 'the surrounding paragraph', $3, $4,
             'The Gazette', '2024-03', $5::jsonb, $6, $7, $8)
     RETURNING id`,
    [
      claimId,
      sourceId,
      fields.stance ?? "affirms",
      fields.speaker ?? null,
      fields.stated === undefined ? null : JSON.stringify(fields.stated),
      fields.rank ?? null,
      fields.argumentId ?? null,
      fields.answerId ?? null,
    ]
  );
  return row!.id;
}

async function seedArgument(claimId: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO arguments (claim_id, name, stance, content, created_by)
     VALUES ($1, 'an argument', 'for', 'an argument', 'dbtest') RETURNING id`,
    [claimId]
  );
  return row!.id;
}

async function seedQuantity(label: string): Promise<string> {
  const id = await seedClaim(label);
  await defineQuantity({
    claimId: id,
    definition: { measures: `Length of ${label}`, unit: { kind: "count", noun: "minutes", min: 0 } },
    createdBy: "dbtest",
  });
  return id;
}

async function seedQuestion(label: string): Promise<string> {
  const id = await seedClaim(label);
  await markQuestion(id);
  return id;
}

async function seedReading(instanceId: string): Promise<void> {
  await rawQuery(`INSERT INTO claim_instance_readings (instance_id) VALUES ($1)`, [instanceId]);
}

async function event(id: string): Promise<{ operation: string; reasoning: string; payload: Record<string, unknown> }> {
  const [row] = await rawQuery<{ operation: string; reasoning: string; payload: Record<string, unknown> }>(
    `SELECT operation, reasoning, payload FROM reconciliation_events WHERE id = $1`,
    [id]
  );
  return row!;
}

const POINT = (v: number) => ({ form: "point", central: v });

describe("reassign_instance: moving", () => {
  it("moves between claims, clearing what pointed into the old one, and reverses whole", async () => {
    const from = await seedClaim("from");
    const to = await seedClaim("to");
    const argumentId = await seedArgument(from);
    const inst = await seedInstance(from, await seedSource(), { rank: 2, argumentId });

    const res = await reassignInstance({ instanceId: inst, toClaimId: to, reasoning: "the passage is about the second claim" });
    expect(res).toMatchObject({ reassigned: true, mode: "move", instanceId: inst, stance: "affirms" });
    expect(await instance(inst)).toMatchObject({ claim_id: to, stance: "affirms", argument_id: null, display_rank: null });

    const logged = await event(res.eventId!);
    expect(logged.reasoning).toBe("the passage is about the second claim");
    expect(logged.payload).toMatchObject({
      mode: "move",
      instance_id: inst,
      copied_from_instance_id: null,
      from_claim_id: from,
      to_claim_id: to,
      prior: {
        claim_id: from,
        stance: "affirms",
        stated_estimate: null,
        argument_id: argumentId,
        answer_claim_id: null,
        display_rank: 2,
      },
    });

    expect((await reverseReconciliation(res.eventId!, { reasoning: "it was about the first" })).reversed).toBe(true);
    expect(await instance(inst)).toMatchObject({
      claim_id: from,
      stance: "affirms",
      argument_id: argumentId,
      display_rank: 2,
      detached_at: null,
    });
  });

  it('flips affirms and denies on "opposed", leaves poses and mentions, and restores the stance on reversal', async () => {
    const from = await seedClaim("from");
    const denial = await seedClaim("denial");
    const source = await seedSource();
    const affirms = await seedInstance(from, source, { stance: "affirms", speaker: "A" });
    const denies = await seedInstance(from, source, { stance: "denies", speaker: "B" });
    const poses = await seedInstance(from, source, { stance: "poses", speaker: "C" });
    const mentions = await seedInstance(from, source, { stance: "mentions", speaker: "D" });

    const moved = [];
    for (const id of [affirms, denies, poses, mentions]) {
      moved.push(await reassignInstance({ instanceId: id, toClaimId: denial, stanceRelation: "opposed", reasoning: "worded as the denial" }));
    }
    expect(moved.map((m) => m.stance)).toEqual(["denies", "affirms", "poses", "mentions"]);
    expect((await instance(affirms)).stance).toBe("denies");
    expect((await event(moved[0]!.eventId!)).payload).toMatchObject({ stance_relation: "opposed", prior: { stance: "affirms" } });

    for (const m of [...moved].reverse()) {
      expect((await reverseReconciliation(m.eventId!, { reasoning: "undo" })).reversed).toBe(true);
    }
    expect((await instance(affirms)).stance).toBe("affirms");
    expect((await instance(denies)).stance).toBe("denies");
    expect((await instance(affirms)).claim_id).toBe(from);
  });

  it("moves onto a quantity only with the figure the passage states for it, and restores the old figure", async () => {
    const bundled = await seedQuantity("bundled");
    const gameTwo = await seedQuantity("game two");
    const inst = await seedInstance(bundled, await seedSource(), { stance: "states", stated: POINT(31) });

    const refused = await reassignInstance({ instanceId: inst, toClaimId: gameTwo, reasoning: "r" });
    expect(refused.reassigned).toBe(false);
    expect(refused.reason).toMatch(/quantity.*stated/);
    const malformed = await reassignInstance({ instanceId: inst, toClaimId: gameTwo, stated: { form: "interval", low: 5 }, reasoning: "r" });
    expect(malformed.reassigned).toBe(false);
    expect(malformed.reason).toMatch(/not a figure/);
    expect(await instance(inst)).toMatchObject({ claim_id: bundled, stated_estimate: POINT(31) });

    const res = await reassignInstance({ instanceId: inst, toClaimId: gameTwo, stated: POINT(42), reasoning: "it gives game two as 42" });
    expect(res).toMatchObject({ reassigned: true, stance: "states" });
    expect(await instance(inst)).toMatchObject({ claim_id: gameTwo, stance: "states", stated_estimate: POINT(42) });

    await reverseReconciliation(res.eventId!, { reasoning: "undo" });
    expect(await instance(inst)).toMatchObject({ claim_id: bundled, stance: "states", stated_estimate: POINT(31) });
  });

  it("reads the stance into the target's kind across kinds, dropping a figure that was for the old quantity", async () => {
    const quantity = await seedQuantity("quantity");
    const claim = await seedClaim("claim");
    const question = await seedQuestion("question");
    const source = await seedSource();

    // A claim's affirming instance becomes a figure on the quantity.
    const onClaim = await seedInstance(claim, source, { stance: "affirms" });
    const toQuantity = await reassignInstance({ instanceId: onClaim, toClaimId: quantity, stated: POINT(7), reasoning: "r" });
    expect(toQuantity.stance).toBe("states");

    // A quantity's figure becomes an affirmation of the claim, flipped when the claim denies it.
    const onQuantity = await seedInstance(quantity, source, { stance: "states", stated: POINT(9) });
    const toClaim = await reassignInstance({ instanceId: onQuantity, toClaimId: claim, stanceRelation: "opposed", reasoning: "r" });
    expect(toClaim.stance).toBe("denies");
    expect(await instance(onQuantity)).toMatchObject({ claim_id: claim, stance: "denies", stated_estimate: null });

    // A claim's instance on a question asks it.
    const third = await seedInstance(claim, source, { stance: "denies", speaker: "someone" });
    const toQuestion = await reassignInstance({ instanceId: third, toClaimId: question, reasoning: "r" });
    expect(toQuestion.stance).toBe("asks");

    await reverseReconciliation(toQuestion.eventId!, { reasoning: "undo" });
    await reverseReconciliation(toClaim.eventId!, { reasoning: "undo" });
    await reverseReconciliation(toQuantity.eventId!, { reasoning: "undo" });
    expect(await instance(third)).toMatchObject({ claim_id: claim, stance: "denies" });
    expect(await instance(onQuantity)).toMatchObject({ claim_id: quantity, stance: "states", stated_estimate: POINT(9) });
    expect(await instance(onClaim)).toMatchObject({ claim_id: claim, stance: "affirms", stated_estimate: null });
  });

  it("moves onto a question with the answer the passage gives, and clears an answer that belonged to the old question", async () => {
    const oldQuestion = await seedQuestion("old question");
    const newQuestion = await seedQuestion("new question");
    const oldAnswer = await seedClaim("old answer");
    const newAnswer = await seedClaim("new answer");
    const stranger = await seedClaim("not an answer");
    await addAnswer({ questionId: oldQuestion, answerId: oldAnswer, basis: "quality", reasoning: "r", createdBy: "dbtest" });
    await addAnswer({ questionId: newQuestion, answerId: newAnswer, basis: "quality", reasoning: "r", createdBy: "dbtest" });
    const source = await seedSource();
    const inst = await seedInstance(oldQuestion, source, { stance: "answers", answerId: oldAnswer });

    const refused = await reassignInstance({ instanceId: inst, toClaimId: newQuestion, answerClaimId: stranger, reasoning: "r" });
    expect(refused.reason).toMatch(/not in the answer set/);

    const res = await reassignInstance({ instanceId: inst, toClaimId: newQuestion, answerClaimId: newAnswer, reasoning: "r" });
    expect(await instance(inst)).toMatchObject({ claim_id: newQuestion, stance: "answers", answer_claim_id: newAnswer });
    await reverseReconciliation(res.eventId!, { reasoning: "undo" });
    expect(await instance(inst)).toMatchObject({ claim_id: oldQuestion, stance: "answers", answer_claim_id: oldAnswer });

    // Without an answer named, the old question's answer does not travel.
    const plain = await reassignInstance({ instanceId: inst, toClaimId: newQuestion, reasoning: "r" });
    expect(await instance(inst)).toMatchObject({ claim_id: newQuestion, answer_claim_id: null });
    await reverseReconciliation(plain.eventId!, { reasoning: "undo" });
    expect((await instance(inst)).answer_claim_id).toBe(oldAnswer);
  });

  it("refuses what the target cannot take, a missing or inactive target, and a move to where it already is", async () => {
    const claim = await seedClaim("claim");
    const other = await seedClaim("other");
    const quantity = await seedQuantity("quantity");
    const question = await seedQuestion("question");
    const inst = await seedInstance(claim, await seedSource());
    const call = (extra: Partial<Parameters<typeof reassignInstance>[0]>) =>
      reassignInstance({ instanceId: inst, toClaimId: other, reasoning: "r", ...extra });

    expect((await call({ toClaimId: claim })).reason).toMatch(/already on that node/);
    expect((await call({ toClaimId: quantity, stated: POINT(1), stanceRelation: "opposed" })).reason).toMatch(/applies to a claim/);
    expect((await call({ toClaimId: question, stanceRelation: "opposed" })).reason).toMatch(/applies to a claim/);
    expect((await call({ stated: POINT(1) })).reason).toMatch(/figure for a quantity/);
    expect((await call({ answerClaimId: claim })).reason).toMatch(/answer to a question/);
    expect((await call({ toClaimId: randomUUID() })).reason).toMatch(/not found/);
    expect((await call({ instanceId: randomUUID() })).reason).toMatch(/not found/);
    await rawQuery(`UPDATE claims SET state = 'deprecated' WHERE id = $1`, [other]);
    expect((await call({})).reason).toMatch(/deprecated, not active/);

    expect((await instance(inst)).claim_id).toBe(claim);
    const [{ n }] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM reconciliation_events WHERE payload->>'instance_id' = $1`,
      [inst]
    );
    expect(n).toBe(0);
  });

  it("still reverses a move logged before the payload recorded the prior state", async () => {
    const from = await seedClaim("from");
    const to = await seedClaim("to");
    const inst = await seedInstance(to, await seedSource());
    const [legacy] = await rawQuery<{ id: string }>(
      `INSERT INTO reconciliation_events (operation, reasoning, payload)
       VALUES ('reassign_instance', 'split: instance moved', $1::jsonb) RETURNING id`,
      [JSON.stringify({ instance_id: inst, from_claim_id: from, to_claim_id: to })]
    );
    expect((await reverseReconciliation(legacy!.id)).reversed).toBe(true);
    expect(await instance(inst)).toMatchObject({ claim_id: from, stance: "affirms", detached_at: null });
  });
});

describe("reassign_instance: copying", () => {
  it("copies one passage onto each quantity of a split with its own figure, unread, and detaches the copy on reversal", async () => {
    const bundled = await seedQuantity("bundled");
    const gameTwo = await seedQuantity("game two");
    const gameThree = await seedQuantity("game three");
    const source = await seedSource();
    const argumentId = await seedArgument(bundled);
    const original = await seedInstance(bundled, source, {
      stance: "states",
      stated: POINT(31),
      speaker: "The referee",
      rank: 1,
      argumentId,
    });
    await seedReading(original);

    const two = await reassignInstance({ instanceId: original, toClaimId: gameTwo, copy: true, stated: POINT(42), reasoning: "game two: 42" });
    const three = await reassignInstance({ instanceId: original, toClaimId: gameThree, copy: true, stated: POINT(55), reasoning: "game three: 55" });
    expect(two).toMatchObject({ reassigned: true, mode: "copy", stance: "states" });
    expect(two.instanceId).not.toBe(original);

    // The original is untouched.
    const before = await instance(original);
    expect(before).toMatchObject({ claim_id: bundled, stated_estimate: POINT(31), display_rank: 1, argument_id: argumentId });

    // The copy carries the passage and its attribution, and nothing judged against the old node.
    const copy = await instance(two.instanceId!);
    expect(copy).toMatchObject({
      claim_id: gameTwo,
      source_id: source,
      verbatim_text: before.verbatim_text,
      context: before.context,
      speaker: "The referee",
      publication: "The Gazette",
      source_date: "2024-03",
      segment_id: before.segment_id,
      stance: "states",
      stated_estimate: POINT(42),
      argument_id: null,
      display_rank: null,
      created_by: "curator",
      detached_at: null,
    });
    expect((await instance(three.instanceId!)).stated_estimate).toEqual(POINT(55));
    const [{ n: readings }] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM claim_instance_readings WHERE instance_id = $1`,
      [copy.id]
    );
    expect(readings).toBe(0);

    expect((await event(two.eventId!)).payload).toMatchObject({
      mode: "copy",
      instance_id: copy.id,
      copied_from_instance_id: original,
      from_claim_id: bundled,
      to_claim_id: gameTwo,
      prior: { claim_id: bundled, stance: "states", stated_estimate: POINT(31), argument_id: argumentId, display_rank: 1 },
    });

    // A second figure from the same source on the same quantity is allowed.
    const again = await reassignInstance({ instanceId: original, toClaimId: gameTwo, copy: true, stated: POINT(43), reasoning: "a second figure" });
    expect(again.reassigned).toBe(true);
    await reverseReconciliation(again.eventId!, { reasoning: "undo" });

    expect((await reverseReconciliation(two.eventId!, { reasoning: "the passage does not give game two" })).reversed).toBe(true);
    const undone = await instance(copy.id);
    expect(undone.claim_id).toBe(gameTwo);
    expect(undone.detached_at).not.toBeNull();
    expect(undone.detached_by).toBe("curator");
    expect(undone.detached_reason).toContain(two.eventId!);
    // The original and the other copy stand.
    expect(await instance(original)).toMatchObject({ claim_id: bundled, detached_at: null });
    expect((await instance(three.instanceId!)).detached_at).toBeNull();
  });

  it("copies onto a claim with the stance flipped, and refuses a second instance from the same source and speaker", async () => {
    const from = await seedClaim("from");
    const denial = await seedClaim("denial");
    const source = await seedSource();
    const original = await seedInstance(from, source, { stance: "affirms", speaker: "Dr. Ito" });

    const res = await reassignInstance({ instanceId: original, toClaimId: denial, copy: true, stanceRelation: "opposed", reasoning: "r" });
    expect(res).toMatchObject({ reassigned: true, mode: "copy", stance: "denies" });
    expect(await instance(original)).toMatchObject({ claim_id: from, stance: "affirms" });

    // The same voice again, in any letter case, and a copy back onto its own claim.
    await rawQuery(`UPDATE claim_instances SET speaker = 'DR. ITO' WHERE id = $1`, [original]);
    const dup = await reassignInstance({ instanceId: original, toClaimId: denial, copy: true, reasoning: "r" });
    expect(dup.reassigned).toBe(false);
    expect(dup.reason).toContain(res.instanceId!);
    expect(dup.reason).toMatch(/already has an instance from this source and speaker/);
    expect((await reassignInstance({ instanceId: original, toClaimId: from, copy: true, reasoning: "r" })).reason).toContain(original);

    // Another speaker in the same source is a different voice.
    const other = await seedInstance(from, source, { stance: "denies", speaker: "Dr. Mbeki" });
    const second = await reassignInstance({ instanceId: other, toClaimId: denial, copy: true, reasoning: "r" });
    expect(second).toMatchObject({ reassigned: true, stance: "denies" });

    // A copy that was undone is detached, and still stands in the way, named as detached.
    await reverseReconciliation(second.eventId!, { reasoning: "undo" });
    const blocked = await reassignInstance({ instanceId: other, toClaimId: denial, copy: true, reasoning: "r" });
    expect(blocked.reason).toMatch(/detached/);
    expect(blocked.reason).toContain(second.instanceId!);
  });

  it("a copy leaves its source node free to be undone around it, and waits on later surgery at its target", async () => {
    const a = await seedClaim("a");
    const b = await seedClaim("b");
    const c = await seedClaim("c");
    const d = await seedClaim("d");
    const inst = await seedInstance(a, await seedSource());

    const move = await reassignInstance({ instanceId: inst, toClaimId: b, reasoning: "r" });
    const copy = await reassignInstance({ instanceId: inst, toClaimId: c, copy: true, reasoning: "r" });
    const onward = await reassignInstance({ instanceId: copy.instanceId!, toClaimId: d, reasoning: "r" });

    // The copy was since moved off its target: undoing it now would detach it somewhere else.
    const refused = await reverseReconciliation(copy.eventId!, { reasoning: "undo" });
    expect(refused).toMatchObject({ reversed: false, blockedBy: [onward.eventId] });
    // The earlier move on the source's node is not held up by the copy taken from it.
    expect((await reverseReconciliation(move.eventId!, { reasoning: "undo" })).reversed).toBe(true);
    expect((await instance(inst)).claim_id).toBe(a);

    expect((await reverseReconciliation(onward.eventId!, { reasoning: "undo" })).reversed).toBe(true);
    expect((await reverseReconciliation(copy.eventId!, { reasoning: "undo" })).reversed).toBe(true);
    expect(await instance(copy.instanceId!)).toMatchObject({ claim_id: c, detached_by: "curator" });
  });

  it("copies onto a question as asking it, or as giving one of its answers", async () => {
    const claim = await seedClaim("claim");
    const question = await seedQuestion("question");
    const answer = await seedClaim("answer");
    await addAnswer({ questionId: question, answerId: answer, basis: "quality", reasoning: "r", createdBy: "dbtest" });
    const original = await seedInstance(claim, await seedSource());

    const asks = await reassignInstance({ instanceId: original, toClaimId: question, copy: true, reasoning: "r" });
    expect(await instance(asks.instanceId!)).toMatchObject({ claim_id: question, stance: "asks", answer_claim_id: null });
    const answers = await reassignInstance({ instanceId: original, toClaimId: question, copy: true, answerClaimId: answer, reasoning: "r" });
    expect(await instance(answers.instanceId!)).toMatchObject({ claim_id: question, stance: "answers", answer_claim_id: answer });

    await reverseReconciliation(answers.eventId!, { reasoning: "undo" });
    await reverseReconciliation(asks.eventId!, { reasoning: "undo" });
    expect((await instance(answers.instanceId!)).detached_at).not.toBeNull();
    expect((await instance(asks.instanceId!)).detached_at).not.toBeNull();
    expect(await instance(original)).toMatchObject({ claim_id: claim, stance: "affirms", detached_at: null });
  });
});
