/**
 * Agent findings (#394) against real Postgres: the ref check, the search
 * over pgvector, the join-as-sighting path, the
 * read-time stale flag, and the tag filter through the claim's taggings.
 * Embeddings are stubbed with deterministic vectors so the similarity
 * arithmetic is under the test's control.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";

const embedMock = vi.hoisted(() => ({
  next: [] as number[][],
}));
vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    const v = embedMock.next.shift();
    if (!v) throw new Error("no stub embedding queued");
    return v;
  }),
}));

import {
  noteFinding,
  searchFindings,
  listFindings,
  findingsPage,
  describeAssessmentRefs,
  getFindingById,
  listFindingSightings,
  setFindingStatus,
} from "../../src/services/finding-service.js";

/** A unit vector along one axis, padded to 1536 dims. */
function axis(i: number, weight = 1): number[] {
  const v = new Array(1536).fill(0);
  v[i] = weight;
  return v;
}
/** Two axes mixed: cosine against axis(a) is a/sqrt(a²+b²). */
function mix(a: number, b: number, wa: number, wb: number): number[] {
  const v = new Array(1536).fill(0);
  v[a] = wa;
  v[b] = wb;
  return v;
}

async function seedAssessment(claimId: string, isCurrent = true): Promise<string> {
  const id = randomUUID();
  await rawQuery(
    `INSERT INTO assessments (id, claim_id, status, confidence, reasoning_trace, is_current)
     VALUES ($1, $2, 'contradicted', 0.8, 'trace', $3)`,
    [id, claimId, isCurrent]
  );
  return id;
}

async function seedQuestionAssessment(claimId: string): Promise<string> {
  const id = randomUUID();
  await rawQuery(
    `INSERT INTO question_assessments (id, claim_id, standing, reasoning_trace)
     VALUES ($1, $2, 'open', 'trace')`,
    [id, claimId]
  );
  return id;
}

async function seedQuantityEstimate(claimId: string): Promise<string> {
  const id = randomUUID();
  await rawQuery(
    `INSERT INTO quantity_estimates (id, claim_id, estimate, work)
     VALUES ($1, $2, '{"form":"point","central":1}', 'work')`,
    [id, claimId]
  );
  return id;
}

function base(claimId: string, assessmentId: string) {
  return {
    headline: "Moderate drinking does not lower cardiovascular risk once abstainer bias is corrected for.",
    account: "The received view rests on cohorts whose abstainers include former drinkers.",
    claimId,
    refs: [
      { kind: "assessment" as const, id: assessmentId },
      { kind: "claim" as const, id: claimId },
    ],
    importance: 5,
    agent: "steward",
    model: "test-model",
    skills: ["mathematics"],
  };
}

beforeEach(() => {
  embedMock.next = [];
});

