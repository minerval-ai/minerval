/**
 * The reads that give a node one judgment, for a reader who has two in
 * force (docs/accounts.md, "Where more than one judgment is in force for
 * one reader"): each says how many there are or carries every one, and for
 * a reader who has one each is exactly what it was.
 *
 * The review labels: `r3-a` and `r3-b` do not read each other. `subject`
 * is judged at both, `other` at `r3-a` alone. `both` reads the two labels,
 * `onlyA` reads one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { assembleClaimCitation, assembleEvidenceRecord } from "../../src/services/citation-service.js";
import { listRelatedClaims } from "../../src/services/claim-link-service.js";
import { loadMatchedClaim } from "../../src/services/extension-service.js";
import { describeAssessmentRefs, findingsPage } from "../../src/services/finding-service.js";
import { severalInForceForRun } from "../../src/services/judgment-version-service.js";
import { assembleClaimMira } from "../../src/services/mira-service.js";
import { assembleClaimNanopub } from "../../src/services/nanopub-service.js";
import { emptyChairs } from "../../src/services/monitor-service.js";
import { getQuantityDetail } from "../../src/services/quantity-service.js";
import { getQuestionDetail } from "../../src/services/question-service.js";
import { getSourceDocument } from "../../src/services/source-segment-service.js";
import { sqlClearanceNote } from "../../src/services/sql-service.js";
import { getClaimDependents, getTransitiveDependents, listClaimDependents } from "../../src/services/tree-service.js";
import { readViewsAs } from "./helpers.js";
import { A, B, C, asPerson, attachSource, seedNode, stewardAt, system, unwall, version, wall } from "./review-3-common.js";

const id: Record<string, string> = {};
const both = <T>(fn: () => Promise<T>) => asPerson([A, B, "public"], fn);
const onlyA = <T>(fn: () => Promise<T>) => asPerson([A, "public"], fn);
type Marked = { judgments_in_force?: number; judgments_in_force_note?: string };
const NOTE =
  "2 judgments of this node are in force for you, made at labels that do not read each other. The one given here is the most recently made of them. None replaces another: get_claim on the node lists each under versions, with its label.";

beforeAll(async () => {
  await wall();
  id.subject = await seedNode("public", "A node judged at two labels that do not read each other");
  id.other = await seedNode("public", "A node judged at one label");
  id.child = await seedNode("public", "A premise of both");
  id.question = await seedNode("public", "Which of the two is so", "question");
  id.askedTwice = await seedNode("public", "A question answered at two labels", "question");
  id.quantity = await seedNode("public", "How much of it there is", "quantity");
  id.chair = await seedNode("public", "An open claim with one side on record");
  const a = await attachSource(id.subject!, A, "What a holds.");
  id.sourceA = a.source;
  await attachSource(id.subject!, B, "What b holds.");
  await attachSource(id.other!, A, "What a holds of the other.");
  await attachSource(id.askedTwice!, A, "What a holds of the question.", "asks");
  await attachSource(id.askedTwice!, B, "What b holds of the question.", "asks");
  await version(id.subject!, A, "supported", "At a: supported.");
  await version(id.subject!, B, "doubtful", "At b: doubtful.");
  await version(id.other!, A, "supported", "At a alone.");
  // One side on record at each label, and an open verdict at each.
  for (const label of [A, B]) {
    await attachSource(id.chair!, label, `Affirmed in what ${label} holds.`);
    await attachSource(id.chair!, label, `Affirmed again in what ${label} holds.`);
    await version(id.chair!, label, "inconclusive", `At ${label}: open.`);
  }
  await system(async () => {
    const edge = (parent: string, child: string, relation: string) =>
      rawQuery(
        `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, confidence, reasoning, sensitivity_label)
         VALUES ($1, $2, $3, 0.9, 'It rests on it.', 'public')`,
        [parent, child, relation]
      );
    // The premise sits under both nodes, so both are its dependents.
    await edge(id.subject!, id.child!, "requires");
    await edge(id.other!, id.child!, "requires");
    // Both are answers of the question, and the subject sits under a second question too.
    await edge(id.question!, id.subject!, "answers");
    await edge(id.question!, id.other!, "answers");
    await edge(id.askedTwice!, id.subject!, "answers");
    const [x, y] = [id.subject!, id.other!].sort();
    await rawQuery(`INSERT INTO claim_links (claim_a_id, claim_b_id, kind, reasoning, sensitivity_label) VALUES ($1, $2, 'related', 'Read together.', 'public')`, [x, y]);
    await rawQuery(
      `INSERT INTO quantity_definitions (claim_id, measures, unit, created_by, sensitivity_label) VALUES ($1, 'how much', '{"symbol":"kg"}', 'dbtest', 'public')`,
      [id.quantity]
    );
    await rawQuery(`INSERT INTO quantity_cuts (claim_id, quantity_id, direction, value, created_by, sensitivity_label) VALUES ($1, $2, 'above', 3, 'dbtest', 'public'), ($3, $2, 'below', 9, 'dbtest', 'public')`, [
      id.subject,
      id.quantity,
      id.other,
    ]);
    for (const label of [A, B]) {
      await rawQuery(
        `INSERT INTO question_assessments (claim_id, standing, summary, reasoning_trace, is_current, sensitivity_label)
         VALUES ($1, $2, $3, $3, true, $4)`,
        [id.askedTwice, label === A ? "leaning" : "open", `At ${label}.`, label]
      );
    }
    const refs = await rawQuery<{ id: string; sensitivity_label: string }>(
      `SELECT id, sensitivity_label FROM assessments WHERE claim_id = $1 AND is_current ORDER BY assessed_at`,
      [id.subject]
    );
    id.assessedAtA = refs.find((r) => r.sensitivity_label === A)!.id;
    id.assessedAtB = refs.find((r) => r.sensitivity_label === B)!.id;
    const [finding] = await rawQuery<{ id: string }>(
      `INSERT INTO agent_findings (headline, account, claim_id, importance, agent, refs, sensitivity_label)
       VALUES ('A finding on a node judged twice', 'It was found.', $1, 5, 'steward', $2::jsonb, 'public') RETURNING id`,
      [id.subject, JSON.stringify([{ kind: "assessment", id: id.assessedAtA }, { kind: "assessment", id: id.assessedAtB }])]
    );
    id.finding = finding!.id;
  });
}, 180_000);

afterAll(async () => {
  await system(() => rawQuery(`DELETE FROM agent_findings WHERE id = $1`, [id.finding])).catch(() => undefined);
  await unwall();
}, 180_000);

const row = <T extends { id: string }>(rows: readonly T[], node: string) => rows.find((r) => r.id === node) as (T & Marked) | undefined;

describe("lists of nodes that give each one status", () => {
  it("dependents: direct, paged and walked upward", async () => {
    for (const read of [
      () => getClaimDependents(id.child!),
      async () => (await listClaimDependents(id.child!)).dependents,
      async () => (await getTransitiveDependents(id.child!, 2)).dependents,
    ]) {
      const rows = await both(read);
      expect(row(rows, id.subject!)).toMatchObject({ judgments_in_force: 2, judgments_in_force_note: NOTE });
      expect(row(rows, id.other!)).toBeDefined();
      expect(row(rows, id.other!)!.judgments_in_force).toBeUndefined();
      const forOne = await onlyA(read);
      expect(row(forOne, id.subject!)).toBeDefined();
      expect(row(forOne, id.subject!)!.judgments_in_force).toBeUndefined();
      expect("judgments_in_force_note" in row(forOne, id.subject!)!).toBe(false);
    }
  });

  it("claim links", async () => {
    const related = await both(() => listRelatedClaims(id.other!));
    expect(row(related, id.subject!)).toMatchObject({ judgments_in_force: 2, judgments_in_force_note: NOTE });
    expect(row(await both(() => listRelatedClaims(id.subject!)), id.other!)!.judgments_in_force).toBeUndefined();
    expect(row(await onlyA(() => listRelatedClaims(id.other!)), id.subject!)!.judgments_in_force).toBeUndefined();
  });

  it("a question's listed answers, and a question a node answers", async () => {
    const detail = await both(() => getQuestionDetail(id.question!));
    expect(row(detail.answers, id.subject!)).toMatchObject({ judgments_in_force: 2 });
    expect(row(detail.answers, id.other!)!.judgments_in_force).toBeUndefined();
    const forOne = await onlyA(() => getQuestionDetail(id.question!));
    expect(row(forOne.answers, id.subject!)!.judgments_in_force).toBeUndefined();
  });

  it("a quantity's bases: the claims that cut it", async () => {
    const detail = await both(() => getQuantityDetail(id.quantity!));
    expect(row(detail.cuts, id.subject!)).toMatchObject({ judgments_in_force: 2 });
    expect(row(detail.cuts, id.other!)!.judgments_in_force).toBeUndefined();
    expect(row((await onlyA(() => getQuantityDetail(id.quantity!))).cuts, id.subject!)!.judgments_in_force).toBeUndefined();
  });

  it("a source's segments: the claim each instance is of", async () => {
    const doc = await both(() => getSourceDocument(id.sourceA!, { rawSourceLabels: [A, B, "public"] }));
    const claims = [...(doc?.segments ?? []).flatMap((s) => s.instances), ...(doc?.unanchored ?? [])].map((i) => i.claim);
    expect(claims.find((c) => c.id === id.subject)).toMatchObject({ judgments_in_force: 2, judgments_in_force_note: NOTE });
    const forOne = await onlyA(() => getSourceDocument(id.sourceA!, { rawSourceLabels: [A, "public"] }));
    const one = [...(forOne?.segments ?? []).flatMap((s) => s.instances), ...(forOne?.unanchored ?? [])].map((i) => i.claim);
    expect(one.find((c) => c.id === id.subject)).toBeDefined();
    expect("judgments_in_force" in one.find((c) => c.id === id.subject)!).toBe(false);
  });
});

describe("findings", () => {
  it("are found under the status of either judgment in force, and counted under each", async () => {
    for (const status of ["supported", "doubtful"]) {
      const page = await both(() => findingsPage({ claimStatus: status, facets: true, limit: 100 }));
      expect(page.rows.map((r) => r.id)).toContain(id.finding);
      expect(page.facets!.claim_statuses.find((s) => s.status === status)!.count).toBeGreaterThanOrEqual(1);
    }
    // A reader of one label finds it under that label's status alone.
    expect((await onlyA(() => findingsPage({ claimStatus: "supported", limit: 100 }))).rows.map((r) => r.id)).toContain(id.finding);
    expect((await onlyA(() => findingsPage({ claimStatus: "doubtful", limit: 100 }))).rows.map((r) => r.id)).not.toContain(id.finding);
  });

  it("call a cited assessment current while it is its own label's current one", async () => {
    const refs = [
      { kind: "assessment" as const, id: id.assessedAtA! },
      { kind: "assessment" as const, id: id.assessedAtB! },
    ];
    const described = await both(() => describeAssessmentRefs(refs));
    expect(described).toHaveLength(2);
    // Neither is "not current" because the other was made later.
    expect(described.every((d) => d.current)).toBe(true);
    expect(described.every((d) => d.judgments_in_force === 2)).toBe(true);
    const forOne = await onlyA(() => describeAssessmentRefs(refs));
    expect(forOne).toHaveLength(1);
    expect(forOne[0]!.current).toBe(true);
    expect("judgments_in_force" in forOne[0]!).toBe(false);
  });
});

describe("monitors", () => {
  it("say so on a candidate judged by one of two", async () => {
    const report = await both(() => emptyChairs());
    const candidate = report.candidates.find((c) => c.claimId === id.chair);
    expect(candidate).toMatchObject({ status: "inconclusive", judgments_in_force: 2 });
    const forOne = (await onlyA(() => emptyChairs())).candidates.find((c) => c.claimId === id.chair);
    expect(forOne).toBeDefined();
    expect("judgments_in_force" in forOne!).toBe(false);
  });
});

describe("records made to be read away from the graph carry every judgment in force", () => {
  it("a citation's evidence record", async () => {
    const record = (await both(() => assembleEvidenceRecord(id.subject!)))!;
    expect(record.judgments_in_force).toBe(2);
    expect(record.judgments_in_force_note).toBe(NOTE);
    expect(record.assessments_in_force!.map((j) => [j.label, j.status]).sort()).toEqual([[A, "supported"], [B, "doubtful"]]);
    // The one the record names is the first of them, the most recently made.
    expect(record.assessments_in_force![0]!.id).toBe(record.assessment!.id);
    expect(record.assessments_in_force![1]!.summary).toBe("At a: supported.");
    const cited = (await both(() => assembleClaimCitation(id.subject!)))!;
    expect(cited.citation.judgments_in_force).toBe(2);
    expect(cited.citation.judgments_in_force_note).toBe(NOTE);

    const forOne = (await onlyA(() => assembleEvidenceRecord(id.subject!)))!;
    expect(forOne.assessment!.status).toBe("supported");
    expect("assessments_in_force" in forOne).toBe(false);
    expect("judgments_in_force" in forOne).toBe(false);
    expect("judgments_in_force" in (await onlyA(() => assembleClaimCitation(id.subject!)))!.citation).toBe(false);
  });

  it("the MIRA export: each as a node of its own, for a claim and for a question", async () => {
    const graphOf = (doc: unknown) => (doc as { "@graph": Array<Record<string, unknown>> })["@graph"];
    const mira = graphOf(await both(() => assembleClaimMira(id.subject!)));
    const assessments = mira.filter((n) => n["@type"] === "mv:Assessment");
    expect(assessments.map((n) => [n["mv:label"], n["mv:status"]]).sort()).toEqual([[A, "supported"], [B, "doubtful"]]);
    // The question it answers has two assessments in force too, and its node says how many.
    expect(JSON.stringify(mira)).toContain('"mv:judgmentsInForce":{"@value":"2"');
    expect(graphOf(await onlyA(() => assembleClaimMira(id.subject!))).filter((n) => n["@type"] === "mv:Assessment")).toEqual([]);
    expect(JSON.stringify(await onlyA(() => assembleClaimMira(id.subject!)))).not.toContain("mv:judgmentsInForce");

    const asked = graphOf(await both(() => assembleClaimMira(id.askedTwice!))).filter((n) => n["@type"] === "mv:Assessment");
    expect(asked.map((n) => [n["mv:label"], n["mv:standing"]]).sort()).toEqual([[A, "leaning"], [B, "open"]]);
    expect(graphOf(await onlyA(() => assembleClaimMira(id.askedTwice!))).filter((n) => n["@type"] === "mv:Assessment")).toEqual([]);
  });

  it("the nanopublication names each in its publication info", async () => {
    const np = JSON.stringify(await both(() => assembleClaimNanopub(id.subject!)));
    expect(np).toContain(id.assessedAtA);
    expect(np).toContain(id.assessedAtB);
    expect(np).toContain("assessmentInForce");
    expect(JSON.stringify(await onlyA(() => assembleClaimNanopub(id.subject!)))).not.toContain("assessmentInForce");
  });
});

describe("one node, read for an agent or a page", () => {
  it("the extension's lookup", async () => {
    expect((await both(() => loadMatchedClaim(id.subject!)))!.judgmentsInForce).toBe(2);
    expect((await both(() => loadMatchedClaim(id.askedTwice!)))!.judgmentsInForce).toBe(2);
    expect("judgmentsInForce" in (await onlyA(() => loadMatchedClaim(id.subject!)))!).toBe(false);
    expect("judgmentsInForce" in (await both(() => loadMatchedClaim(id.other!)))!).toBe(false);
  });

  it("what a resumed session is told beside the node's status", async () => {
    expect(await both(() => severalInForceForRun(id.subject!))).toBe(
      "2 judgments of this node are in force for this run, made at labels that do not read each other. The status given here is that of the most recently made, and none replaces another."
    );
    // A run at one label, or at a label that reads one of the two, has one.
    expect(await stewardAt(A, () => severalInForceForRun(id.subject!))).toBe("");
    expect(await stewardAt(C, () => severalInForceForRun(id.subject!))).toBe("");
    expect(await both(() => severalInForceForRun(id.other!))).toBe("");
  });
});

describe("read-only SQL's assessments view", () => {
  const q = () => `SELECT status FROM assessments WHERE node_id = '${id.subject}' AND is_current ORDER BY status`;

  it("gives a row for each judgment in force, and one row to a reader who has one", async () => {
    expect((await readViewsAs([A, B, "public"], q())).map((r) => r.status)).toEqual(["doubtful", "supported"]);
    expect((await readViewsAs([A, "public"], q())).map((r) => r.status)).toEqual(["supported"]);
    expect((await readViewsAs([B, "public"], q())).map((r) => r.status)).toEqual(["doubtful"]);
    // r3-c reads r3-a: the version at r3-a is the one in force for it, and no other.
    expect((await readViewsAs([C, A, "public"], q())).map((r) => r.status)).toEqual(["supported"]);
    expect(await readViewsAs(["public"], q())).toEqual([]);
  });

  it("tells a reader of several labels what is_current means, and says nothing more to a reader of one", () => {
    expect(sqlClearanceNote([A, B, "public"])).toContain(
      " In `assessments`, is_current is true for each judgment of a node that is in force for you. Where two of your labels do not read each other, a node can have one at each, and a join on is_current then returns a row for each. Neither replaces the other."
    );
    expect(sqlClearanceNote([A, "public"])).not.toContain("is_current");
    expect(sqlClearanceNote(["public"])).not.toContain("is_current");
  });
});
