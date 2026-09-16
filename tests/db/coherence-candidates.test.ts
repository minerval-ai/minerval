/**
 * The coherence pre-filter (#330, Phase 0) against real Postgres: one
 * fixture per candidate kind, the negative controls that keep it a
 * shortlist rather than a dragnet, the tag scope, and the stats read.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim as seedPendingClaim } from "./helpers.js";
import {
  COHERENCE_THRESHOLDS,
  coherenceStats,
  listCoherenceCandidates,
  type CoherenceCandidate,
} from "../../src/services/coherence-service.js";

/**
 * A seeded claim starts in steward_state 'pending' (the row is the Steward
 * queue), and the pre-filter leaves a pending primary out on purpose. These
 * fixtures are stewarded claims, so mark them done.
 */
async function seedClaim(label: string): Promise<string> {
  const id = await seedPendingClaim(label);
  await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [id]);
  return id;
}

const HOUR = 3_600_000;
const T0 = new Date("2026-08-01T00:00:00Z");
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

/**
 * Write an assessment at a given time. The newest row per claim becomes
 * current; earlier ones stay as history (what stale_vs_neighbor reads).
 */
async function assess(
  claimId: string,
  input: { status: string; credence?: number | null; when: Date }
): Promise<string> {
  const id = randomUUID();
  await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1`, [claimId]);
  await rawQuery(
    `INSERT INTO assessments
       (id, claim_id, status, confidence, claim_credence, reasoning_trace, is_current, assessed_at)
     VALUES ($1, $2, $3, 0.8, $4, 'trace', true, $5)`,
    [id, claimId, input.status, input.credence ?? null, input.when]
  );
  return id;
}

async function edge(parent: string, child: string, relation: string): Promise<void> {
  await rawQuery(
    `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning)
     VALUES ($1, $2, $3, 'dbtest')`,
    [parent, child, relation]
  );
}

async function rivals(a: string, b: string): Promise<void> {
  const [x, y] = a < b ? [a, b] : [b, a];
  await rawQuery(
    `INSERT INTO claim_links (claim_a_id, claim_b_id, kind, reasoning)
     VALUES ($1, $2, 'rival_explanation', 'dbtest')`,
    [x, y]
  );
}

async function setImportance(claimId: string, importance: number): Promise<void> {
  await rawQuery(`UPDATE claims SET importance = $2 WHERE id = $1`, [claimId, importance]);
}

/** Every candidate whose pair touches one of these claims, from a whole-graph read. */
async function candidatesTouching(ids: string[]): Promise<CoherenceCandidate[]> {
  const all = await listCoherenceCandidates({}, { limit: 500 });
  return all.filter((c) => c.claim_ids.some((id) => ids.includes(id)));
}

describe("coherence pre-filter (#330)", () => {
  it("requires_status: a standing conclusion over a fallen premise", async () => {
    const parent = await seedClaim("parent");
    const child = await seedClaim("child");
    await edge(parent, child, "requires");
    await assess(parent, { status: "verified", credence: 0.9, when: at(0) });
    await assess(child, { status: "contradicted", credence: 0.1, when: at(1) });

    const found = await candidatesTouching([parent, child]);
    const kinds = found.map((c) => c.kind).sort();
    // The status rule fires; the credence rule yields to it on the same
    // pair; and the child had no assessment when the parent was assessed,
    // so stale_vs_neighbor stays quiet.
    expect(kinds).toEqual(["requires_status"]);
    const c = found[0]!;
    expect(c.primary_claim_id).toBe(parent);
    expect(c.claim_ids).toEqual([parent, child]);
    expect(c.relation).toBe("requires");
    expect(c.primary.status).toBe("verified");
    expect(c.other.status).toBe("contradicted");
    expect(c.other.credence).toBeCloseTo(0.1);
  });

  it("requires_credence: a conclusion priced above its premise beyond the margin, and not within it", async () => {
    const parent = await seedClaim("parent");
    const child = await seedClaim("child");
    await edge(parent, child, "requires");
    await assess(child, { status: "contested", credence: 0.5, when: at(0) });
    // Within the margin: nothing.
    await assess(parent, {
      status: "contested",
      credence: 0.5 + COHERENCE_THRESHOLDS.requiresMargin - 0.01,
      when: at(1),
    });
    expect(await candidatesTouching([parent, child])).toEqual([]);

    // Past it: shortlisted, parent primary.
    await assess(parent, {
      status: "contested",
      credence: 0.5 + COHERENCE_THRESHOLDS.requiresMargin + 0.05,
      when: at(2),
    });
    const found = await candidatesTouching([parent, child]);
    expect(found.map((c) => c.kind)).toEqual(["requires_credence"]);
    expect(found[0]!.primary_claim_id).toBe(parent);
  });

  it("requires_credence ignores pairs where either side states no credence", async () => {
    const parent = await seedClaim("parent");
    const child = await seedClaim("child");
    await edge(parent, child, "requires");
    await assess(child, { status: "contested", credence: null, when: at(0) });
    await assess(parent, { status: "supported", credence: 0.9, when: at(1) });
    expect(await candidatesTouching([parent, child])).toEqual([]);
  });

  it("contradicts_both_high: by status, and by credence alone", async () => {
    const p1 = await seedClaim("p1");
    const c1 = await seedClaim("c1");
    await edge(p1, c1, "contradicts");
    await assess(p1, { status: "supported", credence: null, when: at(0) });
    await assess(c1, { status: "verified", credence: null, when: at(1) });
    let found = await candidatesTouching([p1, c1]);
    expect(found.map((c) => c.kind)).toEqual(["contradicts_both_high"]);
    expect(found[0]!.primary_claim_id).toBe(p1);

    const p2 = await seedClaim("p2");
    const c2 = await seedClaim("c2");
    await edge(p2, c2, "contradicts");
    await assess(p2, { status: "contested", credence: COHERENCE_THRESHOLDS.highCredence, when: at(0) });
    await assess(c2, { status: "contested", credence: 0.95, when: at(1) });
    found = await candidatesTouching([p2, c2]);
    expect(found.map((c) => c.kind)).toEqual(["contradicts_both_high"]);

    // One side low: the contradiction is doing its job.
    const p3 = await seedClaim("p3");
    const c3 = await seedClaim("c3");
    await edge(p3, c3, "contradicts");
    await assess(p3, { status: "supported", credence: 0.8, when: at(0) });
    await assess(c3, { status: "unsupported", credence: 0.2, when: at(1) });
    expect(await candidatesTouching([p3, c3])).toEqual([]);
  });

  it("rivals_jointly_untenable: credences summing past 1 + tolerance, likelier side primary", async () => {
    const a = await seedClaim("a");
    const b = await seedClaim("b");
    await rivals(a, b);
    await assess(a, { status: "supported", credence: 0.6, when: at(0) });
    // Summing to 1.05, inside the tolerance: tenable. (Not tested at the
    // exact boundary: the column is a float4 and the sum rounds.)
    await assess(b, { status: "supported", credence: 0.45, when: at(1) });
    expect(await candidatesTouching([a, b])).toEqual([]);

    await assess(b, { status: "supported", credence: 0.75, when: at(2) });
    const found = await candidatesTouching([a, b]);
    expect(found.map((c) => c.kind)).toEqual(["rivals_jointly_untenable"]);
    expect(found[0]!.primary_claim_id).toBe(b);
    expect(found[0]!.claim_ids).toEqual([b, a]);
    expect(found[0]!.relation).toBe("rival_explanation");
  });

  it("a 'related' link carries no joint-tenability constraint", async () => {
    const a = await seedClaim("a");
    const b = await seedClaim("b");
    const [x, y] = a < b ? [a, b] : [b, a];
    await rawQuery(
      `INSERT INTO claim_links (claim_a_id, claim_b_id, kind, reasoning)
       VALUES ($1, $2, 'related', 'dbtest')`,
      [x, y]
    );
    await assess(a, { status: "verified", credence: 0.95, when: at(0) });
    await assess(b, { status: "verified", credence: 0.95, when: at(1) });
    expect(await candidatesTouching([a, b])).toEqual([]);
  });

  it("stale_vs_neighbor: the child's verdict moved after the parent last looked", async () => {
    const parent = await seedClaim("parent");
    const child = await seedClaim("child");
    await edge(parent, child, "requires");
    await assess(child, { status: "supported", credence: 0.8, when: at(0) });
    await assess(parent, { status: "supported", credence: 0.7, when: at(1) });
    // Child re-assessed later to the same verdict: no change, nothing.
    await assess(child, { status: "supported", credence: 0.85, when: at(2) });
    expect(await candidatesTouching([parent, child])).toEqual([]);

    // ...and then to a different one: the parent is working from a stale
    // premise. (Credence kept inside the requires margin so only this rule fires.)
    await assess(child, { status: "contested", credence: 0.6, when: at(3) });
    const found = await candidatesTouching([parent, child]);
    expect(found.map((c) => c.kind)).toEqual(["stale_vs_neighbor"]);
    const c = found[0]!;
    expect(c.primary_claim_id).toBe(parent);
    expect(c.neighbor_status_then).toBe("supported");
    expect(c.other.status).toBe("contested");
  });

  it("stale_vs_neighbor does not fire when the child was first assessed after the parent", async () => {
    const parent = await seedClaim("parent");
    const child = await seedClaim("child");
    await edge(parent, child, "requires");
    await assess(parent, { status: "supported", credence: 0.7, when: at(0) });
    await assess(child, { status: "supported", credence: 0.8, when: at(1) });
    expect(await candidatesTouching([parent, child])).toEqual([]);
  });

  it("a `supports` edge never shortlists on status or credence", async () => {
    const parent = await seedClaim("parent");
    const child = await seedClaim("child");
    await edge(parent, child, "supports");
    await assess(parent, { status: "verified", credence: 0.95, when: at(0) });
    await assess(child, { status: "contradicted", credence: 0.05, when: at(1) });
    expect(await candidatesTouching([parent, child])).toEqual([]);
  });

  it("a primary already waiting for its Steward is left out", async () => {
    const parent = await seedClaim("parent");
    const child = await seedClaim("child");
    await edge(parent, child, "requires");
    await assess(parent, { status: "verified", credence: 0.9, when: at(0) });
    await assess(child, { status: "contradicted", credence: 0.1, when: at(1) });
    expect((await candidatesTouching([parent, child])).length).toBe(1);

    await rawQuery(`UPDATE claims SET steward_state = 'pending' WHERE id = $1`, [parent]);
    expect(await candidatesTouching([parent, child])).toEqual([]);
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [parent]);
    expect((await candidatesTouching([parent, child])).length).toBe(1);
  });

  it("a merged or inactive claim drops out of every check", async () => {
    const parent = await seedClaim("parent");
    const child = await seedClaim("child");
    await edge(parent, child, "requires");
    await assess(parent, { status: "verified", credence: 0.9, when: at(0) });
    await assess(child, { status: "contradicted", credence: 0.1, when: at(1) });
    await rawQuery(`UPDATE claims SET state = 'archived' WHERE id = $1`, [child]);
    expect(await candidatesTouching([parent, child])).toEqual([]);
  });

  it("orders by the primary's importance and paginates", async () => {
    const lo = await seedClaim("lo");
    const loChild = await seedClaim("lo-child");
    const hi = await seedClaim("hi");
    const hiChild = await seedClaim("hi-child");
    for (const [p, c] of [
      [lo, loChild],
      [hi, hiChild],
    ] as const) {
      await edge(p, c, "requires");
      await assess(p, { status: "verified", credence: 0.9, when: at(0) });
      await assess(c, { status: "contradicted", credence: 0.1, when: at(1) });
    }
    await setImportance(lo, 0.99);
    await setImportance(hi, 1.0);

    const all = await listCoherenceCandidates({}, { limit: 500 });
    const mine = all.filter((c) => [lo, hi].includes(c.primary_claim_id));
    expect(mine.map((c) => c.primary_claim_id)).toEqual([hi, lo]);

    const firstIdx = all.findIndex((c) => c.primary_claim_id === hi);
    const page = await listCoherenceCandidates({}, { limit: 1, offset: firstIdx });
    expect(page.map((c) => c.primary_claim_id)).toEqual([hi]);
  });

  it("scopes to a tag on either end of the pair", async () => {
    const parent = await seedClaim("parent");
    const child = await seedClaim("child");
    await edge(parent, child, "requires");
    await assess(parent, { status: "verified", credence: 0.9, when: at(0) });
    await assess(child, { status: "contradicted", credence: 0.1, when: at(1) });

    const slug = `dbtest-${randomUUID().slice(0, 8)}`;
    const [tag] = await rawQuery<{ id: string }>(
      `INSERT INTO tags (slug, name, description, created_by)
       VALUES ($1, $1, 'dbtest', 'operator') RETURNING id`,
      [slug]
    );
    const [other] = await rawQuery<{ id: string }>(
      `INSERT INTO tags (slug, name, description, created_by)
       VALUES ($1, $1, 'dbtest', 'operator') RETURNING id`,
      [`${slug}-other`]
    );
    // Tag only the CHILD: the pair is still in the tag's scope.
    await rawQuery(
      `INSERT INTO taggings (tag_id, subject_kind, subject_id, source)
       VALUES ($1, 'claim', $2, 'operator')`,
      [tag!.id, child]
    );

    const inScope = await listCoherenceCandidates({ tagId: tag!.id }, { limit: 500 });
    expect(inScope.map((c) => c.primary_claim_id)).toEqual([parent]);
    const outOfScope = await listCoherenceCandidates({ tagId: other!.id }, { limit: 500 });
    expect(outOfScope).toEqual([]);

    const stats = await coherenceStats({ tagId: tag!.id });
    expect(stats.assessed_claims).toBe(1);
    expect(stats.assessed_edges).toBe(1);
    expect(stats.counts.requires_status).toBe(1);
    expect(stats.distinct_primaries).toBe(1);
  });

  it("stats count every kind, zero-filled, over the whole graph", async () => {
    const parent = await seedClaim("parent");
    const child = await seedClaim("child");
    await edge(parent, child, "requires");
    await assess(parent, { status: "verified", credence: 0.9, when: at(0) });
    await assess(child, { status: "contradicted", credence: 0.1, when: at(1) });
    const stats = await coherenceStats();
    expect(Object.keys(stats.counts).sort()).toEqual([
      "contradicts_both_high",
      "requires_credence",
      "requires_status",
      "rivals_jointly_untenable",
      "stale_vs_neighbor",
    ]);
    expect(stats.counts.requires_status).toBeGreaterThanOrEqual(1);
    expect(stats.assessed_claims).toBeGreaterThanOrEqual(2);
    expect(stats.distinct_primaries).toBeGreaterThanOrEqual(1);
  });
});
