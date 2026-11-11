/**
 * Argument passages at ingestion and their placement (#541), against real
 * SQL, with the placement model call stubbed.
 *
 *  - A passage on a claim with no arguments is kept on the claim, unplaced,
 *    with the side the source takes; get_claim lists it for the Steward.
 *  - A passage the Matcher places is an instance of that argument; a source
 *    read again records nothing new.
 *  - place_argument_passage places or dismisses an unplaced passage.
 *  - A merge carries unplaced passages to the survivor, flipping their side
 *    for an opposed merge, and its undo brings them back.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const placement = vi.hoisted(() => ({ next: null as null | Record<string, unknown> }));
vi.mock("../../src/llm/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/llm/client.js")>()),
  completeStructured: vi.fn(async () => placement.next),
}));

import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { recordArgumentPassages } from "../../src/services/argument-passage-service.js";
import { addArgument } from "../../src/services/argument-service.js";
import { getClaimView } from "../../src/services/claim-view-service.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { mergeClaims, reverseReconciliation } from "../../src/services/reconciliation-service.js";

async function source() {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, source_type) VALUES ($1, 'A paper', 'journal_article') RETURNING id`,
    [`https://dbtest.example/${randomUUID()}`]
  );
  return row!.id;
}

const steward = async (name: string, input: Record<string, unknown>) =>
  JSON.parse(await executeStewardTool(name, input));

const passage = (text: string) => ({ verbatim_text: text, context: null, role: "makes" as const });

describe("argument passages at ingestion", () => {
  let claimId: string;
  let sourceId: string;

  beforeAll(async () => {
    claimId = await seedClaim("ingest");
    sourceId = await source();
  });

  it("keeps a passage on a claim with no arguments unplaced, with the source's side", async () => {
    const counts = await recordArgumentPassages({
      claimId,
      claimText: "C",
      claimKind: "claim",
      sourceId,
      sourceStance: "denies",
      passages: [passage("Since X, not C.")],
    });
    expect(counts).toEqual({ placed: 0, unplaced: 1, skipped: 0 });
    const view = (await getClaimView(claimId, { include: ["arguments"] })) as Record<string, unknown>;
    expect(view.unplaced_argument_passages).toEqual([
      expect.objectContaining({ verbatim_text: "Since X, not C.", stance: "advances", direction: "against" }),
    ]);
    expect(view.unplaced_argument_passages_total).toBe(1);
  });

  it("places a passage the Matcher matches, and records nothing new on a second reading", async () => {
    const argument = await addArgument({ claimId, stance: "against", content: "X shows not C.", name: "from X" });
    placement.next = { argument_id: argument.id, stance: "advances", reading: "full", direction: null, reasoning: "Same." };
    const other = await source();
    const first = await recordArgumentPassages({
      claimId,
      claimText: "C",
      claimKind: "claim",
      sourceId: other,
      sourceStance: "denies",
      passages: [passage("X, so C fails.")],
    });
    expect(first).toEqual({ placed: 1, unplaced: 0, skipped: 0 });
    const again = await recordArgumentPassages({
      claimId,
      claimText: "C",
      claimKind: "claim",
      sourceId: other,
      sourceStance: "denies",
      passages: [passage("X, so C fails.")],
    });
    expect(again).toEqual({ placed: 0, unplaced: 0, skipped: 1 });
    const [row] = await rawQuery<{ reading: string; created_by: string; claim_id: string | null }>(
      `SELECT reading, created_by, claim_id FROM argument_instances WHERE argument_id = $1`,
      [argument.id]
    );
    expect(row).toEqual({ reading: "full", created_by: "matcher", claim_id: null });
  });

  it("records nothing for a question", async () => {
    const counts = await recordArgumentPassages({
      claimId,
      claimText: "Which?",
      claimKind: "question",
      sourceId,
      sourceStance: "asks",
      passages: [passage("Because Y.")],
    });
    expect(counts).toEqual({ placed: 0, unplaced: 0, skipped: 0 });
  });
});

describe("place_argument_passage", () => {
  it("places a passage on an argument, and dismisses another with its reason", async () => {
    const claimId = await seedClaim("place");
    const sourceId = await source();
    await recordArgumentPassages({
      claimId,
      claimText: "C",
      claimKind: "claim",
      sourceId,
      sourceStance: "affirms",
      passages: [passage("Because P, C."), passage("C, obviously.")],
    });
    const [p1, p2] = await rawQuery<{ id: string }>(
      `SELECT id FROM argument_instances WHERE claim_id = $1 ORDER BY verbatim_text`,
      [claimId]
    );
    const argument = await addArgument({ claimId, stance: "for", content: "P gives C.", name: "from P" });

    const placed = await steward("place_argument_passage", {
      instance_id: p1!.id,
      argument_id: argument.id,
      reading: "premise_unstated",
    });
    expect(placed.success).toBe(true);
    const dismissed = await steward("place_argument_passage", {
      instance_id: p2!.id,
      dismiss_reason: "Asserts the claim without reasoning.",
    });
    expect(dismissed.success).toBe(true);

    const rows = await rawQuery<{ id: string; argument_id: string | null; claim_id: string | null; dismissed_reason: string | null }>(
      `SELECT id, argument_id, claim_id, dismissed_reason FROM argument_instances WHERE id = ANY($1::uuid[])`,
      [[p1!.id, p2!.id]]
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(p1!.id)).toMatchObject({ argument_id: argument.id, claim_id: null });
    expect(byId.get(p2!.id)).toMatchObject({ argument_id: null, claim_id: claimId, dismissed_reason: "Asserts the claim without reasoning." });
    const view = (await getClaimView(claimId, { include: ["arguments"] })) as Record<string, unknown>;
    expect(view.unplaced_argument_passages).toBeUndefined();
  });

  it("refuses an argument on another claim", async () => {
    const claimId = await seedClaim("place-a");
    const elsewhere = await seedClaim("place-b");
    const sourceId = await source();
    await recordArgumentPassages({
      claimId,
      claimText: "C",
      claimKind: "claim",
      sourceId,
      sourceStance: "affirms",
      passages: [passage("Because Q, C.")],
    });
    const [p] = await rawQuery<{ id: string }>(`SELECT id FROM argument_instances WHERE claim_id = $1`, [claimId]);
    const argument = await addArgument({ claimId: elsewhere, stance: "for", content: "Q.", name: "from Q" });
    const out = await steward("place_argument_passage", { instance_id: p!.id, argument_id: argument.id });
    expect(out.success).toBe(false);
  });
});

describe("merges carry unplaced passages", () => {
  it("moves them to the survivor, flipping their side when opposed, and the undo restores them", async () => {
    const survivor = await seedClaim("survivor");
    const loser = await seedClaim("loser");
    const sourceId = await source();
    await recordArgumentPassages({
      claimId: loser,
      claimText: "not C",
      claimKind: "claim",
      sourceId,
      sourceStance: "affirms",
      passages: [passage("Because R, not C.")],
    });
    const { eventId } = await mergeClaims({
      survivorId: survivor,
      loserId: loser,
      stanceRelation: "opposed",
      reasoning: "The loser is the survivor's negation.",
    });
    const [moved] = await rawQuery<{ claim_id: string; direction: string }>(
      `SELECT claim_id, direction FROM argument_instances WHERE source_id = $1`,
      [sourceId]
    );
    expect(moved).toEqual({ claim_id: survivor, direction: "against" });

    const undone = await reverseReconciliation(eventId!);
    expect(undone.reversed).toBe(true);
    const [back] = await rawQuery<{ claim_id: string; direction: string }>(
      `SELECT claim_id, direction FROM argument_instances WHERE source_id = $1`,
      [sourceId]
    );
    expect(back).toEqual({ claim_id: loser, direction: "for" });
  });
});