describe("noteFinding on a real database", () => {
  it("records a finding, drops the ref that does not exist, and stamps attribution", async () => {
    const claimId = await seedClaim("finding subject");
    const assessmentId = await seedAssessment(claimId);
    embedMock.next.push(axis(0));
    const result = await noteFinding({
      ...base(claimId, assessmentId),
      refs: [
        { kind: "assessment", id: assessmentId },
        { kind: "lean_check", id: randomUUID() },
      ],
    });
    expect(result.outcome).toBe("recorded");
    if (result.outcome !== "recorded") return;
    expect(result.droppedRefs).toHaveLength(1);
    expect(result.droppedRefs[0]!.kind).toBe("lean_check");

    const row = await getFindingById(result.findingId);
    expect(row).not.toBeNull();
    expect(row!.refs).toEqual([{ kind: "assessment", id: assessmentId }]);
    expect(row!.agent).toBe("steward");
    expect(row!.model).toBe("test-model");
    expect(row!.skills).toEqual(["mathematics"]);
    expect(row!.claim_text).toContain("finding subject");
    expect(row!.sighting_count).toBe(1);
    expect(row!.stale).toBe(false);
  });

  it("finds a finding by meaning and records a sighting when the agent joins it", async () => {
    const claimId = await seedClaim("search and join");
    const otherClaim = await seedClaim("search elsewhere");
    const assessmentId = await seedAssessment(claimId);
    embedMock.next.push(axis(1));
    const first = await noteFinding(base(claimId, assessmentId));
    expect(first.outcome).toBe("recorded");
    const firstId = first.outcome === "recorded" ? first.findingId : "";

    // A query at cosine 0.8 against the first finds it, with its similarity.
    embedMock.next.push(mix(1, 2, 4, 3));
    const found = await searchFindings({ query: "drinking and the heart" });
    const hit = found.find((f) => f.id === firstId);
    expect(hit).toBeDefined();
    expect(hit!.similarity).toBeCloseTo(0.8, 5);

    // Limited to another node, it does not.
    embedMock.next.push(mix(1, 2, 4, 3));
    const elsewhere = await searchFindings({ query: "drinking and the heart", claimId: otherClaim });
    expect(elsewhere.map((f) => f.id)).not.toContain(firstId);

    // A near paraphrase without joins is recorded; nothing gates the write.
    embedMock.next.push(mix(1, 2, 4, 3));
    const second = await noteFinding({
      ...base(claimId, assessmentId),
      headline: "Once abstainer bias is corrected, moderate drinking shows no cardiac benefit.",
    });
    expect(second.outcome).toBe("recorded");

    const joined = await noteFinding({
      ...base(claimId, assessmentId),
      account: "Met again on re-assessment; the corrected cohorts still show no effect.",
      agent: "curator",
      joins: firstId,
    });
    expect(joined).toMatchObject({ outcome: "joined", findingId: firstId, sightingCount: 2 });

    const row = await getFindingById(firstId);
    expect(row!.sighting_count).toBe(2);
    const sightings = await listFindingSightings(firstId);
    expect(sightings).toHaveLength(1);
    expect(sightings[0]!.agent).toBe("curator");
    expect(sightings[0]!.account).toContain("Met again");
  });

  it("flags a finding stale once its cited assessment is superseded, and lists by claim, importance, and tag", async () => {
    const claimId = await seedClaim("stale and tagged");
    const assessmentId = await seedAssessment(claimId);
    embedMock.next.push(axis(20));
    const noted = await noteFinding({ ...base(claimId, assessmentId), importance: 8 });
    expect(noted.outcome).toBe("recorded");
    const id = noted.outcome === "recorded" ? noted.findingId : "";

    let [row] = await listFindings({ claimId });
    expect(row!.id).toBe(id);
    expect(row!.stale).toBe(false);

    // The graph moves: the cited assessment stops being current.
    await rawQuery(`UPDATE assessments SET is_current = false WHERE id = $1`, [assessmentId]);
    await seedAssessment(claimId, true);
    [row] = await listFindings({ claimId });
    expect(row!.stale).toBe(true);
    // The finding's page says of the cited assessment what it was and that it has been superseded.
    expect(await describeAssessmentRefs(row!.refs)).toEqual([
      expect.objectContaining({ id: assessmentId, claim_id: claimId, status: "contradicted", current: false }),
    ]);

    expect((await listFindings({ claimId, minImportance: 9 })).length).toBe(0);
    expect((await listFindings({ claimId, minImportance: 8 })).length).toBe(1);

    // Tag filter reads through the claim's taggings.
    const tagId = randomUUID();
    await rawQuery(
      `INSERT INTO tags (id, slug, name) VALUES ($1, 'cardiology-test', 'Cardiology Test')`,
      [tagId]
    );
    await rawQuery(
      `INSERT INTO taggings (tag_id, subject_kind, subject_id, source) VALUES ($1, 'claim', $2, 'operator')`,
      [tagId, claimId]
    );
    expect((await listFindings({ tag: "cardiology-test" })).map((r) => r.id)).toEqual([id]);
    expect((await listFindings({ tag: "no-such-tag" })).length).toBe(0);

    // Withdrawal takes it off the default list; the row still resolves.
    const withdrawn = await setFindingStatus(id, "withdrawn", "cited a retired statement");
    expect(withdrawn!.status).toBe("withdrawn");
    expect(withdrawn!.withdrawn_note).toBe("cited a retired statement");
    expect((await listFindings({ claimId })).length).toBe(0);
    expect((await listFindings({ claimId, status: "withdrawn" })).length).toBe(1);
  });

  it("cites a question's standing and a quantity's estimate, drops ones that do not exist, and flags each stale once superseded", async () => {
    const question = await seedClaim("finding question");
    const quantity = await seedClaim("finding quantity");
    const standingId = await seedQuestionAssessment(question);
    const estimateId = await seedQuantityEstimate(quantity);
    embedMock.next.push(axis(30));
    const noted = await noteFinding({
      ...base(question, standingId),
      refs: [
        { kind: "question_assessment", id: standingId },
        { kind: "quantity_estimate", id: estimateId },
        // Ids from the wrong table do not resolve under these kinds.
        { kind: "question_assessment", id: estimateId },
        { kind: "quantity_estimate", id: randomUUID() },
      ],
    });
    expect(noted.outcome).toBe("recorded");
    if (noted.outcome !== "recorded") return;
    expect(noted.droppedRefs.map((r) => r.kind).sort()).toEqual([
      "quantity_estimate",
      "question_assessment",
    ]);
    let row = await getFindingById(noted.findingId);
    expect(row!.refs).toEqual([
      { kind: "question_assessment", id: standingId },
      { kind: "quantity_estimate", id: estimateId },
    ]);
    expect(row!.stale).toBe(false);

    // The question's standing is superseded: stale.
    await rawQuery(`UPDATE question_assessments SET is_current = false WHERE id = $1`, [standingId]);
    await seedQuestionAssessment(question);
    row = await getFindingById(noted.findingId);
    expect(row!.stale).toBe(true);

    // Only the quantity's estimate cited, and then superseded: stale too.
    embedMock.next.push(axis(31));
    const onEstimate = await noteFinding({
      ...base(quantity, estimateId),
      refs: [{ kind: "quantity_estimate", id: estimateId }],
    });
    expect(onEstimate.outcome).toBe("recorded");
    const estimateFinding = onEstimate.outcome === "recorded" ? onEstimate.findingId : "";
    expect((await getFindingById(estimateFinding))!.stale).toBe(false);
    await rawQuery(`UPDATE quantity_estimates SET is_current = false WHERE id = $1`, [estimateId]);
    await seedQuantityEstimate(quantity);
    expect((await getFindingById(estimateFinding))!.stale).toBe(true);
  });

  it("refuses the importance range and the status vocabulary at the constraint", async () => {
    const claimId = await seedClaim("constraints");
    await expect(
      rawQuery(
        `INSERT INTO agent_findings (headline, account, claim_id, importance, agent)
         VALUES ('h', 'a', $1, 11, 'steward')`,
        [claimId]
      )
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      rawQuery(
        `INSERT INTO agent_findings (headline, account, claim_id, importance, agent, status)
         VALUES ('h', 'a', $1, 5, 'steward', 'deleted')`,
        [claimId]
      )
    ).rejects.toMatchObject({ code: "23514" });
  });
});

