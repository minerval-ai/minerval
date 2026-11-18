/**
 * MIRA export (#515) against real Postgres: a question with its answers, an
 * answer relation, its standing, and a request on it, assembled through the
 * same reads the route uses and validated against MIRA's SHACL shapes
 * (docs/mira/).
 */
import { describe, it, expect, vi } from "vitest";
import { seedClaim } from "./helpers.js";
import {
  addAnswer,
  markQuestion,
  recordQuestionAssessment,
  setAnswerRelation,
} from "../../src/services/question-service.js";
import { fileRequest } from "../../src/services/request-service.js";
import { citationUrl } from "../../src/services/citation-service.js";
import { assembleClaimMira, type JsonLdNode } from "../../src/services/mira-service.js";
import { assembleClaimNanopub } from "../../src/services/nanopub-service.js";
import { assembleClaimScasp, claimAtom } from "../../src/services/scasp-service.js";
import { addArgument } from "../../src/services/argument-service.js";
import { attachEdgeToArgument, insertRelationshipEdge } from "../../src/services/relationship-service.js";
import { validateMira } from "../mira-shacl.js";

vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => new Array(1536).fill(0.01)),
}));

async function expectValid(doc: unknown) {
  const report = await validateMira(doc);
  expect(report.messages).toEqual([]);
  expect(report.conforms).toBe(true);
}

describe("assembleClaimMira", () => {
  it("returns null for an unknown node", async () => {
    expect(await assembleClaimMira("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("exports a question with its answers, standing, and requests, and an answer linked back", async () => {
    const q = await seedClaim("question");
    await markQuestion(q);
    const a1 = await seedClaim("answer one");
    const a2 = await seedClaim("answer two");
    await addAnswer({ questionId: q, answerId: a1, basis: "quality", reasoning: "r", createdBy: "dbtest" });
    await addAnswer({ questionId: q, answerId: a2, basis: "prominence", reasoning: "r", createdBy: "dbtest" });
    await setAnswerRelation({ questionId: q, answerA: a1, answerB: a2, relation: "excludes", createdBy: "dbtest" });
    await recordQuestionAssessment({
      claimId: q,
      standing: "leaning",
      favoredClaimIds: [a1],
      reasoningTrace: `Leaning toward [[claim:${a1}]].`,
    });
    await fileRequest({
      ask: "A survey of the competing answers.",
      why: "The standing turns on which answer the literature favors.",
      satisfiedBy: "A review covering both.",
      claimIds: [q],
      filer: { kind: "admin", agent: "question_steward" },
    });

    const doc = await assembleClaimMira(q);
    await expectValid(doc);
    const byId = (id: string) => doc!["@graph"].find((n: JsonLdNode) => n["@id"] === id);

    expect(byId(citationUrl(q))).toMatchObject({ "@type": "Question" });
    expect(byId(`${citationUrl(q)}#record`)).toMatchObject({
      "mv:standing": "leaning",
      "mv:favors": { "@id": citationUrl(a1) },
    });
    expect(JSON.stringify(doc)).not.toContain("[[claim:");
    expect(byId(citationUrl(a1))).toMatchObject({ "@type": "Claim", addresses: citationUrl(q) });
    expect(doc!["@graph"].find((n: JsonLdNode) => n["@type"] === "mv:AnswerRelation")).toMatchObject({
      "mv:relation": "excludes",
    });
    expect(doc!["@graph"].find((n: JsonLdNode) => n["@type"] === "Request")).toMatchObject({
      creator: [{ "@type": "UserAccount", accountName: "Question Steward" }, expect.any(String)],
    });

    const fromAnswer = await assembleClaimMira(a1);
    await expectValid(fromAnswer);
    expect(fromAnswer!["@graph"].find((n: JsonLdNode) => n["@id"] === citationUrl(a1))).toMatchObject({
      "@type": "Claim",
      addresses: citationUrl(q),
    });
  });

  // On the public graph nothing is set aside. Other files in this suite may
  // leave labels behind in the worker's database, so the test does not
  // assume one label; it needs only that nothing here is set aside.
  it("where nothing is set aside, as on the public graph: every edge and argument is live in every export", async () => {
    const parent = await seedClaim("parent");
    const child = await seedClaim("premise");
    const made = await insertRelationshipEdge({ parentId: parent, childId: child, relationType: "requires", reasoning: "r", createdBy: "dbtest" });
    const argument = await addArgument({ claimId: parent, stance: "for", name: "The one argument", content: "c", createdBy: "dbtest" });
    await attachEdgeToArgument(argument.id, made.id);

    const doc = await assembleClaimMira(parent);
    await expectValid(doc);
    expect(doc!["@graph"].find((n: JsonLdNode) => n["@id"] === citationUrl(child))).toMatchObject({ supports: citationUrl(parent) });
    const trig = (await assembleClaimNanopub(parent, "trig"))!.body;
    expect(trig).toContain(`mv:requires <${citationUrl(child)}>`);
    const scasp = (await assembleClaimScasp(parent, 3))!;
    expect(scasp).toContain(`edge(${claimAtom(parent)}, ${claimAtom(child)}, 'requires').`);
    for (const out of [JSON.stringify(doc), trig, scasp]) {
      expect(out).not.toContain("setAside");
      expect(out).not.toContain("Left out");
    }
  });
});
