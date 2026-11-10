/**
 * The claim card query against real tables: each kind's judgment read from
 * the table that kind keeps, only the current row, and many cards in one
 * read (src/services/claim-card-service.ts).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { getClaimCard, getClaimCards } from "../../src/services/claim-card-service.js";
import { seedClaim } from "./helpers.js";

async function seedAssessment(
  claimId: string,
  status: string,
  confidence: number,
  opts: { current?: boolean; at?: string } = {}
): Promise<void> {
  await rawQuery(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current, assessed_at)
     VALUES ($1, $2, $3, 'dbtest', $4, $5)`,
    [claimId, status, confidence, opts.current ?? true, opts.at ?? "2026-09-30T12:00:00Z"]
  );
}

describe("claim cards", () => {
  it("reads an unassessed claim as a card with a null judgment", async () => {
    const id = await seedClaim("card-unassessed");
    const card = await getClaimCard(id);
    expect(card).toMatchObject({
      id,
      kind: "claim",
      state: "active",
      assessment_status: null,
      assessment_confidence: null,
      standing: null,
      estimate: null,
      unit: null,
      contestation: null,
      assessed_at: null,
    });
    expect(card!.text).toContain("card-unassessed");
    expect(card!.page_url.endsWith(`/claims/${id}`)).toBe(true);
    expect(Number.isNaN(Date.parse(card!.updated_at))).toBe(false);
  });

  it("carries the current assessment and the claim's contestation, not a superseded one", async () => {
    const id = await seedClaim("card-assessed");
    await seedAssessment(id, "contradicted", 0.9, { current: false, at: "2026-01-01T00:00:00Z" });
    await seedAssessment(id, "supported", 0.75);
    await rawQuery(`UPDATE claims SET contestation = 0.5 WHERE id = $1`, [id]);

    const card = await getClaimCard(id);
    expect(card).toMatchObject({
      assessment_status: "supported",
      assessment_confidence: 0.75,
      contestation: 0.5,
      assessed_at: "2026-09-30T12:00:00.000Z",
    });
  });

  it("carries a question's standing and a quantity's estimate and unit", async () => {
    const question = await seedClaim("card-question");
    await rawQuery(`UPDATE claims SET kind = 'question' WHERE id = $1`, [question]);
    await rawQuery(
      `INSERT INTO question_assessments (claim_id, standing, reasoning_trace, confidence, assessed_at)
       VALUES ($1, 'open', 'dbtest', 0.6, '2026-08-01T00:00:00Z')`,
      [question]
    );
    const quantity = await seedClaim("card-quantity");
    await rawQuery(`UPDATE claims SET kind = 'quantity' WHERE id = $1`, [quantity]);
    await rawQuery(
      `INSERT INTO quantity_definitions (claim_id, measures, unit, created_by)
       VALUES ($1, 'dbtest measure', '{"symbol":"kg"}', 'dbtest')`,
      [quantity]
    );
    await rawQuery(
      `INSERT INTO quantity_estimates (claim_id, estimate, work, assessed_at)
       VALUES ($1, '{"form":"point","central":1}', 'dbtest', '2026-08-02T00:00:00Z')`,
      [quantity]
    );

    const cards = await getClaimCards([question, quantity]);
    expect(cards.get(question)).toMatchObject({
      kind: "question",
      assessment_status: null,
      assessment_confidence: 0.6,
      standing: "open",
      estimate: null,
      unit: null,
      assessed_at: "2026-08-01T00:00:00.000Z",
    });
    expect(cards.get(quantity)).toMatchObject({
      kind: "quantity",
      assessment_status: null,
      assessment_confidence: null,
      standing: null,
      estimate: { form: "point", central: 1 },
      unit: { symbol: "kg" },
      assessed_at: "2026-08-02T00:00:00.000Z",
    });
  });

  it("reads many cards at once and leaves out ids the graph does not hold", async () => {
    const a = await seedClaim("card-a");
    const b = await seedClaim("card-b");
    await seedAssessment(b, "inconclusive", 0.4);
    const missing = randomUUID();

    const cards = await getClaimCards([b, missing, a]);
    expect([...cards.keys()].sort()).toEqual([a, b].sort());
    expect(cards.get(a)!.assessment_status).toBeNull();
    expect(cards.get(b)!.assessment_status).toBe("inconclusive");
    expect(await getClaimCard(missing)).toBeNull();
    expect((await getClaimCards([])).size).toBe(0);
  });
});