// The findings page's search and filters (the index at /findings): each
// filter narrows, they combine, the total is of everything that matches, and
// a facet counts what each of its values would leave under the others.
describe("findingsPage: search, filters and facets", () => {
  it("filters by agent and by where the claim stands, and counts each facet under the others", async () => {
    // A tag of this test's own, so the counts are of these three findings only.
    const slug = `facets-${randomUUID().slice(0, 8)}`;
    const tagId = randomUUID();
    await rawQuery(`INSERT INTO tags (id, slug, name) VALUES ($1, $2, 'Facets Test')`, [tagId, slug]);
    const tagged = async (label: string) => {
      const claimId = await seedClaim(label);
      await rawQuery(
        `INSERT INTO taggings (tag_id, subject_kind, subject_id, source) VALUES ($1, 'claim', $2, 'operator')`,
        [tagId, claimId]
      );
      return claimId;
    };

    const contradicted = await tagged("facets contradicted");
    const supported = await tagged("facets supported");
    const unassessed = await tagged("facets unassessed");
    const a1 = await seedAssessment(contradicted);
    const a2 = await seedAssessment(supported);
    await rawQuery(`UPDATE assessments SET status = 'supported' WHERE id = $1`, [a2]);

    embedMock.next.push(axis(40), axis(41), axis(42));
    await noteFinding({ ...base(contradicted, a1), importance: 8, agent: "steward" });
    await noteFinding({ ...base(supported, a2), importance: 3, agent: "grantmaker" });
    await noteFinding({
      ...base(unassessed, a1),
      refs: [{ kind: "claim" as const, id: unassessed }],
      importance: 5,
      agent: "claim_steward",
    });

    const all = await findingsPage({ tag: slug, facets: true });
    expect(all.total).toBe(3);
    expect(all.rows.every((r) => r.tags!.some((t) => t.slug === slug))).toBe(true);
    expect(all.facets!.agents).toEqual(
      expect.arrayContaining([
        { agent: "steward", count: 1 },
        { agent: "grantmaker", count: 1 },
        { agent: "claim_steward", count: 1 },
      ])
    );
    expect(all.facets!.claim_statuses).toEqual(
      expect.arrayContaining([
        { status: "contradicted", count: 1 },
        { status: "supported", count: 1 },
      ])
    );
    expect(all.facets!.importance).toEqual([
      { importance: 3, count: 1 },
      { importance: 5, count: 1 },
      { importance: 8, count: 1 },
    ]);

    // A role under two names is one filter.
    const stewards = await findingsPage({ tag: slug, agents: ["steward", "claim_steward"] });
    expect(stewards.total).toBe(2);

    // The claim's status in force narrows; an unassessed claim matches none.
    const onSupported = await findingsPage({ tag: slug, claimStatus: "supported", facets: true });
    expect(onSupported.rows.map((r) => r.claim_id)).toEqual([supported]);
    // The status facet is counted without its own filter, the others with it.
    expect(onSupported.facets!.claim_statuses).toHaveLength(2);
    expect(onSupported.facets!.agents).toEqual([{ agent: "grantmaker", count: 1 }]);

    // The total is of all that match, whatever the page.
    const paged = await findingsPage({ tag: slug, limit: 1 });
    expect(paged.rows).toHaveLength(1);
    expect(paged.total).toBe(3);

    // The tag facet names this tag with its three findings when no tag is chosen.
    const untagged = await findingsPage({ agents: ["grantmaker"], facets: true });
    expect(untagged.facets!.tags.length).toBeGreaterThan(0);
  });

  it("searches by the words and by meaning, closest first, and still searches when embedding fails", async () => {
    const near = await seedClaim("search near");
    const far = await seedClaim("search far");
    const a1 = await seedAssessment(near);
    const a2 = await seedAssessment(far);
    embedMock.next.push(axis(60), axis(61));
    const nearNote = await noteFinding({
      ...base(near, a1),
      headline: "Zymurgical fermentation yields are overstated in the trade literature.",
    });
    const farNote = await noteFinding({
      ...base(far, a2),
      headline: "Quokka population counts on the island are stable.",
    });
    const nearId = nearNote.outcome === "recorded" ? nearNote.findingId : "";
    const farId = farNote.outcome === "recorded" ? farNote.findingId : "";

    // By meaning alone: no word of the query is in either finding.
    embedMock.next.push(mix(60, 61, 0.9, 0.4));
    const byMeaning = await findingsPage({ q: "xylophone", order: "relevance" });
    const ids = byMeaning.rows.map((r) => r.id);
    expect(ids.indexOf(nearId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(nearId)).toBeLessThan(ids.indexOf(farId));

    // By the words, with the embedding service down (no stub queued).
    const byWords = await findingsPage({ q: "quokka" });
    expect(byWords.rows.map((r) => r.id)).toEqual([farId]);
    expect(byWords.total).toBe(1);
  });
});
